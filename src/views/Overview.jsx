import { useMemo, useState } from 'react';
import { useStore, inspect, navigate } from '../lib/store.js';
import { ViewScroll } from '../components/Toolbar.jsx';
import { Card, SectionTitle, Segmented, HealthPill, StatusDot, Meter, cx, STATE_TONE, SEV_TONE, useNow, Empty } from '../components/ui.jsx';
import { Sparkline, UptimeBars } from '../components/charts.jsx';
import Icon from '../components/icons.jsx';
import { compact, pct, ms, ago, short, num } from '../lib/format.js';
import ExportButton from '../components/ExportButton.jsx';
import { RecoveringTag, SilencedTag } from './Recent.jsx';
import { crashReason } from './Crashes.jsx';

const SERVICE_COLUMNS = [
  { label: 'Service', get: (s) => s.short },
  { label: 'Workload', get: (s) => s.name },
  { label: 'Health', get: (s) => s.health },
  { label: 'Why', get: (s) => (s.health === 'healthy' ? '' : (s.reasons || []).join(' · ')) },
  { label: 'Pods ready', get: (s) => s.ready },
  { label: 'Pods wanted', get: (s) => s.desired },
  { label: 'CPU %', get: (s) => (s.cpuPct != null ? Math.round(s.cpuPct * 1000) / 10 : '') },
  { label: 'Memory %', get: (s) => (s.memPct != null ? Math.round(s.memPct * 1000) / 10 : '') },
  { label: 'Requests / min', get: (s) => (s.hosts?.length && s.rpm != null ? s.rpm : '') },
  { label: 'Errors / min', get: (s) => s.errorsPerMin || 0 },
  { label: 'Restarts', get: (s) => s.restarts || 0 },
  { label: 'Public URLs', get: (s) => (s.hosts || []).join(', ') },
];
const ENDPOINT_COLUMNS = [
  { label: 'Endpoint', get: (u) => u.name },
  { label: 'URL', get: (u) => u.url },
  { label: 'State', get: (u) => u.state },
  { label: 'Response (ms)', get: (u) => u.ms ?? '' },
  { label: 'HTTP status', get: (u) => u.status ?? '' },
  { label: 'Error', get: (u) => u.error || '' },
];

const ORDER = { down: 0, degraded: 1, deploying: 2, healthy: 3, idle: 4 };

function Stat({ label, value, sub, spark, tone, icon, onClick }) {
  const color = tone === 'red' ? 'var(--red)' : tone === 'orange' ? 'var(--orange)' : 'var(--accent)';
  return (
    <button type="button" onClick={onClick} className="card press p-3.5 pb-3 text-left flex flex-col gap-0.5 min-w-0 hover:shadow-[var(--shadow-card),0_0_0_0.5px_var(--separator)]">
      <div className="flex items-center gap-1.5 text-callout text-label-2">
        {icon && <Icon name={icon} size={13} />}
        <span className="truncate">{label}</span>
      </div>
      <div className={cx('text-title1 font-semibold tracking-[-0.02em] leading-7 mt-0.5', tone === 'red' && 'text-red', tone === 'orange' && 'text-orange')}>{value}</div>
      {sub && <div className="text-subheadline text-label-3 truncate">{sub}</div>}
      <div className="mt-auto pt-2">{spark ? <Sparkline fluid data={spark} height={22} color={color} /> : <div className="h-[22px]" />}</div>
    </button>
  );
}

function ServiceCard({ s }) {
  const problem = s.health === 'down' || s.health === 'degraded';
  return (
    <button
      type="button"
      onClick={() => inspect('service', s.name)}
      className={cx(
        'card press p-3.5 text-left flex flex-col gap-2.5 min-w-0 transition-shadow',
        s.health === 'down' && 'shadow-[0_0_0_1.5px_var(--red),var(--shadow-card)]',
        s.health === 'degraded' && 'shadow-[0_0_0_1px_color-mix(in_srgb,var(--orange)_60%,transparent),var(--shadow-card)]',
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-headline font-semibold truncate">{s.short}</span>
        {s.hosts?.length > 0 && <Icon name="globe" size={12} className="text-label-3 shrink-0" />}
        {/* Healthy is the normal state: a quiet check, so the pills that remain are the ones worth reading. */}
        <span className="ml-auto shrink-0">
          {s.health === 'healthy' ? (
            <span title="Healthy" aria-label="Healthy" className="w-5 h-5 grid place-items-center text-green">
              <Icon name="check" size={13} strokeWidth={2.2} />
            </span>
          ) : (
            <HealthPill health={s.health} />
          )}
        </span>
      </div>
      <div className="flex items-center gap-1 flex-wrap min-h-2">
        {s.pods.map((p) => (
          <span key={p.name} title={`${p.name} · ${p.status}`} className={cx('w-2 h-2 rounded-full', { green: 'bg-green', orange: 'bg-orange', red: 'bg-red', accent: 'bg-accent', gray: 'bg-gray' }[STATE_TONE[p.state]])} />
        ))}
        <span className="text-subheadline text-label-3 ml-1 tabular">
          {s.ready}/{s.desired} ready
          {s.scaling ? ` · ${s.scaling.min}–${s.scaling.max}` : ''}
        </span>
      </div>
      {problem && s.reasons?.[0] ? (
        <div className={cx('text-callout leading-4 line-clamp-2', s.health === 'down' ? 'text-red' : 'text-orange')}>{s.reasons.join(' · ')}</div>
      ) : (
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-subheadline">
          <div>
            <div className="flex justify-between text-label-3 mb-1">
              <span>CPU</span>
              <span className="tabular">{s.cpuPct != null ? pct(s.cpuPct) : '—'}</span>
            </div>
            <Meter value={s.cpuPct} />
          </div>
          <div>
            <div className="flex justify-between text-label-3 mb-1">
              <span>Memory</span>
              <span className="tabular">{s.memPct != null ? pct(s.memPct) : '—'}</span>
            </div>
            <Meter value={s.memPct} />
          </div>
        </div>
      )}
      <div className="flex items-center gap-3 text-subheadline text-label-2 tabular">
        {s.rpm != null && s.hosts?.length > 0 && <span>{compact(s.rpm)} req/min</span>}
        <span className={cx(s.errorsPerMin >= 5 && 'text-orange')}>{s.errorsPerMin ? `${s.errorsPerMin < 1 ? s.errorsPerMin.toFixed(1) : Math.round(s.errorsPerMin)} err/min` : 'no errors'}</span>
        {s.restarts > 0 && <span className={cx(s.recentRestarts > 0 && 'text-orange')}>{s.restarts} restarts</span>}
      </div>
    </button>
  );
}

export default function Overview() {
  const services = useStore((s) => s.sections.services) || [];
  const health = useStore((s) => s.sections.health);
  const traffic = useStore((s) => s.sections.traffic);
  const alerts = useStore((s) => s.sections.alerts);
  const uptime = useStore((s) => s.sections.uptime) || [];
  const database = useStore((s) => s.sections.database);
  const crashes = useStore((s) => s.sections.crashes) || [];
  const errors = useStore((s) => s.sections.errors);
  const sources = useStore((s) => s.sections.sources);
  const session = useStore((s) => s.sections.session);
  const [filter, setFilter] = useState('all');
  const now = useNow(15_000);

  const sorted = useMemo(() => [...services].sort((a, b) => (ORDER[a.health] ?? 5) - (ORDER[b.health] ?? 5) || a.short.localeCompare(b.short)), [services]);
  const problems = sorted.filter((s) => s.health === 'down' || s.health === 'degraded' || s.health === 'deploying');
  const exposed = sorted.filter((s) => s.hosts?.length);
  const list = filter === 'problems' ? problems : filter === 'exposed' ? exposed : sorted;

  const history = traffic?.history || [];
  const reqSpark = history.map((h) => h.total);
  const errRate = traffic?.rpm ? traffic.byClass?.['5xx'] / Math.max(1, traffic.rpm) : history.length ? history.slice(-5).reduce((a, h) => a + h.e5, 0) / Math.max(1, history.slice(-5).reduce((a, h) => a + h.total, 0)) : null;
  const errorsPerMin = services.reduce((a, s) => a + (s.errorsPerMin || 0), 0);
  const db = database?.instances?.[0];
  const reach = database?.reachability;
  const dbValue = reach?.unreachable ? 'Unreachable' : db ? (db.down ? 'Down' : db.status === 'maintenance' ? 'Maintenance' : db.status === 'up' ? 'Running' : db.stateText) : '—';
  const dbSub = reach?.unreachable
    ? `${reach.last2m} connection errors in 2 min`
    : db
      ? `${num(database.stats?.errors1h || 0)} Postgres errors · last hour`
      : database?.status === 'none'
        ? 'not found · open to set it up'
        : database?.status === 'forbidden' || database?.status === 'error'
          ? 'status unavailable'
          : 'checking…';
  const backendUptime = uptime.filter((u) => u.group !== 'frontend');
  const k8sError = sources?.kubernetes?.status === 'error' ? sources.kubernetes.message : null;
  // Problems first; alerts whose problem went away (recovering) after them.
  const activeAlerts = [...(alerts?.active || [])].sort((a, b) => Number(!!a.clearing) - Number(!!b.clearing));
  const rollingOut = health?.counts?.deploying || 0;

  return (
    <ViewScroll>
      {k8sError && (
        <Card className="mb-4 flex items-start gap-3 !bg-red-tint animate-rise">
          <Icon name="errors" size={18} className="text-red mt-0.5" />
          <div>
            <div className="text-headline font-semibold">Can't read the cluster</div>
            <div className="text-callout text-label-2 mt-0.5 selectable">{k8sError}</div>
          </div>
        </Card>
      )}

      <div className="@container animate-rise">
      <div className="grid grid-cols-2 @xl:grid-cols-3 @5xl:grid-cols-6 gap-3">
        <Stat icon="traffic" label="Requests / min" value={traffic?.rpm != null && sources?.live?.status === 'streaming' ? compact(traffic.rpm) : history.length ? compact(history[history.length - 1].total) : '—'} sub="load balancer, last 60 s" spark={reqSpark.length > 2 ? reqSpark : null} onClick={() => navigate('traffic')} />
        <Stat icon="bolt" label="Failing requests" value={errRate != null ? pct(errRate, 2) : '—'} sub="5xx responses" tone={errRate >= 0.05 ? 'red' : errRate >= 0.01 ? 'orange' : null} spark={history.length > 2 ? history.map((h) => (h.total ? h.e5 / h.total : 0)) : null} onClick={() => navigate({ to: 'traffic', filter: { status: '5xx' } })} />
        <Stat icon="clock" label="Latency p95" value={traffic?.p95 != null ? ms(traffic.p95) : '—'} sub={traffic?.p50 != null ? `p50 ${ms(traffic.p50)}` : 'waiting for traffic'} tone={traffic?.p95 >= 3000 ? 'orange' : null} onClick={() => navigate('traffic')} />
        <Stat icon="errors" label="Errors / min" value={errorsPerMin ? (errorsPerMin < 10 ? errorsPerMin.toFixed(1) : compact(errorsPerMin)) : '0'} sub={`${(errors?.backend || []).filter((g) => g.active).length} active error types`} tone={errorsPerMin >= 30 ? 'orange' : null} onClick={() => navigate('errors')} />
        <Stat icon="pod" label="Pods ready" value={health?.counts ? `${health.counts.podsReady}/${health.counts.pods}` : '—'} sub={health?.counts ? `${health.counts.restarts1h} restarts in the last hour` : ''} tone={health?.counts && health.counts.podsReady < health.counts.pods ? 'orange' : null} onClick={() => navigate('crashes')} />
        <Stat icon="database" label="Database" value={dbValue} sub={dbSub} tone={reach?.unreachable || db?.down ? 'red' : db?.status === 'maintenance' || database?.stats?.connLimit1h ? 'orange' : null} onClick={() => navigate('database')} />
      </div>
      </div>

      <div className="mt-6 grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_340px] gap-6">
        <section className="min-w-0 animate-rise" style={{ animationDelay: '60ms' }}>
          <SectionTitle
            title="Services"
            subtitle={
              <>
                {services.length} workloads in the {session?.namespace || 'flobi'} namespace
                {rollingOut > 0 && <span className="text-accent font-medium"> · {rollingOut} rolling out</span>}
              </>
            }
            right={
              <>
                <Segmented
                  size="sm"
                  value={filter}
                  onChange={setFilter}
                  options={[
                    { value: 'all', label: 'All', count: sorted.length },
                    { value: 'problems', label: 'Problems', count: problems.length, dot: problems.some((p) => p.health === 'down') ? 'red' : problems.length ? 'orange' : undefined },
                    { value: 'exposed', label: 'Public', count: exposed.length },
                  ]}
                />
                <ExportButton name="services" title="Services" columns={SERVICE_COLUMNS} rows={list} />
              </>
            }
          />
          {!services.length ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
              {Array.from({ length: 9 }, (_, i) => (
                <div key={i} className="card p-3.5 h-[132px]">
                  <div className="skeleton h-4 w-24" />
                  <div className="skeleton h-3 w-32 mt-3" />
                  <div className="skeleton h-2 w-full mt-6" />
                </div>
              ))}
            </div>
          ) : list.length ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3">
              {list.map((s) => (
                <ServiceCard key={s.name} s={s} />
              ))}
            </div>
          ) : (
            <Card>
              <Empty title="No problems" message="Every service has all its pods ready." />
            </Card>
          )}
        </section>

        <aside className="min-w-0 flex flex-col gap-6 animate-rise" style={{ animationDelay: '120ms' }}>
          <section>
            <SectionTitle title="Active alerts" right={<button type="button" className="text-callout text-accent" onClick={() => navigate({ to: 'recent', filter: 'open' })}>See all</button>} />
            <Card pad={false} className="p-1.5">
              {!activeAlerts.length && <div className="px-3 py-6 text-center text-callout text-label-2">No active alerts</div>}
              {activeAlerts.slice(0, 6).map((a) => (
                <button key={a.id} type="button" onClick={() => navigate(a.view || 'crashes')} className={cx('w-full text-left flex gap-2.5 p-2 rounded-[8px] hover:bg-fill-4', a.clearing && 'opacity-60')}>
                  <StatusDot tone={SEV_TONE[a.severity]} size={8} className="mt-1.5" pulse={a.severity === 'critical' && !a.acked && !a.clearing} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="text-callout font-semibold truncate">{a.title}</span>
                      {a.clearing && <RecoveringTag />}
                      {(a.acked || a.silenced) && <SilencedTag />}
                    </div>
                    <div className="text-subheadline text-label-2 truncate">
                      {ago(a.openedAt, now)}
                      {a.detail ? ` · ${a.detail}` : ''}
                    </div>
                  </div>
                </button>
              ))}
            </Card>
          </section>

          <section>
            <SectionTitle title="Endpoints" subtitle="Checked from this computer every 30 s" right={<><button type="button" className="text-callout text-accent" onClick={() => navigate('frontends')}>All</button><ExportButton name="endpoints" title="Endpoints" columns={ENDPOINT_COLUMNS} rows={backendUptime} /></>} />
            <Card pad={false} className="divide-y divide-separator">
              {backendUptime.map((u) => (
                <div key={u.id} className="px-3.5 py-2.5">
                  <div className="flex items-center gap-2 text-callout">
                    <StatusDot tone={u.state === 'up' ? 'green' : u.state === 'slow' ? 'orange' : u.state === 'down' ? 'red' : 'gray'} size={7} />
                    <span className="font-medium truncate">{u.name}</span>
                    <span className="ml-auto tabular text-label-2">{u.state === 'offline' ? 'Offline' : u.state === 'down' ? u.error || `HTTP ${u.status}` : u.ms != null ? `${u.ms} ms` : '…'}</span>
                  </div>
                  <UptimeBars history={u.history} className="mt-2" />
                </div>
              ))}
              {!backendUptime.length && <div className="px-3 py-6 text-center text-callout text-label-2">No endpoints configured</div>}
            </Card>
          </section>

          <section>
            <SectionTitle title="Recent crashes" right={<button type="button" className="text-callout text-accent" onClick={() => navigate('crashes')}>See all</button>} />
            <Card pad={false} className="p-1.5">
              {!crashes.length && <div className="px-3 py-6 text-center text-callout text-label-2">No crashes in the last 7 days</div>}
              {crashes.slice(0, 4).map((c) => (
                <button key={c.id} type="button" onClick={() => inspect('crash', c.id)} className="w-full text-left flex gap-2.5 p-2 rounded-[8px] hover:bg-fill-4">
                  <div className={cx('w-6 h-6 rounded-full grid place-items-center shrink-0', c.reason === 'OOMKilled' ? 'bg-red-tint' : 'bg-orange-tint')}>
                    <Icon name={c.reason === 'OOMKilled' ? 'memory' : 'bolt'} size={12} className={c.reason === 'OOMKilled' ? 'text-red' : 'text-orange'} strokeWidth={2} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-callout font-semibold truncate">
                      {short(c.service)} · {crashReason(c).label}
                    </div>
                    <div className="text-subheadline text-label-2 truncate">
                      {ago(c.at, now)} · {c.fromLogs ? 'from the logs' : `exit ${c.exitCode ?? '—'} · ${c.restarts} restarts`}
                    </div>
                  </div>
                </button>
              ))}
            </Card>
          </section>
        </aside>
      </div>
    </ViewScroll>
  );
}
