// Formatting helpers.
//
// Numbers and clock times always use ASCII digits and a 24-hour clock, whatever the
// system locale: they sit next to each other in tables and logs, and code slices them
// (clockMs(ts).slice(0, 8) is "HH:MM:SS"), so they must never come out as "00 h 05" or
// with Arabic-Indic digits. Only the names of days and months follow the locale.

const two = (n) => String(n).padStart(2, '0');
const toDate = (ts) => {
  if (!ts) return null;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
};

export function ago(ts, now = Date.now()) {
  if (!ts) return '—';
  const s = Math.round((now - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.round(d / 30)}mo ago`;
}

export function duration(ms) {
  if (ms == null) return '—';
  if (ms < 999.5) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60 ? `${s % 60}s` : ''}`.trim();
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60 ? `${m % 60}m` : ''}`.trim();
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24 ? `${h % 24}h` : ''}`.trim();
}

export function uptimeSince(ts, now = Date.now()) {
  return ts ? duration(now - ts) : '—';
}

// ── Clock ────────────────────────────────────────────────────────────────────
// Local time, fixed shape: "14:03", "14:03:22", "14:03:22.051".

const hm = (d) => `${two(d.getHours())}:${two(d.getMinutes())}`;
const hms = (d) => `${hm(d)}:${two(d.getSeconds())}`;

/** "14:03" */
export function clockHM(ts) {
  const d = toDate(ts);
  return d ? hm(d) : '—';
}

/** "14:03:22" */
export function clockHMS(ts) {
  const d = toDate(ts);
  return d ? hms(d) : '—';
}

/** "14:03:22.051" */
export function clockMs(ts) {
  const d = toDate(ts);
  return d ? `${hms(d)}.${String(d.getMilliseconds()).padStart(3, '0')}` : '—';
}

/** "14:03:22", or "14:03" without seconds. */
export function clock(ts, withSeconds = true) {
  return withSeconds ? clockHMS(ts) : clockHM(ts);
}

const DAY = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', numberingSystem: 'latn' });

/** "Today", "Yesterday" or "Sat 27 Sep" (the date part of dayTime). */
export function day(ts) {
  const d = toDate(ts);
  if (!d) return '—';
  const now = new Date();
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, now)) return 'Today';
  if (same(d, new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return 'Yesterday';
  return DAY.format(d);
}

const DAY_LONG = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'short', numberingSystem: 'latn' });

/** "Today", "Yesterday" or "Saturday 27 Sep" (list headers). */
export function dayLong(ts) {
  const d = toDate(ts);
  if (!d) return '—';
  const label = day(d);
  return label === 'Today' || label === 'Yesterday' ? label : DAY_LONG.format(d);
}

/** "Today 14:03", "Yesterday 09:12", "Sat 27 Sep 14:03". */
export function dayTime(ts) {
  const d = toDate(ts);
  return d ? `${day(d)} ${hm(d)}` : '—';
}

/**
 * What a count covers when it counts from `since` (the past week loaded from the logs, or
 * the app's start): { label: "in 7 days" | "since 14:03", sentence: "in the last 7 days" |
 * "since 14:03", full } ("since yesterday 09:12", "since Sat 27 Sep 14:03" on other days).
 */
export function coverage(since, now = Date.now(), days = 7) {
  if (since == null || !toDate(since)) return { full: false, label: '', sentence: '' };
  if (now - since >= days * 86_400_000 - 60_000) return { full: true, label: `in ${days} days`, sentence: `in the last ${days} days` };
  const d = day(since);
  const text = `since ${d === 'Today' ? '' : `${d === 'Yesterday' ? 'yesterday' : d} `}${clockHM(since)}`;
  return { full: false, label: text, sentence: text };
}

// ── Numbers ──────────────────────────────────────────────────────────────────
const NUM = new Intl.NumberFormat(undefined, { numberingSystem: 'latn', maximumFractionDigits: 0 });
const NUM_DIGITS = new Map();

export function num(n, digits = 0) {
  if (n == null || Number.isNaN(n)) return '—';
  let f = digits ? NUM_DIGITS.get(digits) : NUM;
  if (!f) NUM_DIGITS.set(digits, (f = new Intl.NumberFormat(undefined, { numberingSystem: 'latn', maximumFractionDigits: digits, minimumFractionDigits: 0 })));
  return f.format(Number(n));
}

/**
 * Scales `v` down by `base` until it reads well in `units`, deciding on the value as it will be
 * shown: whatever rounds up to `base` moves to the next unit (999,999 is "1.0M", never "1000K").
 * decimals(v, i) says how many decimals to show for v in unit i.
 */
function scaled(v, base, units, decimals) {
  let i = 0;
  while (v >= base && i < units.length - 1) {
    v /= base;
    i++;
  }
  for (;;) {
    let d = decimals(v, i);
    let r = Number(v.toFixed(d));
    // 9.96 with one decimal is "10.0": show it the way 10 is shown.
    if (d && decimals(r, i) < d) {
      d = decimals(r, i);
      r = Number(v.toFixed(d));
    }
    if (r >= base && i < units.length - 1) {
      v /= base;
      i++;
      continue;
    }
    return [r.toFixed(d), units[i]];
  }
}

const MONEY = new Map();

/**
 * "$1,234.56" in this computer's locale (ASCII digits, like every other number). A currency
 * the system doesn't know still shows, as "1,234.56 XYZ". Tiny leftovers never show as "-$0.00".
 */
export function money(amount, currency = 'USD', { cents = true } = {}) {
  if (amount == null || !Number.isFinite(Number(amount))) return '—';
  const n = Math.abs(Number(amount)) < (cents ? 0.005 : 0.5) ? 0 : Number(amount);
  const key = `${currency}:${cents}`;
  if (!MONEY.has(key)) {
    let f = null;
    try {
      f = new Intl.NumberFormat(undefined, { style: 'currency', currency, numberingSystem: 'latn', minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });
    } catch {}
    MONEY.set(key, f);
  }
  const f = MONEY.get(key);
  return f ? f.format(n) : `${num(n, cents ? 2 : 0)} ${currency}`;
}

const MONTH_FMT = new Map();

/** "2026-09" → "September 2026" (style 'long'), "September" ('month'), "Sep" ('short'). */
export function monthName(key, style = 'long') {
  const m = /^(\d{4})-(\d{2})$/.exec(key || '');
  if (!m) return '—';
  const opts = style === 'short' ? { month: 'short' } : style === 'month' ? { month: 'long' } : style === 'shortYear' ? { month: 'short', year: 'numeric' } : { month: 'long', year: 'numeric' };
  if (!MONTH_FMT.has(style)) MONTH_FMT.set(style, new Intl.DateTimeFormat(undefined, { ...opts, numberingSystem: 'latn' }));
  return MONTH_FMT.get(style).format(new Date(Number(m[1]), Number(m[2]) - 1, 15));
}

const DATE_SHORT = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', numberingSystem: 'latn' });

/** "3 Oct" for a time or a "2026-10-03" date. */
export function dateShort(v) {
  const d = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(Number(v.slice(0, 4)), Number(v.slice(5, 7)) - 1, Number(v.slice(8, 10))) : toDate(v);
  return d ? DATE_SHORT.format(d) : '—';
}

export function compact(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  n = Number(n);
  const [text, unit] = scaled(Math.abs(n), 1000, ['', 'K', 'M', 'B'], (v, i) => (i === 0 ? (v >= 100 || Number.isInteger(v) ? 0 : 1) : v < 10 ? 1 : 0));
  return `${n < 0 && Number(text) !== 0 ? '-' : ''}${text}${unit}`;
}

export function pct(x, digits = 0) {
  if (x == null || Number.isNaN(x)) return '—';
  const v = x * 100;
  // Below what the chosen precision can show, say so instead of rounding a real value to zero.
  const shown = Math.max(1, digits);
  const min = 10 ** -shown;
  if (v > 0 && v < min) return `<${min.toFixed(shown)}%`;
  return `${v.toFixed(v < 10 && digits === 0 && v % 1 ? 1 : digits)}%`;
}

export function bytes(b) {
  if (b == null || Number.isNaN(b)) return '—';
  const [text, unit] = scaled(b, 1024, ['B', 'KB', 'MB', 'GB', 'TB'], (v, i) => (v >= 100 || i === 0 ? 0 : 1));
  return `${text} ${unit}`;
}

export function cores(milli) {
  if (milli == null) return '—';
  if (milli < 999.5) return `${Math.round(milli)}m`;
  return `${(milli / 1000).toFixed(2)} cores`;
}

export function ms(v) {
  if (v == null) return '—';
  if (v >= 9_950) return `${(v / 1000).toFixed(0)} s`;
  if (v >= 999.5) return `${(v / 1000).toFixed(1)} s`;
  return `${Math.round(v)} ms`;
}

export const short = (name) => String(name || '').replace(/^flobi-/, '');

/** Tone for an HTTP status. 0 means the client closed the connection before any response (a 4xx-class outcome). */
export function statusClass(s) {
  if (s == null) return 'gray';
  if (s >= 500) return 'red';
  if (s >= 400 || s === 0) return 'orange';
  if (s >= 300) return 'gray';
  return 'green';
}

const UA_RULES = [
  [/iPhone|iPad|iOS/i, 'iOS'],
  [/Android/i, 'Android'],
  [/Mac OS X|Macintosh/i, 'macOS'],
  [/Windows/i, 'Windows'],
  [/Linux/i, 'Linux'],
  [/node-fetch|axios|curl|python|Go-http|okhttp/i, 'Server'],
];
export function uaShort(ua) {
  if (!ua) return '—';
  const os = UA_RULES.find(([re]) => re.test(ua))?.[1] || 'Other';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : null;
  return br && os !== 'Server' ? `${br} · ${os}` : os;
}

const FLAGS = { LB: 'Lebanon', AE: 'UAE', FR: 'France', US: 'United States', SA: 'Saudi Arabia', DE: 'Germany', GB: 'United Kingdom', NL: 'Netherlands', QA: 'Qatar', EG: 'Egypt', JO: 'Jordan', KW: 'Kuwait', TR: 'Türkiye', CA: 'Canada', IN: 'India' };
export const countryName = (c) => FLAGS[c] || c;
