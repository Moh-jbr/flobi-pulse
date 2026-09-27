// Alerts: level-triggered conditions ("brand is down" stays open until it's
// fixed) and one-shot happenings ("pod OOMKilled"). Each alert opens once,
// notifies once, and resolves on its own. Pure JS.

export const SEVERITY_ORDER = { critical: 3, warning: 2, info: 1 };

export class AlertBook {
  constructor({ onOpen, onResolve, oneShotTtlMs = 30 * 60_000, now = () => Date.now() } = {}) {
    this.active = new Map();
    this.recent = []; // resolved, newest first
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
        Object.assign(existing, { title: c.title, detail: c.detail, severity: c.severity, lastAt: now, data: c.data });
        if (escalated) {
          existing.acked = false;
          this.version++;
          this.onOpen?.(existing, { escalated: true, muted: this.isMuted(existing) });
        }
      } else {
        const a = { id: `${c.key}@${now}`, key: c.key, kind: c.kind, severity: c.severity, title: c.title, detail: c.detail, service: c.service || null, openedAt: now, lastAt: now, oneShot: false, acked: false, data: c.data || null, view: c.view || null };
        this.active.set(c.key, a);
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
    const a = { id: `${c.key}@${now}`, key: c.key, kind: c.kind, severity: c.severity, title: c.title, detail: c.detail, service: c.service || null, openedAt: c.at || now, lastAt: now, oneShot: true, acked: false, count: 1, data: c.data || null, view: c.view || null };
    this.active.set(c.key, a);
    this.version++;
    this.onOpen?.(a, { escalated: false, muted: this.isMuted(a) });
    return a;
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
    return { active, recent, muted, counts: { critical: active.filter((a) => a.severity === 'critical').length, warning: active.filter((a) => a.severity === 'warning').length } };
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
    if (s.health === 'down') {
      out.push({ key: `svc-down:${s.name}`, kind: 'service', service: s.name, severity: 'critical', title: `${s.name} is down`, detail: s.reasons.join(' · '), view: { to: 'service', id: s.name } });
    } else if (s.health === 'degraded') {
      out.push({ key: `svc-degraded:${s.name}`, kind: 'service', service: s.name, severity: 'warning', title: `${s.name} is degraded`, detail: s.reasons.join(' · '), view: { to: 'service', id: s.name } });
    }
  }
  for (const p of model.pods || []) {
    if (p.state === 'bad') {
      const critical = ['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'CreateContainerConfigError', 'OOMKilled'].includes(p.status);
      out.push({
        key: `pod:${p.name}`,
        kind: 'pod',
        service: p.service,
        severity: critical ? 'critical' : 'warning',
        title: `${p.name}: ${p.status}`,
        detail: [p.lastTermination?.reason && `last exit: ${p.lastTermination.reason} (code ${p.lastTermination.exitCode})`, p.message].filter(Boolean).join(' · ') || `${p.restarts} restarts`,
        view: { to: 'pod', id: p.name },
      });
    }
  }
  for (const n of model.nodes || []) {
    if (!n.ready) out.push({ key: `node-down:${n.name}`, kind: 'node', severity: 'critical', title: `Node ${n.name} is not ready`, detail: n.message, view: { to: 'infrastructure' } });
    else if (n.pressure.length) out.push({ key: `node-pressure:${n.name}`, kind: 'node', severity: 'warning', title: `Node ${n.name} under ${n.pressure.join(' & ')}`, detail: n.message, view: { to: 'infrastructure' } });
  }
  for (const s of model.scaling || []) {
    if (s.atMax) out.push({ key: `scale-max:${s.service}`, kind: 'scaling', service: s.service, severity: 'warning', title: `${s.service} is at max replicas (${s.max})`, detail: s.cpuNow != null ? `CPU ${s.cpuNow}% (target ${s.cpuTarget}%)` : 'Autoscaler cannot add more pods', view: { to: 'infrastructure' } });
  }
  for (const c of model.jobs?.cronjobs || []) {
    if (c.lastStatus === 'failed') out.push({ key: `cron-failed:${c.name}`, kind: 'job', severity: 'warning', title: `CronJob ${c.name} failed`, detail: c.lastMessage || 'Last run failed', view: { to: 'infrastructure' } });
  }
  for (const c of model.certificates || []) {
    const impact = c.status === 'Active' ? null : certificateImpact(c, uptime, dnsInfo);
    if (impact && !impact.harmless && !impact.waiting) out.push({ key: `cert:${c.name}`, kind: 'certificate', severity: 'warning', title: `Certificate ${c.name} is ${c.status}`, detail: c.domains.map((d) => `${d.domain}: ${d.status}`).join(' · '), view: { to: 'infrastructure' } });
  }
  for (const u of uptime || []) {
    if (u.state === 'down' && u.failStreak >= 2) {
      out.push({ key: `uptime:${u.id}`, kind: 'uptime', severity: 'critical', title: `${u.name} is unreachable`, detail: `${u.url} → ${u.error || `HTTP ${u.status}`}`, view: { to: u.group === 'frontend' ? 'frontends' : 'crashes' } });
    }
    if (u.certDaysLeft != null && u.certDaysLeft < 14) {
      out.push({ key: `tls:${u.id}`, kind: 'uptime', severity: u.certDaysLeft < 3 ? 'critical' : 'warning', title: `TLS certificate for ${new URL(u.url).host} expires in ${u.certDaysLeft} days`, detail: u.url, view: { to: 'infrastructure' } });
    }
  }
  // 5xx at the load balancer, per service (last 2 minutes of live traffic)
  for (const s of traffic?.byService || []) {
    if (s.total2m >= 20 && s.err5xx2m / s.total2m >= 0.05) {
      out.push({ key: `http5xx:${s.service}`, kind: 'http', service: s.service, severity: 'critical', title: `${s.service}: ${pct(s.err5xx2m / s.total2m)} of requests failing`, detail: `${s.err5xx2m} × 5xx in the last 2 min`, view: { to: 'traffic', filter: { service: s.service, status: '5xx' } } });
    }
  }
  for (const [service, r] of Object.entries(errorRates || {})) {
    if (r.now >= 10 && r.now >= 5 * Math.max(1, r.baseline)) {
      out.push({ key: `errspike:${service}`, kind: 'errors', service, severity: 'warning', title: `Error spike in ${service}`, detail: `${Math.round(r.now)} errors/min (usually ~${Math.round(r.baseline)})`, view: { to: 'errors', filter: { service } } });
    }
  }
  for (const db of database?.instances || []) {
    if (db.down) out.push({ key: `sql-down:${db.id}`, kind: 'database', severity: 'critical', title: `Cloud SQL ${db.name} is down`, detail: db.stateText || 'The database instance is not running', view: { to: 'database' } });
    else if (db.status === 'maintenance') out.push({ key: `sql-maint:${db.id}`, kind: 'database', severity: 'warning', title: `Cloud SQL ${db.name} is under maintenance`, detail: 'Connections may drop for a short time', view: { to: 'database' } });
  }
  const reach = database?.reachability;
  if (reach?.unreachable) {
    const who = reach.services.slice(0, 3).join(', ');
    out.push({ key: 'sql-unreachable', kind: 'database', severity: 'critical', title: "Services can't reach the database", detail: `${reach.last2m} connection errors in the last 2 min${who ? ` (${who})` : ''}`, view: { to: 'database' } });
  }
  if (database?.stats?.connLimit1h >= 3) out.push({ key: 'sql-connlimit', kind: 'database', severity: 'warning', title: 'Database is running out of connections', detail: `Postgres refused connections ${database.stats.connLimit1h}× in the last hour`, view: { to: 'database' } });
  for (const r of cloudRun || []) {
    if (r.ready === false) out.push({ key: `run:${r.name}`, kind: 'cloudrun', severity: 'critical', title: `Cloud Run ${r.name} is not ready`, detail: r.reason || 'Latest revision is not serving', view: { to: 'infrastructure' } });
  }
  for (const h of cloudflare?.hostErrors || []) {
    if (h.s52x >= 10) out.push({ key: `cf52x:${h.host}`, kind: 'edge', severity: 'critical', title: `${h.host}: Cloudflare can't reach the origin`, detail: `${h.s52x} × 52x in the last 15 min`, view: { to: 'frontends' } });
  }
  for (const p of cloudflare?.pages || []) {
    if (p.latest?.status === 'failure') out.push({ key: `pages:${p.name}:${p.latest.id}`, kind: 'deploy', severity: 'warning', title: `Cloudflare Pages deploy failed: ${p.name}`, detail: `${p.latest.branch || ''} ${p.latest.commit || ''} ${p.latest.message || ''}`.trim(), view: { to: 'frontends' } });
  }
  return out;
}
