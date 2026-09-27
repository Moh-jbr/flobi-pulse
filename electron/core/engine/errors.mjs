// Groups error log lines into "issues": the same error from the same service is
// one row with a count, first/last seen, affected pods and a per-minute
// sparkline. Pure JS.
import { parseNest, isStackFrame, stripAnsi } from './log-parse.mjs';

/** Removes the parts of a message that change between occurrences. */
export function normalizeMessage(text) {
  let t = parseNest(stripAnsi(text)).message;
  t = t.split('\n')[0];
  return t
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?\b/g, '<time>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b(user|org|ws|brand|file|node|board|job|req|sess)_[A-Za-z0-9]{6,}\b/g, '$1_<id>')
    .replace(/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi, '<email>')
    .replace(/https?:\/\/[^\s"')]+/g, (u) => u.replace(/\?.*$/, '?…'))
    .replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, '<ip>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<hex>')
    .replace(/"[^"]{24,}"/g, '"…"')
    .replace(/'[^']{24,}'/g, "'…'")
    .replace(/\b\d+(\.\d+)?(ms|s|MB|KB|GB|B)?\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function fingerprint(service, text) {
  return `${service}:${hash(normalizeMessage(text))}`;
}

const MINUTE = 60_000;
const SPARK_MINUTES = 60;

export class ErrorBook {
  /** @param {{known?: Record<string, number>, retentionMs?: number}} o */
  constructor({ known = {}, retentionMs = 24 * 60 * MINUTE } = {}) {
    this.groups = new Map();
    this.known = { ...known }; // fingerprint → first time this machine ever saw it
    this.retentionMs = retentionMs;
    this.lastByPod = new Map(); // pod → { group, ts } for attaching stack frames
    this.version = 0;
    // On a machine's very first run everything would look "new"; errors seen in
    // the first 15 minutes become the baseline instead.
    this.baselineUntil = Object.keys(known).length ? 0 : Date.now() + 15 * MINUTE;
  }

  /** @returns {{group:object, isNewGroup:boolean}|null} */
  add(line) {
    if (line.level !== 'ERROR') return null;
    const text = stripAnsi(line.text || '');
    if (!text.trim()) return null;

    // Stack frames belong to the error printed just before them.
    if (isStackFrame(text)) {
      const prev = this.lastByPod.get(line.pod);
      if (prev && Math.abs(line.ts - prev.ts) < 3000 && prev.group.stack.length < 40) {
        prev.group.stack.push(text.trim());
        this.version++;
      }
      return null;
    }

    const service = line.service || line.container || 'unknown';
    const fp = fingerprint(service, text);
    let g = this.groups.get(fp);
    let isNewGroup = false;
    if (!g) {
      const { context, message } = parseNest(text);
      const firstEver = this.known[fp];
      const baseline = !firstEver && Date.now() < this.baselineUntil;
      isNewGroup = !firstEver && !baseline;
      if (!firstEver) this.known[fp] = baseline ? line.ts - 7 * 24 * 60 * MINUTE : line.ts;
      g = {
        id: fp,
        source: 'backend',
        service,
        context,
        title: message.split('\n')[0].slice(0, 240) || text.slice(0, 240),
        count: 0,
        firstSeen: line.ts,
        firstEverSeen: this.known[fp],
        lastSeen: line.ts,
        pods: [],
        samples: [],
        stack: [],
        minutes: new Map(),
      };
      this.groups.set(fp, g);
    }
    g.count++;
    g.lastSeen = Math.max(g.lastSeen, line.ts);
    g.firstSeen = Math.min(g.firstSeen, line.ts);
    if (line.pod && !g.pods.includes(line.pod)) {
      g.pods.push(line.pod);
      if (g.pods.length > 12) g.pods.shift();
    }
    g.samples.push({ ts: line.ts, pod: line.pod, text: text.slice(0, 4000), json: line.json || null });
    if (g.samples.length > 15) g.samples.shift();
    const minute = Math.floor(line.ts / MINUTE);
    g.minutes.set(minute, (g.minutes.get(minute) || 0) + 1);
    this.lastByPod.set(line.pod, { group: g, ts: line.ts });
    this.version++;
    return { group: g, isNewGroup };
  }

  prune(now = Date.now()) {
    for (const [fp, g] of this.groups) {
      if (now - g.lastSeen > this.retentionMs) this.groups.delete(fp);
      else {
        const oldest = Math.floor((now - this.retentionMs) / MINUTE);
        for (const m of g.minutes.keys()) if (m < oldest) g.minutes.delete(m);
      }
    }
    // cap memory of "known" fingerprints at 5000 (oldest first)
    const keys = Object.keys(this.known);
    if (keys.length > 5000) {
      keys.sort((a, b) => this.known[a] - this.known[b]).slice(0, keys.length - 5000).forEach((k) => delete this.known[k]);
    }
  }

  /** Errors per minute for a service over the last `minutes` minutes (for spike detection). */
  ratePerMinute(service, minutes = 5, now = Date.now()) {
    const end = Math.floor(now / MINUTE);
    let total = 0;
    for (const g of this.groups.values()) {
      if (g.service !== service) continue;
      for (let m = end - minutes + 1; m <= end; m++) total += g.minutes.get(m) || 0;
    }
    return total / minutes;
  }

  /** Error lines per finished minute for a service, oldest first (sparklines). */
  perMinute(service, minutes = 60, now = Date.now(), since = 0) {
    const cur = Math.floor(now / MINUTE);
    const first = Math.max(cur - minutes, Math.floor(since / MINUTE) + 1);
    const out = new Array(Math.max(0, cur - first)).fill(0);
    for (const g of this.groups.values()) {
      if (g.service !== service) continue;
      for (const [m, n] of g.minutes) if (m >= first && m < cur) out[m - first] += n;
    }
    return out;
  }

  /** Serializable summary for the UI. */
  summary(now = Date.now(), newWindowMs = 24 * 60 * MINUTE) {
    const end = Math.floor(now / MINUTE);
    const hourAgo = now - 60 * MINUTE;
    return [...this.groups.values()]
      .map((g) => {
        const spark = [];
        let count1h = 0;
        for (let m = end - SPARK_MINUTES + 1; m <= end; m++) {
          const c = g.minutes.get(m) || 0;
          spark.push(c);
          count1h += c;
        }
        return {
          id: g.id,
          source: 'backend',
          service: g.service,
          context: g.context,
          title: g.title,
          count: g.count,
          count1h,
          firstSeen: g.firstSeen,
          lastSeen: g.lastSeen,
          isNew: now - g.firstEverSeen < newWindowMs,
          active: g.lastSeen > hourAgo,
          pods: g.pods,
          samples: g.samples.slice(-5),
          stack: g.stack.slice(0, 25),
          spark,
        };
      })
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }
}
