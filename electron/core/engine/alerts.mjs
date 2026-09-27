// Alerts: level-triggered conditions ("brand is down" stays open until it's
// fixed) and one-shot happenings ("pod OOMKilled"). Each alert opens once,
// notifies once, and resolves on its own. Pure JS.

import { serviceCopy, podCopy, uptimeCopy } from './alert-copy.mjs';
import { shortName } from './log-parse.mjs';

export const SEVERITY_ORDER = { critical: 3, warning: 2, info: 1 };
const HISTORY_DAYS = 7;

export class AlertBook {
  constructor({ onOpen, onResolve, oneShotTtlMs = 30 * 60_000, now = () => Date.now() } = {}) {
    this.active = new Map();
    this.recent = []; // resolved, newest first
    this.history = []; // every alert that opened, newest first (the Recent page); kept across restarts
    this.onOpen = onOpen;
    this.onResolve = onResolve;
    this.oneShotTtlMs = oneShotTtlMs;
    this.now = now;
    this.muted = new Map(); // service → until
    this.version = 0;
  }

  isMuted(alert) {
    const until = alert.service ? this.muted.get(alert.service) : null;
    return !!(until && until > this.now());
  }

  /**
   * Reconciles level-triggered conditions. `conditions` is the full list of what
   * is true right now; anything open (and not one-shot) that is missing resolves.
   */
  reconcile(conditions) {
    const now = this.now();
    const seen = new Set();
    for (const c of conditions) {
      seen.add(c.key);
      const existing = this.active.get(c.key);
      if (existing) {
        const escalated = SEVERITY_ORDER[c.severity] > SEVERITY_ORDER[existing.severity];
        Object.assign(existing, { title: c.title, detail: c.detail, impact: c.impact || null, action: c.action || null, severity: c.severity, lastAt: now, data: c.data });
        if (escalated) {
          existing.acked = false;
          this.version++;
          this.onOpen?.(existing, { escalated: true, muted: this.isMuted(existing) });
        }
      } else {
        const a = { id: `${c.key}@${now}`, key: c.key, kind: c.kind, severity: c.severity, title: c.title, detail: c.detail, impact: c.impact || null, action: c.action || null, service: c.service || null, openedAt: now, lastAt: now, oneShot: false, acked: false, data: c.data || null, view: c.view || null };
        this.active.set(c.key, a);
        this._remember(a);
        this.version++;
        this.onOpen?.(a, { escalated: false, muted: this.isMuted(a) });
      }
    }
    for (const [key, a] of this.active) {
      if (a.oneShot) {
        if (now - a.openedAt > this.oneShotTtlMs) this._resolve(key, now);
      } else if (!seen.has(key)) this._resolve(key, now);
    }
  }

  /** Something happened once (crash, new error, failed deploy). */
  happen(c) {
    if (this.active.has(c.key)) {
      const a = this.active.get(c.key);
      a.lastAt = this.now();
      a.count = (a.count || 1) + 1;
      a.detail = c.detail || a.detail;
      this.version++;
      return a;
    }
    const now = this.now();
    const a = { id: `${c.key}@${now}`, key: c.key, kind: c.kind, severity: c.severity, title: c.title, detail: c.detail, impact: c.impact || null, action: c.action || null, service: c.service || null, openedAt: c.at || now, lastAt: now, oneShot: true, acked: false, count: 1, data: c.data || null, view: c.view || null };
    this.active.set(c.key, a);
    this._remember(a);
    this.version++;
    this.onOpen?.(a, { escalated: false, muted: this.isMuted(a) });
    return a;
  }

  _remember(a) {
    this.history.unshift(a); // the same object, so later updates (resolved, count) show up
    if (this.history.length > 500) this.history.length = 500;
  }

  /** History saved by an earlier run. Anything still open then is marked as such. */
  loadHistory(items = []) {
    const cutoff = this.now() - HISTORY_DAYS * 24 * 60 * 60_000;
    const ids = new Set(this.history.map((a) => a.id));
    const old = items.filter((a) => a?.id && !ids.has(a.id) && a.openedAt > cutoff).map((a) => (a.resolvedAt ? a : { ...a, unfinished: true }));
    this.history = [...this.history, ...old].sort((x, y) => y.openedAt - x.openedAt).slice(0, 500);
    this.version++;
  }

  /** What's worth saving for the next run (no bulky data). */
  historyToSave() {
    const cutoff = this.now() - HISTORY_DAYS * 24 * 60 * 60_000;
    return this.history.filter((a) => a.openedAt > cutoff).map(({ data, ...a }) => a);
  }

  _resolve(key, now) {
    const a = this.active.get(key);
    if (!a) return;
    this.active.delete(key);
    a.resolvedAt = now;
    this.recent.unshift(a);
    if (this.recent.length > 300) this.recent.length = 300;
    this.version++;
    this.onResolve?.(a);
  }

  ack(id) {
    for (const a of this.active.values()) if (a.id === id) a.acked = true;
    this.version++;
  }

  mute(service, minutes) {
    if (minutes <= 0) this.muted.delete(service);
    else this.muted.set(service, this.now() + minutes * 60_000);
    this.version++;
  }

  summary() {
    const now = this.now();
    const active = [...this.active.values()]
      .map((a) => ({ ...a, muted: this.isMuted(a) }))
      .sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || b.openedAt - a.openedAt);
    const recent = this.recent.filter((a) => now - a.resolvedAt < 24 * 60 * 60_000).slice(0, 100);
    const muted = Object.fromEntries([...this.muted.entries()].filter(([, until]) => until > now));
    const history = this.history
      .filter((a) => now - a.openedAt < HISTORY_DAYS * 24 * 60 * 60_000)
      .slice(0, 300)
      .map(({ data, ...a }) => ({ ...a, open: this.active.get(a.key) === a || (this.active.get(a.key)?.id === a.id), muted: this.isMuted(a) }));
    return { active, recent, history, muted, counts: { critical: active.filter((a) => a.severity === 'critical').length, warning: active.filter((a) => a.severity === 'warning').length } };
  }
}

const pct = (x) => `${Math.round(x * 100)}%`;

/** Level-triggered conditions derived from the current model. */
/**
 * A Google-managed certificate stuck on FailedNotVisible means Google's CA
 * couldn't find its load balancer behind the domain's DNS. That's expected when
 * the domain points at Cloudflare (which shows visitors its own certificate) or
 * isn't in DNS at all (nothing uses it). DNS answers come from the app's own
 * lookups; without them, a domain that's up over HTTPS counts as fine too.
 * @param {Map<string,{none:boolean,cloudflare:boolean}>} [dnsInfo]
 */
export function certificateImpact(cert, uptime = [], dnsInfo = null) {
  if (cert.status === 'Active') return { harmless: false, waiting: false, reason: null };
  const hostOf = (u) => {
    try {
      return new URL(u).hostname.toLowerCase();
    } catch {
      return null;
    }
  };
  const up = new Set(uptime.filter((u) => u.state === 'up' || u.state === 'slow').map((u) => hostOf(u.url)));
  const pending = new Set(uptime.filter((u) => u.state === 'pending').map((u) => hostOf(u.url)));
  const failed = (cert.domains || []).filter((d) => d.status !== 'Active');
  const verdicts = failed.map((d) => {
    const host = String(d.domain).toLowerCase();
    if (d.status !== 'FailedNotVisible') return 'real';
    const info = dnsInfo?.get(host);
    if (info?.none) return 'nodns';
    if (info?.cloudflare) return 'cloudflare';
    if (up.has(host)) return 'up';
    if (pending.has(host) || (dnsInfo && !dnsInfo.has(host))) return 'waiting';
    return 'real';
  });
  const harmless = failed.length > 0 && verdicts.every((v) => v === 'nodns' || v === 'cloudflare' || v === 'up');
  const waiting = !harmless && failed.length > 0 && verdicts.every((v) => v !== 'real');
  const list = (kind) => failed.filter((_, i) => verdicts[i] === kind).map((d) => d.domain);
  const join = (xs) => (xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
  const parts = [];
  if (list('cloudflare').length) parts.push(`${join(list('cloudflare'))} point${list('cloudflare').length === 1 ? 's' : ''} at Cloudflare, which shows visitors its own certificate`);
  if (list('nodns').length) parts.push(`${join(list('nodns'))} ${list('nodns').length === 1 ? 'isn’t' : 'aren’t'} in DNS at all, so nothing uses ${list('nodns').length === 1 ? 'it' : 'them'}`);
  if (list('up').length) parts.push(`${join(list('up'))} ${list('up').length === 1 ? 'is' : 'are'} up over HTTPS with another certificate`);
  return {
    harmless,
    waiting,
    reason: harmless ? `Google can’t issue it and it isn’t needed: ${parts.join('; ')}.` : null,
  };
}

export function evaluateConditions({ model, traffic, uptime, database, cloudRun, cloudflare, errorRates, dnsInfo }) {
  const out = [];
  for (const s of model.services || []) {
    if (s.health === 'down') out.push({ key: `svc-down:${s.name}`, kind: 'service', service: s.name, severity: 'critical', ...serviceCopy(s), view: { to: 'service', id: s.name } });
    else if (s.health === 'degraded') out.push({ key: `svc-degraded:${s.name}`, kind: 'service', service: s.name, severity: 'warning', ...serviceCopy(s), view: { to: 'service', id: s.name } });
  }
  for (const p of model.pods || []) {
    if (p.state === 'bad') {
      const critical = ['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'CreateContainerConfigError', 'OOMKilled'].includes(p.status);
      out.push({ key: `pod:${p.name}`, kind: 'pod', service: p.service, severity: critical ? 'critical' : 'warning', ...podCopy(p), view: { to: 'pod', id: p.name } });
    }
  }
  for (const n of model.nodes || []) {
    if (!n.ready) {
      out.push({ key: `node-down:${n.name}`, kind: 'node', severity: 'critical', title: `Node ${n.name} is down (not ready)`, detail: n.message || 'Kubernetes marked the node NotReady', impact: 'Pods on it are being moved to other nodes; services can run short of capacity meanwhile.', action: 'It usually recovers by itself within minutes. If it doesn’t, check the node in Google Cloud Console (Compute Engine).', view: { to: 'infrastructure' } });
    } else if (n.pressure.length) {
      const what = n.pressure.map((x) => x.replace(/Pressure$/, '').toLowerCase()).join(' and ');
      out.push({ key: `node-pressure:${n.name}`, kind: 'node', severity: 'warning', title: `Node ${n.name} is running out of ${what}`, detail: n.message || n.pressure.join(', '), impact: 'Kubernetes will evict pods from it if it gets worse.', action: 'See which pods on this node use the most memory or disk (Infrastructure → Nodes).', view: { to: 'infrastructure' } });
    }
  }
  for (const s of model.scaling || []) {
    if (s.atMax) {
      const name = shortName(s.service);
      out.push({ key: `scale-max:${s.service}`, kind: 'scaling', service: s.service, severity: 'warning', title: `${name} can't scale up: it's at its maximum of ${s.max} pods`, detail: s.cpuNow != null ? `CPU ${s.cpuNow}% (the autoscaler aims for ${s.cpuTarget}%)` : 'The autoscaler wants more pods than it may add', impact: 'More load will slow it down or make requests fail.', action: `Raise its autoscaler's max replicas (now ${s.max}), or find what's using the CPU.`, view: { to: 'infrastructure' } });
    }
  }
  for (const c of model.jobs?.cronjobs || []) {
    if (c.lastStatus === 'failed') out.push({ key: `cron-failed:${c.name}`, kind: 'job', severity: 'warning', title: `Scheduled job ${c.name} failed`, detail: c.lastMessage || 'Its last run failed', impact: 'Whatever it does on a schedule (cleanup, sync, emails…) didn’t happen this time.', action: 'Open Infrastructure → Scheduled jobs for the error, then its logs.', view: { to: 'infrastructure' } });
  }
  for (const c of model.certificates || []) {
    const impact = c.status === 'Active' ? null : certificateImpact(c, uptime, dnsInfo);
    if (impact && !impact.harmless && !impact.waiting) {
      const domains = c.domains.filter((d) => d.status !== 'Active').map((d) => d.domain);
      out.push({ key: `cert:${c.name}`, kind: 'certificate', severity: 'warning', title: `HTTPS certificate ${c.name} isn't working (${c.status})`, detail: c.domains.map((d) => `${d.domain}: ${d.status}`).join(' · '), impact: `${domains.join(', ')} may show browser security warnings.`, action: 'Make sure these domains’ DNS points at the Google load balancer; Google retries issuing the certificate by itself.', view: { to: 'infrastructure' } });
    }
  }
  for (const u of uptime || []) {
    if (u.state === 'down' && u.failStreak >= 2) out.push({ key: `uptime:${u.id}`, kind: 'uptime', severity: 'critical', ...uptimeCopy(u), view: { to: u.group === 'frontend' ? 'frontends' : 'crashes' } });
    if (u.certDaysLeft != null && u.certDaysLeft < 14) {
      const host = new URL(u.url).host;
      out.push({ key: `tls:${u.id}`, kind: 'uptime', severity: u.certDaysLeft < 3 ? 'critical' : 'warning', title: `HTTPS certificate for ${host} expires in ${u.certDaysLeft} day${u.certDaysLeft === 1 ? '' : 's'}`, detail: u.url, impact: 'When it expires, browsers block the site with a security warning.', action: 'Renew it. Google- and Cloudflare-managed certificates renew themselves, so find out why this one hasn’t.', view: { to: 'infrastructure' } });
    }
  }
  // 5xx at the load balancer, per service (last 2 minutes of live traffic)
  for (const s of traffic?.byService || []) {
    if (s.total2m >= 20 && s.err5xx2m / s.total2m >= 0.05) {
      const name = shortName(s.service);
      out.push({ key: `http5xx:${s.service}`, kind: 'http', service: s.service, severity: 'critical', title: `${name}: ${pct(s.err5xx2m / s.total2m)} of requests are failing`, detail: `${s.err5xx2m} server errors (5xx) out of ${s.total2m} requests in the last 2 min`, impact: 'Users are getting errors from it right now.', action: 'Open Live Traffic filtered to these errors: each failed request shows the server’s own log lines for it.', view: { to: 'traffic', filter: { service: s.service, status: '5xx' } } });
    }
  }
  for (const [service, r] of Object.entries(errorRates || {})) {
    if (r.now >= 10 && r.now >= 5 * Math.max(1, r.baseline)) {
      const name = shortName(service);
      out.push({ key: `errspike:${service}`, kind: 'errors', service, severity: 'warning', title: `${name} is logging ${Math.round(r.now / Math.max(1, r.baseline))}× more errors than usual`, detail: `${Math.round(r.now)} errors/min (usually about ${Math.round(r.baseline)})`, impact: 'Something started failing, often right after a deploy.', action: `Open Errors for ${name}: the new or growing error is at the top.`, view: { to: 'errors', filter: { service } } });
    }
  }
  for (const db of database?.instances || []) {
    if (db.down) out.push({ key: `sql-down:${db.id}`, kind: 'database', severity: 'critical', title: `Database ${db.name} is down`, detail: db.stateText || 'The database instance is not running', impact: 'Every app that reads or writes data is failing.', action: 'Check Recent activity on the Database page (maintenance, restart, setting change) and the Google Cloud status page.', view: { to: 'database' } });
    else if (db.status === 'maintenance') out.push({ key: `sql-maint:${db.id}`, kind: 'database', severity: 'warning', title: `Google is doing maintenance on database ${db.name}`, detail: db.stateText || 'Under maintenance', impact: 'Connections can drop for a minute or two.', action: 'Nothing to do: it ends by itself. If apps still fail afterwards, restart them.', view: { to: 'database' } });
  }
  const reach = database?.reachability;
  if (reach?.unreachable) {
    const who = reach.services.slice(0, 3).map(shortName).join(', ');
    out.push({ key: 'sql-unreachable', kind: 'database', severity: 'critical', title: "Apps can't connect to the database", detail: `${reach.last2m} connection errors in the last 2 min${who ? ` from ${who}` : ''}`, impact: 'Anything that reads or writes data is failing.', action: 'Open the Database page: check the instance status and the latest connection errors.', view: { to: 'database' } });
  }
  if (database?.stats?.connLimit1h >= 3) out.push({ key: 'sql-connlimit', kind: 'database', severity: 'warning', title: 'The database is running out of connections', detail: `Postgres refused ${database.stats.connLimit1h} new connections in the last hour (“too many clients”)`, impact: 'Requests that need a new connection fail.', action: 'Make each service’s connection pool smaller, or add a pooler like PgBouncer. A bigger database machine also allows more connections.', view: { to: 'database' } });
  for (const r of cloudRun || []) {
    if (r.ready === false) out.push({ key: `run:${r.name}`, kind: 'cloudrun', severity: 'critical', title: `Cloud Run service ${r.name} isn't serving`, detail: r.reason || 'Its latest revision is not ready', impact: 'Requests to it fail.', action: 'Its latest revision failed to start: open its logs in Google Cloud Console (Cloud Run → the service → Logs).', view: { to: 'infrastructure' } });
  }
  for (const h of cloudflare?.hostErrors || []) {
    if (h.s52x >= 10) out.push({ key: `cf52x:${h.host}`, kind: 'edge', severity: 'critical', title: `${h.host} is down behind Cloudflare: it can't reach our servers`, detail: `${h.s52x} × 52x errors in the last 15 min`, impact: 'Visitors see a Cloudflare error page instead of the site.', action: 'Check the service behind this domain is up (Live Traffic, Crashes & Down). These errors never reach Google’s logs.', view: { to: 'frontends' } });
  }
  for (const p of cloudflare?.pages || []) {
    if (p.latest?.status === 'failure') out.push({ key: `pages:${p.name}:${p.latest.id}`, kind: 'deploy', severity: 'warning', title: `Deploy of ${p.name} failed on Cloudflare Pages`, detail: `${p.latest.branch || ''} ${p.latest.commit || ''} ${p.latest.message || ''}`.trim(), impact: 'The site keeps serving the previous version.', action: 'Open the deployment in Cloudflare Pages to read the build log.', view: { to: 'frontends' } });
  }
  return out;
}
