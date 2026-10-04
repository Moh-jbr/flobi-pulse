import { memo, useEffect, useMemo, useState } from 'react';
import { useStore, inspect, navigate } from '../lib/store.js';
import { ViewScroll } from '../components/Toolbar.jsx';
import { Card, Segmented, SearchField, Toggle, Empty, Pill, cx, useNow, Button } from '../components/ui.jsx';
import { Sparkline } from '../components/charts.jsx';
import Icon from '../components/icons.jsx';
import { ago, compact, short, coverage } from '../lib/format.js';
import ExportButton from '../components/ExportButton.jsx';
import PastWeekNote from '../components/PastWeek.jsx';

/** `span`: what a backend count covers ("in 7 days", "since 14:03"). */
const errorColumns = (span) => [
  { label: 'Error', get: (g) => g.title },
  { label: 'Where', get: (g) => (g.source === 'frontend' ? 'Frontend' : 'Backend') },
  { label: 'Service / app', get: (g) => (g.source === 'frontend' ? g.project : short(g.service)) },
  { label: 'Location', get: (g) => g.context || g.culprit || '' },
  { label: span ? `Count (backend: ${span})` : 'Count', get: (g) => g.count },
  { label: 'Last hour', get: (g) => (g.source === 'frontend' ? '' : g.count1h) },
  { label: 'Users affected', get: (g) => (g.source === 'frontend' ? g.users : '') },
  { label: 'Pods', get: (g) => (g.pods || []).join(', ') },
  { label: 'First seen', get: (g) => (g.firstSeen ? new Date(g.firstSeen) : '') },
  { label: 'Last seen', get: (g) => (g.lastSeen ? new Date(g.lastSeen) : '') },
  { label: 'New', get: (g) => (g.isNew ? 'yes' : '') },
  { label: 'Status', get: (g) => g.substatus || '' },
];

// The list can hold a week of error groups and is sent again every second while errors come in:
// a row renders again only when what it shows changed.
const sameRow = (a, b) =>
  a.now === b.now && a.selected === b.selected && a.span === b.span && ['id', 'count', 'count1h', 'lastSeen', 'firstSeen', 'active', 'isNew', 'title', 'context', 'service', 'level', 'substatus', 'users'].every((k) => a.g[k] === b.g[k]) && a.g.pods?.length === b.g.pods?.length && String(a.g.spark) === String(b.g.spark);

const Row = memo(function Row({ g, now, selected, span }) {
  const frontend = g.source === 'frontend';
  const color = frontend ? (g.level === 'fatal' ? 'var(--red)' : g.level === 'warning' ? 'var(--orange)' : 'var(--red)') : 'var(--red)';
  return (
    <button
      type="button"
      onClick={() => inspect('error', g.id)}
      className={cx('w-full text-left grid grid-cols-[4px_minmax(0,1fr)_110px_120px] gap-4 items-center px-4 py-3 hairline-b hover:bg-fill-4 transition-colors', selected && '!bg-accent-tint')}
    >
      <span className="self-stretch rounded-full" style={{ background: g.active ? color : 'var(--fill-1)' }} />
      <div className="min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-headline font-semibold truncate selectable">{g.title}</span>
          {g.isNew && (
            <Pill tone="accent" icon="sparkles" strong>
              New
            </Pill>
          )}
          {frontend && g.substatus && g.substatus !== 'new' && g.substatus !== 'ongoing' && (
            <Pill tone="orange" strong>
              {g.substatus}
            </Pill>
          )}
        </div>
        <div className="text-subheadline text-label-2 mt-1 flex items-center gap-1.5 min-w-0">
          <span className={cx('inline-flex shrink-0 items-center gap-1 px-1.5 h-[18px] rounded-[5px] font-medium whitespace-nowrap', frontend ? 'bg-accent-tint text-accent' : 'bg-fill-3 text-label-2')}>
            <Icon name={frontend ? 'frontends' : 'pod'} size={11} />
            {frontend ? g.project : short(g.service)}
          </span>
          {g.context && <span className="font-mono truncate">{g.context}</span>}
          {frontend && g.culprit && <span className="font-mono truncate">{g.culprit}</span>}
          <span className="text-label-3">·</span>
          <span className="whitespace-nowrap">first {ago(g.firstSeen, now)}</span>
          <span className="text-label-3">·</span>
          <span className="whitespace-nowrap">last {ago(g.lastSeen, now)}</span>
          {frontend ? (
            g.users > 0 && <span className="whitespace-nowrap">· {compact(g.users)} users</span>
          ) : (
            <>
              {g.pods?.length > 0 && <span className="whitespace-nowrap">· {g.pods.length} pod{g.pods.length > 1 ? 's' : ''}</span>}
              {g.count1h > 0 && <span className="whitespace-nowrap">· {compact(g.count1h)} in the last hour</span>}
            </>
          )}
        </div>
      </div>
      <Sparkline data={g.spark} width={110} height={28} color={g.active ? color : 'var(--gray)'} />
      <div className="text-right">
        <div className="text-title3 font-semibold tabular">{compact(g.count)}</div>
        <div className="text-subheadline text-label-3 tabular whitespace-nowrap">{frontend ? 'events' : span}</div>
      </div>
    </button>
  );
}, sameRow);

export default function Errors() {
  const errors = useStore((s) => s.sections.errors);
  const sentry = useStore((s) => s.sections.sentry);
  const params = useStore((s) => s.nav.params);
  const selected = useStore((s) => (s.inspector?.type === 'error' ? s.inspector.id : null));
  const now = useNow(15_000);
  const [source, setSource] = useState(params?.filter?.source || 'all');
  const [activeOnly, setActiveOnly] = useState(false);
  const [q, setQ] = useState(params?.filter?.service || '');

  useEffect(() => {
    if (params?.filter?.source) setSource(params.filter.source);
    if (params?.filter?.service) setQ(params.filter.service);
    if (params?.q != null) setQ(params.q);
  }, [params?.at]);

  const backend = errors?.backend || [];
  const frontend = errors?.frontend || [];
  const list = useMemo(() => {
    let l = source === 'backend' ? backend : source === 'frontend' ? frontend : [...backend, ...frontend];
    if (activeOnly) l = l.filter((g) => g.active);
    const ql = q.trim().toLowerCase();
    // Only the fields an error has: a missing one mustn't turn into the word "undefined".
    if (ql) l = l.filter((g) => [g.title, g.service, g.project, g.context, g.culprit].filter(Boolean).join(' ').toLowerCase().includes(ql));
    return [...l].sort((a, b) => Number(b.active) - Number(a.active) || b.lastSeen - a.lastSeen);
  }, [backend, frontend, source, activeOnly, q]);
  const filtering = source !== 'all' || activeOnly || q.trim() !== '';
  const clearFilters = () => {
    setSource('all');
    setActiveOnly(false);
    setQ('');
  };

  const sentryOff = !sentry || sentry.status === 'off';
  // Backend counts cover the past week once it's loaded from the logs, until then since the app started.
  const span = coverage(errors?.since, now);
  const columns = useMemo(() => errorColumns(span.label), [span.label]);
  return (
    <ViewScroll>
      <div className="flex items-center gap-2 mb-3 flex-wrap animate-rise">
        <Segmented
          value={source}
          onChange={setSource}
          options={[
            { value: 'all', label: 'All', count: backend.length + frontend.length },
            { value: 'backend', label: 'Backend', count: backend.length },
            { value: 'frontend', label: 'Frontend', count: frontend.length },
          ]}
        />
        <label className="inline-flex items-center gap-2 text-callout text-label-2 ml-2">
          <Toggle checked={activeOnly} onChange={setActiveOnly} label="Active in the last hour" /> Active in the last hour
        </label>
        <div className="ml-auto flex items-center gap-2">
          <SearchField value={q} onChange={setQ} placeholder="Message, service, file…" width={260} />
          <ExportButton name="errors" title="Errors" columns={columns} rows={list} />
        </div>
      </div>
      {source !== 'frontend' && <PastWeekNote kinds={['errors']} />}

      {sentryOff && source !== 'backend' && (
        <Card className="mb-3 flex items-center gap-3 animate-rise">
          <div className="w-9 h-9 rounded-xl bg-accent-tint grid place-items-center">
            <Icon name="frontends" size={18} className="text-accent" />
          </div>
          <div className="flex-1">
            <div className="text-headline font-semibold">Connect Sentry to see frontend errors here</div>
            <div className="text-callout text-label-2">Errors from the React apps show up next to backend errors, and new ones trigger alerts.</div>
          </div>
          <Button variant="tinted" onClick={() => navigate({ to: 'settings', tab: 'integrations' })}>
            Connect
          </Button>
        </Card>
      )}
      {sentry?.status === 'error' && source !== 'backend' && (
        <Card className="mb-3 flex items-center gap-3 !bg-orange-tint">
          <Icon name="errors" size={18} className="text-orange" />
          <div className="text-callout">Sentry: {sentry.message}</div>
        </Card>
      )}

      <Card pad={false} className="overflow-hidden animate-rise" style={{ animationDelay: '60ms' }}>
        {list.length ? (
          list.map((g) => <Row key={g.id} g={g} now={now} selected={selected === g.id} span={span.label} />)
        ) : filtering && backend.length + frontend.length > 0 ? (
          <Empty title="Nothing matches these filters" message={backend.length + frontend.length === 1 ? 'Clear them to see the one error.' : `Clear them to see all ${backend.length + frontend.length} errors.`} action={<Button onClick={clearFilters}>Clear filters</Button>} />
        ) : (
          <Empty title="No errors" message={`No backend errors ${span.sentence || 'since the app connected'}. New ones show up here as they happen.`} />
        )}
      </Card>
    </ViewScroll>
  );
}
