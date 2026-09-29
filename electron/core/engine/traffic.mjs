// Rolling request statistics from the live request stream. Pure JS.
// Everything here is counted from the free Cloud Logging live stream, so the
// per-minute history starts when the app opens (up to the last 60 minutes).

const MINUTE = 60_000;
// Status 0: the load balancer logged no response because the client went away first (like
// nginx's 499). The client's doing, so it counts with the 4xx, and the recap (status ≥ 500) agrees.
const statusClass = (s) => (s >= 500 ? 5 : s >= 400 || !(s > 0) ? 4 : s >= 300 ? 3 : 2);

/** Index of the p-th percentile in n sorted values. */
const rank = (n, p) => Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1));

/**
 * Moves the k-th smallest of a[lo..hi) to a[k], smaller ones before it, and returns it: a
 * percentile without sorting everything (quickselect).
 */
function select(a, lo, hi, k) {
  hi--;
  while (hi > lo) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        const x = a[i];
        a[i++] = a[j];
        a[j--] = x;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return a[k];
}

/** Strings as small ids, counted, so the ids of requests that left the window get reused. */
class Names {
  constructor() {
    this.byName = new Map();
    this.names = [];
    this.refs = [];
    this.free = [];
  }

  get size() {
    return this.names.length;
  }

  ref(name) {
    let id = this.byName.get(name);
    if (id === undefined) {
      id = this.free.length ? this.free.pop() : this.names.length;
      this.byName.set(name, id);
      this.names[id] = name;
      this.refs[id] = 0;
    }
    this.refs[id]++;
    return id;
  }

  unref(id) {
    if (--this.refs[id]) return;
    this.byName.delete(this.names[id]);
    this.names[id] = undefined;
    this.free.push(id);
  }
}

const scratch = new Map(); // reused counter arrays, so a snapshot allocates almost nothing
function counters(key, n, Type = Int32Array) {
  let a = scratch.get(key);
  if (!a || a.length < n) scratch.set(key, (a = new Type(Math.max(n, 64, a ? a.length * 2 : 0))));
  return a.fill(0, 0, n);
}

export class TrafficStats {
  constructor({ windowMs = 5 * 60_000, cap = 60_000, historyMinutes = 60, now = Date.now() } = {}) {
    this.windowMs = windowMs;
    this.cap = Math.max(1, cap);
    this.lastAt = 0;
    this.historyMinutes = historyMinutes;
    this.minutes = new Map(); // minute index → { total, e4, e5, svc: Map(service → { total, e5 }) }
    this.since = now; // history covers [since, now]
    // The last `cap` requests of the window, oldest first, one typed array per field: a
    // snapshot every second reads up to 60k of them, so no objects and no string keys there.
    this.head = 0; // where the oldest request is
    this.size = 0;
    this.services = new Names();
    this.hosts = new Names();
    this.paths = new Names(); // host + path, ids replaced by ":id"
    this.details = new Names(); // the load balancer's statusDetails
    this._resize(Math.min(this.cap, 1024));
  }

  _resize(n) {
    const old = this.ts;
    const fields = { ts: Float64Array, lat: Float64Array, cls: Uint8Array, svc: Int32Array, host: Int32Array, path: Int32Array, det: Int32Array };
    for (const [k, Type] of Object.entries(fields)) {
      const a = new Type(n);
      for (let j = 0; j < this.size; j++) a[j] = this[k][(this.head + j) % old.length];
      this[k] = a;
    }
    this.head = 0;
  }

  _dropOldest() {
    const i = this.head;
    this.services.unref(this.svc[i]);
    this.hosts.unref(this.host[i]);
    this.paths.unref(this.path[i]);
    if (this.det[i] >= 0) this.details.unref(this.det[i]);
    this.head = (i + 1) % this.ts.length;
    this.size--;
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
    const cls = statusClass(r.status);
    const key = r.service || 'unrouted';
    if (this.size >= this.cap) this._dropOldest();
    else if (this.size === this.ts.length) this._resize(Math.min(this.cap, this.ts.length * 2));
    const i = (this.head + this.size) % this.ts.length;
    this.ts[i] = r.ts;
    this.lat[i] = r.latencyMs == null ? NaN : r.latencyMs;
    this.cls[i] = cls;
    this.svc[i] = this.services.ref(key);
    this.host[i] = this.hosts.ref(r.host);
    this.path[i] = this.paths.ref(`${r.host}${(r.path || '').split('?')[0].replace(/\/[0-9a-f-]{16,}|\/\d{3,}/gi, '/:id')}`);
    this.det[i] = r.statusDetails ? this.details.ref(r.statusDetails) : -1;
    this.size++;
    this.lastAt = Math.max(this.lastAt, r.ts);

    const m = Math.floor(r.ts / MINUTE);
    let row = this.minutes.get(m);
    if (!row) this.minutes.set(m, (row = { total: 0, e4: 0, e5: 0, svc: new Map() }));
    row.total++;
    if (cls === 4) row.e4++;
    if (cls === 5) row.e5++;
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
    while (this.size && this.ts[this.head] < cutoff) this._dropOldest();
  }

  snapshot(now = Date.now()) {
    this.prune(now);
    const { ts, lat, cls, svc, host, path, det, size, head } = this;
    const len = ts.length;
    const S = this.services.size;
    const H = this.hosts.size;
    const P = this.paths.size;
    // One pass over the window. Ties in the sorted lists below keep the order in which each
    // key first appears (oldest request first), as grouping the requests in order would.
    const sTotal = counters('sTotal', S);
    const sE4 = counters('sE4', S);
    const sE5 = counters('sE5', S);
    const s2Total = counters('s2Total', S);
    const s2E5 = counters('s2E5', S);
    const sLat = counters('sLat', S);
    const sFirst = counters('sFirst', S).fill(-1, 0, S);
    const hTotal = counters('hTotal', H);
    const hE4 = counters('hE4', H);
    const hE5 = counters('hE5', H);
    const hFirst = counters('hFirst', H).fill(-1, 0, H);
    const pTotal = counters('pTotal', P);
    const pE4 = counters('pE4', P);
    const pE5 = counters('pE5', P);
    const pFirst = counters('pFirst', P).fill(-1, 0, P);
    const detCount = new Map(); // statusDetails id → count, in first-seen order
    const c = [0, 0, 0, 0, 0, 0];
    const nowSec = Math.floor(now / 1000);
    const firstSec = nowSec - 119;
    const perSec = counters('perSec', 120 * 4); // per second (last 120 s) × class 2..5
    const lat60 = counters('lat60', size, Float64Array);
    let n60 = 0;
    let latTotal = 0;
    for (let k = 0, i = head; k < size; k++, i = i + 1 === len ? 0 : i + 1) {
      const age = now - ts[i];
      const x = cls[i];
      const s = svc[i];
      const p = path[i];
      const l = lat[i];
      const hasLat = l === l; // not NaN: the request has a latency
      if (sFirst[s] < 0) sFirst[s] = k;
      sTotal[s]++;
      if (x === 4) sE4[s]++;
      else if (x === 5) sE5[s]++;
      if (hasLat) {
        sLat[s]++;
        latTotal++;
      }
      if (pFirst[p] < 0) pFirst[p] = k;
      pTotal[p]++;
      if (x === 4) pE4[p]++;
      else if (x === 5) pE5[p]++;
      if (!(age <= 120_000)) continue; // also a NaN timestamp, like before
      s2Total[s]++;
      if (x === 5) {
        s2E5[s]++;
        if (det[i] >= 0) detCount.set(det[i], (detCount.get(det[i]) || 0) + 1);
      }
      const sec = Math.floor(ts[i] / 1000) - firstSec;
      if (sec >= 0 && sec < 120) perSec[sec * 4 + x - 2]++;
      if (!(age <= 60_000)) continue;
      c[x]++;
      const h = host[i];
      if (hFirst[h] < 0) hFirst[h] = k;
      hTotal[h]++;
      if (x === 4) hE4[h]++;
      else if (x === 5) hE5[h]++;
      if (hasLat) lat60[n60++] = l;
    }
    const rpm = c[2] + c[3] + c[4] + c[5];

    const perSecond = [];
    for (let j = 0; j < 120; j++) perSecond.push({ t: (firstSec + j) * 1000, c2: perSec[j * 4], c3: perSec[j * 4 + 1], c4: perSec[j * 4 + 2], c5: perSec[j * 4 + 3] });

    const byFirstSeen = (total, first) => (a, b) => total[b] - total[a] || first[a] - first[b];
    const ids = (n, total) => {
      const out = [];
      for (let id = 0; id < n; id++) if (total[id]) out.push(id);
      return out;
    };

    // The 25 busiest paths, without sorting all of them.
    const pathOrder = byFirstSeen(pTotal, pFirst);
    const top = [];
    for (let p = 0; p < P; p++) {
      if (!pTotal[p] || (top.length === 25 && pathOrder(p, top[24]) >= 0)) continue;
      let j = top.length === 25 ? 24 : top.length;
      while (j > 0 && pathOrder(p, top[j - 1]) < 0) {
        top[j] = top[j - 1];
        j--;
      }
      top[j] = p;
    }
    const topRank = counters('topRank', P).fill(-1, 0, P);
    top.forEach((p, j) => (topRank[p] = j));

    // Latencies grouped by service (and by top path) in one buffer, then a percentile per group.
    const sStart = counters('sStart', S + 1);
    for (let s = 0; s < S; s++) sStart[s + 1] = sStart[s] + sLat[s];
    const sFill = counters('sFill', S);
    const svcLat = counters('svcLat', latTotal, Float64Array);
    const tStart = new Array(top.length + 1).fill(0);
    for (let j = 0; j < top.length; j++) tStart[j + 1] = tStart[j] + pTotal[top[j]];
    const tFill = new Array(top.length).fill(0);
    const topLat = counters('topLat', tStart[top.length], Float64Array);
    for (let k = 0, i = head; k < size; k++, i = i + 1 === len ? 0 : i + 1) {
      const l = lat[i];
      if (l !== l) continue;
      const s = svc[i];
      svcLat[sStart[s] + sFill[s]++] = l;
      const j = topRank[path[i]];
      if (j >= 0) topLat[tStart[j] + tFill[j]++] = l;
    }
    const pct = (a, lo, n, p) => (n ? select(a, lo, lo + n, lo + rank(n, p)) : null);

    const byService = ids(S, sTotal)
      .sort(byFirstSeen(sTotal, sFirst))
      .map((s) => {
        const n = sLat[s];
        const p95 = pct(svcLat, sStart[s], n, 95);
        // quickselect left the smaller values before the p95 one: p50 is among them
        const p50 = n ? select(svcLat, sStart[s], sStart[s] + rank(n, 95) + 1, sStart[s] + rank(n, 50)) : null;
        return {
          service: this.services.names[s],
          rpm: sTotal[s] / (this.windowMs / 60_000),
          total: sTotal[s],
          err4xx: sE4[s],
          err5xx: sE5[s],
          p50,
          p95,
          total2m: s2Total[s],
          err5xx2m: s2E5[s],
        };
      });

    const byHost = ids(H, hTotal)
      .sort(byFirstSeen(hTotal, hFirst))
      .map((h) => ({ host: this.hosts.names[h], rpm: hTotal[h], err5xx: hE5[h], err4xx: hE4[h] }));

    const topPaths = top.map((p, j) => ({ path: this.paths.names[p], count: pTotal[p], err5xx: pE5[p], err4xx: pE4[p], p95: pct(topLat, tStart[j], tFill[j], 95) }));

    const failureDetails = {};
    for (const [d, n] of detCount) failureDetails[this.details.names[d]] = n;

    const p99 = pct(lat60, 0, n60, 99);
    const p95 = n60 ? select(lat60, 0, rank(n60, 99) + 1, rank(n60, 95)) : null;
    const p50 = n60 ? select(lat60, 0, rank(n60, 95) + 1, rank(n60, 50)) : null;

    return {
      rpm,
      rps: rpm / 60,
      byClass: { '2xx': c[2], '3xx': c[3], '4xx': c[4], '5xx': c[5] },
      errorRate: rpm ? c[5] / rpm : 0,
      rate4xx: rpm ? c[4] / rpm : 0,
      p50,
      p95,
      p99,
      perSecond,
      byService,
      byHost,
      topPaths,
      failureDetails,
      lastRequestAt: this.lastAt || null,
    };
  }
}
