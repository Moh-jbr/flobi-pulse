import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, logs as globalRing, received, invoke, onFollow, inspect } from '../lib/store.js';
import { ViewFixed } from '../components/Toolbar.jsx';
import VirtualList from '../components/VirtualList.jsx';
import Select from '../components/Select.jsx';
import { Segmented, SearchField, Button, cx, Spinner, Card, useNow } from '../components/ui.jsx';
import Icon from '../components/icons.jsx';
import ExportButton from '../components/ExportButton.jsx';
import { LiveUnavailable, NewCount } from './Traffic.jsx';
import { clockMs, short, compact, dayTime } from '../lib/format.js';
import { parseNest } from '../../electron/core/engine/log-parse.mjs';

const POD_COLORS = ['var(--accent)', 'var(--purple)', 'var(--teal)', 'var(--orange)', 'var(--indigo)', 'var(--green)', 'var(--yellow)', 'var(--gray)'];
const LEVEL = {
  ERROR: { label: 'ERR', cls: 'bg-red-tint text-red' },
  WARN: { label: 'WRN', cls: 'bg-orange-tint text-orange' },
  INFO: { label: 'INF', cls: 'bg-fill-3 text-label-2' },
  DEBUG: { label: 'DBG', cls: 'bg-fill-4 text-label-3' },
};
const LEVEL_RANK = { ERROR: 3, WARN: 2, INFO: 1, DEBUG: 0 };
const LOG_COLUMNS = [
  { label: 'Time', get: (l) => new Date(l.ts) },
  { label: 'Level', get: (l) => l.level },
  { label: 'Service', get: (l) => short(l.service) },
  { label: 'Pod', get: (l) => l.pod },
  { label: 'Message', get: (l) => l.text },
];
const cleanError = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

/**
 * "Searching… 12 s" with a hint once it takes a while, so a wait never looks stuck.
 * Every wait has an end: after `giveUpAfter` seconds it shows `giveUp` instead.
 */
function Waiting({ what, since, onCancel, giveUpAfter, giveUp }) {
  const now = useNow(1000);
  const secs = Math.max(0, Math.round((now - since) / 1000));
  if (giveUpAfter && secs >= giveUpAfter) return giveUp;
  return (
    <EmptyNote spinner action={onCancel ? ['Cancel', onCancel] : null}>
      {what} {secs >= 2 ? `${secs} s` : ''}
      {secs >= 8 && <span className="block mt-1 text-label-3">Cloud Logging can be slow on busy days, and the team's windows share its read limit. It gives up with a clear message after about a minute.</span>}
    </EmptyNote>
  );
}

function useServiceFollow(scope, pods) {
  const ring = useRef([]);
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState({}); // pod -> { state: 'opening'|'streaming'|'error'|'stopped', message }
  const subs = useRef(new Map()); // pod -> {id, off}
  const scheduled = useRef(false);
  const startedAt = useRef(Date.now());
  const setPod = (pod, st) => setStatus((s) => ({ ...s, [pod]: st }));

  useEffect(() => {
    ring.current = [];
    startedAt.current = Date.now();
    setStatus({});
    setVersion((v) => v + 1);
    return () => {
      for (const { id, off } of subs.current.values()) {
        off?.();
        if (id) invoke('logs:unfollow', { id });
      }
      subs.current.clear();
    };
  }, [scope?.kind, scope?.service, scope?.pod]);

  useEffect(() => {
    if (!scope || scope.kind === 'all') return;
    const wanted = scope.kind === 'pod' ? pods.filter((p) => p.name === scope.pod) : pods.filter((p) => p.service === scope.service && p.state !== 'done');
    for (const p of wanted) {
      if (subs.current.has(p.name)) continue;
      const container = p.mainContainer || p.containers?.[0]?.name || p.service;
      const entry = { id: null, off: null };
      subs.current.set(p.name, entry);
      setPod(p.name, { state: 'opening' });
      invoke('logs:follow', { pod: p.name, container, service: p.service })
        .then(({ id }) => {
          if (subs.current.get(p.name) !== entry) {
            // The view moved on before the stream opened: close it right away.
            invoke('logs:unfollow', { id });
            return;
          }
          entry.id = id;
          entry.off = onFollow(id, (m) => {
            if (m.status) {
              setPod(p.name, { state: m.status, message: m.message || null });
              return;
            }
            const lines = m.lines || [];
            if (!lines.length) return;
            setPod(p.name, { state: 'streaming' });
            ring.current.push(...lines);
            if (ring.current.length > 20000) ring.current.splice(0, ring.current.length - 20000);
            if (!scheduled.current) {
              scheduled.current = true;
              requestAnimationFrame(() => {
                scheduled.current = false;
                ring.current.sort((a, b) => a.ts - b.ts);
                setVersion((v) => v + 1);
              });
            }
          });
        })
        .catch((e) => {
          subs.current.delete(p.name);
          setPod(p.name, { state: 'error', message: String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') });
        });
    }
  }, [scope, pods]);

  const wanted = !scope || scope.kind === 'all' ? [] : scope.kind === 'pod' ? pods.filter((p) => p.name === scope.pod) : pods.filter((p) => p.service === scope.service && p.state !== 'done');
  const states = Object.values(status).map((st) => st.state);
  const count = (...xs) => states.filter((x) => xs.includes(x)).length;
  return {
    ring: ring.current,
    version,
    status,
    podCount: wanted.length,
    since: startedAt.current,
    container: wanted[0]?.mainContainer || wanted[0]?.containers?.[0]?.name || null,
    streaming: count('streaming'),
    opening: count('opening'),
    // Pod logs not allowed for this key → the view switches to Cloud Logging.
    forbidden: count('forbidden') > 0,
    // Every stream failed, stopped or never answered → Cloud Logging too.
    allFailed: states.length > 0 && count('error', 'stopped', 'unreachable') === states.length,
  };
}

export default function Logs() {
  const params = useStore((s) => s.nav.params);
  const globalVersion = useStore((s) => s.logsVersion);
  const pods = useStore((s) => s.sections.pods) || [];
  const services = useStore((s) => s.sections.services) || [];
  const live = useStore((s) => s.sections.sources?.live);
  const [scope, setScope] = useState({ kind: 'all' });
  const [level, setLevel] = useState('all');
  const [q, setQ] = useState('');
  const [follow, setFollow] = useState(true);
  const [paused, setPaused] = useState(null); // { rows, by: 'user'|'scroll', at }
  const [history, setHistory] = useState(null); // { loading, items, range, error, since, args }
  const historyRun = useRef(0);

  // Deep links (from the recap, alerts, error groups)
  useEffect(() => {
    if (!params?.at) return;
    if (params.pod) setScope({ kind: 'pod', pod: params.pod, service: params.service });
    else if (params.service) setScope({ kind: 'service', service: params.service });
    if (params.level) setLevel(params.level);
    if (params.from) runHistory({ from: params.from, until: params.until, service: params.service, level: params.level });
  }, [params?.at]);

  const podList = useMemo(() => pods.filter((p) => p.state !== 'done'), [pods.length, pods.map((p) => p.name).join()]);
  const follow$ = useServiceFollow(scope.kind === 'all' ? null : scope, podList);

  async function runHistory(args) {
    const { from, until, service, level: lv, text } = args;
    const run = ++historyRun.current;
    setHistory({ loading: true, items: [], range: { from, until }, since: Date.now(), args });
    try {
      const items = await invoke('logs:query', { from, until, service: service ?? (scope.kind !== 'all' ? scope.service : undefined), pod: scope.kind === 'pod' ? scope.pod : undefined, level: (lv ?? level) === 'all' ? undefined : lv ?? level, text: text ?? (q || undefined), limit: 2000 });
      if (run === historyRun.current) setHistory({ loading: false, items, range: { from, until }, args });
    } catch (e) {
      if (run === historyRun.current) setHistory({ loading: false, items: [], range: { from, until }, error: cleanError(e), args });
    }
  }
  const cancelHistory = () => {
    historyRun.current++;
    setHistory(null);
  };

  const podIndex = useMemo(() => {
    const m = new Map();
    const svcPods = new Map();
    for (const p of pods) {
      const list = svcPods.get(p.service) || [];
      list.push(p.name);
      svcPods.set(p.service, list);
    }
    for (const list of svcPods.values()) list.sort().forEach((n, i) => m.set(n, i));
    return m;
  }, [pods]);

  // Fallback to Cloud Logging (the last 15 minutes, then this service's lines from the
  // live stream, a few seconds behind) when this key can't read pod logs, when every
  // pod stream failed or never answered, or when asked to.
  const [forceCloud, setForceCloud] = useState(false);
  useEffect(() => setForceCloud(false), [scope.kind, scope.service, scope.pod]);
  const cloudReason = scope.kind === 'all' ? null : follow$.forbidden ? 'forbidden' : follow$.allFailed ? 'failed' : forceCloud ? 'asked' : null;
  const cloudMode = !!cloudReason;
  const [cloudInit, setCloudInit] = useState(null);
  const [cloudTry, setCloudTry] = useState(0);
  useEffect(() => {
    if (!cloudMode) {
      setCloudInit(null);
      return;
    }
    let alive = true;
    setCloudInit({ loading: true, items: [], since: Date.now() });
    invoke('logs:query', { service: scope.service, pod: scope.kind === 'pod' ? scope.pod : undefined, from: Date.now() - 15 * 60_000, until: Date.now(), limit: 1000 })
      .then((items) => alive && setCloudInit({ loading: false, items }))
      .catch((e) => alive && setCloudInit({ loading: false, items: [], error: cleanError(e) }));
    return () => {
      alive = false;
    };
  }, [cloudMode, scope.kind, scope.service, scope.pod, cloudTry]);
  const cloudRing = useMemo(() => {
    if (!cloudMode) return null;
    const seen = new Set();
    const out = [];
    for (const l of cloudInit?.items || []) if (!seen.has(l.id)) seen.add(l.id), out.push(l);
    for (const l of globalRing) {
      if (l.service !== scope.service || (scope.kind === 'pod' && l.pod !== scope.pod) || seen.has(l.id)) continue;
      seen.add(l.id);
      out.push(l);
    }
    return out.sort((a, b) => a.ts - b.ts);
  }, [cloudMode, cloudInit, paused ? 0 : globalVersion, scope]);

  const [quiet, setQuiet] = useState(null); // { loading, items, error, since }
  const [quietTry, setQuietTry] = useState(0);
  const silent = scope.kind !== 'all' && !cloudMode && !history && follow$.podCount > 0 && follow$.streaming > 0 && follow$.ring.length === 0;
  // Only a new scope (or a retry) cancels a running check; its own state changes never do.
  const quietRun = useRef(0);
  useEffect(() => {
    quietRun.current++;
    setQuiet(null);
  }, [scope.kind, scope.service, scope.pod]);
  useEffect(() => {
    if (!silent || quiet) return;
    const t = setTimeout(
      () => {
        const run = ++quietRun.current;
        setQuiet({ loading: true, items: [], since: Date.now() });
        invoke('logs:query', { service: scope.service, pod: scope.kind === 'pod' ? scope.pod : undefined, from: Date.now() - 15 * 60_000, until: Date.now(), limit: 1000 })
          .then((items) => run === quietRun.current && setQuiet({ loading: false, items }))
          .catch((e) => run === quietRun.current && setQuiet({ loading: false, items: [], error: cleanError(e) }));
      },
      quietTry ? 0 : 6_000,
    );
    return () => clearTimeout(t);
  }, [silent, quiet, quietTry, scope.service, scope.pod]);
  // Earlier lines from that check stay above whatever the pods stream afterwards.
  const followSource = useMemo(() => {
    const extra = quiet?.items || [];
    if (!extra.length) return follow$.ring;
    const firstLive = follow$.ring[0]?.ts ?? Infinity;
    return [...extra.filter((l) => l.ts < firstLive), ...follow$.ring];
  }, [follow$.version, quiet]);
  const [allSince] = useState(() => Date.now());

  const liveSource = scope.kind === 'all' ? globalRing : cloudRing || followSource;
  const source = history ? history.items : paused ? paused.rows : liveSource;
  const version = history ? history.items.length : paused ? 0 : scope.kind === 'all' || cloudMode ? globalVersion : follow$.version + (quiet?.items?.length || 0);
  // The exact lines on screen right now, so freezing never shifts them.
  const onScreen = useRef({ rows: [], at: 0 });
  const freeze = (by) => setPaused({ rows: onScreen.current.rows, by, at: onScreen.current.at });
  const onFollowChange = (f) => {
    setFollow(f);
    if (!f && !paused && !history) freeze('scroll');
    if (f && paused?.by === 'scroll') setPaused(null);
  };
  const jumpToNewest = () => {
    setPaused(null);
    setFollow(true);
  };

  const regex = useMemo(() => {
    const m = q.match(/^\/(.+)\/([a-z]*)$/);
    if (!m) return null;
    try {
      return new RegExp(m[1], m[2].includes('i') ? m[2] : `${m[2]}i`);
    } catch {
      return null;
    }
  }, [q]);

  const items = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const minRank = level === 'all' ? -1 : LEVEL_RANK[level];
    const out = [];
    const src = history || paused ? source : source.slice();
    if (!history && !paused) onScreen.current = { rows: src, at: received.logs };
    for (const l of src) {
      if (level !== 'all' && (LEVEL_RANK[l.level] ?? 1) < minRank) continue;
      if (scope.kind === 'service' && scope.kind !== 'all' && l.service !== scope.service && !history) continue;
      if (regex ? !regex.test(l.text) : ql && !`${l.text} ${l.pod}`.toLowerCase().includes(ql)) continue;
      out.push(l);
    }
    return out;
  }, [version, source, level, q, regex, scope, history]);

  const rh = document.documentElement.dataset.density === 'compact' ? 22 : 26;
  const serviceOptions = services.map((s) => s.name).sort();
  const filtering = level !== 'all' || q.trim() !== '';
  const clearFilters = () => {
    setLevel('all');
    setQ('');
  };
  const svc = short(scope.service);
  const pods$ = `${follow$.podCount} pod${follow$.podCount === 1 ? '' : 's'}`;
  const toCloud = ['Use Cloud Logging instead', () => setForceCloud(true)];
  const last24h = ['Search the last 24 hours', () => runHistory({ from: Date.now() - 24 * 3600_000, until: Date.now() })];
  const cloudWhy = { forbidden: `This key can't read ${svc}'s pods directly`, failed: `${svc}'s pods aren't sending their logs right now (${Object.values(follow$.status).find((st) => st.message)?.message || 'the stream failed'})`, asked: 'Reading Cloud Logging' }[cloudReason];

  let emptyState;
  if (history?.loading) emptyState = <Waiting what="Searching Cloud Logging…" since={history.since} onCancel={cancelHistory} />;
  else if (history?.error) emptyState = <EmptyNote tone="red" action={['Try again', () => runHistory(history.args)]}>{history.error}</EmptyNote>;
  else if (history) emptyState = <EmptyNote action={filtering ? ['Clear filters', clearFilters] : null}>Nothing found between {dayTime(history.range.from)} and {dayTime(history.range.until)}{filtering ? ' with these filters' : ''}.</EmptyNote>;
  else if (source.length && filtering) emptyState = <EmptyNote action={['Clear filters', clearFilters]}>No lines match {level !== 'all' ? `“${level === 'ERROR' ? 'Errors' : level === 'WARN' ? 'Warnings+' : 'Info+'}”` : ''}{level !== 'all' && q.trim() ? ' and ' : ''}{q.trim() ? `“${q.trim()}”` : ''} in the {compact(source.length)} lines so far. New lines appear here as they come in.</EmptyNote>;
  else if (scope.kind === 'all')
    emptyState =
      live?.status !== 'streaming' ? (
        <EmptyNote>Live logs are not streaming. Pick a service above to read its pods directly from Kubernetes.</EmptyNote>
      ) : (
        <Waiting what="Waiting for log lines…" since={allSince} giveUpAfter={20} giveUp={<EmptyNote>The live stream is connected, but no service has logged anything in the last 20 seconds. Pick a service above to read its pods directly, or check Settings → Data sources.</EmptyNote>} />
      );
  else if (cloudMode && cloudInit?.loading) emptyState = <Waiting what={`${cloudWhy}, so loading its last 15 minutes from Cloud Logging…`} since={cloudInit.since} />;
  else if (cloudMode && cloudInit?.error) emptyState = <EmptyNote tone="red" action={['Try again', () => setCloudTry((n) => n + 1)]}>{cloudInit.error}</EmptyNote>;
  else if (cloudMode) emptyState = <EmptyNote action={last24h}>{cloudWhy}. Cloud Logging has nothing from {svc} in the last 15 minutes either. New lines appear here as they come in.</EmptyNote>;
  else if (!follow$.podCount) emptyState = <EmptyNote action={last24h}>{svc} has no running pods right now, so there's nothing to stream.</EmptyNote>;
  else if (!follow$.streaming) emptyState = <Waiting what={`Opening the log stream of ${pods$}…`} since={follow$.since} giveUpAfter={25} giveUp={<EmptyNote tone="red" action={toCloud}>Kubernetes hasn't answered for {svc}'s pod logs in 25 seconds. It keeps trying in the background.</EmptyNote>} />;
  else if (!quiet) emptyState = <Waiting what={`Connected to ${pods$}, reading their recent output…`} since={follow$.since} />;
  else if (quiet.loading) emptyState = <Waiting what={`${svc}'s pods are connected but haven't sent anything, so checking Cloud Logging for its last 15 minutes…`} since={quiet.since} />;
  else if (quiet.error) emptyState = <EmptyNote tone="red" action={['Try again', () => (setQuiet(null), setQuietTry((n) => n + 1))]}>{svc}'s pods are connected but silent, and Cloud Logging couldn't be checked: {quiet.error}</EmptyNote>;
  else emptyState = <EmptyNote action={last24h}>{svc} hasn't written a single log line in the last 15 minutes: nothing from its pods directly, nothing in Cloud Logging. New lines show up here the moment it writes one.</EmptyNote>;

  return (
    <ViewFixed>
      <div className="px-6 pb-3 flex items-center gap-2 flex-wrap animate-rise">
        <Select
          size="md"
          icon="stack"
          ariaLabel="Which logs"
          maxWidth={300}
          menuWidth={320}
          searchable
          value={scope.kind === 'all' ? '__all' : scope.kind === 'pod' ? `pod:${scope.pod}` : scope.service}
          onChange={(v) => {
            cancelHistory();
            setPaused(null);
            setFollow(true);
            if (v === '__all') setScope({ kind: 'all' });
            else if (v.startsWith('pod:')) {
              const pod = pods.find((p) => p.name === v.slice(4));
              setScope({ kind: 'pod', pod: pod.name, service: pod.service });
            } else setScope({ kind: 'service', service: v });
          }}
          groups={[
            { label: 'Everything', options: [{ value: '__all', label: 'All services (live)', description: 'One stream from Cloud Logging', icon: 'logs' }] },
            {
              label: 'One service, straight from its pods',
              options: serviceOptions.map((s) => {
                const n = pods.filter((p) => p.service === s && p.state !== 'done').length;
                return { value: s, label: short(s), description: s, meta: `${n} pod${n === 1 ? '' : 's'}` };
              }),
            },
            ...(scope.kind !== 'all'
              ? [
                  {
                    label: `One pod of ${short(scope.service)}`,
                    options: pods.filter((p) => p.service === scope.service).map((p) => ({ value: `pod:${p.name}`, label: p.name.replace(`${p.service}-`, '…'), description: p.name, icon: 'pod' })),
                  },
                ]
              : []),
          ]}
        />
        <Segmented
          size="sm"
          value={level}
          onChange={setLevel}
          options={[
            { value: 'all', label: 'All' },
            { value: 'ERROR', label: 'Errors', dot: 'red' },
            { value: 'WARN', label: 'Warnings+', dot: 'orange' },
            { value: 'INFO', label: 'Info+' },
          ]}
        />
        <div className="ml-auto flex items-center gap-2">
          <span className="text-subheadline text-label-3 tabular">{compact(items.length)} lines</span>
          <SearchField value={q} onChange={setQ} placeholder="Search, or /regex/" width={240} />
          {history ? (
            <Button size="sm" variant="tinted" icon="play" onClick={cancelHistory}>
              Back to live
            </Button>
          ) : (
            <>
              <Select
                action
                icon="history"
                placeholder="Search history…"
                ariaLabel="Search Cloud Logging history (kept for 30 days)"
                align="end"
                onChange={(mins) => runHistory({ from: Date.now() - mins * 60_000, until: Date.now(), text: q || undefined })}
                options={[
                  { value: 15, label: 'Last 15 minutes' },
                  { value: 60, label: 'Last hour' },
                  { value: 360, label: 'Last 6 hours' },
                  { value: 1440, label: 'Last 24 hours' },
                  { value: 10080, label: 'Last 7 days', description: 'Cloud Logging keeps 30 days' },
                ]}
              />
              <Button size="sm" variant={paused?.by === 'user' ? 'tinted' : 'secondary'} icon={paused?.by === 'user' ? 'play' : 'pause'} onClick={() => (paused?.by === 'user' ? jumpToNewest() : freeze('user'))}>
                {paused?.by === 'user' ? 'Resume' : 'Pause'}
              </Button>
            </>
          )}
          <ExportButton name={scope.kind === 'all' ? 'logs' : `logs-${short(scope.service)}`} title="Logs" columns={LOG_COLUMNS} rows={items} />
        </div>
      </div>

      {scope.kind === 'all' && !history && <LiveUnavailable live={live} />}
      {history && (
        <div className="mx-6 mb-3 flex items-center gap-2 text-callout text-label-2">
          <Icon name="history" size={14} />
          History: {dayTime(history.range.from)} → {dayTime(history.range.until)}
          {history.loading && <Spinner />}
          {history.error && <span className="text-red">{history.error}</span>}
        </div>
      )}

      <div className="flex-1 min-h-0 relative mx-6 mb-4 rounded-[18px] overflow-hidden bg-[var(--code-bg)] shadow-[var(--shadow-card)]">
        <VirtualList
          className="absolute inset-0 py-1 font-mono text-[11.5px] leading-[16px]"
          items={items}
          rowHeight={rh}
          follow={follow && !paused && !history}
          onFollowChange={onFollowChange}
          getKey={(l) => l.id}
          empty={emptyState}
          renderRow={(l) => {
            const lv = LEVEL[l.level] || LEVEL.INFO;
            const idx = podIndex.get(l.pod) ?? 0;
            return (
              <button key={l.id} type="button" onClick={() => inspect('log', l.id, l)} data-copy={l.text} data-copy-label="Copy log line" style={{ height: rh }} className={cx('w-full text-left grid grid-cols-[96px_3px_120px_34px_minmax(0,1fr)] gap-2.5 items-center px-4 hover:bg-fill-4', l.level === 'ERROR' && 'bg-red-tint/50')}>
                <span className="text-label-3 tabular">{clockMs(l.ts)}</span>
                <span className="self-stretch my-1 rounded-full" style={{ background: POD_COLORS[idx % POD_COLORS.length] }} />
                <span className="truncate text-label-2" title={l.pod}>
                  {scope.kind === 'all' ? short(l.service) : l.pod?.slice(-5)}
                </span>
                <span className={cx('h-[16px] rounded-[4px] text-[9.5px] font-bold grid place-items-center font-sans tracking-wide', lv.cls)}>{lv.label}</span>
                <MessageText text={l.text} dim={l.level === 'DEBUG'} />
              </button>
            );
          }}
        />
        {paused?.by === 'scroll' && !history && (
          <button type="button" onClick={jumpToNewest} className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-elevated shadow-[var(--shadow-pop)] h-7 px-3 rounded-full text-callout font-medium inline-flex items-center gap-1.5 animate-toast font-sans z-20">
            <Icon name="follow" size={13} /> Jump to newest
            <NewCount n={received.logs - paused.at} />
          </button>
        )}
      </div>
      {scope.kind !== 'all' && !history && (
        <div className="px-6 -mt-2 mb-3 text-subheadline text-label-3">
          {cloudMode ? (
            <>
              Reading {scope.kind === 'pod' ? scope.pod : scope.service} from Cloud Logging, a few seconds behind.{' '}
              {cloudReason === 'forbidden' ? 'This key isn’t allowed to read pod logs directly; SETUP.md step 1 shows the one-line fix.' : cloudReason === 'failed' ? 'Its pods aren’t sending their logs directly right now.' : null}
              {cloudReason === 'asked' && (
                <button type="button" className="text-accent ml-1" onClick={() => setForceCloud(false)}>
                  Try the pods directly again
                </button>
              )}
            </>
          ) : (
            <>
              Reading the <span className="font-mono">{follow$.container || 'main'}</span> container of {scope.kind === 'pod' ? scope.pod : `${follow$.podCount} pod${follow$.podCount === 1 ? '' : 's'} of ${scope.service}`} straight from the Kubernetes API, same as <span className="font-mono">kubectl logs -f</span>, no delay.
              {quiet?.items?.length > 0 && follow$.ring.length === 0 && ' The pods are connected but quiet, so the lines above are its last 15 minutes from Cloud Logging.'}
            </>
          )}
          {!cloudMode && follow$.streaming > 0 && follow$.streaming < follow$.podCount && (
            <span className="text-orange"> {follow$.podCount - follow$.streaming} of {follow$.podCount} pod streams aren't connected yet or failed; showing the rest.</span>
          )}
        </div>
      )}
    </ViewFixed>
  );
}

function EmptyNote({ children, spinner, tone, action }) {
  return (
    <div className="grid place-items-center py-16 px-8 text-center font-sans">
      <div className={cx('text-callout max-w-[520px] inline-flex items-center gap-2', tone === 'red' ? 'text-red' : 'text-label-2')}>
        {spinner && <Spinner />}
        <span className="selectable">{children}</span>
      </div>
      {action && (
        <Button size="sm" className="mt-3" onClick={action[1]}>
          {action[0]}
        </Button>
      )}
    </div>
  );
}

function MessageText({ text, dim }) {
  const { context, message } = parseNest(text);
  return (
    <span className={cx('truncate', dim ? 'text-label-3' : 'text-label')} title={text.length > 120 ? text.slice(0, 600) : undefined}>
      {context && <span className="text-label-2 mr-1.5">[{context}]</span>}
      {message}
    </span>
  );
}

export { LEVEL };
export function LogLineCard({ line }) {
  return (
    <Card className="font-mono text-callout whitespace-pre-wrap break-words selectable">{line.text}</Card>
  );
}
