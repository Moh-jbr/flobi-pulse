import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, traffic as ring, received, inspect, invoke } from '../lib/store.js';
import { ViewFixed } from '../components/Toolbar.jsx';
import VirtualList from '../components/VirtualList.jsx';
import Select from '../components/Select.jsx';
import { Card, Segmented, SearchField, StatusCode, Button, cx, Toggle, Spinner } from '../components/ui.jsx';
import { StatusColumns, StatusLegend, LatencyBar } from '../components/charts.jsx';
import Icon from '../components/icons.jsx';
import { clockMs, compact, pct, ms, bytes, uaShort, short } from '../lib/format.js';

// Columns follow the table's own width (container queries): narrow windows keep
// Time · Status · Path · Service · Latency, wider ones add Method, Host, Size, Client.
const GRID = 'grid grid-cols-[84px_52px_minmax(0,1fr)_104px_112px] @4xl:grid-cols-[92px_58px_56px_150px_minmax(0,1fr)_120px_130px_70px] @6xl:grid-cols-[92px_58px_56px_150px_minmax(0,1fr)_120px_130px_70px_120px] items-center gap-3 px-4 @4xl:px-6';
const WIDE = 'hidden @4xl:block';
const WIDEST = 'hidden @6xl:block';

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
  if (!live || live.status === 'streaming' || live.status === 'connecting') return null;
  return (
    <Card className="mx-6 mb-3 flex items-start gap-3 !bg-orange-tint animate-rise">
      <Icon name="errors" size={18} className="text-orange mt-0.5 shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-headline font-semibold">{live.status === 'unavailable' ? 'Live stream unavailable' : "Live stream can't connect"}</div>
        <div className="text-callout text-label-2 mt-0.5 selectable">{live.message || 'Waiting for Google Cloud Logging.'}</div>
        <div className="text-subheadline text-label-3 mt-1">Crashes, pods, errors, database and the recap keep working. Errors are checked every 30 seconds meanwhile.</div>
      </div>
      <Button
        size="sm"
        icon="refresh"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          await invoke('live:retry');
          setTimeout(() => setBusy(false), 1500);
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

export default function Traffic() {
  const version = useStore((s) => s.trafficVersion);
  const stats = useStore((s) => s.sections.traffic);
  const live = useStore((s) => s.sections.sources?.live);
  const params = useStore((s) => s.nav.params);
  const selected = useStore((s) => (s.inspector?.type === 'request' ? s.inspector.id : null));
  const [status, setStatus] = useState(params?.filter?.status || 'all');
  const [host, setHost] = useState('all');
  const [service, setService] = useState(params?.filter?.service || '');
  const [q, setQ] = useState('');
  const [slow, setSlow] = useState(false);
  const [follow, setFollow] = useState(true);
  // Snapshot while paused. `by: 'scroll'` = you scrolled away from the newest
  // rows, so the list holds still until you come back (or press Jump to newest).
  const [paused, setPaused] = useState(null); // { rows, by: 'user'|'scroll', at: received count }
  // The exact rows on screen right now, so freezing never shifts them.
  const onScreen = useRef({ rows: [], at: 0 });
  const freeze = (by) => setPaused({ rows: onScreen.current.rows, by, at: onScreen.current.at });
  const onFollowChange = (f) => {
    setFollow(f);
    if (!f && !paused) freeze('scroll');
    if (f && paused?.by === 'scroll') setPaused(null);
  };
  const jumpToNewest = () => {
    setPaused(null);
    setFollow(true);
  };

  useEffect(() => {
    if (params?.filter?.status) setStatus(params.filter.status);
    if (params?.filter?.service !== undefined) setService(params.filter.service || '');
  }, [params?.at]);

  const hosts = useMemo(() => {
    const m = new Map();
    for (const r of ring.slice(-2000)) m.set(r.host, (m.get(r.host) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([h]) => h);
  }, [Math.floor(version / 20)]);

  const items = useMemo(() => {
    const src = paused?.rows || ring.slice();
    if (!paused) onScreen.current = { rows: src, at: received.traffic };
    const ql = q.trim().toLowerCase();
    const out = [];
    for (let i = src.length - 1; i >= 0; i--) {
      const r = src[i];
      if (status !== 'all') {
        const c = r.status >= 500 || !r.status ? '5xx' : r.status >= 400 ? '4xx' : r.status >= 300 ? '3xx' : '2xx';
        if (c !== status) continue;
      }
      if (host !== 'all' && r.host !== host) continue;
      if (service && r.service !== service) continue;
      if (slow && !(r.latencyMs >= 1000)) continue;
      if (ql && !`${r.method} ${r.host}${r.path} ${r.ip} ${r.ua} ${r.service || ''} ${r.status}`.toLowerCase().includes(ql)) continue;
      out.push(r);
    }
    return out;
  }, [paused ? 0 : version, paused, status, host, service, slow, q]);

  const rh = document.documentElement.dataset.density === 'compact' ? 26 : 30;
  const src = paused?.rows || ring;
  const filtering = status !== 'all' || host !== 'all' || !!service || slow || q.trim() !== '';
  const clearFilters = () => {
    setStatus('all');
    setHost('all');
    setService('');
    setSlow(false);
    setQ('');
  };
  const failures = Object.entries(stats?.failureDetails || {})
    .map(([k, v]) => `${v}× ${k.replace(/_/g, ' ')}`)
    .join(', ');
  const what = [status !== 'all' && status, host !== 'all' && host, service && short(service), slow && 'slower than 1 s', q.trim() && `“${q.trim()}”`].filter(Boolean).join(' · ');

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
            <StatusLegend counts={stats?.byClass} />
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
          <SearchField value={q} onChange={setQ} placeholder="Path, IP, client, status…" width={240} />
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
              <span className={WIDE}>Host</span>
              <span>Path</span>
              <span>Service</span>
              <span>Latency</span>
              <span className={cx(WIDE, 'text-right')}>Size</span>
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
          renderRow={(r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => inspect('request', r.id, r)}
              data-copy={`${r.method} https://${r.host}${r.path}`}
              data-copy-label="Copy request URL"
              style={{ height: rh }}
              className={cx(GRID, 'w-full text-left text-callout hairline-b hover:bg-fill-4', selected === r.id && '!bg-accent-tint', r.status >= 500 && 'bg-red-tint/40')}
            >
              <span className="tabular text-label-2 font-mono text-subheadline">{clockMs(r.ts)}</span>
              <span className={cx(WIDE, 'font-mono text-subheadline font-semibold text-label-2')}>{r.method}</span>
              <span>
                <StatusCode status={r.status} />
              </span>
              <span className={cx(WIDE, 'truncate text-label-2')}>{r.host}</span>
              <span className="truncate font-mono text-subheadline" title={`${r.method} ${r.host}${r.path}`}>
                <span className="@4xl:hidden font-semibold text-label-2 mr-1.5">{r.method}</span>
                {r.path}
              </span>
              <span className="truncate text-label-2">{r.service ? short(r.service) : '—'}</span>
              <LatencyBar ms={r.latencyMs} />
              <span className={cx(WIDE, 'text-right tabular text-label-2')}>{bytes(r.respSize)}</span>
              <span className={cx(WIDEST, 'truncate text-label-3')}>{uaShort(r.ua)}</span>
            </button>
          )}
        />
        {paused?.by === 'scroll' && (
          <button type="button" onClick={jumpToNewest} className="absolute top-10 left-1/2 -translate-x-1/2 bg-elevated shadow-[var(--shadow-pop)] h-7 px-3 rounded-full text-callout font-medium inline-flex items-center gap-1.5 animate-toast z-20">
            <Icon name="follow" size={13} style={{ transform: 'rotate(180deg)' }} /> Jump to newest
            <NewCount n={received.traffic - paused.at} />
          </button>
        )}
      </div>
    </ViewFixed>
  );
}
