import { useStore, navigate } from '../lib/store.js';
import Icon from './icons.jsx';
import { cx, StatusDot, useWindowWidth } from './ui.jsx';
import { compact, clockHM } from '../lib/format.js';
import { isMac, shortcut } from '../lib/platform.js';

/** The views in sidebar order. The command palette and Ctrl/⌘+1–9 follow it. */
export const NAV_GROUPS = [
  {
    title: 'Monitor',
    items: [
      { id: 'overview', label: 'Overview', icon: 'overview' },
      { id: 'recent', label: 'Recent issues', icon: 'bell' },
      { id: 'traffic', label: 'Live Traffic', icon: 'traffic' },
      { id: 'errors', label: 'Errors', icon: 'errors' },
      { id: 'crashes', label: 'Crashes & Down', icon: 'crashes' },
      { id: 'logs', label: 'Logs', icon: 'logs' },
      { id: 'events', label: 'Events', icon: 'events' },
    ],
  },
  {
    title: 'Platform',
    items: [
      { id: 'infrastructure', label: 'Infrastructure', icon: 'infrastructure' },
      { id: 'database', label: 'Database', icon: 'database' },
      { id: 'frontends', label: 'Frontends', icon: 'frontends' },
    ],
  },
  {
    title: 'History',
    items: [
      { id: 'timeline', label: 'Timeline', icon: 'timeline' },
      { id: 'versions', label: 'Versions', icon: 'tag' },
    ],
  },
  {
    title: 'Billing',
    items: [{ id: 'costs', label: 'Costs', icon: 'receipt' }],
  },
];

const OVERALL = {
  operational: { tone: 'green', label: 'Operational' },
  degraded: { tone: 'orange', label: 'Degraded' },
  outage: { tone: 'red', label: 'Outage' },
  connecting: { tone: 'accent', label: 'Connecting' },
  unknown: { tone: 'gray', label: 'Unknown' },
  // This computer is offline: nothing is called down, alerts wait (pipeline.setConnectivity).
  offline: { tone: 'gray', label: 'Offline' },
};

/** The line under the headline: what's running, or while offline since when (and that alerts wait). */
function healthLine(health) {
  if (health?.overall === 'offline') return `Since ${clockHM(health.offlineSince)} · alerts wait until you’re back online`;
  return health?.counts ? `${health.counts.services} services · ${health.counts.podsReady}/${health.counts.pods} pods ready` : null;
}

const SOURCES = [
  ['kubernetes', 'Cluster'],
  ['live', 'Live'],
  ['cloudsql', 'Database'],
  ['metrics', 'Metrics'],
  ['sentry', 'Sentry'],
  ['cloudflare', 'Cloudflare'],
];
const SOURCES_SHOWN = 3;

/** One row: the first few data sources with their status, "+2" for the rest (all of them in the tooltip). Opens Settings. */
function SourceDots({ sources }) {
  const tone = (st) => (!st ? 'gray' : st === 'ok' || st === 'streaming' ? 'green' : st === 'connecting' ? 'accent' : st === 'off' || st === 'offline' ? 'gray' : st === 'degraded' || st === 'unavailable' ? 'orange' : 'red');
  return (
    <button
      type="button"
      onClick={() => navigate('settings')}
      title={SOURCES.map(([k, l]) => `${l}: ${sources?.[k]?.status || 'waiting'}${sources?.[k]?.message ? ` — ${sources[k].message}` : ''}`).join('\n')}
      className="no-drag w-full h-6 px-2.5 rounded-[8px] flex items-center gap-2.5 text-footnote text-label-3 hover:text-label-2 hover:bg-fill-4 whitespace-nowrap overflow-hidden"
    >
      {SOURCES.slice(0, SOURCES_SHOWN).map(([k, l]) => (
        <span key={k} className="inline-flex items-center gap-1 min-w-0">
          <StatusDot tone={tone(sources?.[k]?.status)} size={6} />
          <span className="truncate">{l}</span>
        </span>
      ))}
      <span className="ml-auto shrink-0">+{SOURCES.length - SOURCES_SHOWN}</span>
    </button>
  );
}

export default function Sidebar() {
  const view = useStore((s) => s.nav.view);
  const health = useStore((s) => s.sections.health);
  const alerts = useStore((s) => s.sections.alerts);
  const errors = useStore((s) => s.sections.errors);
  const events = useStore((s) => s.sections.events);
  const traffic = useStore((s) => s.sections.traffic);
  const sources = useStore((s) => s.sections.sources);
  const session = useStore((s) => s.sections.session);
  const info = useStore((s) => s.info);
  const versions = useStore((s) => s.versions);
  const mac = isMac();
  const settingsTip = `Settings (${shortcut(',')})`;

  const crit = alerts?.counts?.critical || 0;
  // Alerts that are clearing (the problem went away, they close after a hold) aren't open problems.
  const openAlerts = (alerts?.active || []).filter((a) => !a.clearing).length;
  const activeErrors = (errors?.backend || []).filter((g) => g.active).length + (errors?.frontend || []).filter((g) => g.active).length;
  const warnEvents = (events || []).filter((e) => e.type === 'Warning' && Date.now() - e.at < 60 * 60_000).length;
  const badges = {
    recent: openAlerts ? { text: openAlerts, tone: 'plain' } : null,
    versions: (() => {
      const n = (versions?.feed || []).filter((r) => !r.baseline && r.publishedAt > (versions.viewedAt || 0) && versions.viewedAt).length;
      return n ? { text: `${n} new`, tone: 'plain' } : null;
    })(),
    traffic: traffic?.rpm ? { text: `${compact(traffic.rpm)}/m`, tone: 'plain' } : null,
    errors: activeErrors ? { text: activeErrors, tone: 'plain' } : null,
    crashes: crit ? { text: crit, tone: 'red' } : alerts?.counts?.warning ? { text: alerts.counts.warning, tone: 'orange' } : null,
    events: warnEvents ? { text: warnEvents, tone: 'plain' } : null,
  };
  const o = OVERALL[health?.overall] || OVERALL.connecting;
  const identity = info?.identity;
  const initials = (identity?.name || identity?.email || '?')
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((x) => x[0].toUpperCase())
    .join('');

  // Narrow windows get an icon rail so the content keeps its room.
  const width = useWindowWidth();
  if (width < 1200) {
    return (
      <aside className="w-[68px] shrink-0 drag">
        <div className="h-full bg-content shadow-[inset_-1px_0_0_var(--line)] flex flex-col items-center overflow-hidden">
          <div className={cx('shrink-0', mac ? 'pt-[46px] pb-2' : 'pt-4 pb-2')}>
            <img src="./icon.png" alt="" className="w-[26px] h-[26px] rounded-[7px]" onError={(e) => (e.currentTarget.style.display = 'none')} title={`Flobi Pulse · ${session?.mode === 'demo' ? 'Demo' : 'Prod'}`} />
          </div>
          <button type="button" onClick={() => navigate('overview')} title={`${health?.headline || 'Connecting…'}${healthLine(health) ? `\n${healthLine(health)}` : ''}`} className="no-drag press w-11 h-11 [@media(max-height:720px)]:h-9 mb-1 rounded-[10px] grid place-items-center bg-fill-4 hover:bg-fill-3">
            <StatusDot tone={o.tone} pulse={health?.overall === 'operational' || health?.overall === 'outage'} size={11} />
          </button>
          <nav className="no-drag flex-1 min-h-0 w-full overflow-y-auto px-2 pb-2 flex flex-col items-center">
            {NAV_GROUPS.map((g, gi) => (
              <div key={g.title} className={cx('w-full flex flex-col items-center gap-0.5', gi > 0 && 'mt-2 pt-2 [@media(max-height:720px)]:mt-1 [@media(max-height:720px)]:pt-1 hairline-t')}>
                {g.items.map((it) => {
                  const active = view === it.id;
                  const b = badges[it.id];
                  return (
                    <button key={it.id} type="button" onClick={() => navigate(it.id)} title={b ? `${it.label} · ${b.text}` : it.label} aria-label={it.label} className={cx('relative w-11 h-10 [@media(max-height:720px)]:h-8 rounded-[8px] grid place-items-center transition-colors duration-150', active ? 'bg-fill-2' : 'hover:bg-fill-4')}>
                      <Icon name={it.icon} size={18} className={active ? 'text-label' : 'text-label-3'} strokeWidth={1.7} />
                      {b && (b.tone === 'red' || b.tone === 'orange') && <span className={cx('absolute top-1 right-1 min-w-[16px] h-4 px-1 rounded-full text-[10px] leading-4 font-semibold text-center tabular', b.tone === 'red' ? 'bg-red text-white' : 'bg-orange text-black')}>{b.text}</span>}
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>
          <div className="no-drag shrink-0 pb-2 pt-2 w-full flex flex-col items-center gap-1.5 hairline-t">
            <button type="button" title={settingsTip} aria-label="Settings" onClick={() => navigate('settings')} className={cx('w-11 h-10 [@media(max-height:720px)]:h-8 rounded-[8px] grid place-items-center text-label-2 hover:text-label hover:bg-fill-4', view === 'settings' && 'text-label bg-fill-3')}>
              <Icon name="settings" size={18} />
            </button>
            <div title={`${identity?.name || 'Signed in'}${identity?.email ? ` · ${identity.email}` : ''}`} className="w-8 h-8 rounded-[8px] bg-fill-3 text-label grid place-items-center text-subheadline font-semibold">
              {initials}
            </div>
          </div>
        </div>
      </aside>
    );
  }

  return (
    <aside className="w-[232px] shrink-0 drag">
      <div className="h-full bg-content shadow-[inset_-1px_0_0_var(--line)] flex flex-col overflow-hidden">
        <div className={cx('shrink-0 flex items-center gap-2 px-[18px]', mac ? 'pt-[46px] pb-2' : 'pt-4 pb-2')}>
          <img src="./icon.png" alt="" className="w-[22px] h-[22px] rounded-[6px]" onError={(e) => (e.currentTarget.style.display = 'none')} />
          <span className="text-headline font-semibold tracking-[-0.01em]">Flobi Pulse</span>
          <span className="ml-auto text-footnote font-semibold px-1.5 h-[18px] inline-flex items-center rounded-[5px] bg-fill-3 text-label-2 uppercase tracking-wide">
            {session?.mode === 'demo' ? 'Demo' : 'Prod'}
          </span>
        </div>

        <button
          type="button"
          onClick={() => navigate('overview')}
          className="no-drag press mx-2 mt-1 mb-2 px-2.5 py-3 rounded-[8px] text-left bg-elevated shadow-[inset_0_0_0_1px_var(--line)] hover:bg-fill-4 transition-colors"
        >
          <div className="flex items-start gap-2.5">
            <StatusDot className="mt-[4px] mx-[3.5px]" tone={o.tone} pulse={health?.overall === 'operational' || health?.overall === 'outage'} size={9} />
            <span className="text-headline font-semibold line-clamp-2">{health?.headline || 'Connecting…'}</span>
          </div>
          {healthLine(health) && <div className="text-subheadline text-label-2 mt-1 pl-[26px] tabular">{healthLine(health)}</div>}
        </button>

        <nav className="no-drag flex-1 min-h-0 overflow-y-auto px-2 pb-2">
          {NAV_GROUPS.map((g) => (
            <div key={g.title} className="mt-2 first:mt-0">
              <div className="px-2.5 pt-2 pb-1 text-footnote font-medium uppercase tracking-[0.08em] text-label-3">{g.title}</div>
              {g.items.map((it) => {
                const active = view === it.id;
                const b = badges[it.id];
                return (
                  <button
                    key={it.id}
                    type="button"
                    onClick={() => navigate(it.id)}
                    className={cx('w-full h-8 px-2.5 rounded-[8px] flex items-center gap-2.5 text-body transition-colors duration-150', active ? 'bg-fill-3 text-label font-medium' : 'text-label-2 hover:bg-fill-4 hover:text-label')}
                  >
                    <Icon name={it.icon} size={16} className={active ? 'text-label' : 'text-label-3'} strokeWidth={1.7} />
                    <span className="flex-1 text-left truncate">{it.label}</span>
                    {b && (
                      <span className={cx('tabular text-subheadline', b.tone === 'red' ? 'min-w-[18px] h-[18px] px-1.5 rounded-full bg-red text-white font-semibold grid place-items-center' : b.tone === 'orange' ? 'min-w-[18px] h-[18px] px-1.5 rounded-full bg-orange text-black font-semibold grid place-items-center' : 'text-label-3')}>
                        {b.text}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="no-drag shrink-0 px-2 pb-2 pt-2 hairline-t">
          <SourceDots sources={sources} />
          <div className="mt-2 flex items-center gap-2.5 py-1.5 pl-2.5 pr-1 rounded-[8px] hover:bg-fill-4 transition-colors">
            <div className="w-7 h-7 rounded-full bg-fill-3 text-label-2 grid place-items-center text-subheadline font-semibold shrink-0">{initials}</div>
            <div className="min-w-0 flex-1">
              <div className="text-callout font-medium truncate">{identity?.name || 'Signed in'}</div>
              <div className="text-footnote text-label-3 truncate">{identity?.kind === 'service-account' ? 'Service account' : identity?.kind === 'demo' ? 'Simulated data' : identity?.email}</div>
            </div>
            <button type="button" title={settingsTip} aria-label="Settings" onClick={() => navigate('settings')} className={cx('w-7 h-7 rounded-full grid place-items-center text-label-2 hover:text-label hover:bg-fill-3', view === 'settings' && 'text-label bg-fill-3')}>
              <Icon name="settings" size={16} />
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
