// Formatting helpers.

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' });

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
  return rtf.format(-Math.round(d / 30), 'month');
}

export function duration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
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

export function clock(ts, withSeconds = true) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}), hour12: false });
}

export function clockMs(ts) {
  const d = new Date(ts);
  return `${clock(ts)}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

export function dayTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  const same = (a, b) => a.toDateString() === b.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  if (same(d, today)) return `Today ${time}`;
  if (same(d, yesterday)) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

export function num(n, digits = 0) {
  if (n == null || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function compact(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(a >= 1e10 ? 0 : 1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(0)}K`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  if (a >= 100 || Number.isInteger(n)) return String(Math.round(n));
  return n.toFixed(1);
}

export function pct(x, digits = 0) {
  if (x == null || Number.isNaN(x)) return '—';
  const v = x * 100;
  if (v > 0 && v < 0.1 && digits < 2) return '<0.1%';
  return `${v.toFixed(v < 10 && digits === 0 && v % 1 ? 1 : digits)}%`;
}

export function bytes(b) {
  if (b == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

export function cores(milli) {
  if (milli == null) return '—';
  if (milli < 1000) return `${Math.round(milli)}m`;
  return `${(milli / 1000).toFixed(2)} cores`;
}

export function ms(v) {
  if (v == null) return '—';
  if (v >= 10_000) return `${(v / 1000).toFixed(0)} s`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)} s`;
  return `${Math.round(v)} ms`;
}

export const short = (name) => String(name || '').replace(/^flobi-/, '');

export function statusClass(s) {
  if (!s) return 'gray';
  if (s >= 500) return 'red';
  if (s >= 400) return 'orange';
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
