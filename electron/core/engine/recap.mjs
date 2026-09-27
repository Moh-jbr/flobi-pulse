// "While you were away": rebuilds what happened between two moments from free
// sources only: Cloud Logging history (30 days), Kubernetes pod restart counts,
// the Cloud SQL Admin API, Sentry and Cloudflare. Cloud Monitoring is not used
// (it's billed per read), so failed requests are counts, not percentages.
// Every source is optional; a failing one becomes a note.
import { normalizeEntry } from './normalize.mjs';
import { ErrorBook } from './errors.mjs';
import { bucketPeriod } from './series.mjs';
import { shortName, DB_CONN_ERROR } from './log-parse.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms) => new Date(ms).toISOString();

export function serviceFromObject(kind, name) {
  if (!name) return null;
  if (kind === 'Pod') return name.replace(/-[a-z0-9]{8,10}-[a-z0-9]{5}$/, '').replace(/-\d+$/, '');
  if (kind === 'ReplicaSet') return name.replace(/-[a-z0-9]{8,10}$/, '');
  if (kind === 'HorizontalPodAutoscaler') return name.replace(/-hpa$/, '').replace(/^keda-hpa-/, '');
  return name;
}

export function fmtDuration(ms) {
  const m = Math.max(1, Math.round(ms / MIN));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h < 24) return r ? `${h}h ${r}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** Groups timestamped points ({t}) that are within `gapMs` of each other. */
export function clusters(points, gapMs) {
  const out = [];
  let cur = null;
  for (const p of [...points].sort((a, b) => a.t - b.t)) {
    if (cur && p.t - cur.end <= gapMs) {
      cur.end = p.t;
      cur.points.push(p);
    } else {
      cur = { start: p.t, end: p.t, points: [p] };
      out.push(cur);
    }
  }
  return out;
}

/** Counts timestamps into period buckets → [{ t: bucket end, v }] oldest first. */
export function bucketize(times, period, since, until) {
  const ms = period * 1000;
  const first = Math.floor(since / ms);
  const last = Math.floor((until - 1) / ms);
  const counts = new Map();
  for (const t of times) {
    const b = Math.floor(t / ms);
    if (b >= first && b <= last) counts.set(b, (counts.get(b) || 0) + 1);
  }
  const out = [];
  for (let b = first; b <= last; b++) out.push({ t: (b + 1) * ms, v: counts.get(b) || 0 });
  return out;
}

const LB_DETAILS = {
  failed_to_connect_to_backend: "the load balancer couldn't reach the pods",
  backend_timeout: 'the service took too long to answer',
  backend_connection_closed_before_data_sent_to_client: 'the service closed the connection',
  backend_connection_closed_after_partial_response_sent: 'the service closed the connection mid-response',
  failed_to_pick_backend: 'no healthy pods to send requests to',
  response_sent_by_backend: 'the service itself answered with an error',
};

function terminationReason(lt) {
  if (!lt?.reason) return null;
  if (/OOMKilled/i.test(lt.reason)) return 'out of memory';
  if (lt.reason === 'Error') return lt.exitCode != null ? `crashed, exit code ${lt.exitCode}` : 'crashed';
  if (lt.reason === 'Completed') return null;
  return lt.reason;
}

/** Merge [t, t+period) buckets that are within `gap` of each other into episodes. */
export function episodes(points, period, isHot, gapBuckets = 1) {
  const out = [];
  let cur = null;
  for (const p of points) {
    if (!isHot(p)) continue;
    const start = p.t - period * 1000;
    if (cur && start - cur.end <= gapBuckets * period * 1000) {
      cur.end = p.t;
      cur.points.push(p);
    } else {
      cur = { start, end: p.t, points: [p] };
      out.push(cur);
    }
  }
  return out;
}

const EVENT_TITLES = {
  FailedScheduling: "Pods couldn't be scheduled",
  Unhealthy: 'Health checks failing',
  Evicted: 'Pods evicted',
  FailedMount: 'Volume mount failed',
  FailedAttachVolume: 'Volume attach failed',
  FailedCreate: "Couldn't create pods",
  FailedGetResourceMetric: "Autoscaler couldn't read metrics",
  FailedComputeMetricsReplicas: "Autoscaler couldn't read metrics",
  NodeNotReady: 'Node went not-ready',
  Rebooted: 'Node rebooted',
  OOMKilling: 'Out-of-memory kill on a node',
  ImagePull: 'Image pull failing',
  ProbeWarning: 'Health-check warnings',
  NetworkNotReady: 'Pod network not ready',
};

/**
 * @param {object} o
 * @param {number} o.since
 * @param {number} [o.until]
 * @param {string} o.namespace
 * @param {string} o.projectId
 * @param {import('../sources/logging.mjs').LoggingClient} [o.logging]
 * @param {import('../sources/cloudsql.mjs').CloudSqlClient} [o.cloudsql]
 * @param {{id:string,name:string,replicaOf?:string}[]} [o.sqlInstances] instances already found (any project)
 * @param {{logging: import('../sources/logging.mjs').LoggingClient, project: string}[]} [o.sqlLogProjects] other projects with Postgres logs
 * @param {object[]} [o.pods] current pod summaries (restart counts, last termination)
 * @param {{at:number, pods:Record<string,{service:string,restarts:number}>}} [o.restartSnapshot] restart counts saved when the app was last open
 * @param {import('../sources/sentry.mjs').SentryClient} [o.sentry]
 * @param {import('../sources/cloudflare.mjs').CloudflareClient} [o.cloudflare]
 * @param {{id:string,name:string}[]} [o.zones] Cloudflare zones
 * @param {Record<string,number>} [o.knownErrors]
 */
export async function buildRecap(o) {
  const until = o.until || Date.now();
  let since = o.since;
  const notes = [];
  if (until - since > 30 * 24 * HOUR) {
    since = until - 30 * 24 * HOUR;
    notes.push('Google keeps logs for 30 days, so this recap starts 30 days ago.');
  }
  const period = bucketPeriod(until - since);
  const ns = o.namespace;

  const safe = (label, p) =>
    p.catch((e) => {
      notes.push(`${label}: ${e.message}`);
      return null;
    });

  const eventsFilter = [
    `logName="projects/${o.projectId}/logs/events"`,
    `timestamp>="${iso(since)}"`,
    `timestamp<"${iso(until)}"`,
    `(jsonPayload.involvedObject.namespace="${ns}" OR jsonPayload.involvedObject.kind="Node")`,
    '(jsonPayload.type="Warning" OR jsonPayload.reason=("ScalingReplicaSet" OR "SuccessfulRescale" OR "Killing" OR "Evicted" OR "NodeNotReady" OR "Rebooted" OR "OOMKilling"))',
  ].join(' AND ');
  const errorsFilter = [`resource.type="k8s_container"`, `resource.labels.namespace_name="${ns}"`, 'severity>=ERROR', `timestamp>="${iso(since)}"`, `timestamp<"${iso(until)}"`].join(' AND ');
  const lbFilter = ['resource.type="http_load_balancer"', 'httpRequest.status>=500', `timestamp>="${iso(since)}"`, `timestamp<"${iso(until)}"`].join(' AND ');
  const sqlFilter = ['resource.type="cloudsql_database"', 'severity>=ERROR', `timestamp>="${iso(since)}"`, `timestamp<"${iso(until)}"`].join(' AND ');
  const MAX_ERRORS = 2000;
  const MAX_5XX = 5000;

  const sqlOps = async () => {
    // The instances the live view found (they can live in another project), else our project's own.
    const instances = o.sqlInstances?.length ? o.sqlInstances : await o.cloudsql.instances();
    const lists = await Promise.all(instances.filter((i) => !i.replicaOf).slice(0, 4).map((i) => o.cloudsql.operations(i.name, 50, i.id ? String(i.id).split(':')[0] : undefined).catch(() => [])));
    return lists.flat();
  };
  // Postgres errors: ours, plus those of a database in another project.
  const readSqlLogs = () =>
    Promise.all([
      o.logging.listAll({ filter: sqlFilter, orderBy: 'timestamp desc', max: 1000 }),
      ...(o.sqlLogProjects || []).map(({ logging, project }) => logging.listAll({ project, filter: sqlFilter, orderBy: 'timestamp desc', max: 1000 }).catch(() => [])),
    ]).then((lists) => lists.flat());

  const [eventsRaw, errorRaw, lbRaw, sqlLogs, ops, sentryIssues, cfHosts] = await Promise.all([
    o.logging ? safe('Kubernetes events', o.logging.listAll({ filter: eventsFilter, orderBy: 'timestamp asc', max: 3000 })) : null,
    o.logging ? safe('Error logs', o.logging.listAll({ filter: errorsFilter, orderBy: 'timestamp desc', max: MAX_ERRORS })) : null,
    o.logging ? safe('Failed requests', o.logging.listAll({ filter: lbFilter, orderBy: 'timestamp desc', max: MAX_5XX })) : null,
    o.logging ? safe('Database logs', readSqlLogs()) : null,
    o.cloudsql ? safe('Cloud SQL', sqlOps()) : null,
    o.sentry?.configured ? safe('Sentry', o.sentry.issuesSince(since)) : null,
    o.cloudflare?.configured && o.zones?.length ? safe('Cloudflare', o.cloudflare.errorsByHost(o.zones, Math.max(since, until - 24 * HOUR), until).then((r) => r.zones)) : null,
  ]);

  const incidents = [];
  const deploys = [];
  const scaling = [];
  const events = (eventsRaw || []).map((e) => normalizeEntry(e, { namespace: ns })).filter((e) => e.kind === 'event');
  const evFor = (service, start, end) => events.filter((e) => e.at >= start && e.at <= end && serviceFromObject(e.objectKind, e.objectName) === service);
  for (const e of events) e.at = e.ts;

  // ── 1. Restarts / crashes ─────────────────────────────────────────────────
  // Pods that still exist: their restart count now vs. the count saved when the
  // app was last open (exact). Pods that are gone: Kubernetes events (at least).
  const snap = o.restartSnapshot && Math.abs(o.restartSnapshot.at - since) < 3 * MIN ? o.restartSnapshot : null;
  const restartPoints = [];
  const livePods = new Set((o.pods || []).map((p) => p.name));
  const exactPods = new Set();
  for (const p of o.pods || []) {
    const lt = p.lastTermination;
    const ltIn = lt?.at && lt.at >= since && lt.at <= until;
    const before = snap?.pods?.[p.name];
    let n = 0;
    let exact = true;
    if (before) n = p.restarts - before.restarts;
    else if (p.createdAt && p.createdAt >= since) n = p.restarts;
    else if (ltIn) (n = 1), (exact = false);
    if (before || (p.createdAt && p.createdAt >= since)) exactPods.add(p.name);
    if (n <= 0) continue;
    restartPoints.push({ t: ltIn ? lt.at : Math.min(until, Math.max(since, lt?.at || until)), service: p.service, pod: p.name, n, exact, reason: terminationReason(lt) });
  }
  for (const e of events) {
    if (e.objectKind !== 'Pod' || exactPods.has(e.objectName)) continue;
    const restartish = (e.reason === 'BackOff' && /restarting failed container/i.test(e.message)) || (e.reason === 'Killing' && /liveness probe|failed.*probe/i.test(e.message));
    if (!restartish) continue;
    const pod = e.objectName;
    if (livePods.has(pod) && restartPoints.some((r) => r.pod === pod && Math.abs(r.t - e.at) < 10 * MIN)) continue;
    if (restartPoints.some((r) => r.pod === pod && !r.exact && Math.abs(r.t - e.at) < 10 * MIN)) continue;
    restartPoints.push({ t: e.at, service: serviceFromObject('Pod', pod), pod, n: 1, exact: false, reason: e.reason === 'BackOff' ? 'crash loop' : 'liveness probe failed' });
  }
  const restartsBySvc = new Map();
  for (const r of restartPoints) {
    if (!restartsBySvc.has(r.service)) restartsBySvc.set(r.service, []);
    restartsBySvc.get(r.service).push(r);
  }
  let totalRestarts = 0;
  let restartsExact = true;
  for (const [svc, pts] of restartsBySvc) {
    for (const ep of clusters(pts, 30 * MIN)) {
      const n = ep.points.reduce((a, p) => a + p.n, 0);
      const exact = ep.points.every((p) => p.exact);
      totalRestarts += n;
      if (!exact) restartsExact = false;
      const evs = evFor(svc, ep.start - 10 * MIN, ep.end + 5 * MIN);
      const text = evs.map((e) => `${e.reason} ${e.message}`).join('\n');
      let reason = ep.points.find((p) => p.reason === 'out of memory')?.reason || null;
      if (!reason && /OOMKill|out of memory|OOMKilled/i.test(text)) reason = 'out of memory';
      else if (!reason && /Liveness probe failed/i.test(text)) reason = 'liveness probe failed';
      else if (!reason && /Back-off restarting failed container|BackOff/i.test(text)) reason = 'crash loop';
      if (!reason) reason = ep.points.find((p) => p.reason)?.reason || null;
      const times = exact ? `${n}×` : n > 1 ? `at least ${n}×` : '';
      incidents.push({
        id: `restart:${svc}:${ep.start}`,
        kind: 'crash',
        severity: n >= 3 || reason === 'out of memory' || reason === 'crash loop' ? 'critical' : 'warning',
        service: svc,
        title: `${shortName(svc)} restarted${times ? ` ${times}` : ''}${reason ? ` (${reason})` : ''}`,
        detail: evs.filter((e) => e.type === 'Warning').slice(-1)[0]?.message || null,
        start: ep.start,
        end: ep.end,
        view: { to: 'logs', service: svc, from: ep.start - 5 * MIN, until: ep.end + 5 * MIN },
      });
    }
  }

  // ── 2. Failed requests at the load balancer (5xx, counted from its logs) ──
  const failed = (lbRaw || []).map((e) => normalizeEntry(e, { namespace: ns })).filter((r) => r.kind === 'request');
  if (lbRaw && lbRaw.length >= MAX_5XX) notes.push(`More than ${MAX_5XX.toLocaleString()} requests failed; the recap looked at the most recent ${MAX_5XX.toLocaleString()}.`);
  const failedRequests = failed.length;
  let outageMs = 0;
  const failedBySvc = new Map();
  for (const r of failed) {
    const svc = r.service || r.host || 'unknown';
    if (!failedBySvc.has(svc)) failedBySvc.set(svc, []);
    failedBySvc.get(svc).push(r);
  }
  const hot5xx = period <= 60 ? 5 : 10;
  for (const [svc, list] of failedBySvc) {
    const buckets = bucketize(
      list.map((r) => r.ts),
      period,
      since,
      until,
    );
    for (const ep of episodes(buckets, period, (b) => b.v >= hot5xx)) {
      const n = ep.points.reduce((a, b) => a + b.v, 0);
      const dur = ep.end - ep.start;
      const severity = n >= 100 || dur >= 5 * MIN ? 'critical' : 'warning';
      if (severity === 'critical') outageMs += dur;
      const inEp = list.filter((r) => r.ts >= ep.start && r.ts < ep.end);
      const why = {};
      for (const r of inEp) if (r.statusDetails) why[r.statusDetails] = (why[r.statusDetails] || 0) + 1;
      const top = Object.entries(why).sort((a, b) => b[1] - a[1])[0]?.[0];
      incidents.push({
        id: `5xx:${svc}:${ep.start}`,
        kind: 'http',
        severity,
        service: svc,
        title: `${shortName(svc)}: ${n.toLocaleString()} failed requests`,
        detail: `5xx errors over ${fmtDuration(dur)}${top ? ` · mostly ${LB_DETAILS[top] || top.replace(/_/g, ' ')}` : ''}`,
        start: ep.start,
        end: ep.end,
        view: { to: 'logs', service: svc, from: ep.start - 5 * MIN, until: ep.end + 5 * MIN },
      });
    }
  }

  // ── 3. Warning events that aren't already explained by restarts ───────────
  const grouped = new Map();
  for (const e of events) {
    if (e.type !== 'Warning' && !['NodeNotReady', 'Rebooted', 'OOMKilling', 'Evicted'].includes(e.reason)) continue;
    let reason = e.reason;
    if (reason === 'BackOff' && /pull/i.test(e.message)) reason = 'ImagePull';
    else if (reason === 'Failed' && /pull|image/i.test(e.message)) reason = 'ImagePull';
    else if (reason === 'BackOff' || reason === 'Killing' || reason === 'Failed') continue; // covered by restarts
    else if (reason === 'Unhealthy' && /Liveness/i.test(e.message)) continue; // leads to restarts
    const svc = e.objectKind === 'Node' ? `node/${e.objectName}` : serviceFromObject(e.objectKind, e.objectName);
    const key = `${svc}|${reason}`;
    const arr = grouped.get(key) || [];
    arr.push(e);
    grouped.set(key, arr);
  }
  for (const [key, list] of grouped) {
    const [svc, reason] = key.split('|');
    for (const ep of episodes(list.map((e) => ({ ...e, t: e.at })), 60, () => true, 30)) {
      const count = ep.points.reduce((a, e) => a + (e.count || 1), 0);
      const isNode = svc.startsWith('node/');
      incidents.push({
        id: `event:${key}:${ep.start}`,
        kind: isNode ? 'node' : 'event',
        severity: reason === 'NodeNotReady' || reason === 'OOMKilling' ? 'critical' : 'warning',
        service: isNode ? null : svc,
        title: `${isNode ? svc.slice(5) : shortName(svc)}: ${EVENT_TITLES[reason] || reason}${count > 1 ? ` (${count}×)` : ''}`,
        detail: ep.points[ep.points.length - 1].message,
        start: ep.start,
        end: ep.end,
        view: { to: 'events', from: ep.start - 5 * MIN, until: ep.end + 5 * MIN },
      });
    }
  }

  // ── 4. Deploys and autoscaling ────────────────────────────────────────────
  const rs = events.filter((e) => e.reason === 'ScalingReplicaSet' && e.objectKind === 'Deployment');
  const byDeploy = new Map();
  for (const e of rs) {
    const m = e.message.match(/Scaled (up|down) replica set (\S+) (?:to|from \d+ to) (\d+)/);
    if (!m) continue;
    const list = byDeploy.get(e.objectName) || [];
    list.push({ at: e.at, dir: m[1], rs: m[2], to: Number(m[3]) });
    byDeploy.set(e.objectName, list);
  }
  for (const [svc, list] of byDeploy) {
    const seenRs = new Set();
    for (const x of list) {
      if (x.dir === 'up' && !seenRs.has(x.rs)) {
        const downOther = list.some((y) => y.dir === 'down' && y.rs !== x.rs && Math.abs(y.at - x.at) < 15 * MIN);
        if (downOther) deploys.push({ service: svc, at: x.at, rs: x.rs });
      }
      seenRs.add(x.rs);
    }
  }
  const rescales = events.filter((e) => e.reason === 'SuccessfulRescale');
  const scaleBySvc = new Map();
  for (const e of rescales) {
    const svc = serviceFromObject(e.objectKind, e.objectName);
    const m = e.message.match(/New size: (\d+); reason: (.*)$/);
    if (!m) continue;
    const list = scaleBySvc.get(svc) || [];
    list.push({ at: e.at, size: Number(m[1]), reason: m[2] });
    scaleBySvc.set(svc, list);
  }
  for (const [svc, list] of scaleBySvc) {
    const sizes = list.map((x) => x.size);
    scaling.push({ service: svc, changes: list.length, peak: Math.max(...sizes), sizes: sizes.slice(0, 12), first: list[0].at, last: list[list.length - 1].at, reason: list.find((x) => /above/.test(x.reason))?.reason || list[0].reason });
  }

  // ── 5. Errors: spikes and brand-new error types ───────────────────────────
  const errLines = (errorRaw || []).map((raw) => normalizeEntry(raw, { namespace: ns })).filter((l) => l.kind === 'log');
  if (errorRaw && errorRaw.length >= MAX_ERRORS) notes.push(`There were more than ${MAX_ERRORS.toLocaleString()} error lines; spikes are based on the most recent ${MAX_ERRORS.toLocaleString()}.`);
  const totalErrors = errLines.length;
  const errBySvc = new Map();
  for (const l of errLines) {
    const svc = l.service || l.container || 'unknown';
    if (!errBySvc.has(svc)) errBySvc.set(svc, []);
    errBySvc.get(svc).push(l.ts);
  }
  for (const [svc, times] of errBySvc) {
    const pts = bucketize(times, period, since, until);
    const sorted = pts.map((p) => p.v).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 0;
    const threshold = Math.max(20 * (period / 60), 5 * median);
    for (const ep of episodes(pts, period, (p) => p.v >= threshold)) {
      const n = Math.round(ep.points.reduce((a, p) => a + p.v, 0));
      incidents.push({
        id: `errspike:${svc}:${ep.start}`,
        kind: 'errors',
        severity: 'warning',
        service: svc,
        title: `Error spike in ${shortName(svc)}`,
        detail: `${n.toLocaleString()} errors in ${fmtDuration(ep.end - ep.start)} (usually ~${Math.round(median)} per ${fmtDuration(period * 1000)})`,
        start: ep.start,
        end: ep.end,
        view: { to: 'logs', service: svc, level: 'ERROR', from: ep.start - 2 * MIN, until: ep.end + 2 * MIN },
      });
    }
  }
  const book = new ErrorBook({ known: o.knownErrors || {} });
  const newGroups = [];
  for (const line of errLines) {
    const r = book.add(line);
    if (r?.isNewGroup) newGroups.push(r.group);
  }
  const firstRun = !o.knownErrors || Object.keys(o.knownErrors).length === 0;
  if (newGroups.length && !firstRun) {
    incidents.push({
      id: `newerrors:${since}`,
      kind: 'errors',
      severity: 'warning',
      service: null,
      title: `${newGroups.length} new type${newGroups.length > 1 ? 's' : ''} of backend error`,
      detail: newGroups
        .slice(0, 3)
        .map((g) => `${shortName(g.service)}: ${g.title}`)
        .join('\n'),
      start: Math.min(...newGroups.map((g) => g.firstSeen)),
      end: Math.max(...newGroups.map((g) => g.lastSeen)),
      items: newGroups.slice(0, 10).map((g) => ({ service: g.service, title: g.title, count: g.count })),
      view: { to: 'errors' },
    });
  }

  // ── 6. Database ───────────────────────────────────────────────────────────
  // a) Services that couldn't reach Postgres (from their own error logs)
  const connErrs = errLines.filter((l) => DB_CONN_ERROR.test(l.text || ''));
  for (const ep of clusters(connErrs.map((l) => ({ t: l.ts, service: l.service || l.container })), 5 * MIN)) {
    if (ep.points.length < 5) continue;
    const dur = ep.end - ep.start;
    const svcs = [...new Set(ep.points.map((p) => p.service))];
    const severity = ep.points.length >= 20 || dur >= 3 * MIN ? 'critical' : 'warning';
    if (severity === 'critical') outageMs += dur;
    incidents.push({
      id: `sqlreach:${ep.start}`,
      kind: 'database',
      severity,
      service: null,
      title: "Services couldn't reach the database",
      detail: `${ep.points.length} connection errors over ${fmtDuration(dur)} · ${svcs.slice(0, 4).map(shortName).join(', ')}`,
      start: ep.start,
      end: ep.end,
      view: { to: 'logs', level: 'ERROR', from: ep.start - 2 * MIN, until: ep.end + 2 * MIN },
    });
  }
  // b) Postgres' own log: connection limit, deadlocks, disk full
  const sqlLines = (sqlLogs || []).map((e) => ({ t: Date.parse(e.timestamp), text: e.textPayload || e.jsonPayload?.message || '' }));
  const sqlGroups = [
    { re: /too many clients|remaining connection slots/i, title: 'Database ran out of connections', severity: (n) => (n >= 20 ? 'critical' : 'warning') },
    { re: /deadlock detected/i, title: 'Database deadlocks', severity: () => 'warning' },
    { re: /could not extend file|No space left on device/i, title: 'Database disk is full', severity: () => 'critical' },
  ];
  for (const g of sqlGroups) {
    for (const ep of clusters(sqlLines.filter((l) => g.re.test(l.text)), 15 * MIN)) {
      const n = ep.points.length;
      incidents.push({ id: `sqllog:${g.title}:${ep.start}`, kind: 'database', severity: g.severity(n), service: null, title: `${g.title}${n > 1 ? ` (${n}×)` : ''}`, detail: ep.points[0].text.slice(0, 300), start: ep.start, end: ep.end, view: { to: 'database' } });
    }
  }
  // c) Cloud SQL operations: maintenance, restarts, failovers, setting changes, failed backups
  for (const op of ops || []) {
    const at = op.startedAt || op.queuedAt;
    if (!at || at < since || at > until) continue;
    if (!op.disruptive && !op.failed) continue;
    const dur = op.endedAt ? op.endedAt - at : 0;
    incidents.push({
      id: `sqlop:${op.id}`,
      kind: 'database',
      severity: op.failed ? 'critical' : 'warning',
      service: null,
      title: `Cloud SQL${op.instance ? ` ${op.instance}` : ''}: ${op.label}${op.failed ? ' failed' : ''}`,
      detail: [op.error, op.type === 'UPDATE' && op.by ? `by ${op.by}` : null, dur >= MIN ? `took ${fmtDuration(dur)}` : null].filter(Boolean).join(' · ') || null,
      start: at,
      end: op.endedAt || at,
      view: { to: 'database' },
    });
  }

  // ── 7. Sentry (frontend) ──────────────────────────────────────────────────
  const byProject = new Map();
  for (const i of sentryIssues || []) {
    const list = byProject.get(i.project) || [];
    list.push(i);
    byProject.set(i.project, list);
  }
  for (const [project, list] of byProject) {
    incidents.push({
      id: `sentry:${project}:${since}`,
      kind: 'frontend',
      severity: list.some((i) => i.level === 'fatal') ? 'critical' : 'warning',
      service: project,
      title: `${list.length} new frontend error${list.length > 1 ? 's' : ''} in ${project}`,
      detail: list
        .slice(0, 3)
        .map((i) => `${i.title} (${i.count}× · ${i.users} user${i.users === 1 ? '' : 's'})`)
        .join('\n'),
      start: Math.min(...list.map((i) => i.firstSeen)),
      end: Math.max(...list.map((i) => i.lastSeen)),
      items: list.slice(0, 10).map((i) => ({ title: i.title, count: i.count, link: i.link })),
      view: { to: 'errors', filter: { source: 'frontend' } },
    });
  }

  // ── 8. Cloudflare edge (52x = Cloudflare couldn't reach us) ───────────────
  const hostMap = new Map();
  for (const z of cfHosts || []) {
    for (const g of z.httpRequestsAdaptiveGroups || []) {
      const host = g.dimensions.clientRequestHTTPHost;
      const row = hostMap.get(host) || { host, s5xx: 0, s52x: 0 };
      row.s5xx += g.count;
      if (g.dimensions.edgeResponseStatus >= 520 && g.dimensions.edgeResponseStatus <= 527) row.s52x += g.count;
      hostMap.set(host, row);
    }
  }
  for (const h of hostMap.values()) {
    if (h.s52x >= 10) {
      incidents.push({ id: `cf:${h.host}:${since}`, kind: 'edge', severity: 'critical', service: null, title: `${h.host}: Cloudflare couldn't reach the origin`, detail: `${h.s52x.toLocaleString()} × 52x at the edge (these never reach Google's logs)`, start: Math.max(since, until - 24 * HOUR), end: until, view: { to: 'frontends' } });
    }
  }

  incidents.sort((a, b) => a.start - b.start);
  const critical = incidents.filter((i) => i.severity === 'critical').length;
  const warning = incidents.filter((i) => i.severity === 'warning').length;
  const headline = !incidents.length
    ? 'All quiet. Nothing went wrong.'
    : critical
      ? `${critical} critical incident${critical > 1 ? 's' : ''}${warning ? ` and ${warning} warning${warning > 1 ? 's' : ''}` : ''}`
      : `${warning} warning${warning > 1 ? 's' : ''}, nothing critical`;

  return {
    since,
    until,
    generatedAt: Date.now(),
    period,
    headline,
    summary: {
      incidents: incidents.length,
      critical,
      warning,
      restarts: totalRestarts,
      restartsExact,
      errors: Math.round(totalErrors),
      newErrorTypes: firstRun ? null : newGroups.length,
      deploys: deploys.length,
      requests: null, // total request volume would need Cloud Monitoring (paid)
      failedRequests: lbRaw ? failedRequests : null,
      outageMinutes: Math.round(outageMs / MIN),
      frontendIssues: (sentryIssues || []).length,
    },
    incidents,
    deploys: deploys.sort((a, b) => a.at - b.at),
    scaling: scaling.sort((a, b) => b.peak - a.peak),
    notes,
  };
}
