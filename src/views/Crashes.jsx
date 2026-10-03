import { useStore, inspect, navigate, invoke } from '../lib/store.js';
import { ViewScroll } from '../components/Toolbar.jsx';
import { Card, SectionTitle, Empty, Pill, cx, useNow, IconButton, SEV_TONE, STATE_TONE, StatusDot, AlertText } from '../components/ui.jsx';
import Icon from '../components/icons.jsx';
import { ago, dayTime, short, duration } from '../lib/format.js';
import ExportButton from '../components/ExportButton.jsx';
import PastWeekNote from '../components/PastWeek.jsx';
import { muteOf, muteAlert, RecoveringTag, SilencedTag } from './Recent.jsx';

const ALERT_COLUMNS = [
  { label: 'Opened', get: (a) => new Date(a.openedAt) },
  { label: 'Severity', get: (a) => a.severity },
  { label: 'What happened', get: (a) => a.title },
  { label: 'Evidence', get: (a) => a.detail || '' },
  { label: 'Impact', get: (a) => a.impact || '' },
  { label: 'What to do', get: (a) => a.action || '' },
  { label: 'Service', get: (a) => (a.service ? short(a.service) : '') },
  { label: 'Silenced', get: (a) => (a.acked || a.silenced ? 'yes' : '') },
  { label: 'Recovering', get: (a) => (a.clearing ? 'yes' : '') },
];
const POD_COLUMNS = [
  { label: 'Pod', get: (p) => p.name },
  { label: 'Service', get: (p) => short(p.service) },
  { label: 'Status', get: (p) => p.status },
  { label: 'Restarts', get: (p) => p.restarts },
  { label: 'Last exit', get: (p) => (p.lastTermination ? `${p.lastTermination.reason || ''} (${p.lastTermination.exitCode ?? '—'})` : '') },
  { label: 'Message', get: (p) => p.message || '' },
];
const CRASH_COLUMNS = [
  { label: 'When', get: (c) => new Date(c.at) },
  { label: 'Service', get: (c) => short(c.service) },
  { label: 'Pod', get: (c) => c.pod },
  { label: 'Container', get: (c) => c.container || '' },
  { label: 'Reason', get: (c) => crashReason(c).label },
  { label: 'Exit code', get: (c) => c.exitCode ?? '' },
  { label: 'Restarts', get: (c) => c.restarts ?? '' },
  { label: 'Message', get: (c) => c.message || '' },
  { label: 'Source', get: (c) => (c.fromLogs ? 'Kubernetes events (Google logs)' : 'Pod status') },
];
const DOWN_COLUMNS = [
  { label: 'What is down', get: (d) => d.title },
  { label: 'Details', get: (d) => d.detail || '' },
  { label: 'Down since', get: (d) => (d.since ? new Date(d.since) : '') },
];

/** When an endpoint started failing: the first check of its current run of failures. */
function failingSince(u) {
  const h = u.history || [];
  let since = null;
  for (let i = h.length - 1; i >= 0 && h[i].state === 'down'; i--) since = h[i].t;
  return since;
}

function DownCard({ title, detail, since, now, icon = 'x', onClick }) {
  return (
    <button type="button" onClick={onClick} className="card press p-4 text-left flex gap-3 shadow-[0_0_0_1.5px_var(--red),var(--shadow-card)] animate-rise">
      <div className="w-9 h-9 rounded-full bg-red-tint grid place-items-center shrink-0">
        <Icon name={icon} size={17} className="text-red" strokeWidth={2.2} />
      </div>
      <div className="min-w-0">
        <div className="text-headline font-semibold">{title}</div>
        {detail && <div className="text-callout text-label-2 mt-0.5 break-words line-clamp-3">{detail}</div>}
        {since && <div className="text-subheadline text-red mt-1 font-medium">Down for {duration(Math.max(0, now - since))}</div>}
      </div>
    </button>
  );
}

const REASON = {
  OOMKilled: { label: 'Out of memory', tone: 'red', icon: 'memory' },
  Error: { label: 'Crashed', tone: 'orange', icon: 'bolt' },
  Completed: { label: 'Exited', tone: 'gray', icon: 'dot' },
  ContainerCannotRun: { label: 'Cannot run', tone: 'red', icon: 'x' },
  // Crashes found in Kubernetes events in the logs (from before the app started)
  CrashLoopBackOff: { label: 'Crash loop', tone: 'orange', icon: 'bolt' },
  LivenessProbe: { label: 'Failed liveness probe', tone: 'orange', icon: 'bolt' },
  StartupProbe: { label: 'Failed startup probe', tone: 'orange', icon: 'bolt' },
};

/** A crash's reason as the UI shows it: { label, tone, icon }. */
export const crashReason = (c) => REASON[c.reason] || { label: c.reason, tone: 'orange', icon: 'bolt' };

export default function Crashes() {
  const services = useStore((s) => s.sections.services) || [];
  const uptime = useStore((s) => s.sections.uptime) || [];
  const database = useStore((s) => s.sections.database);
  const cloudRun = useStore((s) => s.sections.cloudRun) || [];
  const cloudflare = useStore((s) => s.sections.cloudflare);
  const nodes = useStore((s) => s.sections.nodes) || [];
  const alerts = useStore((s) => s.sections.alerts);
  const crashes = useStore((s) => s.sections.crashes) || [];
  const pods = useStore((s) => s.sections.pods) || [];
  const selected = useStore((s) => s.inspector?.id);
  const now = useNow(10_000);

  // How long each thing has been down: from its alert, which opened when it went down.
  const opened = new Map((alerts?.active || []).map((a) => [a.key, a.openedAt]));
  const since = (alertKey) => opened.get(alertKey) ?? null;
  // Keys carry the source: a service, a node and a Cloud Run service can share a name.
  const down = [
    ...services.filter((s) => s.health === 'down').map((s) => ({ key: `service:${s.name}`, title: `${s.short} is down`, detail: s.reasons.join(' · '), since: since(`svc-down:${s.name}`), icon: 'x', onClick: () => inspect('service', s.name) })),
    ...uptime.filter((u) => u.state === 'down' && u.failStreak >= 2).map((u) => ({ key: `uptime:${u.id}`, title: `${u.name} is unreachable`, detail: `${u.url} → ${u.error || `HTTP ${u.status}`}`, since: failingSince(u) ?? since(`uptime:${u.id}`), icon: 'globe', onClick: () => navigate('frontends') })),
    ...(database?.instances || []).filter((d) => d.down).map((d) => ({ key: `sql:${d.id}`, title: `Cloud SQL ${d.name} is down`, detail: d.stateText, since: since(`sql-down:${d.id}`), icon: 'database', onClick: () => navigate('database') })),
    ...(database?.reachability?.unreachable ? [{ key: 'sql-reach:unreachable', title: "Services can't reach the database", detail: `${database.reachability.last2m} connection errors in the last 2 min · ${database.reachability.services.join(', ')}`, since: since('sql-unreachable'), icon: 'database', onClick: () => navigate('database') }] : []),
    ...cloudRun.filter((r) => r.ready === false).map((r) => ({ key: `run:${r.name}`, title: `Cloud Run ${r.name} is not ready`, detail: r.reason, since: since(`run:${r.name}`), icon: 'cloud', onClick: () => navigate('infrastructure') })),
    ...(cloudflare?.hostErrors || []).filter((h) => h.s52x >= 10).map((h) => ({ key: `edge:${h.host}`, title: `${h.host}: Cloudflare can't reach the origin`, detail: `${h.s52x} × 52x in the last 15 min`, since: since(`cf52x:${h.host}`), icon: 'globe', onClick: () => navigate('frontends') })),
    ...nodes.filter((n) => !n.ready).map((n) => ({ key: `node:${n.name}`, title: `Node ${n.name} is not ready`, detail: n.message, since: since(`node-down:${n.name}`), icon: 'infrastructure', onClick: () => navigate('infrastructure') })),
  ];
  // Problems first; alerts whose problem went away (recovering) after them.
  const active = [...(alerts?.active || [])].sort((a, b) => Number(!!a.clearing) - Number(!!b.clearing));
  const badPods = pods.filter((p) => p.state === 'bad' || p.state === 'warn');

  return (
    <ViewScroll>
      <SectionTitle title="Down right now" className="animate-rise" right={<ExportButton name="down-right-now" title="Down right now" columns={DOWN_COLUMNS} rows={down} />} />
      {down.length ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3 mb-8">
          {down.map((d) => (
            <DownCard key={d.key} title={d.title} detail={d.detail} since={d.since} now={now} icon={d.icon} onClick={d.onClick} />
          ))}
        </div>
      ) : (
        <Card className="mb-8 flex items-center gap-3 animate-rise">
          <div className="w-9 h-9 rounded-full bg-green-tint grid place-items-center">
            <Icon name="check" size={18} className="text-green" strokeWidth={2.2} />
          </div>
          <div>
            <div className="text-headline font-semibold">Nothing is down</div>
            <div className="text-callout text-label-2">Every service has ready pods and every endpoint answers.</div>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 2xl:grid-cols-2 gap-6">
        <section className="animate-rise" style={{ animationDelay: '60ms' }}>
          <SectionTitle title="Active alerts" subtitle="Open until the problem goes away" right={<ExportButton name="active-alerts" title="Active alerts" columns={ALERT_COLUMNS} rows={active} />} />
          <Card pad={false} className="p-1.5">
            {!active.length && <Empty compact title="No active alerts" message="Everything is behaving." />}
            {active.map((a) => (
              <div key={a.id} className={cx('group flex gap-3 p-2.5 rounded-[8px] hover:bg-fill-4', (a.acked || a.muted || a.clearing) && 'opacity-60')}>
                <StatusDot tone={SEV_TONE[a.severity]} size={9} className="mt-1.5" pulse={a.severity === 'critical' && !a.acked && !a.clearing} />
                <button type="button" onClick={() => navigate(a.view || 'overview')} className="min-w-0 flex-1 text-left">
                  <AlertText a={a} />
                  <div className="text-subheadline text-label-3 mt-1 flex items-center gap-1.5 flex-wrap">
                    {a.clearing && <RecoveringTag />}
                    {(a.acked || a.silenced) && <SilencedTag />}
                    <span>
                      since {ago(a.openedAt, now)}
                      {a.count > 1 ? ` · ${a.count}×` : ''}
                      {a.muted ? ' · muted' : ''}
                    </span>
                  </div>
                </button>
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                  {!a.acked && !a.clearing && <IconButton icon="check" label="Silence until it’s fixed" onClick={() => invoke('alerts:ack', { id: a.id })} />}
                  <IconButton icon="mute" label={muteOf(a).label} onClick={() => muteAlert(a)} />
                </div>
              </div>
            ))}
          </Card>
        </section>

        <section className="animate-rise" style={{ animationDelay: '90ms' }}>
          <SectionTitle title="Unhealthy pods" subtitle="Crash-looping, not ready, stuck or evicted" right={<ExportButton name="unhealthy-pods" title="Unhealthy pods" columns={POD_COLUMNS} rows={badPods} />} />
          <Card pad={false} className="overflow-hidden">
            {!badPods.length && <Empty compact title="All pods are healthy" message="Nothing is crash-looping, stuck or evicted." />}
            {badPods.map((p) => (
              <button key={p.name} type="button" onClick={() => inspect('pod', p.name)} className={cx('w-full text-left px-4 py-2.5 hairline-b hover:bg-fill-4 flex items-center gap-3', selected === p.name && '!bg-accent-tint')}>
                <StatusDot tone={STATE_TONE[p.state]} size={8} />
                <div className="min-w-0 flex-1">
                  <div className="text-callout font-semibold truncate font-mono">{p.name}</div>
                  <div className="text-subheadline text-label-2 truncate">{p.message || p.lastTermination?.reason || `${p.readyText} ready`}</div>
                </div>
                <Pill tone={STATE_TONE[p.state]} strong>
                  {p.status}
                </Pill>
                <span className="text-subheadline text-label-2 tabular w-20 text-right">{p.restarts} restarts</span>
              </button>
            ))}
          </Card>
        </section>
      </div>

      <section className="mt-8 animate-rise" style={{ animationDelay: '120ms' }}>
        <SectionTitle title="Crashes in the last 7 days" subtitle="Every container restart, with the reason and the logs from right before it" right={<ExportButton name="crashes" title="Crashes (7 days)" columns={CRASH_COLUMNS} rows={crashes} />} />
        <PastWeekNote kinds={['events']} />
        <Card pad={false} className="@container overflow-hidden">
          <div className="grid grid-cols-[118px_minmax(90px,140px)_minmax(0,1fr)_150px_64px] @3xl:grid-cols-[150px_150px_minmax(0,1fr)_160px_70px_90px] gap-3 px-4 h-8 items-center text-subheadline font-semibold text-label-2 hairline-b">
            <span>When</span>
            <span>Service</span>
            <span>Pod</span>
            <span>Reason</span>
            <span className="hidden @3xl:block">Exit</span>
            <span className="text-right">Restarts</span>
          </div>
          {!crashes.length && <Empty compact title="No crashes" message="No container has restarted in the last 7 days." />}
          {crashes.map((c) => {
            const r = crashReason(c);
            return (
              <button key={c.id} type="button" onClick={() => inspect('crash', c.id)} className={cx('w-full text-left grid grid-cols-[118px_minmax(90px,140px)_minmax(0,1fr)_150px_64px] @3xl:grid-cols-[150px_150px_minmax(0,1fr)_160px_70px_90px] gap-3 px-4 py-2.5 items-center hairline-b hover:bg-fill-4 text-callout', selected === c.id && '!bg-accent-tint')}>
                <span className="text-label-2">{dayTime(c.at)}</span>
                <span className="font-semibold truncate">{short(c.service)}</span>
                <span className="font-mono text-subheadline text-label-2 truncate">{c.pod}</span>
                <span>
                  <Pill tone={r.tone} icon={r.icon} strong>
                    {r.label}
                  </Pill>
                </span>
                <span className="hidden @3xl:block tabular font-mono text-label-2">{c.exitCode ?? '—'}</span>
                <span className={cx('tabular text-right', c.restarts == null && 'text-label-3')}>{c.restarts ?? '—'}</span>
              </button>
            );
          })}
        </Card>
        {crashes.some((c) => c.fromLogs) && <p className="text-footnote text-label-3 px-1 mt-2">Crashes from before Flobi Pulse started come from Kubernetes events in Google's logs: they show the reason, but no exit code or restart count.</p>}
      </section>
    </ViewScroll>
  );
}
