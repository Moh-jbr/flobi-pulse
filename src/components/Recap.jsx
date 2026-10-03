import { useMemo, useRef, useState } from 'react';
import { navigate, setState } from '../lib/store.js';
import Icon from './icons.jsx';
import { cx, SEV_TONE, TONE } from './ui.jsx';
import { dayTime, duration, compact, clock, short, day } from '../lib/format.js';

/** Incidents as table rows (Export on Timeline and in the recap sheet). */
export const INCIDENT_COLUMNS = [
  { label: 'Started', get: (i) => new Date(i.start) },
  { label: 'Ended', get: (i) => (i.end ? new Date(i.end) : '') },
  { label: 'Lasted (min)', get: (i) => (i.end > i.start ? Math.round((i.end - i.start) / 6000) / 10 : '') },
  { label: 'Severity', get: (i) => i.severity },
  { label: 'Kind', get: (i) => i.kind },
  { label: 'What happened', get: (i) => i.title },
  { label: 'Details', get: (i) => i.detail || '' },
];

const KIND_ICON = { crash: 'bolt', http: 'traffic', event: 'events', node: 'infrastructure', errors: 'errors', database: 'database', frontend: 'frontends', edge: 'globe', deploy: 'rocket', costs: 'receipt' };

/** Incidents oldest first, the order the recap builds them in (a copy: the list belongs to the store). */
export const byStart = (incidents) => [...(incidents || [])].sort((a, b) => a.start - b.start);

/** "Today", "Yesterday" or "Mon, 28 Sep": the day part of dayTime(), worked out directly so it holds in every locale. */
const lasted = (inc) => (inc.end > inc.start + 60_000 ? `for ${duration(inc.end - inc.start)}` : '');

export function SummaryChips({ summary }) {
  if (!summary) return null;
  const chips = [
    summary.critical ? { n: summary.critical, l: 'critical', tone: 'red' } : null,
    summary.warning ? { n: summary.warning, l: summary.warning === 1 ? 'warning' : 'warnings', tone: 'orange' } : null,
    { n: summary.restartsExact === false && summary.restarts ? `${summary.restarts}+` : summary.restarts, l: summary.restarts === 1 && summary.restartsExact !== false ? 'restart' : 'restarts', tone: summary.restarts ? 'orange' : 'gray' },
    { n: summary.errors, l: 'error logs', tone: 'gray' },
    summary.failedRequests != null ? { n: summary.failedRequests, l: 'failed requests', tone: summary.failedRequests ? 'orange' : 'gray' } : null,
    summary.outageMinutes ? { n: `${summary.outageMinutes}m`, l: 'of outage', tone: 'red' } : null,
    summary.newErrorTypes ? { n: summary.newErrorTypes, l: 'new error types', tone: 'accent' } : null,
    summary.frontendIssues ? { n: summary.frontendIssues, l: 'new frontend errors', tone: 'accent' } : null,
    { n: summary.deploys, l: summary.deploys === 1 ? 'deploy' : 'deploys', tone: 'gray' },
  ].filter(Boolean);
  return (
    <div className="flex flex-wrap gap-2">
      {chips.map((c) => (
        <span key={c.l} className={cx('inline-flex items-baseline gap-1.5 h-8 px-3 rounded-full text-callout', TONE[c.tone].bg)}>
          <span className={cx('text-title3 font-semibold tabular leading-8', c.tone !== 'gray' && TONE[c.tone].fg)}>{typeof c.n === 'number' ? compact(c.n) : c.n}</span>
          <span className="text-label-2">{c.l}</span>
        </span>
      ))}
    </div>
  );
}

/** Horizontal strip: each incident is a bar positioned in time; deploys are ticks. */
export function TimelineStrip({ recap }) {
  const ref = useRef(null);
  const [hover, setHover] = useState(null);
  const { since, until, incidents = [], deploys = [] } = recap;
  const span = Math.max(1, until - since);
  const endOf = (inc) => Math.max(inc.start, inc.end ?? until);
  // Which row each bar sits on, so overlapping incidents don't hide each other. Kept here:
  // the incidents belong to the store and are never written to.
  const { lanes, laneOf } = useMemo(() => {
    const ends = [];
    const laneOf = new Map();
    for (const inc of byStart(incidents)) {
      let lane = ends.findIndex((end) => end + span * 0.01 < inc.start);
      if (lane < 0) {
        lane = ends.length;
        ends.push(0);
      }
      ends[lane] = Math.max(endOf(inc), inc.start + span * 0.012);
      laneOf.set(inc, lane);
    }
    return { lanes: Math.max(1, ends.length), laneOf };
  }, [incidents, span, until]);
  const x = (t) => `${((t - since) / span) * 100}%`;
  const ticks = 6;
  return (
    <div ref={ref} className="relative select-none" onMouseLeave={() => setHover(null)}>
      <div className="relative rounded-xl bg-fill-4" style={{ height: lanes * 16 + 20 }}>
        {Array.from({ length: ticks + 1 }, (_, i) => (
          <span key={i} className="absolute top-0 bottom-0 w-px bg-separator" style={{ left: `${(i / ticks) * 100}%` }} />
        ))}
        {deploys.map((d, i) => (
          <span key={i} title={`Deploy: ${d.service} · ${dayTime(d.at)}`} className="absolute top-1 bottom-1 w-[2px] rounded-full bg-accent/70" style={{ left: x(d.at) }} />
        ))}
        {incidents.map((inc) => (
          <button
            key={inc.id}
            type="button"
            aria-label={[inc.title, dayTime(inc.start), lasted(inc)].filter(Boolean).join(', ')}
            onMouseEnter={() => setHover(inc)}
            onFocus={() => setHover(inc)}
            onBlur={() => setHover(null)}
            onClick={() => inc.view && (setState({ recapOpen: false }), navigate(inc.view))}
            className={cx('absolute h-3 rounded-full hover:brightness-110 transition-[filter]', inc.severity === 'critical' ? 'bg-red' : 'bg-orange')}
            style={{ left: x(inc.start), width: `max(8px, ${((endOf(inc) - inc.start) / span) * 100}%)`, top: 10 + (laneOf.get(inc) ?? 0) * 16 }}
          />
        ))}
      </div>
      <div className="relative h-5 mt-1">
        {Array.from({ length: ticks + 1 }, (_, i) => {
          const t = since + (span * i) / ticks;
          return (
            <span key={i} className="absolute text-footnote text-label-3 tabular -translate-x-1/2 whitespace-nowrap" style={{ left: `${(i / ticks) * 100}%`, transform: i === 0 ? 'none' : i === ticks ? 'translateX(-100%)' : undefined }}>
              {span > 36 * 3600_000 ? dayTime(t) : clock(t, false)}
            </span>
          );
        })}
      </div>
      {hover && (
        <div className="absolute z-10 glass-strong rounded-xl px-3 py-2 text-callout pointer-events-none max-w-[320px] animate-fade" style={{ left: `min(calc(${x(hover.start)}), calc(100% - 320px))`, top: -8, transform: 'translateY(-100%)' }}>
          <div className="font-semibold">{hover.title}</div>
          <div className="text-label-2 text-subheadline">
            {dayTime(hover.start)} · {duration(Math.max(60_000, endOf(hover) - hover.start))}
          </div>
        </div>
      )}
    </div>
  );
}

export function IncidentList({ incidents, onNavigate }) {
  const byDay = useMemo(() => {
    const m = new Map();
    for (const i of byStart(incidents)) {
      const d = new Date(i.start).toDateString();
      if (!m.has(d)) m.set(d, []);
      m.get(d).push(i);
    }
    return [...m.entries()];
  }, [incidents]);
  return (
    <div className="flex flex-col gap-4">
      {byDay.map(([dayKey, list]) => (
        <div key={dayKey}>
          <div className="text-subheadline font-semibold text-label-3 uppercase tracking-wide px-1 mb-1.5">{day(list[0].start)}</div>
          <div className="relative pl-5">
            <span className="absolute left-[7px] top-2 bottom-2 w-px bg-separator" />
            {list.map((inc) => (
              <div key={inc.id} className="relative group">
                <span className={cx('absolute -left-[17px] top-3.5 w-[11px] h-[11px] rounded-full ring-[3px] ring-[var(--bg-elevated)]', TONE[SEV_TONE[inc.severity]].dot)} />
                <button type="button" onClick={() => inc.view && onNavigate?.(inc.view)} className="w-full text-left p-2.5 rounded-[10px] hover:bg-fill-4 flex gap-3">
                  <div className="w-12 shrink-0 text-callout text-label-2 tabular pt-0.5">{clock(inc.start, false)}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <Icon name={KIND_ICON[inc.kind] || 'dot'} size={14} className={TONE[SEV_TONE[inc.severity]].fg} />
                      <span className="text-headline font-semibold">{inc.title}</span>
                      <span className="text-subheadline text-label-3 whitespace-nowrap">{lasted(inc)}</span>
                    </div>
                    {inc.detail && <div className="text-callout text-label-2 mt-1 whitespace-pre-line break-words selectable">{inc.detail}</div>}
                  </div>
                  {inc.view && <Icon name="chevronRight" size={14} className="text-label-3 mt-1 opacity-0 group-hover:opacity-100 transition-opacity" />}
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function RecapExtras({ recap }) {
  if (!recap) return null;
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {recap.deploys?.length > 0 && (
        <div className="rounded-[12px] bg-fill-4 p-3.5">
          <div className="text-headline font-semibold mb-2 flex items-center gap-1.5">
            <Icon name="rocket" size={14} className="text-accent" /> Deploys
          </div>
          {recap.deploys.slice(0, 8).map((d, i) => (
            <div key={i} className="flex justify-between text-callout py-0.5">
              <span className="font-medium">{short(d.service)}</span>
              <span className="text-label-2 tabular">{dayTime(d.at)}</span>
            </div>
          ))}
        </div>
      )}
      {recap.scaling?.length > 0 && (
        <div className="rounded-[12px] bg-fill-4 p-3.5">
          <div className="text-headline font-semibold mb-2 flex items-center gap-1.5">
            <Icon name="scale" size={14} className="text-accent" /> Autoscaling
          </div>
          {recap.scaling.slice(0, 6).map((s) => (
            <div key={s.service} className="flex justify-between gap-3 text-callout py-0.5">
              <span className="font-medium">{short(s.service)}</span>
              <span className="text-label-2 tabular truncate">
                {s.sizes.join(' → ')} <span className="text-label-3">(peak {s.peak})</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
