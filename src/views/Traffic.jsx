import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useStore, traffic as ring, received, inspect, invoke } from '../lib/store.js';
import { ViewFixed } from '../components/Toolbar.jsx';
import VirtualList from '../components/VirtualList.jsx';
import Select from '../components/Select.jsx';
import { Card, Segmented, SearchField, StatusCode, Button, cx, Toggle, Spinner } from '../components/ui.jsx';
import { StatusColumns, StatusLegend, LatencyBar } from '../components/charts.jsx';
import Icon from '../components/icons.jsx';
import ExportButton from '../components/ExportButton.jsx';
import { clockMs, compact, pct, ms, bytes, uaShort, short } from '../lib/format.js';
import { appOf } from '../lib/apps.js';

/** An error from the main process, without Electron's "Error invoking remote method …" prefix. */
export const cleanError = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export const TRAFFIC_COLUMNS = [
  { label: 'Time', get: (r) => new Date(r.ts) },
  { label: 'Method', get: (r) => r.method },
  { label: 'Status', get: (r) => r.status },
  { label: 'App', get: (r) => appOf(r) || '' },
  { label: 'Host', get: (r) => r.host },
  { label: 'Path', get: (r) => r.path },
  { label: 'Service', get: (r) => (r.service ? short(r.service) : '') },
  { label: 'Latency (ms)', get: (r) => r.latencyMs },
  { label: 'Response size (bytes)', get: (r) => r.respSize },
  { label: 'Request size (bytes)', get: (r) => r.reqSize },
  { label: 'Client', get: (r) => uaShort(r.ua) },
  { label: 'IP', get: (r) => r.ip },
  { label: 'User agent', get: (r) => r.ua },
  { label: 'Referrer', get: (r) => r.referer },
  { label: 'Load balancer status', get: (r) => r.statusDetails || '' },
  { label: 'Trace', get: (r) => (r.trace ? r.trace.split('/').pop() : '') },
];

// Columns follow the table's own width (container queries): narrow windows keep
// Time · Status · App · Path · Service · Latency, wider ones add Method and Host, the widest Size and
// Client. Path is what people read, so every tier leaves it about 200 px.
const GRID = 'grid grid-cols-[84px_52px_84px_minmax(0,1fr)_104px_112px] @4xl:grid-cols-[92px_58px_56px_84px_112px_minmax(0,1fr)_120px_130px] @6xl:grid-cols-[92px_58px_56px_84px_112px_minmax(0,1fr)_120px_130px_70px_120px] items-center gap-3 px-4 @4xl:px-6';

/** Says which app made a request with no Referer: none of them said so. */
const NO_APP = 'No app named itself: a server, a script, a link opened directly, or a live connection (those name no page)';
const WIDE = 'hidden @4xl:block';
const WIDEST = 'hidden @6xl:block';

// Same size as the store's ring of requests.
const TRAFFIC_CAP = 6000;
const TRAFFIC_STREAM = {
  lines: ring,
  get total() {
    return received.traffic;
  },
};

/** Status 0 means the load balancer got no answer at all, because the client left first. */
export const NO_RESPONSE = 'No response: the client closed the connection';

/** Which status filter a request falls under. 0 (no response) counts with the 4xx: the client gave up. */
const statusGroup = (s) => (s >= 500 ? '5xx' : s >= 400 || !s ? '4xx' : s >= 300 ? '3xx' : '2xx');

/** The status chip of a request; a 0 reads as "0" and says why there's no status. */
export function RequestStatus({ status }) {
  if (status) return <StatusCode status={status} />;
  return (
    <span title={NO_RESPONSE} className="inline-flex">
      <StatusCode status={0} />
    </span>
  );
}

// ── Live lists that stay cheap ───────────────────────────────────────────────
// A live list used to copy its whole ring and re-check every row whenever a batch
// arrived (20,000 log lines, several times a second). A feed keeps the filtered list
// instead: each pass only looks at the rows that arrived since the last one, keeps
// time order by merging rather than re-sorting, and stops after a few milliseconds,
// carrying on next frame. It starts over only when what's shown changes (scope,
// source) or the ring dropped rows it hadn't looked at yet. New filters re-check the
// rows already here and swap the result in once it's complete.

const FRAME_BUDGET_MS = 6;
const CHUNK = 256;
const byTs = (a, b) => a.ts - b.ts;

/** Lower-cased search text of a row, made once per row: typing a search re-checks the same rows. */
export function makeSearchText(build) {
  const cache = new WeakMap();
  return (row) => {
    let s = cache.get(row);
    if (s === undefined) cache.set(row, (s = build(row).toLowerCase()));
    return s;
  };
}

function insertByTime(list, row) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (list[mid].ts <= row.ts) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, row);
}

/** Merges rows sorted by time into a list sorted by time. Returns the list (a new one when interleaving many). */
function mergeByTime(list, rows) {
  if (!rows.length) return list;
  if (!list.length || list[list.length - 1].ts <= rows[0].ts) {
    for (const r of rows) list.push(r);
    return list;
  }
  if (rows.length <= 32) {
    for (const r of rows) insertByTime(list, r);
    return list;
  }
  const out = new Array(list.length + rows.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < list.length && j < rows.length) out[k++] = list[i].ts <= rows[j].ts ? list[i++] : rows[j++];
  while (i < list.length) out[k++] = list[i++];
  while (j < rows.length) out[k++] = rows[j++];
  return out;
}

function newFeed(o) {
  const { stream } = o;
  const f = {
    key: o.key,
    base: o.base || null,
    lines: stream.lines,
    accept: o.accept || null,
    byTime: !!o.byTime,
    newestFirst: !!o.newestFirst,
    cap: o.cap,
    ids: o.dedupe ? new Set() : null,
    test: o.test,
    filterKey: o.filterKey,
    refilter: null,
    seqOf: new WeakMap(), // row → its position in the stream (for "N new")
    seen: stream.total - stream.lines.length, // stream rows looked at, counted like stream.total
    src: [], // every row that belongs here, oldest first
    out: [], // the ones passing the filters, in display order
  };
  let base = o.base || [];
  if (f.ids) base = base.filter((r) => !f.ids.has(r.id) && f.ids.add(r.id));
  f.src = f.byTime ? [...base].sort(byTs) : base.slice();
  f.out = f.src.filter(f.test);
  if (f.newestFirst) f.out.reverse();
  return f;
}

function addRows(f, fresh, matched) {
  if (f.byTime) {
    // Array sort is stable, so rows with the same time keep their arrival order in both lists.
    f.src = mergeByTime(f.src, fresh.sort(byTs));
    f.out = mergeByTime(f.out, matched.sort(byTs));
  } else {
    for (const r of fresh) f.src.push(r);
    if (f.newestFirst) f.out = matched.reverse().concat(f.out);
    else for (const r of matched) f.out.push(r);
  }
  const extra = f.src.length - f.cap;
  if (extra > 0) {
    const gone = new Set(f.src.splice(0, extra));
    if (f.ids) for (const r of gone) f.ids.delete(r.id);
    if (f.newestFirst) {
      let k = f.out.length;
      while (k > 0 && gone.has(f.out[k - 1])) k--;
      f.out.length = k;
    } else {
      let k = 0;
      while (k < f.out.length && gone.has(f.out[k])) k++;
      if (k) f.out.splice(0, k);
    }
  }
}

/** One pass: finish re-filtering if the filters changed, then take in what arrived. True when caught up. */
function pump(f, stream, test, filterKey) {
  const deadline = performance.now() + FRAME_BUDGET_MS;
  if (filterKey === f.filterKey) f.refilter = null;
  else {
    if (f.refilter?.filterKey !== filterKey) f.refilter = { filterKey, test, next: [], i: 0 };
    const r = f.refilter;
    while (r.i < f.src.length) {
      const end = Math.min(f.src.length, r.i + CHUNK);
      for (; r.i < end; r.i++) if (r.test(f.src[r.i])) r.next.push(f.src[r.i]);
      if (performance.now() > deadline) return false;
    }
    f.out = f.newestFirst ? r.next.reverse() : r.next;
    f.test = r.test;
    f.filterKey = filterKey;
    f.refilter = null;
  }
  const { lines } = stream;
  const total = stream.total;
  const first = total - lines.length; // stream position of lines[0]
  const start = f.seen - first;
  let i = start;
  const fresh = [];
  const matched = [];
  while (i < lines.length) {
    const end = Math.min(lines.length, i + CHUNK);
    for (; i < end; i++) {
      const r = lines[i];
      if (f.accept && !f.accept(r)) continue;
      if (f.ids) {
        if (f.ids.has(r.id)) continue;
        f.ids.add(r.id);
      }
      f.seqOf.set(r, first + i);
      fresh.push(r);
      if (f.test(r)) matched.push(r);
    }
    if (performance.now() > deadline) break;
  }
  f.seen = first + i;
  if (fresh.length) addRows(f, fresh, matched);
  return i >= lines.length;
}

/**
 * A live list, filtered as rows arrive (see above).
 * @param {object} o
 * @param {string} o.key what's shown; a new key starts over
 * @param {{lines: any[], total: number}} o.stream a ring (oldest first, trimmed at the front) and how many rows it has received in all
 * @param {number} o.version changes when the stream has new rows
 * @param {(row: any) => boolean} o.test the filters, with `o.filterKey` changing whenever they do
 * @param {number} o.cap rows kept
 * @param {(row: any) => boolean} [o.accept] which stream rows belong here at all
 * @param {any[]} [o.base] rows to show before the stream's (a query result); a new array starts over
 * @param {boolean} [o.byTime] keep time order (merging), not arrival order
 * @param {boolean} [o.dedupe] skip rows whose id is already here (when base and stream overlap)
 * @param {boolean} [o.newestFirst] list the newest row first
 * @param {boolean} [o.active] false leaves the feed alone while another list is on screen
 * @returns {{ rows: any[], all: any[], seen: number, newSince: (seen: number) => number }}
 *   rows: filtered, in display order; all: every row that belongs here, oldest first (what
 *   Pause freezes); seen: stream rows taken in so far; newSince(seen): filtered rows that
 *   arrived after that point.
 */
export function useLiveFeed(o) {
  const ref = useRef(null);
  const [tick, setTick] = useState(0);
  const active = o.active !== false;
  const state = useMemo(() => {
    let f = ref.current;
    const { stream } = o;
    if (!f || f.key !== o.key || f.base !== (o.base || null) || f.lines !== stream.lines || stream.total - f.seen > stream.lines.length) f = ref.current = newFeed(o);
    const done = active ? pump(f, stream, o.test, o.filterKey) : true;
    return { f, done };
  }, [o.key, o.base, o.stream.lines, o.version, o.filterKey, active, tick]);
  // Work left over (a big burst, a slow search): carry on next frame.
  useEffect(() => {
    if (state.done) return;
    const id = requestAnimationFrame(() => setTick((t) => t + 1));
    return () => cancelAnimationFrame(id);
  }, [state]);
  const f = state.f;
  return {
    rows: f.out,
    all: f.src,
    seen: f.seen,
    newSince: (seen) => {
      const at = (r) => f.seqOf.get(r) ?? -1;
      let n = 0;
      if (f.newestFirst) while (n < f.out.length && at(f.out[n]) >= seen) n++;
      else while (n < f.out.length && at(f.out[f.out.length - 1 - n]) >= seen) n++;
      return n;
    },
  };
}

function Mini({ label, short: shortLabel, value, tone }) {
  return (
    <div className="min-w-0">
      <div className="text-subheadline text-label-2 truncate">
        {shortLabel ? (
          <>
            <span className="@md:hidden">{shortLabel}</span>
            <span className="hidden @md:inline">{label}</span>
          </>
        ) : (
          label
        )}
      </div>
      <div className={cx('text-title3 @md:text-title2 font-semibold tabular tracking-[-0.01em] whitespace-nowrap', tone === 'red' && 'text-red', tone === 'orange' && 'text-orange')}>{value}</div>
    </div>
  );
}

export function LiveUnavailable({ live }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  if (!live || live.status === 'streaming' || live.status === 'connecting') return null;
  // This computer is offline: nothing's wrong with the stream, it comes back by itself.
  if (live.status === 'offline')
    return (
      <Card className="mx-6 mb-3 flex items-start gap-3 animate-rise">
        <Icon name="info" size={18} className="text-label-2 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-headline font-semibold">You’re offline</div>
          <div className="text-callout text-label-2 mt-0.5">The live stream reconnects by itself once the connection is back. Until then this is the last traffic it saw, and alerts wait.</div>
        </div>
      </Card>
    );
  return (
    <Card className="mx-6 mb-3 flex items-start gap-3 !bg-orange-tint animate-rise">
      <Icon name="errors" size={18} className="text-orange mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-headline font-semibold">{live.status === 'unavailable' ? 'Live stream unavailable' : "Live stream can't connect"}</div>
        <div className="text-callout text-label-2 mt-0.5 selectable">{live.message || 'Waiting for Google Cloud Logging.'}</div>
        <div className="text-subheadline text-label-3 mt-1">Crashes, pods, errors, database and the recap keep working. Errors are checked every 30 seconds meanwhile.</div>
        {error && <div className="text-callout text-red mt-1 selectable">Couldn't try again: {error}</div>}
      </div>
      <Button
        size="sm"
        icon="refresh"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await invoke('live:retry');
            setTimeout(() => setBusy(false), 1500);
          } catch (e) {
            setError(cleanError(e));
            setBusy(false);
          }
        }}
      >
        Try again
      </Button>
    </Card>
  );
}

/** "· 128 new" on the jump-to-newest button. */
export function NewCount({ n }) {
  return n > 0 ? <span className="text-label-2 tabular">· {compact(n)} new</span> : null;
}

const requestSearchText = makeSearchText((r) => `${r.method} ${r.host}${r.path} ${r.ip} ${r.ua} ${r.service || ''} ${r.status} ${appOf(r) || ''}`);

// Renders again only when its own props change, so rows already on screen don't redo their work as requests stream in.
const RequestRow = memo(function RequestRow({ r, rh, selected }) {
  return (
    <button
      type="button"
      onClick={() => inspect('request', r.id, r)}
      data-copy={`https://${r.host}${r.path}`}
      data-copy-label="Copy request URL"
      style={{ height: rh }}
      className={cx(GRID, 'w-full text-left text-callout hairline-b hover:bg-fill-4', selected && '!bg-accent-tint', r.status >= 500 && 'bg-red-tint/40')}
    >
      <span className="tabular text-label-2 font-mono text-subheadline">{clockMs(r.ts)}</span>
      <span className={cx(WIDE, 'font-mono text-subheadline font-semibold text-label-2')}>{r.method}</span>
      <span>
        <RequestStatus status={r.status} />
      </span>
      {appOf(r) ? (
        <span className="truncate text-label" title={r.referer}>
          {appOf(r)}
        </span>
      ) : (
        <span className="text-label-4" title={NO_APP}>
          —
        </span>
      )}
      <span className={cx(WIDE, 'truncate text-label-2')}>{r.host}</span>
      <span className="truncate font-mono text-subheadline" title={`${r.method} ${r.host}${r.path}`}>
        <span className="@4xl:hidden font-semibold text-label-2 mr-1.5">{r.method}</span>
        {r.path}
      </span>
      <span className="truncate text-label-2">{r.service ? short(r.service) : '—'}</span>
      <LatencyBar ms={r.latencyMs} />
      <span className={cx(WIDEST, 'text-right tabular text-label-2')}>{bytes(r.respSize)}</span>
      <span className={cx(WIDEST, 'truncate text-label-3')}>{uaShort(r.ua)}</span>
    </button>
  );
});

export default function Traffic() {
  const version = useStore((s) => s.trafficVersion);
  const stats = useStore((s) => s.sections.traffic);
  const live = useStore((s) => s.sections.sources?.live);
  const params = useStore((s) => s.nav.params);
  const selected = useStore((s) => (s.inspector?.type === 'request' ? s.inspector.id : null));
  const [status, setStatus] = useState(params?.filter?.status || 'all');
  const [host, setHost] = useState('all');
  const [app, setApp] = useState('all');
  const [service, setService] = useState(params?.filter?.service || '');
  const [q, setQ] = useState('');
  const [slow, setSlow] = useState(false);
  const [follow, setFollow] = useState(true);
  // Snapshot while paused. `by: 'scroll'` = you scrolled away from the newest
  // rows, so the list holds still until you come back (or press Jump to newest).
  const [paused, setPaused] = useState(null); // { rows, by: 'user'|'scroll', seen }

  useEffect(() => {
    if (params?.filter?.status) setStatus(params.filter.status);
    if (params?.filter?.service !== undefined) setService(params.filter.service || '');
    if (params?.filter?.q != null) setQ(params.filter.q);
  }, [params?.at]);

  const hosts = useMemo(() => {
    const m = new Map();
    for (const r of ring.slice(-2000)) m.set(r.host, (m.get(r.host) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([h]) => h);
  }, [Math.floor(version / 20)]);
  // The apps seen lately, busiest first ('' = requests no app named itself on).
  const apps = useMemo(() => {
    const m = new Map();
    for (const r of ring.slice(-2000)) m.set(appOf(r) || '', (m.get(appOf(r) || '') || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([a]) => a);
  }, [Math.floor(version / 20)]);

  const ql = q.trim().toLowerCase();
  const filterKey = [status, host, app, service, slow, ql].join('\u0000');
  const test = useMemo(
    () => (r) => (status === 'all' || statusGroup(r.status) === status) && (host === 'all' || r.host === host) && (app === 'all' || (appOf(r) || '') === app) && (!service || r.service === service) && (!slow || r.latencyMs >= 1000) && (!ql || requestSearchText(r).includes(ql)),
    [filterKey],
  );
  const feed = useLiveFeed({ key: 'traffic', stream: TRAFFIC_STREAM, version, test, filterKey, cap: TRAFFIC_CAP, newestFirst: true });
  // The rows frozen on screen, filtered again only when the filters change.
  const pausedItems = useMemo(() => {
    if (!paused) return null;
    const out = [];
    for (let i = paused.rows.length - 1; i >= 0; i--) if (test(paused.rows[i])) out.push(paused.rows[i]);
    return out;
  }, [paused, test]);
  const items = pausedItems || feed.rows;

  const freeze = (by) => setPaused({ rows: feed.all.slice(), by, seen: feed.seen });
  const onFollowChange = (f) => {
    setFollow(f);
    if (!f && !paused) freeze('scroll');
    if (f && paused?.by === 'scroll') setPaused(null);
  };
  const jumpToNewest = () => {
    setPaused(null);
    setFollow(true);
  };

  // The legend counts the same 2 minutes the chart shows.
  const chartCounts = useMemo(() => {
    const rows = stats?.perSecond;
    if (!rows?.length) return stats?.byClass;
    const c = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
    for (const r of rows) {
      c['2xx'] += r.c2 || 0;
      c['3xx'] += r.c3 || 0;
      c['4xx'] += r.c4 || 0;
      c['5xx'] += r.c5 || 0;
    }
    return c;
  }, [stats?.perSecond, stats?.byClass]);

  const rh = useStore((s) => s.info?.settings?.appearance?.density) === 'compact' ? 26 : 30;
  const src = paused?.rows || feed.all;
  const filtering = status !== 'all' || host !== 'all' || app !== 'all' || !!service || slow || q.trim() !== '';
  const clearFilters = () => {
    setStatus('all');
    setHost('all');
    setApp('all');
    setService('');
    setSlow(false);
    setQ('');
  };
  const failures = Object.entries(stats?.failureDetails || {})
    .map(([k, v]) => `${v}× ${k.replace(/_/g, ' ')}`)
    .join(', ');
  const what = [status !== 'all' && status, app !== 'all' && (app || 'no app'), host !== 'all' && host, service && short(service), slow && 'slower than 1 s', q.trim() && `“${q.trim()}”`].filter(Boolean).join(' · ');

  return (
    <ViewFixed>
      <div className="px-6 pt-1 pb-3 grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-4 xl:gap-6 items-stretch animate-rise">
        <Card className="@container flex flex-col justify-between gap-3 min-w-0">
          <div className="grid grid-cols-4 gap-3 @md:gap-4">
            <Mini label="Requests / min" short="Req/min" value={stats ? compact(stats.rpm) : '—'} />
            <Mini label="5xx" value={stats ? pct(stats.errorRate, 2) : '—'} tone={stats?.errorRate >= 0.05 ? 'red' : stats?.errorRate >= 0.01 ? 'orange' : null} />
            <Mini label="4xx" value={stats ? pct(stats.rate4xx, 1) : '—'} />
            <Mini label="p95" value={stats?.p95 != null ? ms(stats.p95) : '—'} tone={stats?.p95 >= 3000 ? 'orange' : null} />
          </div>
          <div className="grid grid-cols-2 gap-4 pt-3 hairline-t text-callout">
            <div className="min-w-0">
              <div className="text-subheadline text-label-2">Busiest path</div>
              <div className="font-mono text-subheadline truncate" title={stats?.topPaths?.[0]?.path}>
                {stats?.topPaths?.[0] ? `${stats.topPaths[0].path} · ${compact(stats.topPaths[0].count)}` : '—'}
              </div>
            </div>
            <div className="min-w-0">
              <div className="text-subheadline text-label-2">Latency</div>
              <div className="tabular truncate" title={failures || undefined}>
                p50 {ms(stats?.p50)} · p99 {ms(stats?.p99)}
                {failures && <span className="text-red"> · {failures}</span>}
              </div>
            </div>
          </div>
        </Card>
        <Card className="flex flex-col gap-2 min-w-0">
          <div className="flex items-center justify-between">
            <div className="text-headline font-semibold">Requests per second · last 2 minutes</div>
            <StatusLegend counts={chartCounts} />
          </div>
          <StatusColumns rows={stats?.perSecond || []} height={84} />
        </Card>
      </div>

      <LiveUnavailable live={live} />

      <div className="px-6 pb-3 flex items-center gap-2 flex-wrap">
        <Segmented
          size="sm"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'all', label: 'All' },
            { value: '2xx', label: '2xx' },
            { value: '3xx', label: '3xx' },
            { value: '4xx', label: '4xx', dot: 'orange' },
            { value: '5xx', label: '5xx', dot: 'red' },
          ]}
        />
        <Select value={app} onChange={setApp} icon="frontends" ariaLabel="App" options={[{ value: 'all', label: 'All apps' }, ...apps.map((a) => ({ value: a, label: a || 'No app' }))]} />
        <Select value={host} onChange={setHost} icon="globe" ariaLabel="Host" options={[{ value: 'all', label: 'All hosts' }, ...hosts.map((h) => ({ value: h, label: h }))]} />
        {service && (
          <button type="button" onClick={() => setService('')} className="h-6 px-2.5 rounded-full bg-accent-tint text-accent text-callout inline-flex items-center gap-1">
            {short(service)} <Icon name="x" size={10} strokeWidth={2.4} />
          </button>
        )}
        <label className="no-drag inline-flex items-center gap-2 text-callout text-label-2 ml-1">
          <Toggle checked={slow} onChange={setSlow} label="Slow only" /> Slower than 1 s
        </label>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-subheadline text-label-3 tabular">{compact(items.length)} shown</span>
          <SearchField value={q} onChange={setQ} placeholder="Path, app, IP, client, status…" width={240} />
          <Button
            size="sm"
            variant={paused?.by === 'user' ? 'tinted' : 'secondary'}
            icon={paused?.by === 'user' ? 'play' : 'pause'}
            onClick={() => {
              if (paused?.by === 'user') jumpToNewest();
              else freeze('user');
            }}
          >
            {paused?.by === 'user' ? 'Resume' : 'Pause'}
          </Button>
          <ExportButton name="live-traffic" title="Live traffic" columns={TRAFFIC_COLUMNS} rows={items} />
        </div>
      </div>

      <div className="@container flex-1 min-h-0 relative mx-6 mb-4 card overflow-hidden">
        <VirtualList
          className="absolute inset-0"
          items={items}
          rowHeight={rh}
          reverse
          follow={follow && !paused}
          onFollowChange={onFollowChange}
          header={
            <div className={cx(GRID, 'h-8 bg-elevated text-subheadline font-semibold text-label-2 hairline-b')}>
              <span>Time</span>
              <span className={WIDE}>Method</span>
              <span>Status</span>
              <span>App</span>
              <span className={WIDE}>Host</span>
              <span>Path</span>
              <span>Service</span>
              <span>Latency</span>
              <span className={cx(WIDEST, 'text-right')}>Size</span>
              <span className={WIDEST}>Client</span>
            </div>
          }
          getKey={(r) => r.id}
          empty={
            <div className="grid place-items-center py-16 px-8 text-center text-callout text-label-2">
              {src.length && filtering ? (
                <>
                  <span>
                    No requests match {what} in the last {compact(src.length)} requests{paused ? ' (paused)' : ''}. {status === '5xx' ? 'Nothing is failing right now. ' : ''}Matching requests show up here as they come in.
                  </span>
                  <Button size="sm" className="mt-3" onClick={clearFilters}>
                    Clear filters
                  </Button>
                </>
              ) : live?.status === 'streaming' || !live ? (
                <span className="inline-flex items-center gap-2">
                  <Spinner /> Waiting for requests…
                </span>
              ) : (
                'No live requests to show.'
              )}
            </div>
          }
          renderRow={(r) => <RequestRow key={r.id} r={r} rh={rh} selected={selected === r.id} />}
        />
        {paused?.by === 'scroll' && (
          <button type="button" onClick={jumpToNewest} className="absolute top-10 left-1/2 -translate-x-1/2 bg-elevated shadow-[var(--shadow-pop)] h-7 px-3 rounded-full text-callout font-medium inline-flex items-center gap-1.5 animate-toast z-20">
            <Icon name="follow" size={13} style={{ transform: 'rotate(180deg)' }} /> Jump to newest
            <NewCount n={feed.newSince(paused.seen)} />
          </button>
        )}
      </div>
    </ViewFixed>
  );
}
