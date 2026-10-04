import { useEffect, useMemo, useState } from 'react';
import { useStore, inspect } from '../lib/store.js';
import { ViewScroll } from '../components/Toolbar.jsx';
import { Card, Segmented, SearchField, Empty, Button, cx, useNow, Pill } from '../components/ui.jsx';
import { ago } from '../lib/format.js';
import Select from '../components/Select.jsx';
import ExportButton from '../components/ExportButton.jsx';
import PastWeekNote from '../components/PastWeek.jsx';

const EVENT_COLUMNS = [
  { label: 'When', get: (e) => new Date(e.at) },
  { label: 'Type', get: (e) => e.type },
  { label: 'Reason', get: (e) => e.reason },
  { label: 'Object', get: (e) => `${e.kind || ''} ${e.name || ''}`.trim() },
  { label: 'Message', get: (e) => e.message || '' },
  { label: 'What it means', get: (e) => (e.type === 'Warning' && EXPLAIN[e.reason]) || '' },
  { label: 'Count', get: (e) => e.count || 1 },
];

const EXPLAIN = {
  BackOff: 'A container keeps crashing, so Kubernetes waits longer before each restart.',
  Unhealthy: 'A health check (readiness or liveness probe) failed.',
  FailedScheduling: "No node had room (CPU/memory) for this pod.",
  OOMKilling: 'The kernel killed a process for using more memory than allowed.',
  Killing: 'Kubernetes stopped a container (restart, rollout or failed liveness probe).',
  Evicted: 'The pod was removed because its node ran low on resources.',
  SuccessfulRescale: 'The autoscaler changed the number of pods.',
  ScalingReplicaSet: 'A deployment rolled out or scaled.',
  FailedMount: 'A volume could not be mounted.',
  Pulled: 'The container image was downloaded.',
  Started: 'A container started.',
  Created: 'A container was created.',
  Scheduled: 'The pod was placed on a node.',
};

export default function Events() {
  const events = useStore((s) => s.sections.events) || [];
  const past = useStore((s) => s.sections.backfill);
  const pastLoaded = past?.status === 'done' || !!past?.since;
  const selected = useStore((s) => (s.inspector?.type === 'event' ? s.inspector.id : null));
  const now = useNow(15_000);
  const [type, setType] = useState('all');
  const [kind, setKind] = useState('all');
  const params = useStore((s) => s.nav.params);
  const [q, setQ] = useState(params?.q || '');
  useEffect(() => {
    if (params?.q != null) setQ(params.q);
  }, [params?.at]);

  const kinds = useMemo(() => [...new Set(events.map((e) => e.kind).filter(Boolean))].sort(), [events]);
  const list = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return events.filter((e) => (type === 'all' || e.type === type) && (kind === 'all' || e.kind === kind) && (!ql || `${e.reason} ${e.name} ${e.message}`.toLowerCase().includes(ql)));
  }, [events, type, kind, q]);
  const warnings = events.filter((e) => e.type === 'Warning').length;
  const filtering = type !== 'all' || kind !== 'all' || q.trim() !== '';
  const clearFilters = () => {
    setType('all');
    setKind('all');
    setQ('');
  };

  return (
    <ViewScroll>
      <div className="flex items-center gap-2 mb-3 flex-wrap animate-rise">
        <Segmented
          value={type}
          onChange={setType}
          options={[
            { value: 'all', label: 'All', count: events.length },
            { value: 'Warning', label: 'Warnings', count: warnings, dot: warnings ? 'orange' : undefined },
            { value: 'Normal', label: 'Normal', count: events.length - warnings },
          ]}
        />
        <Select size="md" value={kind} onChange={setKind} icon="stack" ariaLabel="Object type" options={[{ value: 'all', label: 'All objects' }, ...kinds.map((k) => ({ value: k, label: k, meta: events.filter((e) => e.kind === k).length }))]} />
        <div className="ml-auto flex items-center gap-2">
          <SearchField value={q} onChange={setQ} placeholder="Reason, object, message…" width={260} />
          <ExportButton name="kubernetes-events" title="Kubernetes events" columns={EVENT_COLUMNS} rows={list} />
        </div>
      </div>
      <PastWeekNote kinds={['events']} />
      <Card pad={false} className="overflow-hidden animate-rise" style={{ animationDelay: '60ms' }}>
        {!list.length &&
          (filtering && events.length ? (
            <Empty title="Nothing matches these filters" message={events.length === 1 ? 'Clear them to see the one event.' : `Clear them to see all ${events.length} events.`} action={<Button onClick={clearFilters}>Clear filters</Button>} />
          ) : (
            <Empty title="No events" message={pastLoaded ? 'No warnings, restarts or scaling in the last 7 days.' : 'Kubernetes keeps events for about an hour. Older ones are in the Timeline.'} />
          ))}
        {list.map((e) => (
          <button key={e.id} type="button" onClick={() => inspect('event', e.id, e)} className={cx('w-full text-left grid grid-cols-[76px_150px_minmax(0,1fr)_56px] gap-4 px-4 py-2.5 hairline-b hover:bg-fill-4 items-start', selected === e.id && '!bg-accent-tint')}>
            <span className="text-callout text-label-2 tabular pt-0.5">{ago(e.at, now)}</span>
            <span className="min-w-0">
              <Pill tone={e.type === 'Warning' ? 'orange' : 'gray'} strong={e.type === 'Warning'}>
                {e.reason}
              </Pill>
            </span>
            <span className="min-w-0">
              <span className="text-callout font-semibold">
                {e.kind} <span className="font-mono font-normal text-label-2">{e.name}</span>
              </span>
              <span className="block text-callout text-label-2 mt-0.5 break-words line-clamp-2">{e.message}</span>
              {e.type === 'Warning' && EXPLAIN[e.reason] && <span className="block text-subheadline text-label-3 mt-0.5">{EXPLAIN[e.reason]}</span>}
            </span>
            <span className="text-callout text-label-2 tabular text-right pt-0.5">{e.count > 1 ? `${e.count}×` : ''}</span>
          </button>
        ))}
      </Card>
      {pastLoaded && <p className="text-footnote text-label-3 px-1 mt-2">Kubernetes keeps events for about an hour. Older ones here come from Google's logs: warnings, restarts and scaling from the last 7 days.</p>}
    </ViewScroll>
  );
}

export { EXPLAIN };
