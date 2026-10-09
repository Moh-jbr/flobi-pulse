// The Services table's rules, kept apart from its React so they can be tested: which colour each
// part of a row takes, which columns fit, and the order of the rows.
import { usageOf, memWarning } from './usage.js';

/** The ways Overview can show its services; the first is the default. */
export const SERVICES_VIEWS = ['table', 'cards'];

/** Cards or table, from the app's settings: the table unless cards were picked. */
export const servicesView = (settings) => (SERVICES_VIEWS.includes(settings?.views?.services) ? settings.views.services : SERVICES_VIEWS[0]);

export const HEALTH_ORDER = { down: 0, degraded: 1, deploying: 2, healthy: 3, idle: 4 };

const MIN = 60_000;

/**
 * How worried each part of a row looks: null, 'orange' (warning) or 'red' (danger). A down or
 * degraded row takes its colour, and inside it only the figures that made it so (the cards' rule).
 * A row is also orange (or red) whenever any of its figures is: memory about to run out (red under
 * 5 minutes, which makes even a degraded row red), errors from 5 a minute, or a restart in the last
 * 15 minutes. `warning` names what is wrong on a row whose service still reads healthy, for its Health
 * column (and its card's pill).
 */
export function levelsOf(s) {
  const problem = s.health === 'down' || s.health === 'degraded';
  const tone = s.health === 'down' ? 'red' : 'orange';
  const caused = (k) => (problem && s.causes?.includes(k) ? tone : null);
  const memSoon = memWarning(s.memEta) ? (s.memEta < 5 * MIN ? 'red' : 'orange') : null;
  const errors = s.errorsPerMin >= 5 ? 'orange' : null;
  const restarts = caused('restarts') || (s.recentRestarts > 0 ? 'orange' : null);
  const quiet = !problem && s.health !== 'deploying';
  const warning = !quiet ? null : memSoon ? { label: 'Memory rising', tone: memSoon } : errors ? { label: 'Many errors', tone: 'orange' } : restarts ? { label: 'Restarted', tone: 'orange' } : null;
  return {
    row: problem ? (memSoon === 'red' ? 'red' : tone) : memSoon || (errors || restarts ? 'orange' : null),
    warning,
    cpu: caused('cpu'),
    mem: caused('mem') || memSoon,
    pods: caused('pods'),
    restarts,
    errors,
  };
}

/** The line under a row's name: what is wrong with it, in words. */
export function notesOf(s) {
  const problem = s.health === 'down' || s.health === 'degraded';
  const mem = memWarning(s.memEta);
  const err = s.errorsPerMin >= 5 && !problem ? `${Math.round(s.errorsPerMin)} errors a minute` : null;
  const restarts = s.recentRestarts > 0 && !problem ? `${s.recentRestarts} restart${s.recentRestarts > 1 ? 's' : ''} in the last 15 min` : null;
  return [mem, ...(problem ? s.reasons || [] : []), err, restarts].filter(Boolean);
}

/** Whether a service matches what was typed in the table's search: its name, workload or a public address. */
export function matchesQuery(s, q) {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [s.short, s.name, ...(s.hosts || [])].join(' ').toLowerCase();
  return words.every((w) => hay.includes(w));
}

/**
 * The columns, with the narrowest each can be (`w`, px: its widest value or its header with the sort
 * arrow, plus the cell's 8 px either side; Health fits "Memory rising"). `first` is the order a first click on the
 * header sorts in: worst first wherever that makes sense (fewest pods ready, most CPU, most errors).
 */
export const COLUMNS = [
  { key: 'service', label: 'Service', w: 140, track: 'minmax(140px,1.5fr)', first: 'asc', by: (s) => s.short },
  { key: 'health', label: 'Health', w: 120, compactW: 34, first: 'asc', by: (s) => HEALTH_ORDER[s.health] ?? 5 },
  { key: 'cpu', label: 'CPU', w: 60, first: 'desc', by: (s, u) => u.cpu ?? -1 },
  { key: 'mem', label: 'Memory', w: 76, first: 'desc', by: (s, u) => u.mem ?? -1 },
  { key: 'pods', label: 'Pods', w: 92, first: 'asc', by: (s) => (s.desired ? s.ready / s.desired : 2) },
  { key: 'errors', label: 'Err/min', w: 72, first: 'desc', by: (s) => s.errorsPerMin || 0 },
  { key: 'rpm', label: 'Req/min', w: 76, first: 'desc', by: (s) => (s.hosts?.length && s.rpm != null ? s.rpm : -1) },
  { key: 'restarts', label: 'Restarts', w: 80, first: 'desc', by: (s) => s.restarts || 0 },
  { key: 'hour', label: 'Last hour', w: 88, track: 'minmax(88px,1fr)', by: null },
];

/** The table's side padding (px-1.5 on each side). */
export const TABLE_PAD = 12;
/** Least important first: what a narrow table gives up, in order, before it squeezes Health to a dot. */
const DROP = ['hour', 'restarts', 'rpm', 'pods', 'errors'];

const need = (cols, compact) => TABLE_PAD + cols.reduce((a, c) => a + (compact && c.compactW ? c.compactW : c.w), 0);

/**
 * The columns a table this wide shows: every one when they fit at their narrowest, else it drops the
 * least important until they do, and last of all shows Health as a dot (`compact`). Service, Health,
 * CPU and Memory always stay.
 */
export function fitColumns(width) {
  let cols = COLUMNS;
  for (const key of DROP) {
    if (need(cols, false) <= width) break;
    cols = cols.filter((c) => c.key !== key);
  }
  const compact = need(cols, false) > width;
  return { cols, compact, template: cols.map((c) => (compact && c.compactW ? `${c.compactW}px` : c.track || `${c.w}px`)).join(' ') };
}

export const DEFAULT_SORT = { key: 'health', dir: 'asc' };

export const isDefaultSort = (sort) => sort.key === DEFAULT_SORT.key && sort.dir === DEFAULT_SORT.dir;

/**
 * The sort a click on a column's header asks for. The first click sorts the column its usual way,
 * the second the other way round, and the third takes the sort off again (back to worst first).
 */
export function nextSort(sort, col) {
  const first = col.first || 'asc';
  if (sort.key !== col.key) return { key: col.key, dir: first };
  if (sort.dir === first) return { key: col.key, dir: first === 'asc' ? 'desc' : 'asc' };
  return DEFAULT_SORT;
}

const URGENCY = { red: 0, orange: 1 };

/**
 * Rows in the table's order. Whatever it is sorted by, the red rows come first and the orange ones
 * next, so nothing in trouble is ever scrolled out of sight; inside each of those groups (and among
 * the rest) it is the chosen column, then health, then name.
 */
export function sortServices(list, sort, metricsSource) {
  const col = COLUMNS.find((c) => c.key === sort?.key && c.by) || COLUMNS[1];
  const sign = sort?.dir === 'desc' ? -1 : 1;
  const rows = list.map((s) => ({ s, u: usageOf(s, metricsSource), urgency: URGENCY[levelsOf(s).row] ?? 2 }));
  rows.sort((a, b) => {
    const x = col.by(a.s, a.u);
    const y = col.by(b.s, b.u);
    const c = typeof x === 'string' ? x.localeCompare(y) : x - y;
    return a.urgency - b.urgency || sign * c || (HEALTH_ORDER[a.s.health] ?? 5) - (HEALTH_ORDER[b.s.health] ?? 5) || a.s.short.localeCompare(b.s.short);
  });
  return rows.map((r) => r.s);
}

/**
 * What a service's error lines say: its error groups seen in the last hour, the ones firing now
 * first (the last 5 minutes, then the hour). These are lines the service logged as errors while
 * it kept running, which is why they never show among crashes.
 */
export function errorsOfService(groups, service, limit = 5) {
  return (groups || [])
    .filter((g) => g.service === service && g.count1h > 0)
    .map((g) => ({ ...g, count5m: (g.spark || []).slice(-5).reduce((a, n) => a + n, 0) }))
    .sort((a, b) => b.count5m - a.count5m || b.count1h - a.count1h || b.lastSeen - a.lastSeen)
    .slice(0, limit);
}
