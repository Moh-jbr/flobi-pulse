import { useEffect, useMemo, useState } from 'react';
import { useStore, setState, navigate, invoke, inspect, logs as globalLogs } from '../lib/store.js';
import Icon from './icons.jsx';
import { cx, HealthPill, Pill, Meter, KeyValue, Button, Spinner, StatusDot, STATE_TONE, IconButton, useNow, useWindowWidth, CopyButton } from './ui.jsx';
import { LineChart, Sparkline } from './charts.jsx';
import { EXPLAIN } from '../views/Events.jsx';
import { LEVEL } from '../views/Logs.jsx';
import { RequestStatus, NO_RESPONSE, cleanError } from '../views/Traffic.jsx';
import { ago, clock, clockHMS, clockMs, dayTime, duration, bytes, cores, pct, ms, short, uaShort, compact, coverage } from '../lib/format.js';
import { crashReason } from '../views/Crashes.jsx';
import { isWindows } from '../lib/platform.js';
import ErrorBoundary from './ErrorBoundary.jsx';

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
    <div className="code-box max-h-[340px] overflow-auto py-1.5 font-mono text-[11px] leading-[15px] selectable">
      {lines.map((l, i) => (
        <div key={l.id || i} className={cx('px-3 py-[1px] whitespace-pre-wrap break-words', l.level === 'ERROR' && 'text-red', l.level === 'WARN' && 'text-orange')}>
          <span className="text-label-3 mr-2">{clockHMS(l.ts)}</span>
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
    let busy = false;
    const load = () => {
      if (busy) return;
      busy = true;
      invoke('usage:get', { service, range: 3600_000 })
        .then((d) => alive && setData(d))
        // A failed refresh keeps the charts already drawn.
        .catch(() => alive && setData((cur) => (cur && !cur.error ? cur : { error: true })))
        .finally(() => (busy = false));
    };
    load();
    // A new point comes every 15 seconds: redraw with it while the panel is open.
    const t = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
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
  if (!s) return <Gone what="service" section="services" />;
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
        <IconButton icon="mute" label={`Mute ${s.short} for 1 hour`} onClick={() => invoke('alerts:mute', { target: s.name, minutes: 60 })} />
      </div>
      {s.reasons?.length > 0 && s.health !== 'healthy' && (
        <div className={cx('mx-5 mb-4 rounded-[10px] px-3.5 py-2.5 text-callout', s.health === 'down' ? 'bg-red-tint' : s.health === 'deploying' ? 'bg-accent-tint' : 'bg-orange-tint')}>
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
          {myPods.map((p) => {
            // A Pending pod hasn't started a container yet, so there's no start time.
            const started = p.containers?.[0]?.startedAt || p.startedAt;
            return (
              <button key={p.name} type="button" onClick={() => inspect('pod', p.name)} className="text-left rounded-[8px] px-2.5 py-2 hover:bg-fill-4 -mx-2.5">
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
                    {/* The fullest container against its own limit: a sidecar without one doesn't count. */}
                    <Meter value={p.memPct ?? (p.mem != null && p.memLimit ? p.mem / p.memLimit : null)} height={3} />
                  </div>
                </div>
                <div className="text-footnote text-label-3 mt-1 pl-[15px]">
                  {p.restarts} restarts · {started ? `up ${duration(now - started)}` : 'not started yet'}
                  {p.node ? ` · ${p.node.slice(-12)}` : ''}
                </div>
              </button>
            );
          })}
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
  if (!p) return <Gone what="pod" section="pods" />;
  const myEvents = events.filter((e) => e.name === p.name).slice(0, 10);
  const c0 = p.containers.find((c) => c.name === p.mainContainer) || p.containers[0];
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
          <div className={cx('rounded-[10px] px-3.5 py-2.5 text-callout mb-3', p.lastTermination.reason === 'OOMKilled' ? 'bg-red-tint' : 'bg-orange-tint')}>
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
                  setPrev({ lines: [{ id: 'e', ts: Date.now(), text: cleanError(e), level: 'ERROR' }] });
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

// What an HTTP status means, in one plain sentence (like the browser's Network tab, but explained).
const HTTP_STATUS = {
  0: ['No response', 'The user closed the page, lost their connection or gave up waiting before the service answered, so the load balancer had nothing to send back. There is no status code, so it shows as 0.'],
  400: ['Bad Request', 'The request was malformed or missing something the service needs.'],
  401: ['Unauthorized', "The caller isn't signed in, or their session token expired."],
  403: ['Forbidden', "The caller is signed in but isn't allowed to do this."],
  404: ['Not Found', "The route, or the item it asks for, doesn't exist."],
  405: ['Method Not Allowed', "This route doesn't accept this method (for example a GET where only POST works)."],
  408: ['Request Timeout', 'The client took too long to send the request.'],
  409: ['Conflict', 'It clashes with the current state, for example the item already exists.'],
  413: ['Payload Too Large', 'The upload or body is bigger than the service accepts.'],
  415: ['Unsupported Media Type', "The body's format (Content-Type) isn't one the service accepts."],
  422: ['Unprocessable Content', "The data didn't pass the service's validation."],
  429: ['Too Many Requests', 'The caller hit a rate limit.'],
  499: ['Client Closed Request', 'The user closed the page or lost connection before the answer came.'],
  500: ['Internal Server Error', 'The service hit an error while handling it: usually an unhandled exception in the code.'],
  502: ['Bad Gateway', "The load balancer couldn't get a proper answer from the service."],
  503: ['Service Unavailable', 'No healthy pod could take it, or the service is overloaded.'],
  504: ['Gateway Timeout', 'The service took too long to answer.'],
};
const statusText = (s) => HTTP_STATUS[s]?.[0] || (s >= 500 ? 'Server Error' : s >= 400 ? 'Client Error' : s >= 300 ? 'Redirect' : 'OK');

/** The Kubernetes Service the load balancer named → the workload whose pods (and logs) serve it. */
function useWorkload(k8sService) {
  const ingress = useStore((st) => st.sections.ingress);
  return useMemo(() => (ingress || []).flatMap((i) => i.rules || []).find((x) => x.service === k8sService)?.workload || k8sService, [ingress, k8sService]);
}

/** Server log lines for one request: instantly from the live stream, then from Cloud Logging. */
function useRequestLogs(r, workload, enabled) {
  const [state, setLogState] = useState({ loading: false, lines: [], match: null, error: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled || !r?.service) return;
    const near = (l) => (r.trace && l.trace === r.trace) || (l.service === workload && Math.abs(l.ts - r.ts) <= 5_000);
    const fromMemory = globalLogs.filter(near);
    setLogState({ loading: true, lines: fromMemory, match: fromMemory.some((l) => r.trace && l.trace === r.trace) ? 'trace' : fromMemory.length ? 'time' : null, error: null });
    let alive = true;
    invoke('request:logs', { service: r.service, ts: r.ts, trace: r.trace, status: r.status, method: r.method, path: r.path })
      .then((res) => {
        if (!alive) return;
        const seen = new Set();
        const lines = [...(res?.lines || []), ...fromMemory].filter((l) => !seen.has(l.id) && seen.add(l.id)).sort((a, b) => a.ts - b.ts);
        setLogState({ loading: false, lines, match: res?.match === 'trace' ? 'trace' : 'time', error: null });
      })
      .catch((e) => alive && setLogState((st) => ({ ...st, loading: false, error: cleanError(e) })));
    return () => {
      alive = false;
    };
  }, [r?.id, workload, enabled, attempt]);
  return { ...state, retry: () => setAttempt((n) => n + 1) };
}

/** Log lines with a marker at the moment of the request; lines that name its path stand out. */
function RequestLogLines({ lines, r }) {
  const path = r.path.split('?')[0];
  let marked = false;
  const marker = (
    <div key="__req" className="flex items-center gap-2 px-3 py-1 text-accent">
      <span className="h-px flex-1 bg-accent/40" />
      <span className="font-sans text-footnote font-semibold">
        {r.method} {path} → {r.status} at {clockMs(r.ts)}
      </span>
      <span className="h-px flex-1 bg-accent/40" />
    </div>
  );
  const rows = [];
  for (const l of lines) {
    if (!marked && l.ts > r.ts) (marked = true), rows.push(marker);
    rows.push(
      <div key={l.id} className={cx('px-3 py-1 whitespace-pre-wrap break-words not-first:shadow-[inset_0_1px_0_var(--line)]', l.level === 'ERROR' && 'text-red', l.level === 'WARN' && 'text-orange', path.length > 1 && l.text.includes(path) && 'font-semibold')}>
        <span className="text-label-3 mr-2">{clockMs(l.ts)}</span>
        {l.text}
      </div>,
    );
  }
  if (!marked) rows.push(marker);
  return <div className="code-box max-h-[380px] overflow-auto py-1.5 font-mono text-[11px] leading-[15px] selectable">{rows}</div>;
}

const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function RequestInspector({ data: r }) {
  const workload = useWorkload(r?.service);
  const failed = !!r && (r.status >= 400 || !r.status);
  const [wantLogs, setWantLogs] = useState(false);
  const logs = useRequestLogs(r, workload, failed || wantLogs);
  if (!r) return <Gone what="request" />;

  const url = `https://${r.host}${r.path}`;
  const path = r.path.split('?')[0];
  const query = (() => {
    try {
      return [...new URL(url).searchParams.entries()];
    } catch {
      return [];
    }
  })();
  const svc = r.service ? short(workload) : null;
  // Status 0: no answer at all, because the client closed the connection first (not a server failure).
  const noResponse = !r.status;
  const serverSide = r.status >= 500;
  const statusLine = noResponse ? `0 (${NO_RESPONSE})` : `${r.status} ${statusText(r.status)}`;
  const lbSays = r.statusDetails && DETAILS[r.statusDetails];
  const cloudflare = /^1(04|08|62|72|73)\./.test(r.ip);
  const curl = [`curl -X ${r.method} ${shellQuote(url)}`, r.ua && `-H ${shellQuote(`User-Agent: ${r.ua}`)}`, r.referer && `-H ${shellQuote(`Referer: ${r.referer}`)}`].filter(Boolean).join(' \\\n  ');
  const summary = [
    `${r.method} ${url} → ${statusLine}`,
    `When: ${dayTime(r.ts)} ${clockMs(r.ts)} · took ${ms(r.latencyMs)}`,
    `Served by: ${svc || 'unknown'}${r.statusDetails ? ` · load balancer: ${r.statusDetails}` : ''}`,
    `Client: ${uaShort(r.ua)} · ${r.ip}${cloudflare ? ' (via Cloudflare)' : ''}`,
    r.trace && `Trace: ${r.trace.split('/').pop()}`,
    logs.lines.length ? `\nServer logs:\n${logs.lines.map((l) => `${clockMs(l.ts)} ${l.level} ${l.text}`).join('\n')}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <>
      <Header title={`${r.method} ${path}`} mono wrap subtitle={r.host} right={<RequestStatus status={r.status} />} />
      <div className="px-5 pb-4 flex gap-2 flex-wrap">
        {r.service && (
          <Button size="sm" icon="logs" onClick={() => navigate({ to: 'logs', service: workload, from: r.ts - 60_000, until: r.ts + 60_000 })}>
            {svc} logs ±1 min
          </Button>
        )}
        <CopyButton text={curl} label="Copy as cURL" />
        <CopyButton text={summary} label="Copy details" />
      </div>

      {failed && (
        <Section title="What went wrong">
          <div className={cx('rounded-[8px] p-3 text-callout', serverSide ? 'bg-red-tint' : 'bg-orange-tint')}>
            <div className="font-semibold">
              {noResponse ? `0 · ${NO_RESPONSE} before an answer came back.` : `${r.status} ${statusText(r.status)}: ${serverSide ? `the problem is on our side${svc ? ` (${svc})` : ''}, not the user's.` : 'the request was refused, usually because of what the caller sent or who they are.'}`}
            </div>
            <div className="mt-1 text-label-2">{HTTP_STATUS[r.status || 0]?.[1] || (serverSide ? 'The service failed to handle it.' : 'The service rejected it.')}</div>
            {lbSays && <div className="mt-1 text-label-2">Load balancer: {lbSays}</div>}
            <div className="mt-2 text-label">
              {serverSide
                ? `The server logs below usually show the exact error. If they're empty, ${svc || 'the service'} doesn't log failed requests.`
                : noResponse
                  ? `Usually nothing is broken. If it took long${r.latencyMs != null ? ` (${ms(r.latencyMs)})` : ''}, the server logs below show what ${svc || 'the service'} was doing meanwhile.`
                  : "Check the server logs below for the service's reason (for example a validation message)."}
            </div>
          </div>
        </Section>
      )}

      <Section
        title="Server logs for this request"
        right={logs.loading && logs.lines.length ? <Spinner size={13} /> : null}
      >
        {!r.service ? (
          <div className="text-callout text-label-2">The load balancer didn't say which service answered, so there are no logs to match.</div>
        ) : !(failed || wantLogs) ? (
          <Button size="sm" icon="logs" onClick={() => setWantLogs(true)}>
            Show {svc}'s logs for this request
          </Button>
        ) : (
          <>
            <div className="text-subheadline text-label-2 mb-2">
              {logs.match === 'trace' ? 'Exact match: these lines carry this request’s trace ID.' : `What ${svc} logged in the 5 seconds around the request (Google didn't link them to this exact request).`}
            </div>
            {logs.lines.length ? (
              <RequestLogLines lines={logs.lines} r={r} />
            ) : logs.loading ? (
              <div className="py-5 flex items-center justify-center gap-2 text-callout text-label-2">
                <Spinner /> Reading {svc}'s logs from Cloud Logging…
              </div>
            ) : !logs.error ? (
              <div className="text-callout text-label-2">
                {svc} didn't log anything within 5 seconds of this request.
                {serverSide ? ' It probably doesn’t log failed requests: one log line per error in that service would make the cause show up here.' : ''}
              </div>
            ) : null}
            {logs.error && (
              <div className="mt-2 flex items-start gap-2 text-callout text-red">
                <span className="flex-1 selectable">{logs.error}</span>
                <Button size="sm" onClick={logs.retry}>
                  Try again
                </Button>
              </div>
            )}
          </>
        )}
      </Section>

      <Section title="Request">
        <KeyValue
          items={[
            ['Request URL', url],
            ['Method', r.method],
            ['Status code', statusLine],
            ['Time', `${dayTime(r.ts)} · ${clockMs(r.ts)}`],
            ['Took', ms(r.latencyMs)],
            ['Served by', svc || 'unknown'],
            ['Client', uaShort(r.ua)],
            ['Remote address', `${r.ip}${cloudflare ? ' (Cloudflare edge; the user is behind it)' : ''}`],
            r.referer && ['Referrer', r.referer],
            ['User agent', r.ua],
            ['Protocol', r.protocol],
            ['Request size', bytes(r.reqSize)],
            r.cache && ['Cache', r.cache],
            r.statusDetails && ['LB status', r.statusDetails],
            r.trace && ['Trace ID', r.trace.split('/').pop()],
          ]}
        />
      </Section>

      {query.length > 0 && (
        <Section title={`Query parameters (${query.length})`}>
          <KeyValue items={query.map(([k, v], i) => [`${k}${query.filter(([x]) => x === k).length > 1 ? ` #${i + 1}` : ''}`, v || '(empty)'])} />
        </Section>
      )}

      <Section title="Response">
        <KeyValue items={[['Status', statusLine], ['Size', bytes(r.respSize)]]} />
        <p className="text-subheadline text-label-3 mt-2.5">
          Google's load balancer doesn't record request or response bodies or headers, so they can't be shown. The server logs above are the closest thing{failed ? ": that's where the service writes why it failed." : '.'}
        </p>
      </Section>
    </>
  );
}

function ErrorInspector({ id }) {
  const errors = useStore((st) => st.sections.errors);
  const now = useNow(10_000);
  const g = useMemo(() => [...(errors?.backend || []), ...(errors?.frontend || [])].find((x) => x.id === id), [errors, id]);
  const span = coverage(errors?.since, now);
  if (!g) return <Gone what="error" section="errors" />;
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
        <KeyValue items={[['Occurrences', `${compact(g.count)}${span.label ? ` ${span.label}` : ''} (${compact(g.count1h)} in the last hour)`], ['First seen', `${dayTime(g.firstSeen)} (${ago(g.firstSeen, now)})`], ['Last seen', `${dayTime(g.lastSeen)} (${ago(g.lastSeen, now)})`], ['Pods', g.pods.join(', ')]]} />
      </Section>
      {g.stack?.length > 0 && (
        <Section title="Stack trace">
          <pre className="code-box p-3 font-mono text-[11px] leading-[15px] overflow-auto max-h-60 selectable whitespace-pre">{g.stack.join('\n')}</pre>
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
  const podExists = useStore((st) => !!c && !!st.sections.pods?.some((x) => x.name === c.pod));
  const [logs, setLogs] = useState({ loading: true });
  const now = useNow(10_000);
  const found = !!c;
  // Opened from a notification, the crash can show up a moment after the panel: load once it's here.
  useEffect(() => {
    if (!c) return;
    let alive = true;
    setLogs({ loading: true });
    // This crash's own run: main reads Kubernetes' "previous" logs when it's the container's
    // latest crash, and Cloud Logging around `at` for an older one. A crash found in the logs
    // (Kubernetes events, before the app started) is always an older one.
    const load =
      podExists && !c.fromLogs
        ? invoke('logs:previous', { pod: c.pod, container: c.container, service: c.service, restarts: c.restarts, at: c.at })
        : invoke('logs:query', { pod: c.pod, from: c.at - (c.fromLogs ? 10 : 5) * 60_000, until: c.at + 5_000, limit: 300 });
    load.then((lines) => alive && setLogs({ lines })).catch((e) => alive && setLogs({ lines: [{ id: 'e', ts: Date.now(), text: cleanError(e), level: 'ERROR' }] }));
    return () => {
      alive = false;
    };
  }, [id, found, podExists]);
  if (!c) return <Gone what="crash" section="crashes" />;
  const oom = c.reason === 'OOMKilled';
  const why = crashReason(c);
  return (
    <>
      <Header title={oom ? 'Out of memory' : why.label} subtitle={`${short(c.service)} · ${dayTime(c.at)}`} right={c.fromLogs ? <Pill tone="gray">From the logs</Pill> : <Pill tone={oom ? 'red' : 'orange'} strong>exit {c.exitCode ?? '—'}</Pill>} />
      <div className="mx-5 mb-4 rounded-[10px] bg-fill-4 px-3.5 py-2.5 text-callout">
        {oom
          ? 'The container used more memory than its limit and the kernel killed it. Kubernetes restarted it.'
          : c.reason === 'CrashLoopBackOff'
            ? 'The container kept crashing, so Kubernetes waited longer and longer before restarting it (a crash loop).'
            : c.reason === 'LivenessProbe'
              ? 'The container stopped answering its liveness probe, so Kubernetes killed it and restarted it.'
              : c.reason === 'StartupProbe'
                ? "The container didn't pass its startup probe in time, so Kubernetes killed it and restarted it."
                : c.exitCode === 137
                  ? 'The container was killed (SIGKILL) — usually a failed liveness probe or eviction.'
                  : c.exitCode === 143
                    ? 'The container was asked to stop (SIGTERM) and exited.'
                    : c.exitCode === 1
                      ? 'The app exited with an error (usually an unhandled exception at startup or runtime).'
                      : 'The container stopped and Kubernetes restarted it.'}
        {c.fromLogs && <div className="text-label-2 mt-1">Found in Kubernetes events in Google's logs, from before Flobi Pulse started: they name the reason but not the exit code.</div>}
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
        <KeyValue
          items={[
            ['Pod', c.pod],
            ['Container', c.container],
            ['When', `${dayTime(c.at)} (${ago(c.at, now)})`],
            c.fromLogs && c.until > c.at + 60_000 && ['Until', `${dayTime(c.until)} (${duration(c.until - c.at)} later)`],
            ['Reason', why.label],
            !c.fromLogs && ['Exit code', c.exitCode],
            !c.fromLogs && ['Restarts so far', c.restarts],
            c.fromLogs && c.times > 1 && ['Reported', `${c.times} times by Kubernetes`],
            c.message && ['Message', c.message],
          ]}
        />
      </Section>
      <Section title={podExists && !c.fromLogs ? 'Logs from right before the crash' : 'Logs before the crash (Cloud Logging)'}>
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
        <pre className="code-box p-3 font-mono text-[11.5px] leading-[16px] whitespace-pre-wrap break-words selectable">{l.text}</pre>
      </Section>
      {l.json && (
        <Section title="Structured fields">
          <pre className="code-box p-3 font-mono text-[11px] leading-[15px] whitespace-pre-wrap break-words selectable max-h-80 overflow-auto">{JSON.stringify(l.json, null, 2)}</pre>
        </Section>
      )}
      <div className="px-5 py-4 hairline-t flex gap-2">
        <Button size="sm" icon="history" onClick={() => navigate({ to: 'logs', service: l.service, from: l.ts - 60_000, until: l.ts + 60_000 })}>
          Show surrounding lines
        </Button>
        <CopyButton text={l.text} label="Copy" />
      </div>
    </>
  );
}

function EventInspector({ data: e }) {
  if (!e) return <Gone what="event" />;
  return (
    <>
      <Header title={e.reason} subtitle={`${e.kind} ${e.name}`} right={<Pill tone={e.type === 'Warning' ? 'orange' : 'gray'} strong>{e.type}</Pill>} />
      {EXPLAIN[e.reason] && <div className="mx-5 mb-4 rounded-[10px] bg-fill-4 px-3.5 py-2.5 text-callout">{EXPLAIN[e.reason]}</div>}
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

/** Not in the data (anymore): gone, or, right after launch, not loaded yet. */
function Gone({ what, section }) {
  const loaded = useStore((st) => !section || st.sections[section] !== undefined);
  if (!loaded)
    return (
      <div className="p-8 grid place-items-center">
        <Spinner />
      </div>
    );
  return <div className="p-8 text-center text-callout text-label-2">This {what} is no longer around.</div>;
}

const BODIES = { service: ServiceInspector, pod: PodInspector, request: RequestInspector, error: ErrorInspector, crash: CrashInspector, log: LogInspector, event: EventInspector };

export default function Inspector() {
  const ins = useStore((s) => s.inspector);
  const width = useWindowWidth();
  // Windows draws its minimize/maximize/close buttons over the top-right 52 px.
  const isWin = isWindows();
  if (!ins) return null;
  const Body = BODIES[ins.type];
  if (!Body) return null;
  // Below ~1400 px there isn't room for content + panel side by side: the panel
  // floats over the content instead of squeezing tables into a sliver.
  const floating = width < 1400;
  // Floating, only the panel takes clicks: the empty strip above it (the window buttons'
  // room on Windows) must not swallow clicks on the toolbar underneath.
  return (
    <aside className={cx('p-2 pl-0', isWin && 'pt-[54px]', floating ? 'absolute right-0 top-0 bottom-0 z-inspector pointer-events-none' : 'shrink-0 relative')} style={{ width: Math.min(440, width - 120) }}>
      {/* Docked, it's the sidebar's twin (same glass, same radius); floating over content it needs the denser glass. */}
      <div key={`${ins.type}:${ins.id}`} className={cx('h-full rounded-[14px] overflow-y-auto animate-slide-right relative', floating ? 'glass-strong shadow-[var(--shadow-pop)] pointer-events-auto' : 'glass-panel')}>
        <button type="button" onClick={() => setState({ inspector: null })} className="no-drag absolute top-4 right-4 z-10 w-7 h-7 rounded-full bg-fill-3 hover:bg-fill-2 grid place-items-center text-label-2" aria-label="Close">
          <Icon name="x" size={12} strokeWidth={2.4} />
        </button>
        <ErrorBoundary what="panel">
          <Body id={ins.id} data={ins.data} />
        </ErrorBoundary>
      </div>
    </aside>
  );
}
