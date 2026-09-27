import { useRef, useState } from 'react';
import { useStore, setState, navigate, invoke } from '../lib/store.js';
import Icon from './icons.jsx';
import { cx, IconButton, Popover, StatusDot, Button, SEV_TONE, Segmented, Empty, useWindowWidth, AlertText } from './ui.jsx';
import { compact, ago, short } from '../lib/format.js';

const TITLES = {
  overview: ['Overview', 'Every service, pod and endpoint at a glance'],
  recent: ['Recent issues', 'Every alert from the last 7 days: what happened, what it affected and what to do'],
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
  settings: ['Settings', 'Account, integrations, notifications and appearance'],
};

function LivePill() {
  const live = useStore((s) => s.sections.sources?.live);
  const rpm = useStore((s) => s.sections.traffic?.rpm);
  const st = live?.status;
  const tone = st === 'streaming' ? 'green' : st === 'connecting' ? 'accent' : st === 'unavailable' ? 'orange' : 'red';
  const label = st === 'streaming' ? 'Live' : st === 'connecting' ? 'Connecting' : st === 'unavailable' ? 'Live paused' : st ? 'Live error' : 'Waiting';
  return (
    <button type="button" onClick={() => navigate('traffic')} title={live?.message || ''} className="no-drag press glass h-7 pl-2.5 pr-3 rounded-full inline-flex items-center gap-2 text-callout">
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
        failed ? 'bg-orange-tint text-orange' : 'bg-accent text-white shadow-[0_1px_2px_rgb(0_0_0/0.12),inset_0_0.5px_0_rgb(255_255_255/0.35)] hover:brightness-110',
      )}
    >
      {u.status === 'downloading' && <span className="absolute inset-y-0 left-0 bg-white/20" style={{ width: `${pct}%`, transition: 'width 300ms var(--ease-smooth)' }} />}
      <Icon name={failed ? 'refresh' : 'download'} size={14} strokeWidth={2} className={cx('relative', u.status === 'installing' && 'spinner')} />
      <span className="relative tabular">{label}</span>
    </button>
  );
}

function AlertsButton() {
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('active');
  const alerts = useStore((s) => s.sections.alerts);
  const active = alerts?.active || [];
  const recent = alerts?.recent || [];
  const unacked = active.filter((a) => !a.acked && !a.muted);
  const list = tab === 'active' ? active : recent;
  return (
    <>
      <span ref={ref} className="inline-flex">
        <IconButton icon="bell" label="Alerts" variant="glass" badge={unacked.filter((a) => a.severity === 'critical').length || unacked.length} onClick={() => setOpen(!open)} />
      </span>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} width={420}>
        <div className="px-4 pt-3.5 pb-2.5 flex items-center justify-between">
          <div className="flex items-baseline gap-2">
            <div className="text-title3 font-semibold">Alerts</div>
            <button type="button" className="text-callout text-accent" onClick={() => (setOpen(false), navigate('recent'))}>
              See all
            </button>
          </div>
          <Segmented
            size="sm"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'active', label: 'Active', count: active.length },
              { value: 'resolved', label: 'Resolved', count: recent.length },
            ]}
          />
        </div>
        <div className="max-h-[460px] min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {!list.length && <Empty title={tab === 'active' ? 'No active alerts' : 'Nothing resolved in the last 24h'} message={tab === 'active' ? 'Everything is behaving.' : null} />}
          {list.map((a) => (
            <div key={a.id} className={cx('group p-2.5 rounded-[14px] hover:bg-fill-4 flex gap-2.5', (a.acked || a.muted) && 'opacity-60')}>
              <div className={cx('mt-0.5 w-6 h-6 rounded-full grid place-items-center shrink-0', a.resolvedAt ? 'bg-green-tint' : a.severity === 'critical' ? 'bg-red-tint' : a.severity === 'warning' ? 'bg-orange-tint' : 'bg-accent-tint')}>
                <Icon name={a.resolvedAt ? 'check' : a.severity === 'critical' ? 'bolt' : 'errors'} size={13} strokeWidth={2} className={a.resolvedAt ? 'text-green' : `text-${SEV_TONE[a.severity]}`} />
              </div>
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => (setOpen(false), navigate(a.view || { to: 'crashes' }))}>
                <AlertText a={a} compact />
                <div className="text-subheadline text-label-3 mt-1">
                  {a.resolvedAt ? `Resolved ${ago(a.resolvedAt)} · lasted ${Math.max(1, Math.round((a.resolvedAt - a.openedAt) / 60000))}m` : `Since ${ago(a.openedAt)}`}
                  {a.count > 1 ? ` · ${a.count}×` : ''}
                  {a.muted ? ' · muted' : ''}
                  {a.acked ? ' · acknowledged' : ''}
                </div>
              </button>
              {!a.resolvedAt && (
                <div className="flex flex-col gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  {!a.acked && <IconButton icon="check" size={24} iconSize={13} label="Acknowledge" onClick={() => invoke('alerts:ack', { id: a.id })} />}
                  {a.service && <IconButton icon="mute" size={24} iconSize={13} label={`Mute ${short(a.service)} for 1 hour`} onClick={() => invoke('alerts:mute', { service: a.service, minutes: 60 })} />}
                </div>
              )}
            </div>
          ))}
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
          background: 'linear-gradient(to bottom, var(--bg-content) 0%, color-mix(in srgb, var(--bg-content) 82%, transparent) 70%, transparent 100%)',
          backdropFilter: 'blur(12px)',
          maskImage: 'linear-gradient(to bottom, black 60%, transparent)',
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
          <span className="text-footnote text-label-3 font-medium">{navigator.platform.includes('Mac') ? '⌘K' : 'Ctrl K'}</span>
        </button>
        <IconButton icon="timeline" label="While you were away" variant="glass" onClick={() => setState({ recapOpen: true })} />
        <AlertsButton />
      </div>
    </header>
  );
}

// `inner` limits the width of the content only, so the whole view (including
// the empty area beside a narrow column) still scrolls with the wheel.
export function ViewScroll({ children, className, inner }) {
  return (
    <div className={cx('absolute inset-0 overflow-y-auto pt-[60px] pb-10 px-6', className)}>
      {inner ? <div className={inner}>{children}</div> : children}
    </div>
  );
}

export function ViewFixed({ children, className }) {
  return <div className={cx('absolute inset-0 flex flex-col pt-[56px]', className)}>{children}</div>;
}

export { Button };
