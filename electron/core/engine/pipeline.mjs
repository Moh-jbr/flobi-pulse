// The pipeline holds everything the app knows, derives the model + alerts, and
// emits compact sections to the UI. Both the live connector and demo mode feed
// it, so the UI and alert rules behave identically in both. Pure JS.
import { buildModel, makeRouter, slim, summarizeEvent, workloadOf, cpuMilli, bytes } from './model.mjs';
import { ErrorBook } from './errors.mjs';
import { AlertBook, evaluateConditions, certificateImpact } from './alerts.mjs';
import { crashCopy } from './alert-copy.mjs';
import { TrafficStats } from './traffic.mjs';
import { shortName, DB_CONN_ERROR } from './log-parse.mjs';
import { deploysOf } from './recap.mjs';
import { mergeCrashRecords, crashCovered, pastIssue, sameProblem, mergeEventRows, PAST_DAYS } from './backfill.mjs';

const MIN = 60_000;
const PAST_MS = PAST_DAYS * 24 * 60 * MIN; // crashes, events and errors reach this far back

/** At most `n` of a list of points, evenly spaced, always keeping the newest. */
const thin = (points, n) => {
  const step = Math.max(1, Math.ceil(points.length / n));
  return points.filter((_, i) => (points.length - 1 - i) % step === 0);
};
const K8S_KEYS = ['pods', 'deployments', 'statefulsets', 'services', 'hpas', 'scaledobjects', 'nodes', 'jobs', 'cronjobs', 'ingresses', 'certificates', 'pdbs'];
// Source statuses that aren't trouble (setSource).
const WORKING = new Set(['ok', 'streaming', 'connecting', 'off']);

export class Pipeline {
  /**
   * @param {{namespace:string, emit:(type:string, payload:any)=>void, notify?:(alert:object, meta:{escalated:boolean, muted:boolean, related:object[]})=>void, knownErrors?:Record<string,number>, legacyKnownErrors?:Record<string,number>|null, now?:()=>number, mode:'live'|'demo', onTrouble?:()=>void}} o
   *   notify: `related` are the other alerts sent in the same notification (one incident, one notification).
   *   onTrouble: a data source just failed: main checks whether this computer went offline.
   */
  constructor({ namespace, emit, notify, knownErrors = {}, legacyKnownErrors = null, now = () => Date.now(), mode = 'live', graceMs = 45_000, onTrouble = () => {} }) {
    this.graceMs = graceMs;
    this.namespace = namespace;
    this.emit = emit;
    this.notify = notify;
    this.onTrouble = onTrouble;
    // This computer's connection (setConnectivity): { since } while it's offline, else null.
    this.offline = null;
    this.now = now;
    this.mode = mode;
    this.raw = Object.fromEntries(K8S_KEYS.map((k) => [k, []]));
    this.synced = new Set();
    this.podMetrics = new Map();
    this.nodeMetrics = new Map();
    this.metricsAt = null;
    this.restartLedger = new Map();
    this.lastDesired = new Map(); // workload → desired replicas at the previous rebuild
    this.stoppedAt = new Map(); // workload → when someone scaled it to 0 by hand
    this.startingAt = new Map(); // workload → when it was scaled up from 0
    this.prevRestarts = new Map();
    this.crashes = [];
    this.events = [];
    this.errors = new ErrorBook({ known: knownErrors, legacyKnown: legacyKnownErrors, now });
    // The past week, rebuilt from the logs on start (backfill.mjs): what it covers so far, and
    // what it found that the live sources don't have.
    this.backfill = { status: 'off', days: PAST_DAYS, since: null, until: null, notes: [], error: null };
    this.pastCrashes = []; // container crashes from Kubernetes events in the logs
    this.pastEvents = new Map(); // event id → row, from the logs (Kubernetes keeps an hour)
    this.logsBefore = null; // { since, until, lines }: the Logs page's lines from before the live stream
    this.pastSlices = new Set(); // the slices of it added so far ("from-until")
    this.heldNewErrors = []; // "new error" alerts waiting for the past week to finish loading
    this.traffic = new TrafficStats({ now: now() });
    this.uptime = new Map();
    this.database = { instances: [], operations: [], errors: [], status: 'off', message: null };
    this.sqlSeenInLogs = new Set(); // Cloud SQL connection names seen in Postgres logs
    this.dbConnIssues = []; // app log lines that look like "can't reach the database"
    this.usageHistory = new Map();
    this.serviceCpu = new Map(); // service → { unit: 'pct' | 'cores', points: [{ t, v }] }, the last hour
    this.serviceMem = new Map(); // service → { points: [{ t, v }] }: its fullest pod against its memory limit, the last hour
    this.billingStorage = null; // the Costs page's billing export vs BigQuery's free storage (setBillingStorage)
    this._billingStorageKey = null;
    this.billingCredits = []; // prepaid balances below their alert amount (setBillingCredits)
    this._billingCreditsKey = '';
    this.dnsInfo = null; // domain → { none, cloudflare } for certificates Google couldn't issue // pod → { service, points: [{ t, cpu, mem }] } from metrics-server
    this.cloudRun = [];
    this.sentry = { status: 'off', issues: [], projects: [], message: null };
    this.sentrySubstatus = new Map(); // issue id → { substatus, at }: its state when last polled
    this.cloudflare = { status: 'off', zones: [], pages: [], hostErrors: [], message: null };
    this.sources = {};
    this.session = {};
    this.recap = null;
    this.model = { services: [], pods: [], nodes: [], scaling: [], jobs: { cronjobs: [], jobs: [] }, certificates: [], ingress: [], routes: [] };
    this.router = () => null;
    this.pendingTraffic = [];
    this.pendingLogs = [];
    this.dirty = new Set();
    this.startedAt = now();
    this.liveSince = null;
    this.initialPhase = true;
    this.initialQueue = [];
    this.notifyBuckets = new Map();
    this.unsent = new Set(); // new alerts whose condition went away before their notification went out
    this.lastErrorsVersion = -1;
    this.lastAlertsVersion = -1;

    this.alerts = new AlertBook({
      now,
      onOpen: (a, meta) => this._onAlertOpen(a, meta),
      onResolve: () => this.dirty.add('alerts'),
    });
    this.timer = setInterval(() => this.tick(), 1000);
    this.flushTimer = setInterval(() => this.flushStreams(), 250);
  }

  destroy() {
    this.destroyed = true;
    clearInterval(this.timer);
    clearInterval(this.flushTimer);
    clearTimeout(this.rebuildTimer);
    clearTimeout(this.graceTimer);
    for (const b of this.notifyBuckets.values()) clearTimeout(b.timer);
    this.notifyBuckets.clear();
    this.unsent.clear();
    // Late callbacks from sources that are still winding down go nowhere.
    this.emit = () => {};
    this.notify = () => {};
  }

  // ── inputs ────────────────────────────────────────────────────────────────
  setSession(session) {
    this.session = { ...this.session, ...session };
    this.dirty.add('session');
  }

  setSource(key, status, message = null, extra = {}) {
    const prev = this.sources[key];
    if (prev && prev.status === status && prev.message === message) return;
    this.sources[key] = { status, message, at: this.now(), ...extra };
    if (key === 'live' && status === 'streaming' && !this.liveSince) this.liveSince = this.now();
    this.dirty.add('sources');
    // A source that just stopped working: first make sure it isn't this computer that went offline.
    if (prev?.status !== status && !WORKING.has(status) && !this.offline) {
      try {
        this.onTrouble();
      } catch {}
    }
  }

  /**
   * This computer's connection (net/connectivity.mjs). While it's offline nothing is called down
   * and no alert opens or closes (what can't be read isn't news): the page says it's offline and
   * shows what it last saw. Back online, it all carries on.
   */
  setConnectivity({ online = true, since = null } = {}) {
    const offline = online === false ? { since: since ?? this.now() } : null;
    if (!!offline === !!this.offline) return;
    this.offline = offline;
    for (const k of ['health', 'sources', 'uptime', 'alerts']) this.dirty.add(k);
    this.scheduleRebuild();
  }

  setK8s(key, items) {
    if (key === 'events' || key === 'nodeEvents') {
      this._setEvents(key, items);
      return;
    }
    this.raw[key] = items;
    this.synced.add(key);
    if (key === 'pods') this._trackRestarts(items);
    if (key === 'pods' && this.initialPhase && !this.graceTimer) {
      this.graceTimer = setTimeout(() => this._endInitialPhase(), this.graceMs);
    }
    this.scheduleRebuild();
  }

  setMetrics({ pods = [], nodes = [], at }) {
    this.podMetrics = new Map(pods.map((p) => [p.metadata?.name, p]));
    this.nodeMetrics = new Map(nodes.map((n) => [n.metadata?.name, n]));
    this.metricsAt = at || this.now();
    const t = this.metricsAt;
    for (const m of pods) {
      const name = m.metadata?.name;
      if (!name) continue;
      let cpu = 0;
      let mem = 0;
      for (const c of m.containers || []) {
        cpu += cpuMilli(c.usage?.cpu) / 1000;
        mem += bytes(c.usage?.memory);
      }
      let h = this.usageHistory.get(name);
      if (!h) this.usageHistory.set(name, (h = { service: this.model.pods.find((x) => x.name === name)?.service || null, points: [] }));
      if (!h.service) h.service = this.model.pods.find((x) => x.name === name)?.service || null;
      h.points.push({ t, cpu, mem });
      while (h.points.length && t - h.points[0].t > 60 * MIN) h.points.shift();
    }
    for (const [name, h] of this.usageHistory) if (!h.points.length || t - h.points[h.points.length - 1].t > 60 * MIN) this.usageHistory.delete(name);
    this._trackServiceUsage(pods, t);
    this.scheduleRebuild();
  }

  /**
   * One CPU and one memory point per service per metrics poll, for the Overview
   * cards' last-hour lines.
   * - CPU: the pods' usage summed against their limits summed (requests where a
   *   pod has no limit), so it reads as the same kind of % as the card's number.
   *   A service whose pods set neither keeps its usage in cores and says so.
   * - Memory: the fullest pod against its own limit, since one pod hitting its
   *   limit is what gets it killed. Only pods with a memory limit count.
   */
  _trackServiceUsage(podMetrics, t) {
    const pods = new Map(this.model.pods.map((p) => [p.name, p]));
    const sums = new Map();
    for (const m of podMetrics) {
      const pod = pods.get(m.metadata?.name);
      if (!pod?.service || pod.terminal) continue;
      let used = 0;
      let mem = 0;
      for (const c of m.containers || []) {
        used += cpuMilli(c.usage?.cpu);
        mem += bytes(c.usage?.memory);
      }
      const x = sums.get(pod.service) || { used: 0, cap: 0, uncapped: false, memPct: null };
      const cap = pod.cpuLimit || pod.cpuRequest;
      x.used += used;
      if (cap) x.cap += cap;
      else x.uncapped = true;
      if (pod.memLimit > 0) x.memPct = Math.max(x.memPct ?? 0, mem / pod.memLimit);
      sums.set(pod.service, x);
    }
    const trim = (points) => {
      while (points.length && t - points[0].t > 60 * MIN) points.shift();
    };
    for (const [service, x] of sums) {
      const unit = x.cap && !x.uncapped ? 'pct' : 'cores';
      let h = this.serviceCpu.get(service);
      if (!h || h.unit !== unit) this.serviceCpu.set(service, (h = { unit, points: [] }));
      h.points.push({ t, v: unit === 'pct' ? x.used / x.cap : x.used / 1000 });
      trim(h.points);
      if (x.memPct != null) {
        let mh = this.serviceMem.get(service);
        if (!mh) this.serviceMem.set(service, (mh = { points: [] }));
        mh.points.push({ t, v: x.memPct });
        trim(mh.points);
      }
    }
    for (const map of [this.serviceCpu, this.serviceMem]) {
      for (const [service, h] of map) if (!h.points.length || t - h.points[h.points.length - 1].t > 60 * MIN) map.delete(service);
    }
  }

  /** A service's last-hour CPU line, at most `n` points (the newest kept), or null with fewer than two. */
  cpuSpark(service, n = 60) {
    const h = this.serviceCpu.get(service);
    if (!h || h.points.length < 2) return null;
    const kept = thin(h.points, n);
    return { unit: h.unit, points: kept.map((p) => p.v), times: kept.map((p) => p.t) };
  }

  /** A service's last-hour memory line (its fullest pod, 0–1 of the limit), or null with fewer than two points. */
  memSpark(service, n = 60) {
    const h = this.serviceMem.get(service);
    if (!h || h.points.length < 2) return null;
    const kept = thin(h.points, n);
    return { points: kept.map((p) => p.v), times: kept.map((p) => p.t) };
  }

  /**
   * How long until a service's fullest pod reaches its memory limit at the pace
   * of the last 15 minutes (a least-squares line through them), in ms. Null when
   * memory isn't climbing, when there's under 5 minutes of it, when it is still
   * under half the limit, or when the limit is more than an hour away.
   */
  memEta(service, now = this.now()) {
    const pts = (this.serviceMem.get(service)?.points || []).filter((p) => now - p.t <= 15 * MIN);
    if (pts.length < 4 || pts[pts.length - 1].t - pts[0].t < 5 * MIN) return null;
    const n = pts.length;
    const mt = pts.reduce((a, p) => a + p.t, 0) / n;
    const mv = pts.reduce((a, p) => a + p.v, 0) / n;
    let num = 0;
    let den = 0;
    for (const p of pts) {
      num += (p.t - mt) * (p.v - mv);
      den += (p.t - mt) ** 2;
    }
    const slope = den ? num / den : 0; // share of the limit per ms
    const last = pts[n - 1].v;
    if (slope <= 0 || last < 0.5) return null;
    if (last >= 1) return 0;
    const eta = (1 - last) / slope;
    return eta <= 60 * MIN ? eta : null;
  }

  /** When each service was deployed in the last hour, from the Kubernetes events (oldest first). */
  recentDeploys(now = this.now()) {
    const evs = this.events
      .filter((e) => e.kind === 'Deployment' && e.reason === 'ScalingReplicaSet' && now - e.at <= 75 * MIN)
      .map((e) => ({ reason: e.reason, objectKind: e.kind, objectName: e.name, message: e.message, at: e.at }))
      .sort((a, b) => a.at - b.at);
    const out = new Map();
    for (const d of deploysOf(evs)) {
      if (now - d.at > 60 * MIN) continue;
      if (!out.has(d.service)) out.set(d.service, []);
      out.get(d.service).push(d.at);
    }
    return out;
  }

  /** The cards' last hour, about a point a minute, to save on quit and bring back on the next start. */
  usageToSave() {
    const pack = (points) => thin(points, 60).map((p) => [p.t, Math.round(p.v * 1e4) / 1e4]);
    const cpu = {};
    const mem = {};
    for (const [svc, h] of this.serviceCpu) cpu[svc] = { unit: h.unit, points: pack(h.points) };
    for (const [svc, h] of this.serviceMem) mem[svc] = pack(h.points);
    return Object.keys(cpu).length || Object.keys(mem).length ? { at: this.now(), cpu, mem } : null;
  }

  /** Brings back what usageToSave() kept, minus anything older than an hour. Points from this session win. */
  restoreUsage(saved, now = this.now()) {
    if (!saved || typeof saved !== 'object') return;
    const fresh = (list) => (Array.isArray(list) ? list.filter((x) => Array.isArray(x) && now - x[0] <= 60 * MIN && x[0] <= now && Number.isFinite(x[1])).map(([t, v]) => ({ t, v })) : []);
    for (const [svc, h] of Object.entries(saved.cpu || {})) {
      const pts = fresh(h?.points);
      if (!pts.length || (h.unit !== 'pct' && h.unit !== 'cores')) continue;
      const cur = this.serviceCpu.get(svc);
      if (cur && cur.unit !== h.unit) continue;
      this.serviceCpu.set(svc, { unit: h.unit, points: [...pts.filter((p) => !cur?.points.length || p.t < cur.points[0].t), ...(cur?.points || [])] });
    }
    for (const [svc, list] of Object.entries(saved.mem || {})) {
      const pts = fresh(list);
      if (!pts.length) continue;
      const cur = this.serviceMem.get(svc);
      this.serviceMem.set(svc, { points: [...pts.filter((p) => !cur?.points.length || p.t < cur.points[0].t), ...(cur?.points || [])] });
    }
    this.dirty.add('services');
  }

  /** CPU (cores) / memory (bytes) per pod of a service, collected while the app is open. */
  usage({ service, range = 60 * MIN }) {
    const now = this.now();
    const pick = (k) =>
      [...this.usageHistory.entries()]
        .filter(([name, h]) => (h.service || (h.service = this.model.pods.find((x) => x.name === name)?.service || null)) === service)
        .map(([pod, h]) => ({ pod, points: h.points.filter((p) => now - p.t <= range).map((p) => ({ t: p.t, v: p[k] })) }))
        .filter((x) => x.points.length);
    const cpu = pick('cpu');
    const since = Math.min(...cpu.map((x) => x.points[0].t), now);
    return { cpu, memory: pick('mem'), since, collectedSince: this.startedAt };
  }

  /** Restart counts per pod, saved on quit so the next recap can tell what restarted meanwhile. */
  restartSnapshot() {
    if (!this.synced.has('pods')) return null;
    return { at: this.now(), pods: Object.fromEntries(this.model.pods.map((p) => [p.name, { service: p.service, restarts: p.restarts }])) };
  }

  /** Normalized entries from the live tail / demo / fallback polling. */
  ingest(items) {
    for (const it of items) {
      if (it.kind === 'request') {
        if (it.service && this.svcToWorkload?.has(it.service)) it.service = this.svcToWorkload.get(it.service);
        if (!it.service && this.router) it.service = this.router(it.host, it.path);
        this.traffic.add(it);
        this.pendingTraffic.push(it);
      } else if (it.kind === 'log') {
        this.pendingLogs.push(it);
        if ((it.level === 'ERROR' || it.level === 'WARN') && DB_CONN_ERROR.test(it.text || '')) {
          this.dbConnIssues.push({ ts: it.ts, service: it.service || it.container || 'unknown', text: String(it.text).slice(0, 400) });
          if (this.dbConnIssues.length > 300) this.dbConnIssues.shift();
          this.dirty.add('database');
        }
        const res = this.errors.add(it);
        if (res?.isNewGroup) this._onNewErrorGroup(res.group);
      } else if (it.kind === 'cloudsql') {
        if (it.connection) this.sqlSeenInLogs.add(it.connection);
        const slow = /duration: ([\d.]+) ms/.exec(it.text || '');
        if (slow) {
          it.slow = true;
          it.durationMs = Number(slow[1]);
          if (it.level === 'INFO') it.level = 'WARN';
        }
        if (it.level === 'ERROR' || it.level === 'WARN') {
          this.database.errors.unshift(it);
          if (this.database.errors.length > 200) this.database.errors.length = 200;
          this.dirty.add('database');
        }
      }
    }
    if (this.pendingTraffic.length > 5000) this.pendingTraffic.splice(0, this.pendingTraffic.length - 5000);
    if (this.pendingLogs.length > 5000) this.pendingLogs.splice(0, this.pendingLogs.length - 5000);
  }

  setUptime(target, result) {
    const prev = this.uptime.get(target.id) || { ...target, history: [], failStreak: 0 };
    const history = [...prev.history, { t: result.at, state: result.state, ms: result.ms, status: result.status ?? null }].slice(-60);
    // 'offline': this computer couldn't reach anything, so it says nothing about the site.
    const failStreak = result.state === 'down' ? prev.failStreak + 1 : result.state === 'offline' ? prev.failStreak : 0;
    this.uptime.set(target.id, { ...target, ...result, history, failStreak, error: result.error || null });
    this.dirty.add('uptime');
    this.dirty.add('certificates');
    this.scheduleRebuild();
  }

  setUptimeTargets(targets) {
    const ids = new Set(targets.map((t) => t.id));
    for (const id of this.uptime.keys()) if (!ids.has(id)) this.uptime.delete(id);
    for (const t of targets) if (!this.uptime.has(t.id)) this.uptime.set(t.id, { ...t, state: 'pending', history: [], failStreak: 0 });
    this.dirty.add('uptime');
  }

  /** How much of BigQuery's free storage the Costs page's billing export uses (engine/costs.mjs), or null. */
  setBillingStorage(storage) {
    const key = storage ? `${storage.level}:${storage.bytes}:${storage.expirationDays}:${storage.keepDays}` : null;
    if (key === this._billingStorageKey) return;
    this._billingStorageKey = key;
    this.billingStorage = storage || null;
    this.scheduleRebuild();
  }

  /** The prepaid balances (OpenRouter, fal) below the amount set to alert at (engine/costs.mjs, lowCredits). */
  setBillingCredits(list) {
    const next = Array.isArray(list) ? list : [];
    const key = next.map((b) => `${b.id}:${Math.round(b.amount * 100)}:${b.below}:${b.daysLeft}`).join('|');
    if (key === this._billingCreditsKey) return;
    this._billingCreditsKey = key;
    this.billingCredits = next;
    this.scheduleRebuild();
  }

  setDnsInfo(map) {
    this.dnsInfo = map;
    this.dirty.add('certificates');
    this.scheduleRebuild();
  }

  setDatabase(patch) {
    this.database = { ...this.database, ...patch };
    this.dirty.add('database');
    this.scheduleRebuild();
  }

  setCloudRun(list) {
    this.cloudRun = list;
    this.dirty.add('cloudRun');
    this.scheduleRebuild();
  }

  setSentry(patch) {
    const before = new Set(this.sentry.issues.map((i) => i.id));
    this.sentry = { ...this.sentry, ...patch };
    if (patch.issues && this.sentry.primed) {
      for (const i of patch.issues) {
        if (!before.has(i.id) && this.now() - i.firstSeen < 30 * MIN) {
          const who = i.users ? `${i.users} user${i.users === 1 ? '' : 's'} hit it so far` : 'Users are hitting it in the browser';
          this.alerts.happen({ key: `sentry:${i.id}`, kind: 'frontend', severity: i.level === 'fatal' ? 'critical' : 'warning', title: `New error in the ${i.project} app: ${String(i.title).slice(0, 90)}`, detail: `${i.title}${i.culprit ? ` · in ${i.culprit}` : ''}`, impact: `${who}${i.unhandled ? ', and it crashes the page' : ''}.`, action: 'Open it for the stack trace, or view it in Sentry.', view: { to: 'errors', filter: { source: 'frontend' }, id: `sentry:${i.id}` } });
        } else if ((i.substatus === 'regressed' || i.substatus === 'escalating') && this.sentrySubstatus.get(i.id)?.substatus !== i.substatus) {
          // Only the change into regressed/escalating is news: Sentry keeps an
          // issue in that state for days, and it's polled every minute.
          const regressed = i.substatus === 'regressed';
          this.alerts.happen({ key: `sentry-${i.substatus}:${i.id}`, kind: 'frontend', severity: 'warning', title: regressed ? `A fixed error is back in the ${i.project} app` : `An error in the ${i.project} app is happening much more often`, detail: i.title, impact: regressed ? 'It was marked as fixed, so the fix was undone or didn’t cover every case.' : 'More users are hitting it than usual.', action: 'Open it to see when it came back and on which pages.', view: { to: 'errors', filter: { source: 'frontend' }, id: `sentry:${i.id}` } });
        }
      }
    }
    if (patch.issues) {
      // The first poll only primes this: what was already regressed when the app opened isn't new.
      // Merged, not replaced: an issue that drops off the polled page and comes back still
      // regressed isn't news either. Issues unseen for a week are forgotten.
      const now = this.now();
      for (const i of patch.issues) this.sentrySubstatus.set(i.id, { substatus: i.substatus, at: now });
      for (const [id, v] of this.sentrySubstatus) if (now - v.at > 7 * 24 * 60 * MIN) this.sentrySubstatus.delete(id);
      this.sentry.primed = true;
    }
    this.dirty.add('sentry');
    this.dirty.add('errors');
  }

  setCloudflare(patch) {
    this.cloudflare = { ...this.cloudflare, ...patch };
    this.dirty.add('cloudflare');
    this.scheduleRebuild();
  }

  setRecap(recap) {
    this.recap = recap;
    this.dirty.add('recap');
  }

  // ── derived ───────────────────────────────────────────────────────────────
  _setEvents(key, items) {
    const mine = items.map(summarizeEvent);
    const other = this.events.filter((e) => e._src !== key);
    this.events = [...other, ...mine.map((e) => ({ ...e, _src: key }))].sort((a, b) => b.at - a.at).slice(0, 600);
    this.dirty.add('events');
  }

  _trackRestarts(pods) {
    const now = this.now();
    const first = this.prevRestarts.size === 0;
    for (const p of pods) {
      const podName = p.metadata.name;
      for (const c of p.status?.containerStatuses || []) {
        const key = `${podName}/${c.name}`;
        const count = c.restartCount || 0;
        const prev = this.prevRestarts.get(key);
        this.prevRestarts.set(key, count);
        const lt = c.lastState?.terminated;
        const at = lt?.finishedAt ? Date.parse(lt.finishedAt) : now;
        if (prev === undefined) {
          // Seed the crash list with what happened before we connected (the last crash of each container).
          if (lt && now - at < PAST_MS) this._recordCrash(p, c, at, false);
          if (lt && now - at < 15 * MIN) this.restartLedger.set(key, [at]);
          continue;
        }
        if (count > prev) {
          const times = this.restartLedger.get(key) || [];
          times.push(at);
          this.restartLedger.set(key, times.filter((x) => now - x < 60 * MIN));
          this._recordCrash(p, c, at, !first);
        }
      }
    }
    for (const key of this.prevRestarts.keys()) {
      const pod = key.split('/')[0];
      if (!pods.some((p) => p.metadata.name === pod)) this.prevRestarts.delete(key);
    }
  }

  _recordCrash(pod, c, at, live) {
    const lt = c.lastState?.terminated || {};
    const service = workloadOf(pod);
    const id = `${pod.metadata.name}/${c.name}/${c.restartCount}`;
    if (this.crashes.some((x) => x.id === id)) return;
    const crash = {
      id,
      at,
      pod: pod.metadata.name,
      service,
      container: c.name,
      reason: lt.reason || 'Restarted',
      exitCode: lt.exitCode ?? null,
      message: lt.message || null,
      restarts: c.restartCount || 0,
    };
    this.crashes.unshift(crash);
    this.crashes = this.crashes.filter((x) => this.now() - x.at < PAST_MS).sort((a, b) => b.at - a.at).slice(0, 300);
    this.dirty.add('crashes');
    if (live) {
      // One alert per container, not per restart: a crash loop counts up on it
      // (and stays silenced once acknowledged) instead of notifying every restart.
      this.alerts.happen({
        key: `crash:${crash.pod}/${crash.container}`,
        kind: 'crash',
        service,
        severity: crash.reason === 'OOMKilled' ? 'critical' : 'warning',
        ...crashCopy(crash),
        at,
        view: { to: 'crashes', id: crash.id },
      });
    }
  }

  _onNewErrorGroup(g) {
    this.dirty.add('errors');
    const now = this.now();
    // Don't flood while a first run learns what's usual (the ErrorBook's
    // baseline), or right after connecting.
    if (this.initialPhase || this.errors.inBaseline?.(now)) return;
    if (!this.liveSince || now - this.liveSince < 3 * MIN) return;
    // The past week is still loading and may well have it: wait for it (see _releaseNewErrors).
    if (this.backfill.status === 'loading') {
      this.heldNewErrors.push({ g, at: now, first: g.firstEverSeen });
      return;
    }
    this._newErrorAlert(g);
  }

  _newErrorAlert(g) {
    this.alerts.happen({
      key: `newerr:${g.id}`,
      kind: 'errors',
      service: g.service,
      severity: 'warning',
      title: `New error in ${shortName(g.service)}: ${String(g.title).slice(0, 90)}`,
      detail: `${g.title}${g.context ? ` · in ${g.context}` : ''}`,
      impact: 'An error type this service has never logged before, so something just changed: a deploy, a new input or a dependency.',
      action: 'Open it for the stack trace, the pods involved and how often it happens.',
      view: { to: 'errors', id: g.id },
    });
  }

  _onAlertOpen(alert, meta) {
    this.dirty.add('alerts');
    // Part of a problem someone silenced (AlertBook.silence): it shows in the app, and that's all.
    if (meta?.silenced) return;
    if (this.initialPhase) {
      this.initialQueue.push(alert);
      return;
    }
    // One incident usually opens several alerts at once (pod crash-looping +
    // service degraded + OOM). Wait a moment and send one notification per service;
    // the others ride along as `related` so the siren covers every one of them.
    const key = alert.service || alert.key;
    const bucket = this.notifyBuckets.get(key) || { alerts: [], escalated: false, timer: null };
    if (!bucket.alerts.includes(alert)) bucket.alerts.push(alert);
    bucket.escalated ||= !!meta?.escalated;
    if (!bucket.timer) bucket.timer = setTimeout(() => this._sendBucket(key), 2500);
    this.notifyBuckets.set(key, bucket);
  }

  _sendBucket(key) {
    const bucket = this.notifyBuckets.get(key);
    this.notifyBuckets.delete(key);
    if (!bucket) return;
    // An alert whose condition went away meanwhile (it's on hold, clearing) waits:
    // it's announced only if it comes back.
    const open = bucket.alerts.filter((a) => this.alerts.active.get(a.key) === a);
    for (const a of open) if (a.clearingSince != null) this.unsent.add(a);
    const due = open.filter((a) => a.clearingSince == null);
    const muted = (a) => this.alerts.isMuted(a);
    const quiet = (a) => muted(a) || !!a.acked; // never the headline if there's something louder
    // Silenced or muted meanwhile, every one of them: nothing to announce.
    if (!due.length || due.every(quiet)) return;
    const order = { critical: 3, warning: 2, info: 1 };
    const [lead, ...related] = due.sort((a, b) => quiet(a) - quiet(b) || order[b.severity] - order[a.severity] || (b.kind === 'crash') - (a.kind === 'crash'));
    const extra = related.length;
    this.notify?.(extra ? { ...lead, detail: `${lead.detail || ''}${lead.detail ? ' · ' : ''}+${extra} related alert${extra > 1 ? 's' : ''}` } : lead, { escalated: bucket.escalated, muted: due.every(muted), related });
  }

  /** New alerts held back by _sendBucket: sent once their condition is back, dropped once they resolve. */
  _sendUnsent() {
    for (const a of this.unsent) {
      if (this.alerts.active.get(a.key) !== a) this.unsent.delete(a);
      else if (a.clearingSince == null) {
        this.unsent.delete(a);
        this._onAlertOpen(a, { escalated: false, muted: this.alerts.isMuted(a) });
      }
    }
  }

  _endInitialPhase() {
    this.initialPhase = false;
    // What someone silenced (a restart keeps that: AlertBook.loadState) is no news, and muted problems aren't either.
    const quiet = (a) => a.severity === 'info' || a.acked || a.silenced;
    const open = [...this.alerts.active.values()].filter((a) => !quiet(a) && a.clearingSince == null && !this.alerts.isMuted(a));
    // Ones that went away during startup are announced if they come back.
    for (const a of this.alerts.active.values()) if (!quiet(a) && a.clearingSince != null) this.unsent.add(a);
    if (open.length) {
      const crit = open.filter((a) => a.severity === 'critical').length;
      this.notify?.(
        {
          id: 'startup-summary',
          severity: crit ? 'critical' : 'warning',
          title: `${open.length} active problem${open.length > 1 ? 's' : ''}`,
          detail: open.slice(0, 3).map((a) => a.title).join(' · ') + (open.length > 3 ? ` · +${open.length - 3} more` : ''),
          view: { to: 'crashes' },
          summary: true,
        },
        { escalated: false, muted: false, related: open },
      );
    }
    this.initialQueue = [];
  }

  scheduleRebuild() {
    if (this.rebuildTimer) return;
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      this.rebuild();
    }, 250);
  }

  /** Errors/min per service now (last 2 min) and usually (the 30 min before that). */
  errorRates() {
    const out = {};
    const services = new Set([...this.errors.groups.values()].map((g) => g.service));
    const now = this.now();
    // A sliding window: whole calendar minutes would average in the minute that
    // just started (nearly empty), so a steady rate would dip and flap.
    const sliding = typeof this.errors.rate === 'function';
    const perMin = (s, minutes) => (sliding ? this.errors.rate(s, minutes * MIN, now) : this.errors.ratePerMinute(s, minutes, now));
    for (const s of services) {
      const nowRate = perMin(s, 2);
      const base = (perMin(s, 32) * 32 - nowRate * 2) / 30;
      out[s] = { now: nowRate, baseline: Math.max(0, base) };
    }
    return out;
  }

  /**
   * A workload scaling up from zero (KEDA/HPA waking it, or someone scaling it
   * back up) has no ready pod until its first one starts. That's a start, not an
   * outage: it shows as deploying for up to 10 minutes, unless a pod is broken.
   * Runs before _markStopped, which moves lastDesired on.
   */
  _markStarting(now) {
    for (const s of this.model.services) {
      if (s.desired === 0 || s.ready > 0) {
        this.startingAt.delete(s.name);
        continue;
      }
      if (this.lastDesired.get(s.name) === 0) this.startingAt.set(s.name, now);
      if (s.health !== 'down') continue;
      const pods = this.model.pods.filter((p) => p.service === s.name && !p.terminal);
      if (pods.some((p) => p.state === 'bad')) continue;
      const at = this.startingAt.get(s.name);
      // Seen scaling up: 10 minutes to get a pod ready. Opened the app mid-start:
      // an autoscaler that goes down to 0, and nothing but brand-new pods.
      const starting = at != null ? now - at < 10 * MIN : s.scaling?.min === 0 && pods.length > 0 && pods.every((p) => p.createdAt != null && now - p.createdAt < 5 * MIN);
      if (!starting) continue;
      const n = `${s.desired} pod${s.desired === 1 ? '' : 's'}`;
      s.health = 'deploying';
      s.reasons = [`Starting from zero: ${s.scaling ? `the autoscaler asked for ${n}` : `scaled up to ${n}`}`, ...s.reasons.filter((r) => !/^0 of \d+ pods ready$/.test(r))];
    }
  }

  /**
   * A workload with no autoscaler that drops to 0 replicas was stopped by hand
   * (kubectl scale --replicas=0). That's an outage, not "idle". Workloads that an
   * HPA/KEDA scales to zero, or that were already at 0 long before the app
   * started, stay idle.
   */
  _markStopped(now) {
    for (const s of this.model.services) {
      const prev = this.lastDesired.get(s.name);
      this.lastDesired.set(s.name, s.desired);
      if (s.desired > 0 || s.scaling) {
        this.stoppedAt.delete(s.name);
        continue;
      }
      if (!this.stoppedAt.has(s.name)) {
        if (prev > 0) this.stoppedAt.set(s.name, now);
        else {
          // Opened the app after it was stopped: Kubernetes keeps the scale-down event for about an hour.
          const ev = this.events.find((e) => e.kind === 'Deployment' && e.name === s.name && e.reason === 'ScalingReplicaSet' && /Scaled down replica set \S+ to 0\b/.test(e.message) && now - e.at < 60 * MIN);
          if (ev) this.stoppedAt.set(s.name, ev.at);
        }
      }
      const at = this.stoppedAt.get(s.name);
      if (at) {
        s.health = 'down';
        s.reasons = [`Stopped: scaled to 0 replicas ${Math.max(1, Math.round((now - at) / MIN))} min ago (no autoscaler manages it)`];
      }
    }
  }

  /** Cloud SQL connection names the pods are set up to use → services using each. */
  sqlInstancesInUse() {
    const byPod = new Map((this.model?.pods || []).map((x) => [x.name, x.service]));
    const out = new Map();
    for (const pod of this.raw.pods || []) {
      for (const id of pod.spec?.sqlInstances || []) {
        if (!out.has(id)) out.set(id, new Set());
        out.get(id).add(byPod.get(pod.metadata?.name) || pod.metadata?.name);
      }
    }
    return out;
  }

  /** Cloud SQL state + what the apps and Postgres logs say, for the UI and alert rules. */
  databaseView(now = this.now()) {
    const recent = this.dbConnIssues.filter((x) => now - x.ts <= 15 * MIN);
    const last2 = recent.filter((x) => now - x.ts <= 2 * MIN);
    const services = [...new Set(last2.map((x) => x.service))];
    const unreachable = last2.length >= 10 || (last2.length >= 5 && services.length >= 2);
    const errs = this.database.errors;
    const hour = errs.filter((e) => now - e.ts <= 60 * MIN);
    return {
      ...this.database,
      inUse: [...this.sqlInstancesInUse()].map(([id, svcs]) => ({ id, services: [...svcs].sort() })),
      reachability: {
        unreachable,
        last2m: last2.length,
        last15m: recent.length,
        services: [...new Set(recent.map((x) => x.service))],
        latest: recent.slice(-5).reverse(),
      },
      stats: {
        errors1h: hour.filter((e) => !e.slow && e.level === 'ERROR').length,
        warnings1h: hour.filter((e) => !e.slow && e.level === 'WARN').length,
        slow1h: hour.filter((e) => e.slow).length,
        deadlocks1h: hour.filter((e) => /deadlock detected/i.test(e.text || '')).length,
        connLimit1h: hour.filter((e) => /too many clients|remaining connection slots/i.test(e.text || '')).length,
      },
    };
  }

  /** Traffic history is rebuilt from the live stream; cached so the 1 s tick stays cheap. */
  trafficHistory(now = this.now()) {
    if (!this._hist || now - this._histAt > 10_000 || Math.floor(now / MIN) !== Math.floor(this._histAt / MIN)) {
      this._hist = this.traffic.history(now);
      this._histAt = now;
    }
    return this._hist;
  }

  rebuild() {
    const now = this.now();
    this.model = buildModel(this.raw, { podMetrics: this.podMetrics, nodeMetrics: this.nodeMetrics, restartLedger: this.restartLedger, now });
    this._markStarting(now);
    this._markStopped(now);
    this.router = makeRouter(this.model.routes);
    // The load balancer names the Kubernetes Service; the app shows workloads.
    this.svcToWorkload = new Map(this.model.routes.filter((r) => r.service && r.workload).map((r) => [r.service, r.workload]));
    const trafficSnap = this.traffic.snapshot(now);
    this.trafficSnap = trafficSnap;
    const conditions = evaluateConditions({
      model: this.model,
      traffic: trafficSnap,
      uptime: [...this.uptime.values()],
      database: this.databaseView(now),
      cloudRun: this.cloudRun,
      cloudflare: this.cloudflare,
      errorRates: this.errorRates(),
      dnsInfo: this.dnsInfo,
      billingStorage: this.billingStorage,
      billingCredits: this.billingCredits,
      now,
    });
    // Offline, what couldn't be read isn't news: no alert opens or closes until it's back.
    if (!this.offline) {
      this.alerts.reconcile(conditions);
      this._sendUnsent();
    }
    for (const k of ['services', 'pods', 'nodes', 'scaling', 'jobs', 'certificates', 'ingress', 'health', 'alerts', 'cluster']) this.dirty.add(k);
  }

  health() {
    const svc = this.model.services;
    const down = svc.filter((s) => s.health === 'down');
    const degraded = svc.filter((s) => s.health === 'degraded');
    const deploying = svc.filter((s) => s.health === 'deploying');
    const uptimeDown = [...this.uptime.values()].filter((u) => u.state === 'down' && u.failStreak >= 2);
    const dbView = this.databaseView();
    const dbDown = [...this.database.instances.filter((d) => d.down), ...(dbView.reachability.unreachable && !this.database.instances.some((d) => d.down) ? [{ name: 'Database' }] : [])];
    const k8s = this.sources.kubernetes?.status;
    let overall = 'operational';
    let headline = 'All systems operational';
    if (this.offline) {
      overall = 'offline';
      headline = 'You’re offline';
    } else if (!this.synced.has('pods') && this.mode === 'live') {
      overall = k8s === 'error' || k8s === 'forbidden' ? 'unknown' : 'connecting';
      headline = overall === 'unknown' ? "Can't reach the cluster" : 'Connecting…';
    } else if (down.length || dbDown.length || uptimeDown.some((u) => u.group === 'backend')) {
      overall = 'outage';
      const names = [...down.map((s) => s.short), ...dbDown.map((d) => d.name), ...uptimeDown.map((u) => u.name)];
      headline = names.length === 1 ? `${names[0]} is down` : `${names.length} things are down`;
    } else if (degraded.length || uptimeDown.length || this.alerts.summary().counts.critical) {
      overall = 'degraded';
      const n = degraded.length + uptimeDown.length;
      headline = n === 1 ? `${degraded[0]?.short || uptimeDown[0]?.name} is degraded` : n ? `${n} services degraded` : 'Active incidents';
    } else if (deploying.length) {
      headline = `All systems operational · ${deploying.length} rolling out`;
    }
    // Finished pods (evicted, preempted, done Job runs) aren't running and never will be again.
    const pods = this.model.pods.filter((p) => p.state !== 'done' && !p.terminal);
    return {
      overall,
      headline,
      // While offline: since when (what's shown is what was last seen, and alerts wait).
      offlineSince: this.offline?.since ?? null,
      counts: {
        services: svc.length,
        healthy: svc.filter((s) => s.health === 'healthy' || s.health === 'idle').length,
        degraded: degraded.length,
        down: down.length,
        deploying: deploying.length,
        pods: pods.length,
        podsReady: pods.filter((p) => p.ready).length,
        restarts1h: [...this.restartLedger.values()].reduce((a, times) => a + times.filter((x) => this.now() - x < 60 * MIN).length, 0),
        nodes: this.model.nodes.length,
        nodesReady: this.model.nodes.filter((n) => n.ready).length,
      },
    };
  }

  // ── outputs ───────────────────────────────────────────────────────────────
  section(name) {
    const now = this.now();
    switch (name) {
      case 'session':
        return this.session;
      case 'sources':
        // Offline, no source can be read: they're shown as offline (gray), not failing (red).
        return this.offline ? Object.fromEntries(Object.entries(this.sources).map(([k, v]) => [k, v.status === 'off' ? v : { ...v, status: 'offline', message: 'This computer is offline. It reconnects by itself once the connection is back.' }])) : this.sources;
      case 'health':
        return this.health();
      case 'services': {
        const snap = this.trafficSnap || this.traffic.snapshot(now);
        const live = new Map(snap.byService.map((s) => [s.service, s]));
        const liveOk = this.sources.live?.status === 'streaming' || this.mode === 'demo';
        const hist = this.trafficHistory(now);
        const deploys = this.recentDeploys(now);
        return this.model.services.map((s) => {
          const t = live.get(s.name);
          const errSpark = this.errors.perMinute(s.name, hist.series.length, now);
          return {
            ...s,
            rpm: liveOk ? (t ? t.rpm : 0) : null,
            err5xxRate: liveOk ? (t && t.total ? t.err5xx / t.total : 0) : null,
            p95: t?.p95 ?? null,
            errorsPerMin: this.errors.ratePerMinute(s.name, 5, now),
            requestSpark: hist.spark[s.name]?.length > 1 ? hist.spark[s.name] : null,
            errorSpark: errSpark.length > 1 ? errSpark : null,
            cpuSpark: this.cpuSpark(s.name),
            memSpark: this.memSpark(s.name),
            memEta: this.memEta(s.name, now),
            deploys: deploys.get(s.name) || null,
          };
        });
      }
      case 'pods':
        return this.model.pods;
      case 'nodes':
        return this.model.nodes;
      case 'scaling':
        return this.model.scaling;
      case 'jobs':
        return this.model.jobs;
      case 'certificates': {
        const uptime = [...this.uptime.values()];
        return this.model.certificates.map((c) => ({ ...c, ...certificateImpact(c, uptime, this.dnsInfo) }));
      }
      case 'ingress':
        return this.model.ingress;
      case 'cluster':
        return { ...(this.session.cluster || {}), nodeCount: this.model.nodes.length, metricsAt: this.metricsAt };
      case 'events': {
        // Live ones (Kubernetes keeps about an hour), then older ones from the logs.
        const live = this.events.slice(0, 400).map(({ _src, ...e }) => e);
        const ids = new Set(live.map((e) => e.id));
        const past = [...this.pastEvents.values()].filter((e) => !ids.has(e.id) && now - e.at < PAST_MS);
        return [...live, ...past]
          .sort((a, b) => b.at - a.at)
          .slice(0, 1000)
          .map((e) => ({ ...e, service: this._serviceForObject(e.kind, e.name) }));
      }
      case 'crashes': {
        // From the pods' status (live, with exit codes), then the ones only the logs know about.
        const past = this.pastCrashes.filter((c) => now - c.at < PAST_MS && !crashCovered(c, this.crashes));
        return past.length ? [...this.crashes, ...past].sort((a, b) => b.at - a.at).slice(0, 300) : this.crashes;
      }
      case 'errors':
        return {
          backend: this.errors.summary(now),
          frontend: this.sentry.issues.map((i) => ({ ...i, id: `sentry:${i.id}`, source: 'frontend', service: i.project, isNew: now - i.firstSeen < 24 * 60 * MIN, active: now - i.lastSeen < 60 * MIN })),
          // What the backend counts cover: since the app started, or further back once the past week is in.
          since: Math.min(this.startedAt, this.backfill.since ?? Infinity),
        };
      case 'alerts':
        return this._alertsView();
      case 'backfill':
        return this.backfill;
      case 'logsBefore':
        return this.logsBefore;
      case 'traffic': {
        const snap = this.trafficSnap || this.traffic.snapshot(now);
        const hist = this.trafficHistory(now);
        return { ...snap, history: hist.series, historySince: hist.since };
      }
      case 'uptime':
        return [...this.uptime.values()];
      case 'database':
        return this.databaseView(now);
      case 'cloudRun': {
        // Request stats for Cloud Run come from its request logs in the live stream.
        const snap = this.trafficSnap || this.traffic.snapshot(now);
        const hist = this.trafficHistory(now);
        const liveOk = this.sources.live?.status === 'streaming' || this.mode === 'demo';
        return this.cloudRun.map((r) => {
          const t = snap.byService.find((x) => x.service === r.name);
          return { ...r, rpm: liveOk ? (t ? t.rpm : 0) : null, errRate: liveOk ? (t && t.total ? t.err5xx / t.total : 0) : null, p95: t?.p95 ?? null, spark: hist.spark[r.name] || [] };
        });
      }
      case 'sentry':
        return { status: this.sentry.status, message: this.sentry.message, projects: this.sentry.projects, org: this.sentry.org };
      case 'cloudflare':
        return this.cloudflare;
      case 'recap':
        return this.recap;
      default:
        return null;
    }
  }

  _serviceForObject(kind, name) {
    if (!name) return null;
    if (kind === 'Deployment' || kind === 'StatefulSet' || kind === 'HorizontalPodAutoscaler') return name.replace(/-hpa$/, '');
    if (kind === 'Pod') return this.model.pods.find((p) => p.name === name)?.service || name.replace(/-[a-z0-9]{8,10}-[a-z0-9]{5}$/, '');
    if (kind === 'ReplicaSet') return name.replace(/-[a-z0-9]{8,10}$/, '');
    return null;
  }

  /** Every second: refresh traffic stats and push any sections that changed. */
  tick() {
    const now = this.now();
    this.trafficSnap = this.traffic.snapshot(now);
    this.dirty.add('traffic');
    if (this.errors.version !== this.lastErrorsVersion) {
      this.lastErrorsVersion = this.errors.version;
      this.dirty.add('errors');
    }
    if (this.alerts.version !== this.lastAlertsVersion) {
      this.lastAlertsVersion = this.alerts.version;
      this.dirty.add('alerts');
      this.dirty.add('health');
    }
    // Re-evaluate time-based conditions (5xx rate, error spikes) every 5 s.
    if (!this._lastEval || now - this._lastEval > 5000) {
      this._lastEval = now;
      this.scheduleRebuild();
      this.dirty.add('database');
      if (this.cloudRun.length) this.dirty.add('cloudRun');
      this.errors.prune(now);
      if (this.heldNewErrors.length) this._releaseNewErrors(false);
    }
    this.flushSections();
  }

  flushSections() {
    if (!this.dirty.size) return;
    const sections = {};
    for (const name of this.dirty) sections[name] = this.section(name);
    this.dirty.clear();
    this.emit('state', sections);
  }

  flushStreams() {
    if (!this.pendingTraffic.length && !this.pendingLogs.length) return;
    const traffic = this.pendingTraffic;
    const logs = this.pendingLogs;
    this.pendingTraffic = [];
    this.pendingLogs = [];
    this.emit('stream', { traffic, logs });
  }

  fullState() {
    const names = ['session', 'sources', 'health', 'services', 'pods', 'nodes', 'scaling', 'jobs', 'certificates', 'ingress', 'cluster', 'events', 'crashes', 'errors', 'alerts', 'traffic', 'uptime', 'database', 'cloudRun', 'sentry', 'cloudflare', 'recap', 'backfill', 'logsBefore'];
    return Object.fromEntries(names.map((n) => [n, this.section(n)]));
  }

  knownErrors() {
    return this.errors.known;
  }

  // ── The past week, from the logs (see backfill.mjs) ─────────────────────────
  /** How the past-week load is going: { status: 'loading'|'done'|'error', since, until, notes, error }. */
  setBackfill(patch) {
    const was = this.backfill.status;
    this.backfill = { ...this.backfill, ...patch };
    const loading = this.backfill.status === 'loading';
    // Entries near the start can come both ways: remember their ids until the load is over.
    if (loading) this.errors.holdIds?.(Infinity);
    else if (was === 'loading') {
      this.errors.holdIds?.(this.now() + 2 * MIN);
      this._releaseNewErrors(true);
    }
    this.dirty.add('backfill');
    this.dirty.add('errors'); // what the counts cover changed
  }

  /**
   * One slice of the past week: error lines, Kubernetes events, the crashes in them and the
   * incidents they add up to. Error types become known; nothing here notifies or opens an alert.
   */
  addPast(slice) {
    const { errors = [], events = [], crashes = [], incidents = [] } = slice;
    // A slice that's already here (a load tried again feeds what it had first) isn't counted twice.
    if (slice.from != null && slice.until != null) {
      const key = `${slice.from}-${slice.until}`;
      if (this.pastSlices.has(key)) return;
      this.pastSlices.add(key);
    }
    const now = this.now();
    if (errors.length && this.errors.addPast(errors, now)) this.dirty.add('errors');
    if (events.length) {
      for (const e of events) {
        const had = this.pastEvents.get(e.id);
        this.pastEvents.set(e.id, had ? mergeEventRows(had, e) : e);
      }
      if (this.pastEvents.size > 5000) this.pastEvents = new Map([...this.pastEvents].sort((a, b) => b[1].at - a[1].at).slice(0, 5000));
      this.dirty.add('events');
    }
    if (crashes.length) {
      this.pastCrashes = mergeCrashRecords(this.pastCrashes, crashes);
      this.dirty.add('crashes');
    }
    if (incidents.length) {
      // Recent issues, marked as from the logs: closed, never counted as open, never saved.
      this.alerts.loadHistory(incidents.map((i) => pastIssue(i, this.svcToWorkload)));
      this.dirty.add('alerts');
    }
  }

  /** The Logs page's lines from just before the live stream: { since, until, lines (oldest first), capped }. */
  setLogsBefore(block) {
    this.logsBefore = block;
    this.dirty.add('logsBefore');
  }

  /** Alert history worth saving for the next run: issues rebuilt from the logs are rebuilt again then. */
  historyToSave() {
    return this.alerts.historyToSave().filter((a) => !a.fromLogs);
  }

  /** The alerts section, without issues from the logs that an alert already covers (same problem, same time). */
  _alertsView() {
    const s = this.alerts.summary();
    if (!s.history.some((a) => a.fromLogs)) return s;
    if (this._alertsViewOf === s) return this._alertsViewOut;
    const now = this.now();
    const alerts = s.history.filter((a) => !a.fromLogs);
    this._alertsViewOf = s;
    this._alertsViewOut = { ...s, history: s.history.filter((a) => !a.fromLogs || !alerts.some((b) => sameProblem(a, b, now))) };
    return this._alertsViewOut;
  }

  /**
   * "New error" alerts held while the past week loaded: an error type found in it after all
   * (seen before the live occurrence) isn't new. The rest are sent once the load is over,
   * or after 5 minutes whatever happens.
   */
  _releaseNewErrors(all) {
    const now = this.now();
    const held = this.heldNewErrors;
    this.heldNewErrors = [];
    for (const h of held) {
      if (!all && now - h.at < 5 * MIN) {
        this.heldNewErrors.push(h);
        continue;
      }
      const known = this.errors.known[h.g.id];
      if (known != null && h.first != null && known < h.first) continue;
      if (this.errors.groups.get(h.g.id) !== h.g) continue;
      this._newErrorAlert(h.g);
    }
  }

  shortName(n) {
    return shortName(n);
  }
}

export { slim };
