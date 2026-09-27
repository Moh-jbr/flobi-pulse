import { useEffect, useMemo, useState } from 'react';
import { useStore, setState, navigate, invoke, inspect } from '../lib/store.js';
import Icon from './icons.jsx';
import { cx, HealthPill, Pill, Meter, KeyValue, Button, Spinner, StatusDot, STATE_TONE, StatusCode, IconButton, useNow, useWindowWidth } from './ui.jsx';
import { LineChart, Sparkline } from './charts.jsx';
import { EXPLAIN } from '../views/Events.jsx';
import { LEVEL } from '../views/Logs.jsx';
import { ago, clock, clockMs, dayTime, duration, bytes, cores, pct, ms, short, uaShort, compact } from '../lib/format.js';

const DETAILS = {
  response_sent_by_backend: 'The service answered with this status itself.',
  failed_to_connect_to_backend: "The load balancer couldn't open a connection to any pod.",
  failed_to_pick_backend: 'No healthy pod was available to take the request.',
  backend_connection_closed_before_data_sent_to_client: 'The pod closed the connection before answering (crash, restart or timeout).',
  backend_timeout: 'The pod took longer than the load balancer timeout.',
  client_disconnected_before_any_response: 'The user closed the connection before we answered.',
  backend_early_response_with_non_error_status: 'The pod answered before reading the whole request.',
};

function Section({ title, children, right }) {
  return (
    <section className="px-5 py-4 hairline-t">
      <div className="flex items-center justify-between mb-2.5">
        <h3 className="text-headline font-semibold">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

function LogBlock({ lines, loading, empty = 'No log lines.' }) {
  if (loading)
    return (
      <div className="py-6 grid place-items-center">
        <Spinner />
      </div>
    );
  if (!lines?.length) return <div className="text-callout text-label-2">{empty}</div>;
  return (
    <div className="rounded-[12px] bg-[var(--code-bg)] max-h-[340px] overflow-auto py-1.5 font-mono text-[11px] leading-[15px] selectable">
      {lines.map((l, i) => (
        <div key={l.id || i} className={cx('px-3 py-[1px] whitespace-pre-wrap break-words', l.level === 'ERROR' && 'text-red', l.level === 'WARN' && 'text-orange')}>
          <span className="text-label-3 mr-2">{clockMs(l.ts).slice(0, 8)}</span>
          {l.text}
        </div>
      ))}
    </div>
  );
}

function UsageCharts({ service }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let alive = true;
    invoke('usage:get', { service, range: 3600_000 })
      .then((d) => alive && setData(d))
      .catch(() => alive && setData({ error: true }));
    return () => {
      alive = false;
    };
  }, [service]);
  if (!data) return <div className="skeleton h-[120px]" />;
  if (data.error || !data.cpu?.length || data.cpu.every((s) => s.points.length < 2)) return <div className="text-callout text-label-2">Charts fill in while Flobi Pulse is open (a new point every 15 seconds).</div>;
  const partial = data.since && Date.now() - data.since < 55 * 60_000;
  const COLORS = ['var(--accent)', 'var(--purple)', 'var(--teal)', 'var(--orange)', 'var(--indigo)'];
  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="text-subheadline text-label-2 mb-1">CPU (cores) · per pod{partial ? ` · since ${clock(data.since, false)}` : ' · last hour'}</div>
        <LineChart height={110} area={false} format={(v) => v.toFixed(v < 1 ? 2 : 1)} series={data.cpu.map((s, i) => ({ key: s.pod, label: s.pod.slice(-5), color: COLORS[i % COLORS.length], points: s.points }))} />
      </div>
      <div>
        <div className="text-subheadline text-label-2 mb-1">Memory · per pod</div>
        <LineChart height={110} area={false} format={(v) => bytes(v)} series={data.memory.map((s, i) => ({ key: s.pod, label: s.pod.slice(-5), color: COLORS[i % COLORS.length], points: s.points }))} />
      </div>
    </div>
  );
}

function ServiceInspector({ id }) {
  const s = useStore((st) => st.sections.services?.find((x) => x.name === id));
  const pods = useStore((st) => st.sections.pods) || [];
  const events = useStore((st) => st.sections.events) || [];
  const crashes = useStore((st) => st.sections.crashes) || [];
  const now = useNow(10_000);
  if (!s) return <Gone what="service" />;
  const myPods = pods.filter((p) => p.service === s.name);
  const myEvents = events.filter((e) => e.service === s.name).slice(0, 8);
  const myCrashes = crashes.filter((c) => c.service === s.name).slice(0, 5);
  return (
    <>
      <Header title={s.short} subtitle={`${s.kind} · ${s.name}`} right={<HealthPill health={s.health} />} />
      <div className="px-5 pb-4 flex flex-wrap gap-2">
        <Button size="sm" icon="logs" onClick={() => navigate({ to: 'logs', service: s.name })}>
          Follow logs
        </Button>
        {s.hosts?.length > 0 && (
          <Button size="sm" icon="traffic" onClick={() => navigate({ to: 'traffic', filter: { service: s.name } })}>
            Requests
          </Button>
        )}
        <Button size="sm" icon="errors" onClick={() => navigate({ to: 'errors', filter: { service: s.name } })}>
          Errors
        </Button>
        <IconButton icon="mute" label="Mute alerts for 1 hour" onClick={() => invoke('alerts:mute', { service: s.name, minutes: 60 })} />
      </div>
      {s.reasons?.length > 0 && s.health !== 'healthy' && (
        <div className={cx('mx-5 mb-4 rounded-[14px] px-3.5 py-2.5 text-callout', s.health === 'down' ? 'bg-red-tint' : s.health === 'deploying' ? 'bg-accent-tint' : 'bg-orange-tint')}>
          {s.reasons.map((r, i) => (
            <div key={i}>• {r}</div>
          ))}
        </div>
      )}
      <Section title="At a glance">
        <KeyValue
          items={[
            ['Pods ready', `${s.ready} of ${s.desired}`],
            s.scaling && ['Autoscaling', `${s.scaling.kind.toUpperCase()} ${s.scaling.min}–${s.scaling.max}${s.scaling.cpuTarget ? ` · CPU target ${s.scaling.cpuTarget}%` : ''}`],
            ['Restarts', `${s.restarts} total · ${s.recentRestarts} in 15 min`],
            ['CPU now', `${cores(s.cpu)}${s.cpuLimit ? ` · limit ${s.cpuLimit}/pod` : ''}`],
            ['Memory now', `${bytes(s.mem)}${s.memLimit ? ` · limit ${s.memLimit}/pod` : ''}`],
            s.rpm != null && s.hosts?.length > 0 && ['Traffic', `${compact(s.rpm)} req/min · ${pct(s.err5xxRate, 2)} 5xx · p95 ${ms(s.p95)}`],
            ['Errors', `${s.errorsPerMin ? s.errorsPerMin.toFixed(1) : 0} per minute`],
            ['Image', s.image],
            s.revision && ['Revision', `#${s.revision}`],
            s.hosts?.length && ['Public URLs', s.hosts.join(', ')],
          ]}
        />
      </Section>
      <Section title={`Pods (${myPods.length})`}>
        <div className="flex flex-col gap-1">
          {myPods.map((p) => (
            <button key={p.name} type="button" onClick={() => inspect('pod', p.name)} className="text-left rounded-[12px] px-2.5 py-2 hover:bg-fill-4 -mx-2.5">
              <div className="flex items-center gap-2">
                <StatusDot tone={STATE_TONE[p.state]} size={7} />
                <span className="font-mono text-callout truncate flex-1">{p.name}</span>
                <span className="text-subheadline text-label-2">{p.status}</span>
              </div>
              <div className="grid grid-cols-2 gap-3 mt-1.5 pl-[15px]">
                <div>
                  <div className="flex justify-between text-footnote text-label-3 mb-0.5">
                    <span>CPU</span>
                    <span>{cores(p.cpu)}</span>
                  </div>
                  <Meter value={p.cpu != null && (p.cpuLimit || p.cpuRequest) ? p.cpu / (p.cpuLimit || p.cpuRequest) : null} height={3} />
                </div>
                <div>
                  <div className="flex justify-between text-footnote text-label-3 mb-0.5">
                    <span>Memory</span>
                    <span>{bytes(p.mem)}</span>
                  </div>
                  <Meter value={p.mem != null && p.memLimit ? p.mem / p.memLimit : null} height={3} />
                </div>
              </div>
              <div className="text-footnote text-label-3 mt-1 pl-[15px]">
                {p.restarts} restarts · up {duration(now - (p.containers[0]?.startedAt || p.startedAt))} · {p.node?.slice(-12)}
              </div>
            </button>
          ))}
        </div>
      </Section>
      <Section title="Usage · last hour">
        <UsageCharts service={s.name} />
      </Section>
      {myCrashes.length > 0 && (
        <Section title="Recent crashes">
          {myCrashes.map((c) => (
            <button key={c.id} type="button" onClick={() => inspect('crash', c.id)} className="w-full text-left flex items-center gap-2 py-1.5 text-callout hover:text-accent">
              <Icon name={c.reason === 'OOMKilled' ? 'memory' : 'bolt'} size={13} className={c.reason === 'OOMKilled' ? 'text-red' : 'text-orange'} />
              <span className="flex-1 truncate">
                {c.reason} · exit {c.exitCode ?? '—'}
              </span>
              <span className="text-label-2">{ago(c.at, now)}</span>
            </button>
          ))}
        </Section>
      )}
      <Section title="Recent events">
        {!myEvents.length && <div className="text-callout text-label-2">No recent events.</div>}
        {myEvents.map((e) => (
          <div key={e.id} className="py-1.5 text-callout">
            <div className="flex items-center gap-2">
              <StatusDot tone={e.type === 'Warning' ? 'orange' : 'gray'} size={6} />
              <span className="font-semibold">{e.reason}</span>
              <span className="text-label-3 ml-auto">{ago(e.at, now)}</span>
            </div>
            <div className="text-label-2 pl-[14px] break-words line-clamp-2">{e.message}</div>
          </div>
        ))}
      </Section>
    </>
  );
}

function PodInspector({ id }) {
  const p = useStore((st) => st.sections.pods?.find((x) => x.name === id));
  const events = useStore((st) => st.sections.events) || [];
  const [prev, setPrev] = useState(null);
  const now = useNow(10_000);
  useEffect(() => setPrev(null), [id]);
  if (!p) return <Gone what="pod" />;
  const myEvents = events.filter((e) => e.name === p.name).slice(0, 10);
  const c0 = p.containers[0];
  return (
    <>
      <Header title={p.name} mono subtitle={`Pod of ${p.service}`} right={<Pill tone={STATE_TONE[p.state]} strong={p.state === 'bad'}>{p.status}</Pill>} />
      <div className="px-5 pb-4 flex flex-wrap gap-2">
        <Button size="sm" icon="logs" onClick={() => navigate({ to: 'logs', service: p.service, pod: p.name })}>
          Follow this pod's logs
        </Button>
        <Button size="sm" icon="stack" onClick={() => inspect('service', p.service)}>
          Service
        </Button>
      </div>
      <Section title="Details">
        <KeyValue
          items={[
            ['Ready', p.readyText],
            ['Restarts', p.restarts],
            ['Started', p.startedAt ? `${dayTime(p.startedAt)} (${ago(p.startedAt, now)})` : '—'],
            ['Node', p.node],
            ['Pod IP', p.ip],
            ['CPU', `${cores(p.cpu)} · request ${cores(p.cpuRequest)} · limit ${cores(p.cpuLimit)}`],
            ['Memory', `${bytes(p.mem)} · limit ${bytes(p.memLimit)}`],
            p.message && ['Message', p.message],
          ]}
        />
      </Section>
      {p.containers.map((c) => (
        <Section key={c.name} title={`Container ${c.name}`} right={<Pill tone={c.ready ? 'green' : 'orange'}>{c.ready ? 'Ready' : c.reason || c.state}</Pill>}>
          <KeyValue items={[['Image', c.image], ['State', `${c.state}${c.reason ? ` (${c.reason})` : ''}`], ['Restarts', c.restarts], c.message && ['Message', c.message]]} />
        </Section>
      ))}
      {p.lastTermination && (
        <Section title="Last crash">
          <div className={cx('rounded-[14px] px-3.5 py-2.5 text-callout mb-3', p.lastTermination.reason === 'OOMKilled' ? 'bg-red-tint' : 'bg-orange-tint')}>
            <div className="font-semibold">
              {p.lastTermination.reason === 'OOMKilled' ? 'Ran out of memory' : p.lastTermination.reason} · exit code {p.lastTermination.exitCode}
            </div>
            <div className="text-label-2">{p.lastTermination.at ? `${dayTime(p.lastTermination.at)} · ${ago(p.lastTermination.at, now)}` : ''}</div>
            {p.lastTermination.reason === 'OOMKilled' && <div className="text-label-2 mt-1">It used more than its {bytes(c0?.memLimit)} memory limit, so Kubernetes killed it.</div>}
          </div>
          {prev ? (
            <LogBlock lines={prev.lines} loading={prev.loading} empty="No logs from the previous run (the container may have been replaced)." />
          ) : (
            <Button
              size="sm"
              icon="history"
              onClick={async () => {
                setPrev({ loading: true });
                try {
                  setPrev({ lines: await invoke('logs:previous', { pod: p.name, container: p.lastTermination.container || c0?.name, service: p.service }) });
                } catch (e) {
                  setPrev({ lines: [{ id: 'e', ts: Date.now(), text: e.message, level: 'ERROR' }] });
                }
              }}
            >
              Show logs from right before the crash
            </Button>
          )}
        </Section>
      )}
      <Section title="Events">
        {!myEvents.length && <div className="text-callout text-label-2">No recent events for this pod.</div>}
        {myEvents.map((e) => (
          <div key={e.id} className="py-1.5 text-callout">
            <div className="flex items-center gap-2">
              <StatusDot tone={e.type === 'Warning' ? 'orange' : 'gray'} size={6} />
              <span className="font-semibold">{e.reason}</span>
              {e.count > 1 && <span className="text-label-3">{e.count}×</span>}
              <span className="text-label-3 ml-auto">{ago(e.at, now)}</span>
            </div>
            <div className="text-label-2 pl-[14px] break-words">{e.message}</div>
          </div>
        ))}
      </Section>
    </>
  );
}

function RequestInspector({ data: r }) {
  if (!r) return <Gone what="request" />;
  return (
    <>
      <Header title={`${r.method} ${r.path.split('?')[0]}`} mono subtitle={r.host} right={<StatusCode status={r.status} />} />
      <Section title="Request">
        <KeyValue
          items={[
            ['Time', `${dayTime(r.ts)} · ${clockMs(r.ts)}`],
            ['URL', `https://${r.host}${r.path}`],
            ['Status', r.status],
            ['Latency', ms(r.latencyMs)],
            ['Served by', r.service ? short(r.service) : 'unknown'],
            ['Response size', bytes(r.respSize)],
            ['Request size', bytes(r.reqSize)],
            ['Client', uaShort(r.ua)],
            ['User agent', r.ua],
            ['IP', `${r.ip}${/^1(04|08|62|72|73)\./.test(r.ip) ? ' (Cloudflare edge)' : ''}`],
            r.referer && ['Referer', r.referer],
            ['Protocol', r.protocol],
            r.cache && ['Cache', r.cache],
            r.trace && ['Trace', r.trace.split('/').pop()],
          ]}
        />
      </Section>
      {r.statusDetails && (
        <Section title="What the load balancer says">
          <div className="text-callout">
            <span className="font-mono text-label-2">{r.statusDetails}</span>
            <div className="mt-1">{DETAILS[r.statusDetails] || 'See Google Cloud load balancer status details.'}</div>
          </div>
        </Section>
      )}
      {r.service && (
        <div className="px-5 py-4 hairline-t flex gap-2">
          <Button size="sm" icon="logs" onClick={() => navigate({ to: 'logs', service: r.service, from: r.ts - 60_000, until: r.ts + 60_000 })}>
            {short(r.service)} logs around this request
          </Button>
        </div>
      )}
    </>
  );
}

function ErrorInspector({ id }) {
  const errors = useStore((st) => st.sections.errors);
  const now = useNow(10_000);
  const g = useMemo(() => [...(errors?.backend || []), ...(errors?.frontend || [])].find((x) => x.id === id), [errors, id]);
  if (!g) return <Gone what="error" />;
  if (g.source === 'frontend') {
    return (
      <>
        <Header title={g.title} subtitle={`${g.project} · ${g.culprit}`} right={<Pill tone={g.level === 'fatal' ? 'red' : g.level === 'warning' ? 'orange' : 'red'} strong>{g.level}</Pill>} wrap />
        <div className="px-5 pb-4">
          {g.link && (
            <Button size="sm" icon="external" onClick={() => invoke('open:external', { url: g.link })}>
              Open in Sentry
            </Button>
          )}
        </div>
        <Section title="Frequency · last 24 hours">
          <Sparkline data={g.spark} width={380} height={56} color="var(--red)" />
        </Section>
        <Section title="Details">
          <KeyValue items={[['Issue', g.shortId], ['Events', compact(g.count)], ['Users affected', compact(g.users)], ['First seen', `${dayTime(g.firstSeen)} (${ago(g.firstSeen, now)})`], ['Last seen', ago(g.lastSeen, now)], ['Status', g.substatus || g.status], ['Handled', g.unhandled ? 'No — it crashed the page' : 'Yes'], ['Platform', g.platform]]} />
        </Section>
      </>
    );
  }
  return (
    <>
      <Header title={g.title} subtitle={`${short(g.service)}${g.context ? ` · ${g.context}` : ''}`} right={g.isNew ? <Pill tone="accent" icon="sparkles" strong>New</Pill> : null} wrap />
      <div className="px-5 pb-4 flex gap-2 flex-wrap">
        <Button size="sm" icon="logs" onClick={() => navigate({ to: 'logs', service: g.service, level: 'ERROR', from: g.lastSeen - 120_000, until: g.lastSeen + 60_000 })}>
          Logs around the last one
        </Button>
        <Button size="sm" icon="stack" onClick={() => inspect('service', g.service)}>
          Service
        </Button>
      </div>
      <Section title="Last hour">
        <Sparkline data={g.spark} width={380} height={56} color="var(--red)" />
      </Section>
      <Section title="Details">
        <KeyValue items={[['Occurrences', `${compact(g.count)} (${compact(g.count1h)} in the last hour)`], ['First seen', `${dayTime(g.firstSeen)} (${ago(g.firstSeen, now)})`], ['Last seen', ago(g.lastSeen, now)], ['Pods', g.pods.join(', ')]]} />
      </Section>
      {g.stack?.length > 0 && (
        <Section title="Stack trace">
          <pre className="rounded-[12px] bg-[var(--code-bg)] p-3 font-mono text-[11px] leading-[15px] overflow-auto max-h-60 selectable whitespace-pre">{g.stack.join('\n')}</pre>
        </Section>
      )}
      <Section title="Latest occurrences">
        <LogBlock lines={[...g.samples].reverse().map((x, i) => ({ id: i, ts: x.ts, text: x.text, level: 'ERROR' }))} />
      </Section>
    </>
  );
}

function CrashInspector({ id }) {
  const c = useStore((st) => st.sections.crashes?.find((x) => x.id === id));
  const podExists = useStore((st) => !!st.sections.pods?.find((x) => x.name === c?.pod));
  const [logs, setLogs] = useState({ loading: true });
  const now = useNow(10_000);
  useEffect(() => {
    if (!c) return;
    let alive = true;
    setLogs({ loading: true });
    const load = podExists ? invoke('logs:previous', { pod: c.pod, container: c.container, service: c.service }) : invoke('logs:query', { pod: c.pod, from: c.at - 5 * 60_000, until: c.at + 5_000, limit: 300 });
    load.then((lines) => alive && setLogs({ lines })).catch((e) => alive && setLogs({ lines: [{ id: 'e', ts: Date.now(), text: e.message, level: 'ERROR' }] }));
    return () => {
      alive = false;
    };
  }, [id]);
  if (!c) return <Gone what="crash" />;
  const oom = c.reason === 'OOMKilled';
  return (
    <>
      <Header title={oom ? 'Out of memory' : c.reason} subtitle={`${short(c.service)} · ${dayTime(c.at)}`} right={<Pill tone={oom ? 'red' : 'orange'} strong>exit {c.exitCode ?? '—'}</Pill>} />
      <div className="mx-5 mb-4 rounded-[14px] bg-fill-4 px-3.5 py-2.5 text-callout">
        {oom ? 'The container used more memory than its limit and the kernel killed it. Kubernetes restarted it.' : c.exitCode === 137 ? 'The container was killed (SIGKILL) — usually a failed liveness probe or eviction.' : c.exitCode === 143 ? 'The container was asked to stop (SIGTERM) and exited.' : c.exitCode === 1 ? 'The app exited with an error (usually an unhandled exception at startup or runtime).' : 'The container stopped and Kubernetes restarted it.'}
      </div>
      <div className="px-5 pb-4 flex gap-2">
        <Button size="sm" icon="stack" onClick={() => inspect('service', c.service)}>
          Service
        </Button>
        {podExists && (
          <Button size="sm" icon="pod" onClick={() => inspect('pod', c.pod)}>
            Pod
          </Button>
        )}
      </div>
      <Section title="Details">
        <KeyValue items={[['Pod', c.pod], ['Container', c.container], ['When', `${dayTime(c.at)} (${ago(c.at, now)})`], ['Reason', c.reason], ['Exit code', c.exitCode], ['Restarts so far', c.restarts], c.message && ['Message', c.message]]} />
      </Section>
      <Section title={podExists ? 'Logs from right before the crash' : 'Logs around the crash (Cloud Logging)'}>
        <LogBlock lines={logs.lines} loading={logs.loading} empty="No logs were kept from before this crash." />
      </Section>
    </>
  );
}

function LogInspector({ data: l }) {
  if (!l) return <Gone what="line" />;
  const lv = LEVEL[l.level] || LEVEL.INFO;
  return (
    <>
      <Header title="Log line" subtitle={`${short(l.service)} · ${l.pod}`} right={<span className={cx('h-5 px-2 rounded-md text-subheadline font-bold grid place-items-center', lv.cls)}>{l.level}</span>} />
      <Section title={dayTime(l.ts)}>
        <pre className="rounded-[12px] bg-[var(--code-bg)] p-3 font-mono text-[11.5px] leading-[16px] whitespace-pre-wrap break-words selectable">{l.text}</pre>
      </Section>
      {l.json && (
        <Section title="Structured fields">
          <pre className="rounded-[12px] bg-[var(--code-bg)] p-3 font-mono text-[11px] leading-[15px] whitespace-pre-wrap break-words selectable max-h-80 overflow-auto">{JSON.stringify(l.json, null, 2)}</pre>
        </Section>
      )}
      <div className="px-5 py-4 hairline-t flex gap-2">
        <Button size="sm" icon="history" onClick={() => navigate({ to: 'logs', service: l.service, from: l.ts - 60_000, until: l.ts + 60_000 })}>
          Show surrounding lines
        </Button>
        <Button size="sm" icon="copy" onClick={() => invoke('clipboard:write', { text: l.text })}>
          Copy
        </Button>
      </div>
    </>
  );
}

function EventInspector({ data: e }) {
  if (!e) return <Gone what="event" />;
  return (
    <>
      <Header title={e.reason} subtitle={`${e.kind} ${e.name}`} right={<Pill tone={e.type === 'Warning' ? 'orange' : 'gray'} strong>{e.type}</Pill>} />
      {EXPLAIN[e.reason] && <div className="mx-5 mb-4 rounded-[14px] bg-fill-4 px-3.5 py-2.5 text-callout">{EXPLAIN[e.reason]}</div>}
      <Section title="Details">
        <KeyValue items={[['Message', e.message], ['Count', e.count], ['First seen', dayTime(e.firstAt)], ['Last seen', dayTime(e.at)], ['Reported by', e.source]]} />
      </Section>
      {e.service && (
        <div className="px-5 py-4 hairline-t">
          <Button size="sm" icon="stack" onClick={() => inspect('service', e.service)}>
            Open {short(e.service)}
          </Button>
        </div>
      )}
    </>
  );
}

function Header({ title, subtitle, right, mono, wrap }) {
  return (
    <div className="pl-5 pr-14 pt-5 pb-3 flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <h2 className={cx('text-title2 font-semibold tracking-[-0.01em] selectable', wrap ? 'break-words' : 'truncate', mono && 'font-mono text-title3')}>{title}</h2>
        {subtitle && <p className="text-callout text-label-2 mt-0.5 truncate">{subtitle}</p>}
      </div>
      {right && <div className="shrink-0 pt-0.5">{right}</div>}
    </div>
  );
}

function Gone({ what }) {
  return <div className="p-8 text-center text-callout text-label-2">This {what} is no longer around.</div>;
}

const BODIES = { service: ServiceInspector, pod: PodInspector, request: RequestInspector, error: ErrorInspector, crash: CrashInspector, log: LogInspector, event: EventInspector };

export default function Inspector() {
  const ins = useStore((s) => s.inspector);
  const width = useWindowWidth();
  // Windows draws its minimize/maximize/close buttons over the top-right 52 px.
  const isWin = useStore((s) => s.info?.platform === 'win32');
  if (!ins) return null;
  const Body = BODIES[ins.type];
  if (!Body) return null;
  // Below ~1400 px there isn't room for content + panel side by side: the panel
  // floats over the content instead of squeezing tables into a sliver.
  const floating = width < 1400;
  return (
    <aside className={cx('p-2 pl-0', isWin && 'pt-[54px]', floating ? 'absolute right-0 top-0 bottom-0 z-40' : 'shrink-0 relative')} style={{ width: Math.min(440, width - 120) }}>
      {/* Docked, it's the sidebar's twin (same glass, same radius); floating over content it needs the denser glass. */}
      <div key={`${ins.type}:${ins.id}`} className={cx('h-full rounded-[20px] overflow-y-auto animate-slide-right relative', floating ? 'glass-strong shadow-[var(--shadow-pop)]' : 'glass-panel')}>
        <button type="button" onClick={() => setState({ inspector: null })} className="no-drag absolute top-4 right-4 z-10 w-7 h-7 rounded-full bg-fill-3 hover:bg-fill-2 grid place-items-center text-label-2" aria-label="Close">
          <Icon name="x" size={12} strokeWidth={2.4} />
        </button>
        <Body id={ins.id} data={ins.data} />
      </div>
    </aside>
  );
}
