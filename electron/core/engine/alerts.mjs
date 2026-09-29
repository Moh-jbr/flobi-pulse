// Alerts: level-triggered conditions ("brand is down" stays open until it's
// fixed) and one-shot happenings ("pod OOMKilled"). Each alert opens once,
// notifies once, and resolves on its own. Pure JS.
//
// Silence (and Acknowledge) covers the problem, not just the alert: the alert's
// own key and its service stay silenced until nothing in them has been open for
// 30 minutes. A problem that clears and comes back, or the next alert of the same
// incident (the pod crash-loops, then the service goes down), opens already
// acknowledged: it shows in the app, and never notifies or rings. Something worse
// than what was silenced (a higher severity) is news again. Silences and mutes
// carry over to the next run (stateToSave / loadState).

import { serviceCopy, podCopy, uptimeCopy } from './alert-copy.mjs';
import { shortName } from './log-parse.mjs';

export const SEVERITY_ORDER = { critical: 3, warning: 2, info: 1 };
const HISTORY_DAYS = 7;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** What the Mute button silences for an alert: its service, else just this alert. */
export const muteTarget = (a) => a.service || `key:${a.key}`;

/** What Silence covers for an alert: this alert's problem ("key:<alert key>"), and its service. */
const silenceScopes = (a) => (a.service ? [`key:${a.key}`, a.service] : [`key:${a.key}`]);

export class AlertBook {
  /**
   * @param {{ onOpen?:Function, onResolve?:Function, oneShotTtlMs?:number, resolveAfterMs?:number, silenceMs?:number, now?:()=>number }} [o]
   *   resolveAfterMs: how long a condition must stay gone before its alert resolves
   *   (a condition may ask for longer with `holdMs`).
   *   silenceMs: how long a silenced problem must stay fixed before it can notify again.
   *   onOpen(alert, { escalated, muted, silenced }): `silenced` alerts opened (or got worse)
   *   already acknowledged, inside something someone silenced: never announce them.
   */
  constructor({ onOpen, onResolve, oneShotTtlMs = 30 * MIN, resolveAfterMs = 60_000, silenceMs = 30 * MIN, now = () => Date.now() } = {}) {
    this.active = new Map();
    this.recent = []; // resolved, newest first
    this.history = []; // every alert that opened, newest first (the Recent page); kept across restarts
    this.onOpen = onOpen;
    this.onResolve = onResolve;
    this.oneShotTtlMs = oneShotTtlMs;
    this.resolveAfterMs = resolveAfterMs;
    this.silenceMs = silenceMs;
    this.now = now;
    this.muted = new Map(); // service, or "key:<alert key>" → until
    // What Silence covers: "key:<alert key>" or a service → { severity (the worst silenced), clearAt
    // (null while something in it is open, else since when it's been fixed), fixedAt (the latest
    // time an alert in it was fixed) }.
    this.silenced = new Map();
    this.version = 0;
  }

  isMuted(alert) {
    const now = this.now();
    const on = (target) => {
      const until = this.muted.get(target);
      return !!(until && until > now);
    };
    return (!!alert.service && on(alert.service)) || (!!alert.key && on(`key:${alert.key}`));
  }

  /**
   * Reconciles level-triggered conditions. `conditions` is the full list of what
   * is true right now. Something that goes missing isn't fixed yet: its alert
   * stays open, "clearing", until the condition has been gone for the hold time,
   * so one flapping problem stays one alert with one notification.
   */
  reconcile(conditions) {
    const now = this.now();
    const seen = new Set();
    for (const c of conditions) {
      seen.add(c.key);
      const existing = this.active.get(c.key);
      if (existing) {
        const rose = SEVERITY_ORDER[c.severity] > SEVERITY_ORDER[existing.peak || existing.severity];
        const next = { title: c.title, detail: c.detail, impact: c.impact || null, action: c.action || null, severity: c.severity };
        let changed = Object.keys(next).some((k) => existing[k] !== next[k]);
        Object.assign(existing, next, { lastAt: now, data: c.data, holdMs: c.holdMs ?? null });
        if (existing.clearingSince != null) {
          // Back before the hold ran out: the same alert carries on, quietly (ack kept).
          existing.clearingSince = null;
          changed = true;
        }
        if (rose) {
          // Worse than it has ever been: that's news. Dropping back never is.
          existing.peak = c.severity;
          this.version++;
          this._escalated(existing);
        } else if (changed) this.version++;
      } else {
        const a = { id: `${c.key}@${now}`, key: c.key, kind: c.kind, severity: c.severity, peak: c.severity, title: c.title, detail: c.detail, impact: c.impact || null, action: c.action || null, service: c.service || null, openedAt: now, lastAt: now, oneShot: false, acked: false, clearingSince: null, holdMs: c.holdMs ?? null, data: c.data || null, view: c.view || null };
        this.active.set(c.key, a);
        this._remember(a);
        this.version++;
        this._opened(a);
      }
    }
    for (const [key, a] of this.active) {
      if (a.oneShot) {
        // Counted from the latest occurrence: a crash loop that keeps crashing stays one
        // (acknowledged) alert instead of reopening, and notifying, every 30 minutes.
        if (now - (a.lastAt ?? a.openedAt) > this.oneShotTtlMs) this._resolve(key, now);
      } else if (!seen.has(key)) {
        if (a.clearingSince == null) {
          a.clearingSince = now;
          this.version++;
        } else if (now - a.clearingSince >= (a.holdMs ?? this.resolveAfterMs)) this._resolve(key, a.clearingSince); // fixed since it went away
      }
    }
    this._pruneSilenced(now);
  }

  /** Something happened once (crash, new error, failed deploy). Again while it's open counts on the same alert. */
  happen(c) {
    if (this.active.has(c.key)) {
      const a = this.active.get(c.key);
      a.lastAt = this.now();
      a.count = (a.count || 1) + 1;
      a.detail = c.detail || a.detail;
      a.view = c.view || a.view; // the latest one (the newest crash)
      this.version++;
      if (SEVERITY_ORDER[c.severity] > SEVERITY_ORDER[a.peak || a.severity]) {
        // Worse than before (the next crash ran out of memory): that's news.
        Object.assign(a, { severity: c.severity, peak: c.severity, title: c.title || a.title, impact: c.impact || a.impact, action: c.action || a.action });
        this._escalated(a);
      }
      return a;
    }
    const now = this.now();
    const a = { id: `${c.key}@${now}`, key: c.key, kind: c.kind, severity: c.severity, peak: c.severity, title: c.title, detail: c.detail, impact: c.impact || null, action: c.action || null, service: c.service || null, openedAt: c.at || now, lastAt: now, oneShot: true, acked: false, clearingSince: null, count: 1, data: c.data || null, view: c.view || null };
    this.active.set(c.key, a);
    this._remember(a);
    this.version++;
    this._opened(a);
    return a;
  }

  /** A new alert is news, unless it's part of something someone silenced. */
  _opened(a) {
    const silenced = this._covered(a);
    if (silenced) Object.assign(a, { acked: true, silenced: true });
    this.onOpen?.(a, { escalated: false, muted: this.isMuted(a), silenced });
  }

  /** An alert worse than it has ever been: news again, unless what's silenced around it was at least as bad. */
  _escalated(a) {
    const silenced = this._covered(a);
    Object.assign(a, { acked: silenced, silenced });
    this.onOpen?.(a, { escalated: true, muted: this.isMuted(a), silenced });
  }

  /** Whether a silenced scope is still in force: something in it is open, or it was fixed less than silenceMs ago. */
  _inForce(s, now) {
    return !!s && (s.clearAt == null || now - s.clearAt < this.silenceMs);
  }

  /** The silenced scopes in force that this alert falls in, and whether one was silenced at its severity or worse. */
  _scopesOver(a, now) {
    const scopes = silenceScopes(a).filter((k) => this._inForce(this.silenced.get(k), now));
    const sev = SEVERITY_ORDER[a.severity] || 0;
    return { scopes, covered: scopes.some((k) => sev <= SEVERITY_ORDER[this.silenced.get(k).severity]) };
  }

  /**
   * Whether this alert, at its current severity, falls under something silenced: its own key or
   * its service, silenced at this severity or worse. Worse than anything silenced there ends
   * those silences: from then on that's news again, until someone silences it again.
   */
  _covered(a) {
    if (!this.silenced.size) return false;
    const { scopes, covered } = this._scopesOver(a, this.now());
    if (covered) return true;
    for (const k of scopes) this.silenced.delete(k);
    return false;
  }

  /** Scopes with nothing open start their clock (from when their problem was last fixed); after silenceMs they're over. */
  _pruneSilenced(now) {
    if (!this.silenced.size) return;
    const open = new Set();
    for (const a of this.active.values()) for (const k of silenceScopes(a)) open.add(k);
    for (const [k, s] of this.silenced) {
      if (open.has(k)) s.clearAt = null;
      else {
        s.clearAt ??= Math.min(now, s.fixedAt ?? now);
        if (now - s.clearAt >= this.silenceMs) this.silenced.delete(k);
      }
    }
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

  _resolve(key, at) {
    const a = this.active.get(key);
    if (!a) return;
    this.active.delete(key);
    a.resolvedAt = at;
    // Fixed as of: a condition, when it went away; a one-shot, its latest occurrence.
    const fixedAt = a.oneShot ? (a.lastAt ?? a.openedAt) : at;
    for (const k of silenceScopes(a)) {
      const s = this.silenced.get(k);
      if (s) s.fixedAt = Math.max(s.fixedAt ?? -Infinity, fixedAt);
    }
    this.recent.unshift(a);
    if (this.recent.length > 300) this.recent.length = 300;
    this.version++;
    this.onResolve?.(a);
  }

  /**
   * The Silence button: these alerts are acknowledged, and what they're about (each one's own
   * problem and its service, at the worst severity it reached) stays silenced while any alert in
   * it is open, and until it has been fixed for silenceMs. Other open alerts that this covers
   * (the same incident's warning about the service, say) are silenced with them, so they can't
   * be announced later either. Returns how many of `ids` were open.
   */
  silence(ids) {
    const want = new Set(ids);
    let n = 0;
    for (const a of this.active.values()) {
      if (!want.has(a.id)) continue;
      n++;
      a.acked = true;
      const sev = a.peak || a.severity;
      for (const k of silenceScopes(a)) {
        const s = this.silenced.get(k);
        if (!s) this.silenced.set(k, { severity: sev, clearAt: null, fixedAt: null });
        else {
          if (SEVERITY_ORDER[sev] > SEVERITY_ORDER[s.severity]) s.severity = sev;
          s.clearAt = null;
        }
      }
    }
    if (n) {
      const now = this.now();
      for (const a of this.active.values()) if (!a.acked && this._scopesOver(a, now).covered) Object.assign(a, { acked: true, silenced: true });
    }
    this.version++;
    return n;
  }

  /** Acknowledging one alert silences it like the Silence button does. */
  ack(id) {
    return this.silence([id]);
  }

  /** `target` is a service name, or "key:<alert key>" for an alert that has no service. */
  mute(target, minutes) {
    const now = this.now();
    for (const [t, until] of this.muted) if (until <= now) this.muted.delete(t);
    if (minutes <= 0) this.muted.delete(target);
    else this.muted.set(target, now + minutes * MIN);
    this.version++;
  }

  /** What Silence and Mute set up, for the next run (a reconnect, waking up, a restart). Small, plain JSON. */
  stateToSave() {
    const now = this.now();
    const silenced = [];
    for (const [scope, s] of this.silenced) if (this._inForce(s, now)) silenced.push({ scope, severity: s.severity, clearAt: s.clearAt });
    const muted = {};
    for (const [target, until] of this.muted) if (until > now) muted[target] = until;
    return { silenced, muted };
  }

  /**
   * What stateToSave() kept from an earlier run. Nothing is open yet in a new book, so a silenced
   * problem that was still going on starts its silenceMs now: if it's seen again meanwhile, it's
   * open again (and stays quiet); if not, it's over silenceMs from now.
   */
  loadState(saved) {
    if (!saved || typeof saved !== 'object') return;
    const now = this.now();
    for (const s of (Array.isArray(saved.silenced) ? saved.silenced : []).slice(0, 500)) {
      if (!s || typeof s.scope !== 'string' || !s.scope || !Object.hasOwn(SEVERITY_ORDER, s.severity) || this.silenced.has(s.scope)) continue;
      const clearAt = Number.isFinite(s.clearAt) ? Math.min(s.clearAt, now) : now;
      if (now - clearAt < this.silenceMs) this.silenced.set(s.scope, { severity: s.severity, clearAt, fixedAt: null });
    }
    const muted = saved.muted && typeof saved.muted === 'object' ? Object.entries(saved.muted) : [];
    for (const [target, until] of muted.slice(0, 500)) if (target && Number.isFinite(until) && until > now && until > (this.muted.get(target) ?? 0)) this.muted.set(target, until);
    this.version++;
  }

  /** Cached until something changes (health and the tray ask for it on every tick). */
  summary() {
    const now = this.now();
    const hit = this._summary;
    if (hit && hit.version === this.version && now >= hit.at && now < hit.until) return hit.value;
    const view = (a) => ({ ...a, muted: this.isMuted(a), muteTarget: muteTarget(a), silenced: !!a.silenced });
    const active = [...this.active.values()]
      .map((a) => ({ ...view(a), peak: a.peak || a.severity, clearing: a.clearingSince != null, clearingSince: a.clearingSince ?? null }))
      .sort((a, b) => a.clearing - b.clearing || SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || b.openedAt - a.openedAt);
    const recent = this.recent.filter((a) => now - a.resolvedAt < DAY).slice(0, 100).map(view);
    const muted = Object.fromEntries([...this.muted.entries()].filter(([, until]) => until > now));
    const history = this.history
      .filter((a) => now - a.openedAt < HISTORY_DAYS * DAY)
      .slice(0, 300)
      .map(({ data, ...a }) => {
        const open = this.active.get(a.key)?.id === a.id;
        return { ...view(a), open, clearing: open && a.clearingSince != null };
      });
    // Clearing alerts are on their way out: they don't count as problems.
    const live = active.filter((a) => !a.clearing);
    const value = { active, recent, history, muted, counts: { critical: live.filter((a) => a.severity === 'critical').length, warning: live.filter((a) => a.severity === 'warning').length } };
    // Time alone changes it only when a mute runs out (or, slowly, as old entries age out).
    this._summary = { version: this.version, at: now, until: Math.min(now + MIN, ...Object.values(muted)), value };
    return value;
  }
}

const pct = (x) => `${Math.round(x * 100)}%`;

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

/** Level-triggered conditions derived from the current model. */
export function evaluateConditions({ model, traffic, uptime, database, cloudRun, cloudflare, errorRates, dnsInfo, billingStorage, billingCredits, now = Date.now() }) {
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
      // Nodes blink NotReady for a moment (spot preemption, upgrades, a slow
      // kubelet): only one that stays down for 3 minutes is critical.
      const downMs = Number.isFinite(n.notReadySince) ? now - n.notReadySince : Infinity;
      if (downMs < 3 * MIN) out.push({ key: `node-down:${n.name}`, kind: 'node', severity: 'warning', title: `Node ${n.name} is not ready`, detail: n.message || 'Kubernetes marked the node NotReady', impact: 'If it stays down, its pods are moved to other nodes and services can run short of capacity meanwhile.', action: 'Nothing yet: nodes often come back within a minute or two. It turns critical if it’s still down after 3 minutes.', view: { to: 'infrastructure' } });
      else out.push({ key: `node-down:${n.name}`, kind: 'node', severity: 'critical', title: `Node ${n.name} is down (not ready)`, detail: `${n.message || 'Kubernetes marked the node NotReady'}${Number.isFinite(downMs) ? ` · for ${Math.round(downMs / MIN)} min` : ''}`, impact: 'Pods on it are being moved to other nodes; services can run short of capacity meanwhile.', action: 'It usually recovers by itself within minutes. If it doesn’t, check the node in Google Cloud Console (Compute Engine).', view: { to: 'infrastructure' } });
    } else if (n.pressure.length) {
      const what = n.pressure.map((x) => x.replace(/Pressure$/, '').toLowerCase()).join(' and ');
      out.push({ key: `node-pressure:${n.name}`, kind: 'node', severity: 'warning', title: `Node ${n.name} is running out of ${what}`, detail: n.message || n.pressure.join(', '), impact: 'Kubernetes will evict pods from it if it gets worse.', action: 'See which pods on this node use the most memory or disk (Infrastructure → Nodes).', view: { to: 'infrastructure' } });
    }
  }
  for (const s of model.scaling || []) {
    // At max is only a problem if it wants more: the HPA says so (ScalingLimited),
    // or CPU is over its target. Sitting at max with idle CPU is fine.
    const hot = s.cpuNow != null && s.cpuTarget != null && s.cpuNow > s.cpuTarget;
    if (s.atMax && (s.limited || hot)) {
      const name = shortName(s.service);
      out.push({ key: `scale-max:${s.service}`, kind: 'scaling', service: s.service, severity: 'warning', title: `${name} can't scale up: it's at its maximum of ${s.max} pods`, detail: hot ? `CPU ${s.cpuNow}% (the autoscaler aims for ${s.cpuTarget}%)` : 'The autoscaler wants more pods than it may add', impact: 'More load will slow it down or make requests fail.', action: `Raise its autoscaler's max replicas (now ${s.max}), or find what's ${hot ? 'using the CPU' : 'driving the load'}.`, view: { to: 'infrastructure' } });
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
  // 5xx at the load balancer, per service (last 2 minutes of live traffic). A
  // stray failed request is noise: it takes several, and a real share of traffic.
  // Rates this noisy wait 2 minutes before calling it over.
  for (const s of traffic?.byService || []) {
    if (!(s.total2m >= 20)) continue;
    const rate = s.err5xx2m / s.total2m;
    const critical = s.err5xx2m >= 10 && rate >= 0.1;
    if (!critical && !(s.err5xx2m >= 5 && rate >= 0.05)) continue;
    const name = shortName(s.service);
    out.push({ key: `http5xx:${s.service}`, kind: 'http', service: s.service, severity: critical ? 'critical' : 'warning', holdMs: 2 * MIN, title: `${name}: ${pct(rate)} of requests are failing`, detail: `${s.err5xx2m} server errors (5xx) out of ${s.total2m} requests in the last 2 min`, impact: critical ? 'Users are getting errors from it right now.' : 'Some users are getting errors from it right now.', action: 'Open Live Traffic filtered to these errors: each failed request shows the server’s own log lines for it.', view: { to: 'traffic', filter: { service: s.service, status: '5xx' } } });
  }
  for (const [service, r] of Object.entries(errorRates || {})) {
    if (r.now >= 10 && r.now >= 5 * Math.max(1, r.baseline)) {
      const name = shortName(service);
      out.push({ key: `errspike:${service}`, kind: 'errors', service, severity: 'warning', holdMs: 2 * MIN, title: `${name} is logging ${Math.round(r.now / Math.max(1, r.baseline))}× more errors than usual`, detail: `${Math.round(r.now)} errors/min (usually about ${Math.round(r.baseline)})`, impact: 'Something started failing, often right after a deploy.', action: `Open Errors for ${name}: the new or growing error is at the top.`, view: { to: 'errors', filter: { service } } });
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
  // The Costs page's billing export getting close to BigQuery's free storage (engine/costs.mjs,
  // bigQueryStorage): a heads-up while there's still room, with the command that keeps it small.
  const bq = billingStorage;
  if (bq && (bq.level === 'near' || bq.level === 'full')) {
    const gb = (b) => (b / 1024 ** 3).toFixed(1);
    const soon = (d) => (d < 14 ? `${d} day${d === 1 ? '' : 's'}` : d < 60 ? `${Math.round(d / 7)} weeks` : `${Math.round(d / 30)} months`);
    out.push({
      key: 'bq-storage',
      kind: 'costs',
      severity: 'warning',
      title: `Billing data in BigQuery is at ${gb(bq.bytes)} of the free 10 GB`,
      detail: bq.cappedAt != null ? `Days older than ${bq.expirationDays} are deleted, so it levels off around ${gb(bq.cappedAt)} GB` : bq.daysToFree != null ? `At this pace it passes 10 GB in about ${soon(bq.daysToFree)}` : bq.bytes >= bq.freeBytes ? 'It’s past the free 10 GB' : 'BigQuery storage is free up to 10 GB for the whole Google Cloud account',
      impact: 'Past 10 GB, BigQuery storage costs about 2 cents per GB a month.',
      action: `Open Costs → Google Cloud → Keep it small, copy the command that keeps the last ${bq.keepDays} days, and run it once in BigQuery. Flobi Pulse never runs it.`,
      view: { to: 'costs' },
    });
  }
  // Prepaid credits (OpenRouter, fal) below the amount set in Settings → Costs (engine/costs.mjs,
  // lowCredits). It clears once a check finds the balance back above it.
  for (const b of billingCredits || []) {
    const cash = (n) => {
      const a = Math.abs(n);
      const t = Number.isInteger(a) ? String(a) : a.toFixed(2);
      return `${n < 0 ? '-' : ''}${b.currency === 'USD' || !b.currency ? `$${t}` : `${t} ${b.currency}`}`;
    };
    const empty = b.amount <= 0;
    const pace = !empty && b.daysLeft != null ? `, about ${b.daysLeft} day${b.daysLeft === 1 ? '' : 's'} at this month’s pace` : '';
    out.push({
      key: `credits:${b.id}`,
      kind: 'costs',
      severity: 'warning',
      title: empty ? `${b.name} credits are used up` : `${b.name} credits are below ${cash(b.below)}`,
      detail: `${cash(b.amount)} left${pace}`,
      impact: b.id === 'openrouter' ? 'When they run out, requests through OpenRouter fail, and so does anything in Flobi that uses them.' : `When they run out, ${b.name} generations fail, and so does anything in Flobi that uses them.`,
      action: `Top up in ${b.id === 'openrouter' ? 'OpenRouter → Credits' : 'fal → Billing'} (or turn on automatic top-ups there). This clears once the balance is back above ${cash(b.below)}.`,
      view: { to: 'costs' },
    });
  }
  for (const p of cloudflare?.pages || []) {
    if (p.latest?.status === 'failure') out.push({ key: `pages:${p.name}:${p.latest.id}`, kind: 'deploy', severity: 'warning', title: `Deploy of ${p.name} failed on Cloudflare Pages`, detail: `${p.latest.branch || ''} ${p.latest.commit || ''} ${p.latest.message || ''}`.trim(), impact: 'The site keeps serving the previous version.', action: 'Open the deployment in Cloudflare Pages to read the build log.', view: { to: 'frontends' } });
  }
  return out;
}
