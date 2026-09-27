// Rolling request statistics from the live request stream. Pure JS.
// Everything here is counted from the free Cloud Logging live stream, so the
// per-minute history starts when the app opens (up to the last 60 minutes).

const MINUTE = 60_000;
const statusClass = (s) => (s >= 500 || s === 0 ? 5 : s >= 400 ? 4 : s >= 300 ? 3 : 2);

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

export class TrafficStats {
  constructor({ windowMs = 5 * 60_000, cap = 60_000, historyMinutes = 60, now = Date.now() } = {}) {
    this.windowMs = windowMs;
    this.cap = cap;
    this.items = []; // { ts, cls, status, latencyMs, service, host, path, details }
    this.lastAt = 0;
    this.historyMinutes = historyMinutes;
    this.minutes = new Map(); // minute index → { total, e4, e5, svc: Map(service → { total, e5 }) }
    this.since = now; // history covers [since, now]
  }

  /** Demo only: pretend the app has been open for a while. */
  seedHistory(rows, since) {
    for (const r of rows) {
      const m = Math.floor((r.t - 1) / MINUTE);
      const svc = new Map(Object.entries(r.byService || {}).map(([k, v]) => [k, { ...v }]));
      this.minutes.set(m, { total: r.total, e4: r.e4 || 0, e5: r.e5 || 0, svc });
    }
    if (since) this.since = Math.min(this.since, since);
  }

  add(r) {
    this.items.push({
      ts: r.ts,
      cls: statusClass(r.status),
      status: r.status,
      latencyMs: r.latencyMs,
      service: r.service || 'unrouted',
      host: r.host,
      path: (r.path || '').split('?')[0].replace(/\/[0-9a-f-]{16,}|\/\d{3,}/gi, '/:id'),
      details: r.statusDetails,
    });
    this.lastAt = Math.max(this.lastAt, r.ts);
    if (this.items.length > this.cap) this.items.splice(0, this.items.length - this.cap);

    const cls = statusClass(r.status);
    const m = Math.floor(r.ts / MINUTE);
    let row = this.minutes.get(m);
    if (!row) this.minutes.set(m, (row = { total: 0, e4: 0, e5: 0, svc: new Map() }));
    row.total++;
    if (cls === 4) row.e4++;
    if (cls === 5) row.e5++;
    const key = r.service || 'unrouted';
    let sv = row.svc.get(key);
    if (!sv) row.svc.set(key, (sv = { total: 0, e5: 0 }));
    sv.total++;
    if (cls === 5) sv.e5++;
  }

  /**
   * Per-minute history of finished minutes (the current minute is still filling
   * up, so it's left out). `t` is the end of each minute.
   */
  history(now = Date.now()) {
    const cur = Math.floor(now / MINUTE);
    const first = Math.max(cur - this.historyMinutes, Math.floor(this.since / MINUTE) + 1);
    for (const m of this.minutes.keys()) if (m < cur - this.historyMinutes - 1) this.minutes.delete(m);
    const series = [];
    const spark = {};
    for (let m = first; m < cur; m++) {
      const row = this.minutes.get(m);
      series.push({ t: (m + 1) * MINUTE, total: row?.total || 0, e4: row?.e4 || 0, e5: row?.e5 || 0 });
    }
    const services = new Set();
    for (let m = first; m < cur; m++) for (const k of this.minutes.get(m)?.svc.keys() || []) services.add(k);
    for (const k of services) {
      spark[k] = [];
      for (let m = first; m < cur; m++) spark[k].push(this.minutes.get(m)?.svc.get(k)?.total || 0);
    }
    return { series, spark, since: Math.max(this.since, first * MINUTE) };
  }

  prune(now = Date.now()) {
    const cutoff = now - this.windowMs;
    let i = 0;
    while (i < this.items.length && this.items[i].ts < cutoff) i++;
    if (i) this.items.splice(0, i);
  }

  snapshot(now = Date.now()) {
    this.prune(now);
    const last60 = this.items.filter((x) => now - x.ts <= 60_000);
    const last120 = this.items.filter((x) => now - x.ts <= 120_000);
    const lat = last60.map((x) => x.latencyMs).filter((x) => x != null).sort((a, b) => a - b);
    const c = { 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const x of last60) c[x.cls]++;

    // per second, last 120 s
    const nowSec = Math.floor(now / 1000);
    const perSecond = [];
    const idx = new Map();
    for (let s = nowSec - 119; s <= nowSec; s++) {
      const row = { t: s * 1000, c2: 0, c3: 0, c4: 0, c5: 0 };
      idx.set(s, row);
      perSecond.push(row);
    }
    for (const x of last120) {
      const row = idx.get(Math.floor(x.ts / 1000));
      if (row) row[`c${x.cls}`]++;
    }

    const group = (keyFn, list) => {
      const m = new Map();
      for (const x of list) {
        const k = keyFn(x);
        let g = m.get(k);
        if (!g) m.set(k, (g = { key: k, total: 0, e4: 0, e5: 0, lat: [] }));
        g.total++;
        if (x.cls === 4) g.e4++;
        if (x.cls === 5) g.e5++;
        if (x.latencyMs != null) g.lat.push(x.latencyMs);
      }
      return m;
    };

    const svc5m = group((x) => x.service, this.items);
    const svc2m = group((x) => x.service, last120);
    const byService = [...svc5m.values()]
      .map((g) => {
        const l = g.lat.sort((a, b) => a - b);
        const g2 = svc2m.get(g.key);
        return {
          service: g.key,
          rpm: g.total / (this.windowMs / 60_000),
          total: g.total,
          err4xx: g.e4,
          err5xx: g.e5,
          p50: percentile(l, 50),
          p95: percentile(l, 95),
          total2m: g2?.total || 0,
          err5xx2m: g2?.e5 || 0,
        };
      })
      .sort((a, b) => b.total - a.total);

    const byHost = [...group((x) => x.host, last60).values()].map((g) => ({ host: g.key, rpm: g.total, err5xx: g.e5, err4xx: g.e4 })).sort((a, b) => b.rpm - a.rpm);

    const paths = [...group((x) => `${x.host}${x.path}`, this.items).values()]
      .map((g) => {
        const l = g.lat.sort((a, b) => a - b);
        return { path: g.key, count: g.total, err5xx: g.e5, err4xx: g.e4, p95: percentile(l, 95) };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 25);

    const details = {};
    for (const x of last120) if (x.cls === 5 && x.details) details[x.details] = (details[x.details] || 0) + 1;

    return {
      rpm: last60.length,
      rps: last60.length / 60,
      byClass: { '2xx': c[2], '3xx': c[3], '4xx': c[4], '5xx': c[5] },
      errorRate: last60.length ? c[5] / last60.length : 0,
      rate4xx: last60.length ? c[4] / last60.length : 0,
      p50: percentile(lat, 50),
      p95: percentile(lat, 95),
      p99: percentile(lat, 99),
      perSecond,
      byService,
      byHost,
      topPaths: paths,
      failureDetails: details,
      lastRequestAt: this.lastAt || null,
    };
  }
}
