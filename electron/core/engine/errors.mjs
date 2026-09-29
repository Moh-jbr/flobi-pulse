// Groups error log lines into "issues": the same error from the same service is
// one row with a count (over the last 7 days: live lines, plus the past week read
// from Cloud Logging on start), first/last seen, affected pods and a per-minute
// sparkline of the last hour. Pure JS.
import { parseNest, isStackFrame, isExceptionHeader, stripAnsi } from './log-parse.mjs';

// A token that is an id rather than a word: it has a digit, mixes cases, or has no vowel at
// all (Kubernetes and many id generators leave vowels out so random names never spell words).
const idish = (s) => /\d/.test(s) || (/[a-z]/.test(s) && /[A-Z]/.test(s)) || !/[aeiouy]/i.test(s);

// Each token pattern starts with the character before the token (group 1, put back as is):
// lookbehind would do, but older Safari can't even parse it and the preview runs in a browser.
const PREFIXED_ID = /(^|[^A-Za-z0-9])([a-z]{2,12})_([A-Za-z0-9]{6,})(?![A-Za-z0-9])/g; // "fd_ppfzbts5zj"
// "flobi-brand-7d9f8c6b5-x2x9z" (Deployment), "bull-cleanup-29230000-x2x9z" (CronJob)
const POD_NAME = /(^|[^A-Za-z0-9-])([a-z][a-z0-9]*(?:-[a-z0-9]+)*)-([a-z0-9]{6,10})-([a-z0-9]{5})(?![A-Za-z0-9-])/g;
// nanoid and other url-safe ids: "V1StGXR8_Z5jdHi6B-myT"
const DASHED_ID = /(^|[^A-Za-z0-9_-])(?=[A-Za-z0-9_-]*[_-])([A-Za-z0-9_-]{12,})(?![A-Za-z0-9_-])/g;
const WORDY = /^(?:[A-Z]?[a-z]+|[A-Z]+|\d+)$/; // "X-Request-Id-2" is made of words, an id isn't
const BASE64 = /(^|[^A-Za-z0-9+/=])([A-Za-z0-9+/]{24,}={0,2})(?![A-Za-z0-9+/=])/g;
// cuid, cuid2, base36 and other long random tokens: "clx9k2m3n0000qwerty123abc", "6v7mnsxrwp"
const LONG_ID = /(^|[^A-Za-z0-9])([A-Za-z0-9]{10,})(?![A-Za-z0-9])/g;

const mixed = (s) => /\d/.test(s) && /[a-z]/.test(s) && /[A-Z]/.test(s);

const isJsonText = (t) => /^\s*(?:\{\s*"|\[\s*[{["\d])/.test(t);

/** Removes the parts of a message that change between occurrences. */
export function normalizeMessage(text) {
  let t = parseNest(stripAnsi(text)).message;
  // Only the start of the first line counts (the result is cut to 300 characters anyway).
  t = t.split('\n')[0].slice(0, 2000);
  // A JSON message's quoted values are the message itself, not user input to hide.
  const json = isJsonText(t);
  t = t
    .replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?\b/g, '<time>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*/g, '<jwt>')
    .replace(/\b(Bearer|Basic)\s+[\w.~+/-]{8,}=*/g, '$1 <token>')
    .replace(/\b(user|org|ws|brand|file|node|board|job|req|sess)_[A-Za-z0-9]{6,}\b/g, '$1_<id>')
    .replace(PREFIXED_ID, (m, pre, prefix, id) => (idish(id) ? `${pre}${prefix}_<id>` : m))
    .replace(/\b[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,}\b/gi, '<email>') // bounded: long dotted runs stay linear
    .replace(/https?:\/\/[^\s"')]+/g, (u) => u.replace(/\?.*$/, '?…'))
    .replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, '<ip>')
    .replace(POD_NAME, (m, pre, name, hash, suffix) => (idish(hash) && idish(suffix) ? `${pre}${name}-<pod>` : m))
    .replace(/\b[0-9a-f]{12,}\b/gi, '<hex>')
    .replace(DASHED_ID, (m, pre, id) => (mixed(id) && !id.split(/[-_]+/).every((p) => !p || WORDY.test(p)) ? `${pre}<id>` : m))
    .replace(BASE64, (m, pre, blob) => (mixed(blob) && (blob.match(/\//g) || []).length <= blob.length / 20 ? `${pre}<base64>` : m))
    .replace(LONG_ID, (m, pre, id) => ((/\d/.test(id) && /[A-Za-z]/.test(id)) || (/^[a-z]+$/.test(id) && !/[aeiouy]/.test(id)) ? `${pre}<id>` : m));
  if (!json) t = t.replace(/"[^"]{24,}"/g, '"…"').replace(/'[^']{24,}'/g, "'…'");
  return t
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

// ── Fingerprints of app versions ≤ 1.0.3 ─────────────────────────────────────
// A frozen copy of that normalizer (with its own copies of the ANSI and Nest patterns), only
// used to recognise errors this machine already knew before fingerprints changed. Never edit.
// eslint-disable-next-line no-control-regex
const V1_ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const V1_NEST = /^\[Nest\]\s+\d+\s+-\s+.*?\s+(LOG|ERROR|WARN|DEBUG|VERBOSE|FATAL)\s+(?:\[([^\]]+)\]\s*)?/;

function normalizeMessageV1(text) {
  // Twice, like 1.0.3 did (its stripAnsi ran again inside parseNest): nested codes differ otherwise.
  const s = String(text ?? '').replace(V1_ANSI, '').replace(V1_ANSI, '');
  const nest = s.match(V1_NEST);
  let t = nest ? s.slice(nest[0].length) : s;
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

/** The fingerprint app versions ≤ 1.0.3 gave an error (for their saved "known errors"). */
export function fingerprintV1(service, text) {
  return `${service}:${hash(normalizeMessageV1(text))}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SPARK_MINUTES = 60;
const MINUTES_KEPT = 120; // per-minute counts (sparklines, rates) cover the last two hours
const MAX_GROUPS = 1500; // the whole list goes to the UI on every change
const MAX_KNOWN = 5000;
const MAX_SAMPLES = 15;
const MAX_PODS = 12;
const STACK_MS = 3000; // a stack trace's lines arrive within this of the error line they belong to
const MAX_STACK = 40;
// Entries this close to the start can come both from the live stream and from the past-week
// load (Google delivers live entries a few seconds late): their ids are remembered for a while.
const OVERLAP_MS = 15 * MINUTE;
const MAX_IDS = 100_000;

/** Inserts `item` into `list` (sorted by ts, oldest first), after any with the same time. */
function insertByTs(list, item) {
  let i = list.length;
  while (i > 0 && list[i - 1].ts > item.ts) i--;
  list.splice(i, 0, item);
}

export class ErrorBook {
  /**
   * @param {{known?: Record<string, number>, legacyKnown?: Record<string, number>|null, retentionMs?: number, now?: number|(() => number)}} o
   *   known: fingerprint → first time this machine ever saw it (the current fingerprints; saved as is).
   *   legacyKnown: the same, saved by app versions ≤ 1.0.3 under their fingerprints. Read only.
   *   retentionMs: how far back a group's count reaches, and how long a group stays after it was
   *   last seen: a week, like the past errors loaded from Cloud Logging on start (addPast).
   */
  constructor({ known = {}, legacyKnown = null, retentionMs = 7 * DAY, now = Date.now() } = {}) {
    this.groups = new Map(); // fingerprint → group, least recently seen first
    this.known = { ...known };
    this.legacyKnown = legacyKnown && typeof legacyKnown === 'object' ? legacyKnown : null;
    this.seenAt = new Map(); // fingerprint → last time it was seen (memory only)
    this.retentionMs = retentionMs;
    this.lastByPod = new Map(); // pod → the error it logged last, for attaching its stack trace
    this.pastByPod = new Map(); // the same for lines from the past (addPast), which arrive out of time order
    this.byService = new Map(); // service → minute → error count (rates and sparklines), live lines only
    this.version = 0;
    // On a machine's very first run everything would look "new"; errors seen in
    // the first 15 minutes become the baseline instead.
    const start = typeof now === 'function' ? now() : Number.isFinite(now) ? now : Date.now();
    const empty = (o) => !o || !Object.keys(o).length;
    // Also right after an update from 1.0.3 (new map still empty): lines that only now count
    // as errors have no old fingerprint to match, and would each alert as "New" at once.
    this.baselineUntil = empty(known) ? start + 15 * MINUTE : 0;
    this.ids = new Set(); // entry ids of lines near the start (see OVERLAP_MS)
    this.idsFrom = start - OVERLAP_MS;
    this.idsUntil = start + 30 * MINUTE; // prune() forgets them after this (holdIds() moves it)
  }

  /** True during the first run's first 15 minutes, while errors become the baseline. */
  inBaseline(now = Date.now()) {
    return now < this.baselineUntil;
  }

  /** Keep remembering entry ids until `until` (while the past week is still loading). */
  holdIds(until) {
    if (this.ids) this.idsUntil = until;
  }

  /** True for an entry already counted: the live stream and the past-week load can both have it. */
  _counted(id, ts) {
    if (!id || !this.ids || ts < this.idsFrom) return false;
    if (this.ids.has(id)) return true;
    if (this.ids.size < MAX_IDS) this.ids.add(id);
    return false;
  }

  _newGroup(fp, service, text, ts) {
    const { context, message } = parseNest(text);
    return {
      id: fp,
      source: 'backend',
      service,
      context,
      title: message.split('\n')[0].slice(0, 240) || text.slice(0, 240),
      count: 0, // occurrences in the retention window (the sum of `hours`)
      hours: new Map(), // hour → occurrences
      oldestHour: Infinity,
      firstSeen: ts,
      firstEverSeen: this.known[fp],
      lastSeen: ts,
      pods: [],
      samples: [],
      stack: [],
      stackAt: 0, // when the occurrence the stack belongs to happened
      minutes: new Map(), // minute → occurrences, for the last two hours
    };
  }

  /** One more occurrence of `g` at `ts`. */
  _count(g, ts, { minute = true } = {}) {
    const h = Math.floor(ts / HOUR);
    g.hours.set(h, (g.hours.get(h) || 0) + 1);
    if (h < g.oldestHour) g.oldestHour = h;
    g.count++;
    if (minute) {
      const m = Math.floor(ts / MINUTE);
      g.minutes.set(m, (g.minutes.get(m) || 0) + 1);
    }
  }

  /** @returns {{group:object, isNewGroup:boolean}|null} null for anything that isn't an error of its own */
  add(line) {
    if (line.level !== 'ERROR') return null;
    const text = stripAnsi(line.text || '');
    if (!text.trim()) return null;
    const ts = Number.isFinite(line.ts) ? line.ts : Date.now();
    const prev = this.lastByPod.get(line.pod);
    const near = prev && Math.abs(ts - prev.ts) <= STACK_MS;

    // In GKE every line of a stack trace is its own log entry: the frames belong to
    // the error printed just before them.
    if (isStackFrame(text)) {
      if (near) this._attach(prev, text);
      return null;
    }
    // Already counted from the past-week load, which read it before the live stream brought it.
    if (this._counted(line.id, ts)) return null;
    // Nest logs "ERROR [ExceptionsHandler] msg", then the exception itself ("TypeError: msg")
    // and its frames: that line is the top of the error's stack trace, not another error.
    const header = isExceptionHeader(text);
    if (header && near && !prev.header && !prev.lines.length) {
      prev.header = true;
      this._attach(prev, text);
      return null;
    }

    const service = line.service || line.container || 'unknown';
    const fp = fingerprint(service, text);
    let g = this.groups.get(fp);
    let isNewGroup = false;
    if (g) this.groups.delete(fp); // set again below, so the map stays in last-seen order
    else {
      const firstEver = this._firstEver(fp, service, text, line.container);
      const baseline = firstEver == null && this.inBaseline(ts);
      isNewGroup = firstEver == null && !baseline;
      if (firstEver == null) this.known[fp] = baseline ? ts - 7 * DAY : ts;
      // Too many groups: forget the one not seen for the longest (it stays known).
      if (this.groups.size >= MAX_GROUPS) this.groups.delete(this.groups.keys().next().value);
      g = this._newGroup(fp, service, text, ts);
    }
    this.groups.set(fp, g);
    this.seenAt.set(fp, Math.max(this.seenAt.get(fp) || 0, ts));
    this._count(g, ts);
    g.lastSeen = Math.max(g.lastSeen, ts);
    g.firstSeen = Math.min(g.firstSeen, ts);
    if (line.pod && !g.pods.includes(line.pod)) {
      g.pods.push(line.pod);
      if (g.pods.length > MAX_PODS) g.pods.shift();
    }
    insertByTs(g.samples, { ts, pod: line.pod, text: text.slice(0, 4000), json: line.json || null });
    if (g.samples.length > MAX_SAMPLES) g.samples.shift();
    const minute = Math.floor(ts / MINUTE);
    let perMin = this.byService.get(service);
    if (!perMin) this.byService.set(service, (perMin = new Map()));
    perMin.set(minute, (perMin.get(minute) || 0) + 1);
    // This error's own stack trace starts empty; the group shows its latest one.
    this.lastByPod.set(line.pod, { group: g, ts, lines: [], header });
    this.version++;
    return { group: g, isNewGroup };
  }

  /**
   * Error lines from before the app started (the past week, read from Cloud Logging), in any
   * order, grouped exactly like live ones. Their error types become known (on a first run they
   * are the baseline, as usual), so none of them is ever reported as new later; nothing here
   * is reported now either. Returns how many lines were counted.
   */
  addPast(lines, now = Date.now()) {
    const windowFrom = now - this.retentionMs;
    const minutesFrom = now - MINUTES_KEPT * MINUTE;
    const touched = new Set();
    let counted = 0;
    const sorted = lines.filter((l) => l && l.level === 'ERROR' && Number.isFinite(l.ts)).sort((a, b) => a.ts - b.ts);
    for (const line of sorted) {
      const text = stripAnsi(line.text || '');
      if (!text.trim()) continue;
      const ts = line.ts;
      const prev = this.pastByPod.get(line.pod);
      const near = prev && Math.abs(ts - prev.ts) <= STACK_MS;
      if (isStackFrame(text)) {
        if (near) this._attach(prev, text);
        continue;
      }
      if (this._counted(line.id, ts)) continue;
      const header = isExceptionHeader(text);
      if (header && near && !prev.header && !prev.lines.length) {
        prev.header = true;
        this._attach(prev, text);
        continue;
      }
      const service = line.service || line.container || 'unknown';
      const fp = fingerprint(service, text);
      const firstEver = this._firstEver(fp, service, text, line.container);
      this.known[fp] = firstEver == null ? (this.inBaseline(ts) ? ts - 7 * DAY : ts) : Math.min(firstEver, ts);
      this.seenAt.set(fp, Math.max(this.seenAt.get(fp) || 0, ts));
      if (ts < windowFrom) continue; // known, but older than any count reaches
      let g = this.groups.get(fp);
      if (!g) this.groups.set(fp, (g = this._newGroup(fp, service, text, ts)));
      g.firstEverSeen = Math.min(g.firstEverSeen ?? Infinity, this.known[fp]);
      this._count(g, ts, { minute: ts >= minutesFrom });
      g.lastSeen = Math.max(g.lastSeen, ts);
      g.firstSeen = Math.min(g.firstSeen, ts);
      // Live pods (listed last) stay; older ones fill any room left in front of them.
      if (line.pod && !g.pods.includes(line.pod) && g.pods.length < MAX_PODS) g.pods.unshift(line.pod);
      if (!g.samples.length || ts > g.samples[0].ts || g.samples.length < MAX_SAMPLES) {
        insertByTs(g.samples, { ts, pod: line.pod, text: text.slice(0, 4000), json: line.json || null });
        if (g.samples.length > MAX_SAMPLES) g.samples.shift();
      }
      this.pastByPod.set(line.pod, { group: g, ts, lines: [], header, past: true });
      touched.add(g);
      counted++;
    }
    this.pastByPod.clear();
    if (!counted) return 0;
    // Back in last-seen order (the least recently seen goes first when there are too many),
    // and each touched group's minutes in time order (prune() relies on neither, but it's cheap).
    const all = [...this.groups.values()].sort((a, b) => a.lastSeen - b.lastSeen).slice(-MAX_GROUPS);
    this.groups.clear();
    for (const g of all) this.groups.set(g.id, g);
    for (const g of touched) if (g.minutes.size > 1) g.minutes = new Map([...g.minutes].sort((a, b) => a[0] - b[0]));
    this.version++;
    return counted;
  }

  _attach(occurrence, text) {
    if (occurrence.lines.length >= MAX_STACK) return;
    occurrence.lines.push(text.trim());
    // The group shows the stack of its latest occurrence: an older one from the logs doesn't replace it.
    const g = occurrence.group;
    if (g.stack === occurrence.lines || occurrence.ts >= (g.stackAt || 0)) {
      g.stack = occurrence.lines;
      g.stackAt = occurrence.ts;
    }
    this.version++;
  }

  /** When this machine first saw an error, also under the fingerprints of app versions ≤ 1.0.3. */
  _firstEver(fp, service, text, container) {
    if (this.known[fp] != null) return this.known[fp];
    if (!this.legacyKnown) return null;
    // Old fingerprints hid every long quoted value, so for a JSON message (whose quoted values
    // now count) many different new errors would all match one old one: don't adopt those.
    const first = parseNest(stripAnsi(text)).message.split('\n')[0];
    if (isJsonText(first) && /"…"/.test(normalizeMessageV1(text))) return null;
    let at = this.legacyKnown[fingerprintV1(service, text)];
    // Those versions named a service after its container once its pod was gone.
    if (at == null && container && container !== service) at = this.legacyKnown[fingerprintV1(container, text)];
    if (at == null) return null;
    this.known[fp] = at; // known under the new fingerprint from now on
    return at;
  }

  prune(now = Date.now()) {
    const oldestMinute = Math.floor((now - Math.min(this.retentionMs, MINUTES_KEPT * MINUTE)) / MINUTE);
    const oldestHour = Math.floor((now - this.retentionMs) / HOUR);
    for (const [fp, g] of this.groups) {
      if (now - g.lastSeen > this.retentionMs) {
        this.groups.delete(fp);
        continue;
      }
      // Minutes from the logs can arrive after live ones, so every key is checked (a group has
      // at most two hours of them).
      for (const m of g.minutes.keys()) if (m < oldestMinute) g.minutes.delete(m);
      // The count covers the retention window: whole hours drop out of it (checked once an hour).
      if (g.oldestHour < oldestHour) {
        let oldest = Infinity;
        for (const [h, n] of g.hours) {
          if (h < oldestHour) {
            g.hours.delete(h);
            g.count -= n;
          } else if (h < oldest) oldest = h;
        }
        g.oldestHour = oldest;
      }
    }
    for (const [service, minutes] of this.byService) {
      // live minutes are added in time order, so the old ones come first
      for (const m of minutes.keys()) {
        if (m >= oldestMinute) break;
        minutes.delete(m);
      }
      if (!minutes.size) this.byService.delete(service);
    }
    // Only the last few seconds matter for attaching stack traces; older entries would keep
    // groups alive long after they were pruned.
    for (const [pod, occurrence] of this.lastByPod) if (now - occurrence.ts > MINUTE) this.lastByPod.delete(pod);
    if (this.ids && now > this.idsUntil) this.ids = null;
    // Cap the memory of "known" fingerprints: forget the ones not seen for the longest, those
    // not seen at all while the app ran first (oldest first). First-seen order would forget
    // long-standing errors first, and they'd come back as "new".
    const keys = Object.keys(this.known);
    if (keys.length > MAX_KNOWN) {
      const seen = (k) => this.seenAt.get(k);
      keys.sort((a, b) => {
        const sa = seen(a);
        const sb = seen(b);
        if (sa == null || sb == null) return sa == null && sb == null ? this.known[a] - this.known[b] : sa == null ? -1 : 1;
        return sa - sb;
      });
      for (const k of keys.slice(0, keys.length - MAX_KNOWN)) {
        delete this.known[k];
        this.seenAt.delete(k);
      }
    }
  }

  /**
   * Errors per minute for a service over exactly [now − windowMs, now]. Finished minutes are
   * complete; the one the window starts in only counts the part inside the window, assuming its
   * errors were spread evenly (the current minute has only filled up to now).
   */
  rate(service, windowMs = 2 * MINUTE, now = Date.now()) {
    const minutes = this.byService.get(service);
    if (!minutes || !(windowMs > 0) || !Number.isFinite(windowMs) || !Number.isFinite(now)) return 0;
    const start = now - windowMs;
    const cur = Math.floor(now / MINUTE);
    let total = 0;
    for (let m = Math.floor(start / MINUTE); m <= cur; m++) {
      const n = minutes.get(m);
      if (!n) continue;
      const from = m * MINUTE;
      const to = m === cur ? now : from + MINUTE; // the part of the minute its errors are spread over
      total += to > from ? (n * (to - Math.max(start, from))) / (to - from) : n;
    }
    return total / (windowMs / MINUTE);
  }

  /** Errors per minute for a service over the last `minutes` minutes. */
  ratePerMinute(service, minutes = 5, now = Date.now()) {
    return this.rate(service, minutes * MINUTE, now);
  }

  /** Error lines per finished minute for a service, oldest first (sparklines). */
  perMinute(service, minutes = 60, now = Date.now(), since = 0) {
    const cur = Math.floor(now / MINUTE);
    const first = Math.max(cur - minutes, Math.floor(since / MINUTE) + 1);
    const out = new Array(Math.max(0, cur - first)).fill(0);
    const counts = this.byService.get(service);
    if (counts) for (let m = first; m < cur; m++) out[m - first] = counts.get(m) || 0;
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
          count: g.count, // in the retention window (7 days)
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
