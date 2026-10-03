import { useRef, useState } from 'react';
import { useStore, setState, navigate, invoke } from '../lib/store.js';
import Icon from './icons.jsx';
import { cx, IconButton, Popover, StatusDot, Segmented, Empty, useWindowWidth, AlertText } from './ui.jsx';
import { compact, ago, short, duration } from '../lib/format.js';
import { shortcut } from '../lib/platform.js';

const TITLES = {
  overview: ['Overview', 'Every service, pod and endpoint at a glance'],
  recent: ['Recent issues', 'Every alert and incident from the last 7 days: what happened, what it affected and what to do'],
  traffic: ['Live Traffic', 'Every request reaching the load balancer, as it happens'],
  errors: ['Errors', 'Backend errors from every pod, and frontend errors from Sentry'],
  crashes: ['Crashes & Down', "What's broken right now, and what crashed recently"],
  logs: ['Logs', 'All services, one stream'],
  events: ['Events', 'What Kubernetes is doing and complaining about'],
  infrastructure: ['Infrastructure', 'Nodes, autoscaling, jobs, certificates and Cloud Run'],
  database: ['Database', 'Cloud SQL health and Postgres errors'],
  frontends: ['Frontends', 'Cloudflare edge, Pages deployments and uptime'],
  timeline: ['Timeline', 'Everything that happened, for any time range'],
  versions: ['Versions', 'Every release of the team’s repos, with its changelog'],
  costs: ['Costs', 'What the platform costs each month: Google Cloud, Cloudflare, GitHub, the AI APIs, Sentry, Clerk and the rest'],
  settings: ['Settings', 'Account, integrations, notifications and appearance'],
};

function LivePill() {
  const live = useStore((s) => s.sections.sources?.live);
  const rpm = useStore((s) => s.sections.traffic?.rpm);
  const st = live?.status;
  const tone = st === 'streaming' ? 'green' : st === 'connecting' ? 'accent' : st === 'offline' ? 'gray' : st === 'unavailable' ? 'orange' : 'red';
  const label = st === 'streaming' ? 'Live' : st === 'connecting' ? 'Connecting' : st === 'offline' ? 'Offline' : st === 'unavailable' ? 'Live paused' : st ? 'Live error' : 'Waiting';
  return (
    <button type="button" onClick={() => navigate('traffic')} title={live?.message || undefined} className="no-drag press glass h-7 pl-2.5 pr-3 rounded-full inline-flex items-center gap-2 text-callout">
      <StatusDot tone={tone} pulse={st === 'streaming'} size={7} />
      <span className="font-semibold">{label}</span>
      {st === 'streaming' && rpm != null && <span className="text-label-2 tabular">{compact(rpm)} req/min</span>}
    </button>
  );
}

// Like Discord: when a new release is out, a button appears; one click downloads
// it, installs it and restarts the app.
function UpdateButton() {
  const u = useStore((s) => s.update);
  if (!u || !['available', 'downloading', 'installing', 'error'].includes(u.status)) return null;
  const pct = Math.round((u.progress || 0) * 100);
  const failed = u.status === 'error';
  const busy = u.status === 'downloading' || u.status === 'installing';
  const label = { available: 'Update available', downloading: `Downloading ${pct}%`, installing: 'Restarting…', error: 'Update failed · retry' }[u.status];
  const size = u.size ? ` (${(u.size / 1048576).toFixed(0)} MB)` : '';
  const tip = failed ? `${u.error}\nClick to try again.` : u.status === 'available' ? `Flobi Pulse ${u.version} is out. Click to download it${size} and restart.` : `Updating to ${u.version}…`;
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => invoke('update:install')}
      title={tip}
      className={cx(
        'no-drag press relative overflow-hidden h-7 pl-2.5 pr-3 rounded-full inline-flex items-center gap-1.5 text-callout font-semibold disabled:pointer-events-none',
        failed ? 'bg-orange-tint text-orange' : 'bg-accent text-on-accent hover:opacity-85',
      )}
    >
      {u.status === 'downloading' && <span className="absolute inset-y-0 left-0 bg-white/20" style={{ width: `${pct}%`, transition: 'width 300ms var(--ease-smooth)' }} />}
      <Icon name={failed ? 'refresh' : 'download'} size={14} strokeWidth={2} className={cx('relative', u.status === 'installing' && 'spinner')} />
      <span className="relative tabular">{label}</span>
    </button>
  );
}

// How an alert's icon looks: resolved, clearing (the problem went away; it closes after a
// hold, so it isn't an open problem any more) or open, by severity. Full class names, so
// Tailwind sees every one of them.
const ALERT_LOOK = {
  resolved: { icon: 'check', bg: 'bg-green-tint', fg: 'text-green' },
  clearing: { icon: 'check', bg: 'bg-fill-3', fg: 'text-label-3' },
  critical: { icon: 'bolt', bg: 'bg-red-tint', fg: 'text-red' },
  warning: { icon: 'errors', bg: 'bg-orange-tint', fg: 'text-orange' },
  info: { icon: 'errors', bg: 'bg-accent-tint', fg: 'text-accent' },
};
const alertLook = (a) => ALERT_LOOK[a.resolvedAt ? 'resolved' : a.clearing ? 'clearing' : a.severity] || ALERT_LOOK.info;

function AlertsButton() {
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('active');
  const alerts = useStore((s) => s.sections.alerts);
  const active = alerts?.active || [];
  const recent = alerts?.recent || [];
  const problems = active.filter((a) => !a.clearing);
  const unacked = problems.filter((a) => !a.acked && !a.muted);
  // Open problems first, then the ones that are clearing.
  const list = tab === 'active' ? [...problems, ...active.filter((a) => a.clearing)] : recent;
  const go = (to) => {
    setOpen(false);
    navigate(to);
  };
  return (
    <>
      <span ref={ref} className="inline-flex">
        <IconButton icon="bell" label="Alerts" variant="glass" badge={unacked.filter((a) => a.severity === 'critical').length || unacked.length} onClick={() => setOpen(!open)} aria-haspopup="dialog" aria-expanded={open} />
      </span>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} width={420} role="dialog" label="Alerts">
        <div className="px-4 pt-3.5 pb-2.5 flex items-center justify-between">
          <div className="flex items-baseline gap-2">
            <div className="text-title3 font-semibold">Alerts</div>
            <button type="button" className="text-callout text-accent" onClick={() => go({ to: 'alerts' })}>
              See all
            </button>
          </div>
          <Segmented
            size="sm"
            label="Show"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'active', label: 'Active', count: problems.length },
              { value: 'resolved', label: 'Resolved', count: recent.length },
            ]}
          />
        </div>
        <div className="max-h-[460px] min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {!list.length && <Empty title={tab === 'active' ? 'No active alerts' : 'Nothing resolved in the last 24h'} message={tab === 'active' ? 'Everything is behaving.' : null} />}
          {list.map((a) => {
            const look = alertLook(a);
            return (
              <div key={a.id} className={cx('group p-2.5 rounded-[10px] hover:bg-fill-4 flex gap-2.5', (a.acked || a.muted || a.clearing) && 'opacity-60')}>
                <div className={cx('mt-0.5 w-6 h-6 rounded-full grid place-items-center shrink-0', look.bg)}>
                  <Icon name={look.icon} size={13} strokeWidth={2} className={look.fg} />
                </div>
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => go(a.view || { to: 'alerts' })}>
                  <AlertText a={a} compact />
                  <div className="text-subheadline text-label-3 mt-1">
                    {a.clearing && <span className="mr-1.5 px-1.5 rounded-[5px] bg-fill-3 text-label-2 font-medium">Recovering</span>}
                    {!a.resolvedAt && (a.acked || a.silenced) && (
                      <span title="No notifications or sound until it’s been fixed for 30 min" className="mr-1.5 px-1.5 rounded-[5px] bg-fill-3 text-label-2 font-medium">
                        Silenced
                      </span>
                    )}
                    {a.resolvedAt ? `Resolved ${ago(a.resolvedAt)} · lasted ${duration(Math.max(0, a.resolvedAt - a.openedAt))}` : `Since ${ago(a.openedAt)}`}
                    {a.count > 1 ? ` · ${a.count}×` : ''}
                    {a.muted ? ' · muted' : ''}
                    {a.resolvedAt && (a.acked || a.silenced) ? ' · silenced' : ''}
                  </div>
                </button>
                {!a.resolvedAt && (
                  // Shown on hover, and whenever keyboard focus is in the row.
                  <div className="flex flex-col gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                    {!a.acked && !a.clearing && <IconButton icon="check" size={24} iconSize={13} label="Silence until it’s fixed" onClick={() => invoke('alerts:ack', { id: a.id })} />}
                    <IconButton icon="mute" size={24} iconSize={13} label={a.service ? `Mute ${short(a.service)} for 1 hour` : 'Mute this alert for 1 hour'} onClick={() => invoke('alerts:mute', { target: a.muteTarget ?? a.service, minutes: 60 })} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Popover>
    </>
  );
}

export default function Toolbar() {
  const view = useStore((s) => s.nav.view);
  const session = useStore((s) => s.sections.session);
  // A docked inspector (see Inspector) sits under the Windows caption buttons, so the toolbar needn't make room for them.
  const inspecting = useStore((s) => !!s.inspector);
  const docked = useWindowWidth() >= 1400 && inspecting;
  const [title, subtitle] = TITLES[view] || TITLES.overview;
  return (
    <header className="drag absolute top-0 inset-x-0 h-[52px] z-20 flex items-center gap-3 pl-6 pr-3">
      <div
        className="absolute inset-0 -z-10"
        style={{
          // A plain fade, no blur or mask: both flicker on macOS as rows repaint underneath.
          // Solid behind the title and subtitle, so nothing scrolling under shows through them.
          background: 'linear-gradient(to bottom, var(--bg-content) 70%, color-mix(in srgb, var(--bg-content) 60%, transparent) 82%, color-mix(in srgb, var(--bg-content) 22%, transparent) 92%, transparent 100%)',
        }}
      />
      <div className="min-w-0 flex-1">
        <h1 className="text-title3 font-semibold leading-5 truncate">{title}</h1>
        <p className="text-subheadline text-label-2 truncate">
          {subtitle}
          {session?.projectId ? ` · ${session.projectId}` : ''}
        </p>
      </div>
      <div className={cx('flex items-center gap-2', !docked && 'toolbar-end')}>
        <UpdateButton />
        <LivePill />
        <button type="button" onClick={() => setState({ palette: true })} className="no-drag press glass h-7 pl-2.5 pr-2 rounded-full inline-flex items-center gap-2 text-callout text-label-2 hover:text-label">
          <Icon name="search" size={14} />
          <span>Search</span>
          <span className="text-footnote text-label-3 font-medium">{shortcut('K')}</span>
        </button>
        <IconButton icon="timeline" label="While you were away" variant="glass" onClick={() => setState({ recapOpen: true })} />
        <AlertsButton />
      </div>
    </header>
  );
}

// `inner` limits the width of the content only, so the whole view (including
// the empty area beside a narrow column) still scrolls with the wheel. The
// scrollbar's room is always kept, so content doesn't shift sideways when a
// page (or a Settings tab) grows tall enough to scroll.
export function ViewScroll({ children, className, inner }) {
  return (
    <div className={cx('absolute inset-0 overflow-y-auto [scrollbar-gutter:stable] pt-[60px] pb-10 px-6', className)}>
      {inner ? <div className={inner}>{children}</div> : children}
    </div>
  );
}

export function ViewFixed({ children, className }) {
  return <div className={cx('absolute inset-0 flex flex-col pt-[56px]', className)}>{children}</div>;
}
