import { useStore, inspect, navigate, invoke } from '../lib/store.js';
import { ViewScroll } from '../components/Toolbar.jsx';
import { Card, SectionTitle, Empty, Pill, cx, useNow, IconButton, SEV_TONE, STATE_TONE, StatusDot } from '../components/ui.jsx';
import Icon from '../components/icons.jsx';
import { ago, dayTime, short, duration } from '../lib/format.js';

function DownCard({ title, detail, since, icon = 'x', onClick }) {
  return (
    <button type="button" onClick={onClick} className="card press p-4 text-left flex gap-3 shadow-[0_0_0_1.5px_var(--red),var(--shadow-card)] animate-rise">
      <div className="w-9 h-9 rounded-full bg-red-tint grid place-items-center shrink-0">
        <Icon name={icon} size={17} className="text-red" strokeWidth={2.2} />
      </div>
      <div className="min-w-0">
        <div className="text-headline font-semibold">{title}</div>
        {detail && <div className="text-callout text-label-2 mt-0.5 break-words line-clamp-3">{detail}</div>}
        {since && <div className="text-subheadline text-red mt-1 font-medium">Down for {duration(Date.now() - since)}</div>}
      </div>
    </button>
  );
}

const REASON = {
  OOMKilled: { label: 'Out of memory', tone: 'red', icon: 'memory' },
  Error: { label: 'Crashed', tone: 'orange', icon: 'bolt' },
  Completed: { label: 'Exited', tone: 'gray', icon: 'dot' },
  ContainerCannotRun: { label: 'Cannot run', tone: 'red', icon: 'x' },
};

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

  const down = [
    ...services.filter((s) => s.health === 'down').map((s) => ({ key: s.name, title: `${s.short} is down`, detail: s.reasons.join(' · '), icon: 'x', onClick: () => inspect('service', s.name) })),
    ...uptime.filter((u) => u.state === 'down' && u.failStreak >= 2).map((u) => ({ key: u.id, title: `${u.name} is unreachable`, detail: `${u.url} → ${u.error || `HTTP ${u.status}`}`, icon: 'globe', onClick: () => navigate('frontends') })),
    ...(database?.instances || []).filter((d) => d.down).map((d) => ({ key: d.id, title: `Cloud SQL ${d.name} is down`, detail: d.stateText, icon: 'database', onClick: () => navigate('database') })),
    ...(database?.reachability?.unreachable ? [{ key: 'sql-unreachable', title: "Services can't reach the database", detail: `${database.reachability.last2m} connection errors in the last 2 min · ${database.reachability.services.join(', ')}`, icon: 'database', onClick: () => navigate('database') }] : []),
    ...cloudRun.filter((r) => r.ready === false).map((r) => ({ key: r.name, title: `Cloud Run ${r.name} is not ready`, detail: r.reason, icon: 'cloud', onClick: () => navigate('infrastructure') })),
    ...(cloudflare?.hostErrors || []).filter((h) => h.s52x >= 10).map((h) => ({ key: h.host, title: `${h.host}: Cloudflare can't reach the origin`, detail: `${h.s52x} × 52x in the last 15 min`, icon: 'globe', onClick: () => navigate('frontends') })),
    ...nodes.filter((n) => !n.ready).map((n) => ({ key: n.name, title: `Node ${n.name} is not ready`, detail: n.message, icon: 'infrastructure', onClick: () => navigate('infrastructure') })),
  ];
  const active = alerts?.active || [];
  const badPods = pods.filter((p) => p.state === 'bad' || p.state === 'warn');

  return (
    <ViewScroll>
      <SectionTitle title="Down right now" className="animate-rise" />
      {down.length ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3 mb-8">
          {down.map((d) => (
            <DownCard key={d.key} title={d.title} detail={d.detail} since={d.since} icon={d.icon} onClick={d.onClick} />
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
          <SectionTitle title="Active alerts" subtitle="Open until the problem goes away" />
          <Card pad={false} className="p-1.5">
            {!active.length && <Empty compact title="No active alerts" message="Everything is behaving." />}
            {active.map((a) => (
              <div key={a.id} className={cx('group flex gap-3 p-2.5 rounded-[12px] hover:bg-fill-4', (a.acked || a.muted) && 'opacity-60')}>
                <StatusDot tone={SEV_TONE[a.severity]} size={9} className="mt-1.5" pulse={a.severity === 'critical' && !a.acked} />
                <button type="button" onClick={() => navigate(a.view || 'overview')} className="min-w-0 flex-1 text-left">
                  <div className="text-headline font-semibold">{a.title}</div>
                  {a.detail && <div className="text-callout text-label-2 mt-0.5 break-words">{a.detail}</div>}
                  <div className="text-subheadline text-label-3 mt-1">
                    since {ago(a.openedAt, now)}
                    {a.count > 1 ? ` · ${a.count}×` : ''}
                    {a.acked ? ' · acknowledged' : ''}
                    {a.muted ? ' · muted' : ''}
                  </div>
                </button>
                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  {!a.acked && <IconButton icon="check" label="Acknowledge" onClick={() => invoke('alerts:ack', { id: a.id })} />}
                  {a.service && <IconButton icon="mute" label={`Mute ${short(a.service)} for 1 hour`} onClick={() => invoke('alerts:mute', { service: a.service, minutes: 60 })} />}
                </div>
              </div>
            ))}
          </Card>
        </section>

        <section className="animate-rise" style={{ animationDelay: '90ms' }}>
          <SectionTitle title="Unhealthy pods" subtitle="Crash-looping, not ready, stuck or evicted" />
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
        <SectionTitle title="Crashes in the last 24 hours" subtitle="Every container restart, with the reason and the logs from right before it" />
        <Card pad={false} className="@container overflow-hidden">
          <div className="grid grid-cols-[118px_minmax(90px,140px)_minmax(0,1fr)_150px_64px] @3xl:grid-cols-[150px_150px_minmax(0,1fr)_160px_70px_90px] gap-3 px-4 h-8 items-center text-subheadline font-semibold text-label-2 hairline-b">
            <span>When</span>
            <span>Service</span>
            <span>Pod</span>
            <span>Reason</span>
            <span className="hidden @3xl:block">Exit</span>
            <span className="text-right">Restarts</span>
          </div>
          {!crashes.length && <Empty compact title="No crashes" message="No container has restarted in the last 24 hours." />}
          {crashes.map((c) => {
            const r = REASON[c.reason] || { label: c.reason, tone: 'orange', icon: 'bolt' };
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
                <span className="tabular text-right">{c.restarts}</span>
              </button>
            );
          })}
        </Card>
      </section>
    </ViewScroll>
  );
}
