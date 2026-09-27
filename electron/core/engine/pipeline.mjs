// The pipeline holds everything the app knows, derives the model + alerts, and
// emits compact sections to the UI. Both the live connector and demo mode feed
// it, so the UI and alert rules behave identically in both. Pure JS.
import { buildModel, makeRouter, slim, summarizeEvent, workloadOf, cpuMilli, bytes } from './model.mjs';
import { ErrorBook } from './errors.mjs';
import { AlertBook, evaluateConditions, certificateImpact } from './alerts.mjs';
import { TrafficStats } from './traffic.mjs';
import { shortName, DB_CONN_ERROR } from './log-parse.mjs';

const MIN = 60_000;
const K8S_KEYS = ['pods', 'deployments', 'statefulsets', 'services', 'hpas', 'scaledobjects', 'nodes', 'jobs', 'cronjobs', 'ingresses', 'certificates', 'pdbs'];

export class Pipeline {
  /**
   * @param {{namespace:string, emit:(type:string, payload:any)=>void, notify?:(alert:object, meta:object)=>void, knownErrors?:Record<string,number>, now?:()=>number, mode:'live'|'demo'}} o
   */
  constructor({ namespace, emit, notify, knownErrors = {}, now = () => Date.now(), mode = 'live', graceMs = 45_000 }) {
    this.graceMs = graceMs;
    this.namespace = namespace;
    this.emit = emit;
    this.notify = notify;
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
    this.prevRestarts = new Map();
    this.crashes = [];
    this.events = [];
    this.firstRun = Object.keys(knownErrors).length === 0;
    this.errors = new ErrorBook({ known: knownErrors });
    this.traffic = new TrafficStats({ now: now() });
    this.uptime = new Map();
    this.database = { instances: [], operations: [], errors: [], status: 'off', message: null };
    this.sqlSeenInLogs = new Set(); // Cloud SQL connection names seen in Postgres logs
    this.dbConnIssues = []; // app log lines that look like "can't reach the database"
    this.usageHistory = new Map();
    this.dnsInfo = null; // domain → { none, cloudflare } for certificates Google couldn't issue // pod → { service, points: [{ t, cpu, mem }] } from metrics-server
    this.cloudRun = [];
    this.sentry = { status: 'off', issues: [], projects: [], message: null };
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
    this.scheduleRebuild();
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
    const failStreak = result.state === 'down' ? prev.failStreak + 1 : 0;
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
          this.alerts.happen({ key: `sentry:${i.id}`, kind: 'frontend', severity: i.level === 'fatal' ? 'critical' : 'warning', title: `New frontend error in ${i.project}`, detail: i.title, view: { to: 'errors', filter: { source: 'frontend' }, id: `sentry:${i.id}` } });
        } else if (i.substatus === 'regressed' || i.substatus === 'escalating') {
          this.alerts.happen({ key: `sentry-${i.substatus}:${i.id}`, kind: 'frontend', severity: 'warning', title: `Frontend error ${i.substatus} in ${i.project}`, detail: i.title, view: { to: 'errors', filter: { source: 'frontend' }, id: `sentry:${i.id}` } });
        }
      }
    }
    if (patch.issues) this.sentry.primed = true;
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
          // Seed the crash list with what happened before we connected (last 24h).
          if (lt && now - at < 24 * 60 * MIN) this._recordCrash(p, c, at, false);
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
    this.crashes = this.crashes.filter((x) => this.now() - x.at < 24 * 60 * MIN).sort((a, b) => b.at - a.at).slice(0, 300);
    this.dirty.add('crashes');
    if (live) {
      const oom = crash.reason === 'OOMKilled';
      this.alerts.happen({
        key: `crash:${crash.id}`,
        kind: 'crash',
        service,
        severity: oom ? 'critical' : 'warning',
        title: oom ? `${service} ran out of memory` : `${service} restarted`,
        detail: `${crash.pod} · ${crash.reason}${crash.exitCode != null ? ` (exit ${crash.exitCode})` : ''} · ${crash.restarts} restart${crash.restarts === 1 ? '' : 's'} so far`,
        at,
        view: { to: 'crashes', id: crash.id },
      });
    }
  }

  _onNewErrorGroup(g) {
    this.dirty.add('errors');
    // Don't flood on the very first run or right after connecting.
    if (this.firstRun || this.initialPhase) return;
    if (!this.liveSince || this.now() - this.liveSince < 3 * MIN) return;
    this.alerts.happen({
      key: `newerr:${g.id}`,
      kind: 'errors',
      service: g.service,
      severity: 'warning',
      title: `New error in ${g.service}`,
      detail: g.title,
      view: { to: 'errors', id: g.id },
    });
  }

  _onAlertOpen(alert, meta) {
    this.dirty.add('alerts');
    if (this.initialPhase) {
      this.initialQueue.push(alert);
      return;
    }
    // One incident usually opens several alerts at once (pod crash-looping +
    // service degraded + OOM). Wait a moment and send one notification per service.
    const key = alert.service || alert.key;
    const bucket = this.notifyBuckets.get(key) || { alerts: [], meta, timer: null };
    bucket.alerts.push(alert);
    bucket.meta = { ...bucket.meta, muted: bucket.meta.muted && meta.muted };
    if (!bucket.timer) {
      bucket.timer = setTimeout(() => {
        this.notifyBuckets.delete(key);
        const order = { critical: 3, warning: 2, info: 1 };
        const sorted = bucket.alerts.sort((a, b) => order[b.severity] - order[a.severity] || (a.kind === 'crash' ? -1 : 0));
        const lead = sorted[0];
        const extra = sorted.length - 1;
        this.notify?.(extra ? { ...lead, detail: `${lead.detail || ''}${lead.detail ? ' · ' : ''}+${extra} related alert${extra > 1 ? 's' : ''}` } : lead, bucket.meta);
      }, 2500);
    }
    this.notifyBuckets.set(key, bucket);
  }

  _endInitialPhase() {
    this.initialPhase = false;
    const open = [...this.alerts.active.values()].filter((a) => a.severity !== 'info');
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
        { escalated: false, muted: false },
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

  errorRates() {
    const out = {};
    const services = new Set([...this.errors.groups.values()].map((g) => g.service));
    const now = this.now();
    for (const s of services) {
      const nowRate = this.errors.ratePerMinute(s, 2, now);
      const base = (this.errors.ratePerMinute(s, 32, now) * 32 - nowRate * 2) / 30;
      out[s] = { now: nowRate, baseline: Math.max(0, base) };
    }
    return out;
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
    });
    this.alerts.reconcile(conditions);
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
    if (!this.synced.has('pods') && this.mode === 'live') {
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
    const pods = this.model.pods.filter((p) => p.state !== 'done');
    return {
      overall,
      headline,
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
        return this.sources;
      case 'health':
        return this.health();
      case 'services': {
        const snap = this.trafficSnap || this.traffic.snapshot(now);
        const live = new Map(snap.byService.map((s) => [s.service, s]));
        const liveOk = this.sources.live?.status === 'streaming' || this.mode === 'demo';
        const hist = this.trafficHistory(now);
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
      case 'events':
        return this.events.slice(0, 400).map(({ _src, ...e }) => ({ ...e, service: this._serviceForObject(e.kind, e.name) }));
      case 'crashes':
        return this.crashes;
      case 'errors':
        return {
          backend: this.errors.summary(now),
          frontend: this.sentry.issues.map((i) => ({ ...i, id: `sentry:${i.id}`, source: 'frontend', service: i.project, isNew: now - i.firstSeen < 24 * 60 * MIN, active: now - i.lastSeen < 60 * MIN })),
        };
      case 'alerts':
        return this.alerts.summary();
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
    const names = ['session', 'sources', 'health', 'services', 'pods', 'nodes', 'scaling', 'jobs', 'certificates', 'ingress', 'cluster', 'events', 'crashes', 'errors', 'alerts', 'traffic', 'uptime', 'database', 'cloudRun', 'sentry', 'cloudflare', 'recap'];
    return Object.fromEntries(names.map((n) => [n, this.section(n)]));
  }

  knownErrors() {
    return this.errors.known;
  }

  shortName(n) {
    return shortName(n);
  }
}

export { slim };
