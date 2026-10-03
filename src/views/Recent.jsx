// Every alert and notification from the last 7 days, newest first: what went
// wrong, what it affected, what to do, and whether it's still going on.
import { useEffect, useMemo, useState } from 'react';
import { useStore, navigate, invoke } from '../lib/store.js';
import { ViewScroll } from '../components/Toolbar.jsx';
import { Card, Segmented, SearchField, Empty, IconButton, Pill, AlertText, Button, cx, useNow } from '../components/ui.jsx';
import Icon from '../components/icons.jsx';
import { clock, duration, short, dayLong } from '../lib/format.js';
import ExportButton from '../components/ExportButton.jsx';
import PastWeekNote from '../components/PastWeek.jsx';

const SEV = {
  critical: { icon: 'bolt', bg: 'bg-red-tint', fg: 'text-red', label: 'Critical' },
  warning: { icon: 'errors', bg: 'bg-orange-tint', fg: 'text-orange', label: 'Warning' },
  info: { icon: 'bell', bg: 'bg-accent-tint', fg: 'text-accent', label: 'Info' },
};
const FILTERS = ['all', 'open', 'critical', 'warning'];

/**
 * What the mute button of an alert silences, and its words. Alerts name it (`muteTarget`:
 * their service, or `key:<alert key>` for just this alert); older ones only have a service.
 */
export function muteOf(a) {
  const target = a.muteTarget ?? a.service ?? (a.key ? `key:${a.key}` : null);
  return { target, label: target && !String(target).startsWith('key:') ? `Mute ${short(target)} for 1 hour` : 'Mute this alert for 1 hour' };
}
export const muteAlert = (a) => invoke('alerts:mute', { target: muteOf(a).target, minutes: 60 });

/** On an alert whose problem went away: it closes by itself after a short wait, unless the problem comes back. */
export function RecoveringTag() {
  return <span className="inline-flex items-center h-[18px] px-1.5 rounded-[5px] bg-green-tint text-green text-footnote font-semibold whitespace-nowrap">Recovering</span>;
}

/** Silenced (or acknowledged), or part of a problem that was: no notification or sound until it’s been fixed for 30 min. */
export function SilencedTag() {
  return (
    <span title="No notifications or sound until it’s been fixed for 30 min" className="inline-flex items-center gap-1 h-[18px] px-1.5 rounded-[5px] bg-fill-3 text-label-2 text-footnote font-semibold whitespace-nowrap">
      <Icon name="mute" size={10} strokeWidth={2.2} />
      Silenced
    </span>
  );
}

// The same words on the page and in the export.
const STATUS = {
  open: 'Open',
  recovering: 'Recovering',
  resolved: 'Resolved',
  unfinished: 'Still open when Flobi Pulse closed',
  closed: 'Closed',
  logs: 'From the logs',
};
// Issues rebuilt from Google's logs (the past week, loaded on start) were never alerts: they're never open.
const stateOf = (a) => (a.fromLogs ? 'logs' : a.open ? (a.clearing ? 'recovering' : 'open') : a.resolvedAt ? 'resolved' : a.unfinished ? 'unfinished' : 'closed');

function statusOf(a, now) {
  const st = stateOf(a);
  if (st === 'open') return { text: `${STATUS.open} for ${duration(now - a.openedAt)}`, tone: a.severity === 'critical' ? 'red' : 'orange' };
  if (st === 'recovering') return { text: STATUS.recovering, tone: 'green' };
  if (st === 'resolved') return { text: `${STATUS.resolved} after ${duration(Math.max(60_000, a.resolvedAt - a.openedAt))}`, tone: 'green' };
  return { text: STATUS[st], tone: 'gray' };
}

const COLUMNS = [
  { label: 'Opened', get: (a) => new Date(a.openedAt) },
  { label: 'Severity', get: (a) => SEV[a.severity]?.label || a.severity },
  { label: 'What happened', get: (a) => a.title },
  { label: 'Evidence', get: (a) => a.detail || '' },
  { label: 'Impact', get: (a) => a.impact || '' },
  { label: 'What to do', get: (a) => a.action || '' },
  { label: 'Service', get: (a) => (a.service ? short(a.service) : '') },
  { label: 'Status', get: (a) => STATUS[stateOf(a)] },
  { label: 'Resolved', get: (a) => (a.resolvedAt ? new Date(a.resolvedAt) : '') },
  { label: 'Times', get: (a) => a.count || 1 },
];

export default function Recent() {
  const alerts = useStore((s) => s.sections.alerts);
  const params = useStore((s) => s.nav.params);
  const now = useNow(30_000);
  const asked = typeof params?.filter === 'string' && FILTERS.includes(params.filter) ? params.filter : null;
  const [filter, setFilter] = useState(asked || 'all');
  const [q, setQ] = useState('');
  const history = alerts?.history || [];

  // "See all" next to the active alerts opens "Open now", also when this page is already showing.
  useEffect(() => {
    if (asked) setFilter(asked);
  }, [params?.at]);

  const list = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return history.filter((a) => {
      if (filter === 'open' && !a.open) return false;
      if (filter === 'critical' && a.severity !== 'critical') return false;
      if (filter === 'warning' && a.severity !== 'warning') return false;
      return !ql || `${a.title} ${a.detail || ''} ${a.service || ''}`.toLowerCase().includes(ql);
    });
  }, [history, filter, q]);

  const days = useMemo(() => {
    const out = [];
    for (const a of list) {
      const label = dayLong(a.openedAt);
      if (out.at(-1)?.label !== label) out.push({ label, items: [] });
      out.at(-1).items.push(a);
    }
    return out;
  }, [list, now]);

  const open = history.filter((a) => a.open).length;
  // Only a problem that's still there makes the dot red; recovering alerts don't.
  const openProblems = history.some((a) => a.open && !a.clearing);
  return (
    <ViewScroll inner="max-w-[980px]">
      <div className="flex items-center gap-2 flex-wrap mb-4 animate-rise">
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All', count: history.length },
            { value: 'open', label: 'Open now', count: open, dot: openProblems ? 'red' : undefined },
            { value: 'critical', label: 'Critical', count: history.filter((a) => a.severity === 'critical').length },
            { value: 'warning', label: 'Warnings', count: history.filter((a) => a.severity === 'warning').length },
          ]}
        />
        <div className="flex-1" />
        <SearchField value={q} onChange={setQ} placeholder="Search issues" width={220} />
        <ExportButton name="recent-issues" title="Recent issues" columns={COLUMNS} rows={list} />
      </div>
      <PastWeekNote kinds={['failed', 'sql']} />

      {!list.length && (
        <Card>
          <Empty
            title={!history.length ? 'No issues in the last 7 days' : filter === 'open' && !q.trim() ? 'Nothing is open right now' : 'Nothing matches these filters'}
            message={!history.length ? 'Every alert Flobi Pulse raises shows up here, with what to do about it, and stays for 7 days.' : filter === 'open' && !q.trim() ? 'Every alert from the last 7 days has closed.' : null}
            action={
              history.length > 0 && (filter !== 'all' || q.trim()) ? (
                <Button onClick={() => (setFilter('all'), setQ(''))}>{filter === 'open' && !q.trim() ? 'Show all issues' : 'Clear filters'}</Button>
              ) : null
            }
          />
        </Card>
      )}

      {days.map((d) => (
        <section key={d.label} className="mb-6 animate-rise">
          <h2 className="text-headline font-semibold text-label-2 px-1 mb-2">{d.label}</h2>
          <Card pad={false} className="overflow-hidden divide-y divide-separator">
            {d.items.map((a) => {
              const sev = SEV[a.severity] || SEV.info;
              const st = statusOf(a, now);
              // Still open and still a problem (not recovering).
              const live = a.open && !a.clearing;
              const mute = muteOf(a);
              return (
                <div key={a.id} className={cx('group flex gap-3 p-4', !a.open ? 'opacity-80' : a.clearing && 'opacity-60')}>
                  <div className={cx('mt-0.5 w-8 h-8 rounded-[8px] grid place-items-center shrink-0', live ? sev.bg : 'bg-fill-3')}>
                    <Icon name={live ? sev.icon : a.fromLogs ? 'history' : 'check'} size={15} strokeWidth={2} className={live ? sev.fg : 'text-label-3'} />
                  </div>
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => a.view && navigate(a.view)} disabled={!a.view}>
                    <AlertText a={a} />
                    <div className="mt-2 flex items-center gap-2 flex-wrap text-subheadline text-label-3">
                      <span className="tabular">{clock(a.openedAt)}</span>
                      <Pill tone={st.tone}>{st.text}</Pill>
                      {a.fromLogs && a.resolvedAt - a.openedAt >= 60_000 && <span>lasted {duration(a.resolvedAt - a.openedAt)}</span>}
                      {a.count > 1 && <span>{a.count}×</span>}
                      {a.service && <span>{short(a.service)}</span>}
                      {(a.acked || a.silenced) && (a.open ? <SilencedTag /> : <span>silenced</span>)}
                      {a.muted && <span>muted</span>}
                    </div>
                  </button>
                  {a.open && (
                    <div className="flex flex-col gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                      {!a.acked && live && <IconButton icon="check" label="Silence until it’s fixed" onClick={() => invoke('alerts:ack', { id: a.id })} />}
                      <IconButton icon="mute" label={mute.label} onClick={() => muteAlert(a)} />
                    </div>
                  )}
                </div>
              );
            })}
          </Card>
        </section>
      ))}
      <p className="text-footnote text-label-3 px-1 mt-4">
        Kept for 7 days on this computer. Critical and warning alerts also arrive as notifications (Settings → Notifications).
        {history.some((a) => a.fromLogs) && ' Issues marked “From the logs” were rebuilt from Google’s logs when Flobi Pulse started; they never notify.'}
      </p>
    </ViewScroll>
  );
}
