// Every alert and notification from the last 7 days, newest first: what went
// wrong, what it affected, what to do, and whether it's still going on.
import { useMemo, useState } from 'react';
import { useStore, navigate, invoke } from '../lib/store.js';
import { ViewScroll } from '../components/Toolbar.jsx';
import { Card, Segmented, SearchField, Empty, IconButton, Pill, AlertText, cx, useNow } from '../components/ui.jsx';
import Icon from '../components/icons.jsx';
import { clock, duration, short } from '../lib/format.js';
import ExportButton from '../components/ExportButton.jsx';

const SEV = {
  critical: { icon: 'bolt', bg: 'bg-red-tint', fg: 'text-red', label: 'Critical' },
  warning: { icon: 'errors', bg: 'bg-orange-tint', fg: 'text-orange', label: 'Warning' },
  info: { icon: 'bell', bg: 'bg-accent-tint', fg: 'text-accent', label: 'Info' },
};

function dayLabel(ts, now) {
  const d = new Date(ts);
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

function statusOf(a, now) {
  if (a.open) return { text: `Open for ${duration(now - a.openedAt)}`, tone: a.severity === 'critical' ? 'red' : 'orange' };
  if (a.resolvedAt) return { text: `Resolved after ${duration(Math.max(60_000, a.resolvedAt - a.openedAt))}`, tone: 'green' };
  if (a.unfinished) return { text: 'Still open when Flobi Pulse closed', tone: 'gray' };
  return { text: 'Closed', tone: 'gray' };
}

const COLUMNS = [
  { label: 'Opened', get: (a) => new Date(a.openedAt) },
  { label: 'Severity', get: (a) => SEV[a.severity]?.label || a.severity },
  { label: 'What happened', get: (a) => a.title },
  { label: 'Evidence', get: (a) => a.detail || '' },
  { label: 'Impact', get: (a) => a.impact || '' },
  { label: 'What to do', get: (a) => a.action || '' },
  { label: 'Service', get: (a) => (a.service ? short(a.service) : '') },
  { label: 'Status', get: (a) => (a.open ? 'Open' : a.resolvedAt ? 'Resolved' : 'Unknown') },
  { label: 'Resolved', get: (a) => (a.resolvedAt ? new Date(a.resolvedAt) : '') },
  { label: 'Times', get: (a) => a.count || 1 },
];

export default function Recent() {
  const alerts = useStore((s) => s.sections.alerts);
  const now = useNow(30_000);
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const history = alerts?.history || [];

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
      const label = dayLabel(a.openedAt, now);
      if (out.at(-1)?.label !== label) out.push({ label, items: [] });
      out.at(-1).items.push(a);
    }
    return out;
  }, [list, now]);

  const open = history.filter((a) => a.open).length;
  return (
    <ViewScroll inner="max-w-[980px]">
      <div className="flex items-center gap-2 flex-wrap mb-4 animate-rise">
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All', count: history.length },
            { value: 'open', label: 'Open now', count: open, dot: open ? 'red' : undefined },
            { value: 'critical', label: 'Critical', count: history.filter((a) => a.severity === 'critical').length },
            { value: 'warning', label: 'Warnings', count: history.filter((a) => a.severity === 'warning').length },
          ]}
        />
        <div className="flex-1" />
        <SearchField value={q} onChange={setQ} placeholder="Search issues" width={220} />
        <ExportButton name="recent-issues" title="Recent issues" columns={COLUMNS} rows={list} />
      </div>

      {!list.length && (
        <Card>
          <Empty
            title={history.length ? 'Nothing matches' : 'No issues in the last 7 days'}
            message={history.length ? 'Try another filter or search.' : 'Every alert Flobi Pulse raises shows up here, with what to do about it, and stays for 7 days.'}
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
              return (
                <div key={a.id} className={cx('group flex gap-3 p-4', !a.open && 'opacity-80')}>
                  <div className={cx('mt-0.5 w-8 h-8 rounded-[10px] grid place-items-center shrink-0', a.open ? sev.bg : 'bg-fill-3')}>
                    <Icon name={a.open ? sev.icon : 'check'} size={15} strokeWidth={2} className={a.open ? sev.fg : 'text-label-3'} />
                  </div>
                  <button type="button" className="min-w-0 flex-1 text-left" onClick={() => a.view && navigate(a.view)} disabled={!a.view}>
                    <AlertText a={a} />
                    <div className="mt-2 flex items-center gap-2 flex-wrap text-subheadline text-label-3">
                      <span className="tabular">{clock(a.openedAt)}</span>
                      <Pill tone={st.tone}>{st.text}</Pill>
                      {a.count > 1 && <span>{a.count}×</span>}
                      {a.service && <span>{short(a.service)}</span>}
                      {a.acked && <span>acknowledged</span>}
                      {a.muted && <span>muted</span>}
                    </div>
                  </button>
                  {a.open && (
                    <div className="flex flex-col gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                      {!a.acked && <IconButton icon="check" label="Acknowledge" onClick={() => invoke('alerts:ack', { id: a.id })} />}
                      {a.service && <IconButton icon="mute" label={`Mute ${short(a.service)} for 1 hour`} onClick={() => invoke('alerts:mute', { service: a.service, minutes: 60 })} />}
                    </div>
                  )}
                </div>
              );
            })}
          </Card>
        </section>
      ))}
      <p className="text-footnote text-label-3 px-1 mt-4">Kept for 7 days on this computer. Critical and warning alerts also arrive as notifications (Settings → Notifications).</p>
    </ViewScroll>
  );
}
