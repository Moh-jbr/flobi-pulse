import { useStore, inspect } from '../lib/store.js';
import { ViewScroll } from '../components/Toolbar.jsx';
import { Card, SectionTitle, Meter, Pill, StatusDot, cx, useNow, Empty, HealthPill } from '../components/ui.jsx';
import { Sparkline } from '../components/charts.jsx';
import Icon from '../components/icons.jsx';
import { pct, bytes, cores, ago, short, dayTime, ms, compact, duration } from '../lib/format.js';
import ExportButton from '../components/ExportButton.jsx';

const pctNum = (v) => (v == null ? '' : Math.round(v * 1000) / 10);
const NODE_COLUMNS = [
  { label: 'Node', get: (n) => n.name },
  { label: 'Pool', get: (n) => n.pool },
  { label: 'Machine', get: (n) => n.machine },
  { label: 'Zone', get: (n) => n.zone },
  { label: 'Spot', get: (n) => (n.spot ? 'yes' : '') },
  { label: 'CPU %', get: (n) => pctNum(n.cpuPct) },
  { label: 'CPU used (cores)', get: (n) => (n.cpu != null ? Math.round(n.cpu) / 1000 : '') },
  { label: 'CPU allocatable (cores)', get: (n) => (n.cpuAlloc != null ? Math.round(n.cpuAlloc) / 1000 : '') },
  { label: 'Memory %', get: (n) => pctNum(n.memPct) },
  { label: 'Memory used (GB)', get: (n) => (n.mem != null ? Math.round(n.mem / 1e7) / 100 : '') },
  { label: 'Memory allocatable (GB)', get: (n) => (n.memAlloc != null ? Math.round(n.memAlloc / 1e7) / 100 : '') },
  { label: 'Pods', get: (n) => n.pods },
  { label: 'Created', get: (n) => (n.createdAt ? new Date(n.createdAt) : '') },
  { label: 'Message', get: (n) => n.message || '' },
];
const SCALING_COLUMNS = [
  { label: 'Service', get: (s) => s.short },
  { label: 'Type', get: (s) => s.kind },
  { label: 'Replicas now', get: (s) => s.current ?? '' },
  { label: 'Min', get: (s) => s.min },
  { label: 'Max', get: (s) => s.max },
  { label: 'At max', get: (s) => (s.atMax ? 'yes' : '') },
  { label: 'CPU %', get: (s) => s.cpuNow ?? '' },
  { label: 'CPU target %', get: (s) => s.cpuTarget ?? '' },
  { label: 'Memory %', get: (s) => s.memNow ?? '' },
  { label: 'Memory target %', get: (s) => s.memTarget ?? '' },
  { label: 'Triggers', get: (s) => (s.triggers || []).join(', ') },
  { label: 'Last change', get: (s) => (s.lastScaleAt ? new Date(s.lastScaleAt) : '') },
];
const INFRA_COLUMNS = [
  { label: 'Name', get: (s) => s.name },
  { label: 'Health', get: (s) => s.health },
  { label: 'Memory %', get: (s) => pctNum(s.memPct) },
  { label: 'Memory limit', get: (s) => s.memLimit || '' },
  { label: 'Restarts', get: (s) => s.restarts },
];
const CRON_COLUMNS = [
  { label: 'Job', get: (c) => c.name },
  { label: 'Schedule', get: (c) => c.schedule },
  { label: 'Status', get: (c) => (c.active ? 'Running' : c.lastStatus === 'failed' ? 'Failed' : c.suspended ? 'Suspended' : 'OK') },
  { label: 'Last run', get: (c) => (c.lastScheduleAt ? new Date(c.lastScheduleAt) : '') },
  { label: 'Last success', get: (c) => (c.lastSuccessAt ? new Date(c.lastSuccessAt) : '') },
  { label: 'Last message', get: (c) => c.lastMessage || '' },
];
const CERT_COLUMNS = [
  { label: 'Certificate', get: (c) => c.name },
  { label: 'Status', get: (c) => (c.harmless ? `Not in use (${c.status})` : c.status) },
  { label: 'Domains', get: (c) => c.domains.map((d) => `${d.domain} (${d.status})`).join(', ') },
  { label: 'Renews before', get: (c) => (c.expiresAt ? new Date(c.expiresAt) : '') },
  { label: 'Note', get: (c) => c.reason || '' },
];
const RUN_COLUMNS = [
  { label: 'Service', get: (r) => r.name },
  { label: 'Ready', get: (r) => (r.ready ? 'yes' : 'no') },
  { label: 'Revision', get: (r) => r.revision || '' },
  { label: 'Requests / min', get: (r) => r.rpm ?? '' },
  { label: '5xx %', get: (r) => (r.errRate != null ? Math.round(r.errRate * 1000) / 10 : '') },
  { label: 'p95 (ms)', get: (r) => r.p95 ?? '' },
  { label: 'Reason', get: (r) => r.reason || '' },
];
const ROUTE_COLUMNS = [
  { label: 'Host', get: (r) => r.host },
  { label: 'Path', get: (r) => r.path },
  { label: 'Service', get: (r) => short(r.workload || r.service) },
  { label: 'Kubernetes Service', get: (r) => r.service || '' },
];

function ReplicaBar({ min, max, current }) {
  const span = Math.max(1, max);
  return (
    <div className="relative h-5 w-full">
      <div className="absolute top-2 inset-x-0 h-1 rounded-full bg-fill-3" />
      <div className="absolute top-2 h-1 rounded-full bg-accent/35" style={{ left: `${(min / span) * 100}%`, right: 0 }} />
      <div className="absolute top-2 left-0 h-1 rounded-full bg-accent" style={{ width: `${((current ?? 0) / span) * 100}%`, transition: 'width 700ms var(--ease-spring)' }} />
      {Array.from({ length: max + 1 }, (_, i) => (
        <span key={i} className="absolute top-[5px] w-px h-2.5 bg-separator" style={{ left: `${(i / span) * 100}%` }} />
      ))}
    </div>
  );
}

export default function Infrastructure() {
  const session = useStore((s) => s.sections.session);
  const nodes = useStore((s) => s.sections.nodes) || [];
  const scaling = useStore((s) => s.sections.scaling) || [];
  const jobs = useStore((s) => s.sections.jobs);
  const certs = useStore((s) => s.sections.certificates) || [];
  const ingress = useStore((s) => s.sections.ingress) || [];
  const cloudRun = useStore((s) => s.sections.cloudRun) || [];
  const services = useStore((s) => s.sections.services) || [];
  const health = useStore((s) => s.sections.health);
  const now = useNow(30_000);
  const infra = services.filter((s) => ['rabbitmq', 'redis'].includes(s.name));
  const cl = session?.cluster || {};

  return (
    <ViewScroll>
      <Card className="flex items-center gap-6 flex-wrap animate-rise">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-accent-tint grid place-items-center">
            <Icon name="infrastructure" size={20} className="text-accent" />
          </div>
          <div>
            <div className="text-title3 font-semibold">{cl.name || 'flobi-cluster'}</div>
            <div className="text-callout text-label-2">
              {cl.location} · Kubernetes {cl.version?.replace(/^v/, '') || '—'}
            </div>
          </div>
        </div>
        <div className="flex gap-8 ml-auto text-callout">
          {[
            ['Nodes', health?.counts ? `${health.counts.nodesReady}/${health.counts.nodes} ready` : '—'],
            ['Pods', health?.counts ? `${health.counts.podsReady}/${health.counts.pods} ready` : '—'],
            ['Workloads', services.length],
            ['Endpoint', cl.endpoint || '—'],
          ].map(([k, v]) => (
            <div key={k}>
              <div className="text-label-2 text-subheadline">{k}</div>
              <div className="font-semibold tabular selectable">{v}</div>
            </div>
          ))}
        </div>
      </Card>

      <section className="mt-6 animate-rise" style={{ animationDelay: '40ms' }}>
        <SectionTitle title="Nodes" subtitle="Live usage from metrics-server, against what the node can allocate" right={<ExportButton name="nodes" title="Nodes" columns={NODE_COLUMNS} rows={nodes} />} />
        <div className="grid grid-cols-[repeat(auto-fill,minmax(270px,1fr))] gap-3">
          {nodes.map((n) => (
            <Card key={n.name} className={cx('flex flex-col gap-3', n.state === 'bad' && 'shadow-[0_0_0_1.5px_var(--red),var(--shadow-card)]')}>
              <div className="flex items-center gap-2 min-w-0">
                <StatusDot tone={n.state === 'ok' ? 'green' : n.state === 'warn' ? 'orange' : 'red'} size={8} />
                <span className="text-headline font-semibold truncate font-mono" title={n.name}>
                  …{n.name.slice(-14)}
                </span>
                {n.spot && (
                  <Pill tone="accent" strong>
                    Spot
                  </Pill>
                )}
              </div>
              <div className="text-subheadline text-label-2">
                {n.pool} · {n.machine} · {n.zone?.replace('europe-west1-', 'zone ')}
              </div>
              {[
                ['CPU', n.cpuPct, `${cores(n.cpu)} of ${cores(n.cpuAlloc)}`],
                ['Memory', n.memPct, `${bytes(n.mem)} of ${bytes(n.memAlloc)}`],
              ].map(([k, v, d]) => (
                <div key={k}>
                  <div className="flex justify-between text-subheadline mb-1">
                    <span className="text-label-2">{k}</span>
                    <span className="tabular text-label-2">
                      <span className="text-label font-semibold">{pct(v)}</span> · {d}
                    </span>
                  </div>
                  <Meter value={v} height={5} />
                </div>
              ))}
              <div className="text-subheadline text-label-3 flex justify-between">
                <span>{n.pods} pods</span>
                <span>up {duration(now - n.createdAt)}</span>
              </div>
              {n.message && <div className="text-callout text-orange">{n.message}</div>}
            </Card>
          ))}
          {!nodes.length && <Card className="col-span-full"><Empty icon="infrastructure" tone="gray" title="Waiting for nodes…" /></Card>}
        </div>
      </section>

      <section className="mt-8 animate-rise" style={{ animationDelay: '80ms' }}>
        <SectionTitle title="Autoscaling" subtitle="HPAs and KEDA scalers — current replicas between min and max" right={<ExportButton name="autoscaling" title="Autoscaling" columns={SCALING_COLUMNS} rows={scaling} />} />
        <Card pad={false} className="@container overflow-hidden">
          <div className="grid grid-cols-[minmax(110px,1fr)_minmax(120px,1.3fr)_84px_110px] @5xl:grid-cols-[180px_70px_minmax(160px,1fr)_90px_120px_120px_110px] gap-4 px-4 h-8 items-center text-subheadline font-semibold text-label-2 hairline-b">
            <span>Service</span>
            <span className="hidden @5xl:block">Type</span>
            <span>Replicas</span>
            <span className="text-right">Now</span>
            <span>CPU</span>
            <span className="hidden @5xl:block">Memory</span>
            <span className="hidden @5xl:block">Last change</span>
          </div>
          {scaling.map((s) => (
            <button key={s.service} type="button" onClick={() => inspect('service', s.service)} className="w-full text-left grid grid-cols-[minmax(110px,1fr)_minmax(120px,1.3fr)_84px_110px] @5xl:grid-cols-[180px_70px_minmax(160px,1fr)_90px_120px_120px_110px] gap-4 px-4 py-2.5 items-center hairline-b hover:bg-fill-4 text-callout">
              <span className="font-semibold truncate">{s.short}</span>
              <span className="hidden @5xl:block text-label-2 uppercase text-subheadline font-semibold">{s.kind}</span>
              <ReplicaBar min={s.min} max={s.max} current={s.current} />
              <span className={cx('text-right tabular font-semibold', s.atMax && 'text-orange')}>
                {s.current ?? '—'}
                <span className="text-label-3 font-normal">
                  {' '}
                  / {s.min}–{s.max}
                </span>
              </span>
              <span className="tabular text-label-2 truncate">{s.cpuNow != null ? `${s.cpuNow}% / ${s.cpuTarget}%` : s.triggers?.length ? s.triggers.join(', ') : '—'}</span>
              <span className="hidden @5xl:block tabular text-label-2">{s.memNow != null ? `${s.memNow}% / ${s.memTarget}%` : '—'}</span>
              <span className="hidden @5xl:block text-label-2">{s.lastScaleAt ? ago(s.lastScaleAt, now) : '—'}</span>
            </button>
          ))}
        </Card>
      </section>

      <div className="mt-8 grid grid-cols-1 2xl:grid-cols-2 gap-6">
        <section className="animate-rise" style={{ animationDelay: '100ms' }}>
          <SectionTitle title="Message queue & cache" subtitle="RabbitMQ and Redis containers" right={<ExportButton name="queue-and-cache" title="Queue and cache" columns={INFRA_COLUMNS} rows={infra} />} />
          <div className="grid grid-cols-2 gap-3">
            {infra.map((s) => (
              <Card key={s.name} as="button" onClick={() => inspect('service', s.name)} className="press text-left flex flex-col gap-2.5">
                <div className="flex items-center gap-2">
                  <Icon name={s.name === 'redis' ? 'memory' : 'stack'} size={16} className="text-accent" />
                  <span className="text-headline font-semibold">{s.name}</span>
                  <span className="ml-auto">
                    <HealthPill health={s.health} />
                  </span>
                </div>
                <div>
                  <div className="flex justify-between text-subheadline mb-1">
                    <span className="text-label-2">Memory</span>
                    <span className="tabular">
                      {bytes(s.mem)} of {s.memLimit || '—'}
                    </span>
                  </div>
                  <Meter value={s.memPct} height={5} />
                </div>
                <div className="text-subheadline text-label-3">{s.restarts} restarts · CPU {cores(s.cpu)}</div>
              </Card>
            ))}
          </div>
          <p className="text-subheadline text-label-3 mt-2 px-1">Queue depth and Redis internals need a small read-only exporter inside the cluster — not installed (would need your approval).</p>
        </section>

        <section className="animate-rise" style={{ animationDelay: '120ms' }}>
          <SectionTitle title="Scheduled jobs" right={<ExportButton name="scheduled-jobs" title="Scheduled jobs" columns={CRON_COLUMNS} rows={jobs?.cronjobs || []} />} />
          <Card pad={false} className="overflow-hidden">
            {!(jobs?.cronjobs || []).length && <Empty icon="clock" tone="gray" title="No CronJobs" />}
            {(jobs?.cronjobs || []).map((c) => (
              <div key={c.name} className="px-4 py-3 hairline-b flex items-center gap-3">
                <StatusDot tone={c.lastStatus === 'failed' ? 'red' : c.suspended ? 'gray' : 'green'} size={8} />
                <div className="min-w-0 flex-1">
                  <div className="text-headline font-semibold">{c.name}</div>
                  <div className="text-subheadline text-label-2">
                    <span className="font-mono">{c.schedule}</span> · last run {c.lastScheduleAt ? ago(c.lastScheduleAt, now) : 'never'} · last success {c.lastSuccessAt ? ago(c.lastSuccessAt, now) : 'never'}
                  </div>
                </div>
                <Pill tone={c.lastStatus === 'failed' ? 'red' : c.active ? 'accent' : 'green'} strong={c.lastStatus === 'failed'}>
                  {c.active ? 'Running' : c.lastStatus === 'failed' ? 'Failed' : c.suspended ? 'Suspended' : 'OK'}
                </Pill>
              </div>
            ))}
            {(jobs?.jobs || []).slice(0, 5).map((j) => (
              <div key={j.name} className="px-4 py-2 hairline-b flex items-center gap-3 text-callout">
                <span className="w-2" />
                <span className="font-mono text-subheadline text-label-2 truncate flex-1">{j.name}</span>
                <span className="text-label-3">{j.startedAt ? dayTime(j.startedAt) : '—'}</span>
                <Pill tone={j.status === 'failed' ? 'red' : j.status === 'running' ? 'accent' : 'green'}>{j.status}</Pill>
              </div>
            ))}
          </Card>
        </section>

        <section className="animate-rise" style={{ animationDelay: '140ms' }}>
          <SectionTitle title="Certificates" subtitle="Google-managed TLS on the load balancer" right={<ExportButton name="certificates" title="Certificates" columns={CERT_COLUMNS} rows={certs} />} />
          <Card pad={false} className="overflow-hidden">
            {!certs.length && <Empty icon="seal" tone="gray" title="No managed certificates found" />}
            {certs.map((c) => (
              <div key={c.name} className="px-4 py-3 hairline-b">
                <div className="flex items-center gap-2">
                  <Icon name="seal" size={15} className={c.status === 'Active' ? 'text-green' : c.harmless ? 'text-label-3' : 'text-orange'} />
                  <span className="text-headline font-semibold">{c.name}</span>
                  <span className="ml-auto text-subheadline text-label-2">{c.expiresAt ? `renews before ${dayTime(c.expiresAt)}` : ''}</span>
                  <Pill tone={c.status === 'Active' ? 'green' : c.harmless ? 'gray' : 'orange'}>{c.harmless ? 'Not in use' : c.status}</Pill>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {c.domains.map((d) => (
                    <span key={d.domain} title={d.status} className={cx('text-subheadline px-2 h-5 inline-flex items-center rounded-full', d.status === 'Active' || c.harmless ? 'bg-fill-4 text-label-2' : 'bg-orange-tint text-orange')}>
                      {d.domain}
                    </span>
                  ))}
                </div>
                {c.harmless && <div className="mt-1.5 text-subheadline text-label-3">{c.status}. {c.reason}</div>}
              </div>
            ))}
          </Card>
        </section>

        <section className="animate-rise" style={{ animationDelay: '160ms' }}>
          <SectionTitle title="Cloud Run" subtitle="Serverless services outside the cluster" right={<ExportButton name="cloud-run" title="Cloud Run" columns={RUN_COLUMNS} rows={cloudRun} />} />
          <Card pad={false} className="overflow-hidden">
            {!cloudRun.length && <Empty icon="cloud" tone="gray" title="No Cloud Run services" />}
            {cloudRun.map((r) => (
              <div key={r.name} className="px-4 py-3 hairline-b flex items-center gap-3">
                <StatusDot tone={r.ready ? 'green' : 'red'} size={8} />
                <div className="min-w-0 flex-1">
                  <div className="text-headline font-semibold">{r.name}</div>
                  <div className="text-subheadline text-label-2 truncate">
                    {r.revision} · {r.rpm != null ? `${compact(r.rpm)} req/min` : '—'} · {r.errRate != null ? `${pct(r.errRate, 1)} 5xx` : '—'} · p95 {ms(r.p95)}
                  </div>
                </div>
                {r.spark?.length > 2 && <Sparkline data={r.spark} width={90} height={26} />}
              </div>
            ))}
          </Card>
        </section>
      </div>

      <section className="mt-8 animate-rise" style={{ animationDelay: '180ms' }}>
        <SectionTitle title="Ingress routes" subtitle={ingress[0]?.ip ? `Load balancer ${ingress[0].ip}` : 'Which service answers which URL'} right={<ExportButton name="ingress-routes" title="Ingress routes" columns={ROUTE_COLUMNS} rows={ingress.flatMap((i) => i.rules || [])} />} />
        <Card pad={false} className="overflow-hidden">
          {ingress.flatMap((i) => i.rules).map((r, idx) => (
            <button key={idx} type="button" onClick={() => r.workload && inspect('service', r.workload)} className="w-full text-left grid grid-cols-[220px_minmax(0,1fr)_200px] gap-4 px-4 py-2.5 hairline-b hover:bg-fill-4 text-callout">
              <span className="font-semibold">{r.host}</span>
              <span className="font-mono text-label-2">{r.path}</span>
              <span className="text-label-2 truncate">→ {short(r.workload || r.service)}</span>
            </button>
          ))}
          {!ingress.length && <Empty icon="globe" tone="gray" title="No ingress found" />}
        </Card>
      </section>
    </ViewScroll>
  );
}
