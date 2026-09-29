import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useStore, logs as globalRing, received, invoke, onFollow, inspect } from '../lib/store.js';
import { ViewFixed } from '../components/Toolbar.jsx';
import VirtualList from '../components/VirtualList.jsx';
import Select from '../components/Select.jsx';
import { Segmented, SearchField, Button, cx, Spinner, Card, useNow } from '../components/ui.jsx';
import Icon from '../components/icons.jsx';
import ExportButton from '../components/ExportButton.jsx';
import { LiveUnavailable, NewCount, useLiveFeed, makeSearchText, cleanError } from './Traffic.jsx';
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
// The store keeps this many lines of the all-services stream; a view of one service keeps as many.
const RING_CAP = 20_000;
const GLOBAL_STREAM = {
  lines: globalRing,
  get total() {
    return received.logs;
  },
};
const EMPTY = [];
const lineSearchText = makeSearchText((l) => `${l.text} ${l.pod}`);

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

const wantedPods = (scope, pods) => (!scope ? EMPTY : scope.kind === 'pod' ? pods.filter((p) => p.name === scope.pod) : pods.filter((p) => p.service === scope.service && p.state !== 'done' && !p.terminal));
const containerOf = (p) => p.mainContainer || p.containers?.[0]?.name || null;

/**
 * Follows the logs of one service's pods (or one pod) straight from Kubernetes.
 * Lines land in `log` in arrival order ({ lines, total }, like the store's ring);
 * the view merges them by time. Pods that show up (a rollout, a scale-up) get
 * followed, pods that go away get unfollowed and forgotten.
 */
function useServiceFollow(scope, pods) {
  const key = scope ? `${scope.kind}:${scope.service}:${scope.pod || ''}` : null;
  // A new scope gets a new log during the render itself, so its first frame never shows the old scope's lines.
  const log = useRef(null);
  if (!log.current || log.current.key !== key) log.current = { key, lines: [], total: 0, since: Date.now() };
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState({ key, pods: {} }); // pods: name → { state: 'opening'|'streaming'|'error'|'stopped'|'unreachable'|'forbidden', message }
  const subs = useRef(new Map()); // pod → { id, off }
  const scheduled = useRef(false);
  const setPod = (name, st) =>
    setStatus((s) => {
      const cur = s.key === key ? s.pods : {};
      if (cur[name] && cur[name].state === st.state && cur[name].message === st.message) return s;
      return { key, pods: { ...cur, [name]: st } };
    });
  // Forget pods that went away, including ones whose stream had failed.
  const keepOnly = (names) =>
    setStatus((s) => {
      if (s.key !== key || Object.keys(s.pods).every((n) => names.has(n))) return s;
      return { key, pods: Object.fromEntries(Object.entries(s.pods).filter(([n]) => names.has(n))) };
    });
  const stop = (name) => {
    const entry = subs.current.get(name);
    if (!entry) return;
    subs.current.delete(name);
    entry.off?.();
    if (entry.id) invoke('logs:unfollow', { id: entry.id }).catch(() => {});
  };

  // Leaving the scope (or the page) closes every stream.
  useEffect(
    () => () => {
      for (const name of [...subs.current.keys()]) stop(name);
    },
    [key],
  );

  useEffect(() => {
    if (!key) return;
    const wanted = wantedPods(scope, pods);
    const names = new Set(wanted.map((p) => p.name));
    for (const name of [...subs.current.keys()]) if (!names.has(name)) stop(name);
    keepOnly(names);
    for (const p of wanted) {
      if (subs.current.has(p.name)) continue;
      const entry = { id: null, off: null };
      const target = log.current;
      subs.current.set(p.name, entry);
      setPod(p.name, { state: 'opening', message: null });
      invoke('logs:follow', { pod: p.name, container: containerOf(p) || p.service, service: p.service })
        .then(({ id }) => {
          if (subs.current.get(p.name) !== entry) {
            // The view moved on (or the pod went away) before the stream opened: close it right away.
            invoke('logs:unfollow', { id }).catch(() => {});
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
            setPod(p.name, { state: 'streaming', message: null });
            for (const l of lines) target.lines.push(l);
            target.total += lines.length;
            if (target.lines.length > RING_CAP) target.lines.splice(0, target.lines.length - RING_CAP);
            if (!scheduled.current) {
              scheduled.current = true;
              requestAnimationFrame(() => {
                scheduled.current = false;
                setVersion((v) => v + 1);
              });
            }
          });
        })
        .catch((e) => {
          if (subs.current.get(p.name) !== entry) return;
          subs.current.delete(p.name);
          setPod(p.name, { state: 'error', message: cleanError(e) });
        });
    }
  }, [key, pods]);

  const wanted = wantedPods(scope, pods);
  const podStatus = status.key === key ? status.pods : {};
  const states = Object.values(podStatus).map((st) => st.state);
  const count = (...xs) => states.filter((x) => xs.includes(x)).length;
  return {
    log: log.current,
    version,
    status: podStatus,
    podCount: wanted.length,
    since: log.current.since,
    container: wanted[0] ? containerOf(wanted[0]) : null,
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
  const pods = useStore((s) => s.sections.pods) || EMPTY;
  const services = useStore((s) => s.sections.services) || EMPTY;
  const live = useStore((s) => s.sections.sources?.live);
  // The 15 minutes before the live stream started, read from Google's logs on start: shown above
  // its lines in the all-services view, when they lead straight into them (after waking up, the
  // stream still holds its earlier lines). The same block sent again keeps its identity.
  const before = useStore((s) => s.sections.logsBefore);
  const beforeLines = useMemo(() => {
    if (!before?.lines?.length) return null;
    const first = globalRing[0];
    return !first || (first.ts >= before.lines[0].ts && first.ts - before.until < 5 * 60_000) ? before.lines : null;
  }, [before?.until, before?.lines?.length]);
  const [scope, setScope] = useState({ kind: 'all' });
  const [level, setLevel] = useState('all');
  const [q, setQ] = useState('');
  const [follow, setFollow] = useState(true);
  const [paused, setPaused] = useState(null); // { rows, by: 'user'|'scroll', seen }
  const [history, setHistory] = useState(null); // { loading, items, range, error, since, args }
  const historyRun = useRef(0);

  // Deep links (from the recap, alerts, error groups)
  useEffect(() => {
    if (!params?.at) return;
    if (params.pod || params.service) setPaused(null);
    if (params.pod) setScope({ kind: 'pod', pod: params.pod, service: params.service });
    else if (params.service) setScope({ kind: 'service', service: params.service });
    if (params.level) setLevel(params.level);
    if (params.from) runHistory({ from: params.from, until: params.until, service: params.service, pod: params.pod, level: params.level });
  }, [params?.at]);

  const podList = useMemo(() => pods.filter((p) => p.state !== 'done' && !p.terminal), [pods.map((p) => `${p.name}:${p.state === 'done' || !!p.terminal}`).join()]);
  const follow$ = useServiceFollow(scope.kind === 'all' ? null : scope, podList);

  async function runHistory(args) {
    const { from, until, service, level: lv, text } = args;
    const pod = 'pod' in args ? args.pod : scope.kind === 'pod' ? scope.pod : undefined;
    const run = ++historyRun.current;
    setHistory({ loading: true, items: [], range: { from, until }, since: Date.now(), args });
    try {
      const res = await invoke('logs:query', { from, until, service: service ?? (scope.kind !== 'all' ? scope.service : undefined), pod, level: (lv ?? level) === 'all' ? undefined : lv ?? level, text: text ?? (q || undefined), limit: 2000, withMeta: true });
      const items = Array.isArray(res) ? res : res?.items || [];
      if (run === historyRun.current) setHistory({ loading: false, items, truncated: !Array.isArray(res) && !!res?.truncated, range: { from, until }, args });
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

  const [quiet, setQuiet] = useState(null); // { loading, items, error, since }
  const [quietTry, setQuietTry] = useState(0);
  const hasLive = follow$.log.total > 0;
  const silent = scope.kind !== 'all' && !cloudMode && !history && follow$.podCount > 0 && follow$.streaming > 0 && !hasLive;
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
  const followBase = useMemo(() => {
    const extra = quiet?.items || EMPTY;
    if (!extra.length) return null;
    let first = Infinity;
    for (const l of follow$.log.lines) if (l.ts < first) first = l.ts;
    return first === Infinity ? extra : extra.filter((l) => l.ts < first);
  }, [quiet, follow$.log, hasLive]);
  const [allSince] = useState(() => Date.now());

  const regex = useMemo(() => {
    const m = q.trim().match(/^\/(.+)\/([a-z]*)$/);
    if (!m) return null;
    // The g and y flags make test() carry on from where the last match ended, skipping matches on the next line.
    const flags = [...new Set(`${m[2].replace(/[gy]/g, '')}i`)].join('');
    try {
      return new RegExp(m[1], flags);
    } catch {
      return null;
    }
  }, [q]);
  const ql = q.trim().toLowerCase();
  const filterKey = `${level}\u0000${q.trim()}`;
  const test = useMemo(() => {
    const minRank = level === 'all' ? -1 : LEVEL_RANK[level];
    return (l) => {
      if (minRank >= 0 && (LEVEL_RANK[l.level] ?? 1) < minRank) return false;
      if (regex) return regex.test(l.text);
      return !ql || lineSearchText(l).includes(ql);
    };
  }, [filterKey]);

  // The live lines, filtered as they arrive. Only the all-services view (and the Cloud
  // Logging fallback) reads the store's stream, so only they re-render with it.
  const usesGlobal = scope.kind === 'all' || cloudMode;
  const globalVersion = useStore((s) => (usesGlobal && !history ? s.logsVersion : 0));
  const inScope = (l) => l.service === scope.service && (scope.kind !== 'pod' || l.pod === scope.pod);
  const feedKey = scope.kind === 'all' ? 'all' : `${cloudMode ? 'cloud' : 'pods'}:${scope.service}:${scope.kind === 'pod' ? scope.pod : ''}`;
  const feed = useLiveFeed({
    key: feedKey,
    stream: usesGlobal ? GLOBAL_STREAM : follow$.log,
    version: usesGlobal ? globalVersion : follow$.version,
    base: scope.kind === 'all' ? beforeLines : cloudMode ? cloudInit?.items || null : followBase,
    accept: cloudMode ? inScope : null,
    byTime: scope.kind !== 'all',
    // The live stream may also bring the last few of those lines (Google delivers them a little late).
    dedupe: cloudMode || (scope.kind === 'all' && !!beforeLines),
    test,
    filterKey,
    cap: RING_CAP,
    active: !history,
  });
  // History results and the frozen lines of a pause are fixed lists: filtered again only when the filters change.
  const fixed = history ? history.items : paused ? paused.rows : null;
  const fixedItems = useMemo(() => (fixed ? fixed.filter(test) : null), [fixed, test]);
  const items = fixedItems || feed.rows;
  const source = fixed || feed.all;

  const freeze = (by) => setPaused({ rows: feed.all.slice(), by, seen: feed.seen, key: feedKey });
  // A pause belongs to the stream it froze: when the view switches streams (the pods' own logs
  // ↔ Cloud Logging) its "N new" would compare positions in two different streams.
  useEffect(() => {
    if (paused && paused.key !== feedKey) setPaused(null);
  }, [feedKey]);
  const onFollowChange = (f) => {
    setFollow(f);
    if (!f && !paused && !history) freeze('scroll');
    if (f && paused?.by === 'scroll') setPaused(null);
  };
  const jumpToNewest = () => {
    setPaused(null);
    setFollow(true);
  };

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
                const n = pods.filter((p) => p.service === s && p.state !== 'done' && !p.terminal).length;
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
          {history.truncated && <span className="text-orange">Google's search took too long, so this is only what came back in time. A shorter range shows everything.</span>}
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
          renderRow={(l) => <LogRow key={l.id} l={l} rh={rh} who={scope.kind === 'all' ? short(l.service) : l.pod?.slice(-5)} color={POD_COLORS[(podIndex.get(l.pod) ?? 0) % POD_COLORS.length]} />}
        />
        {paused?.by === 'scroll' && !history && (
          <button type="button" onClick={jumpToNewest} className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-elevated shadow-[var(--shadow-pop)] h-7 px-3 rounded-full text-callout font-medium inline-flex items-center gap-1.5 animate-toast font-sans z-20">
            <Icon name="follow" size={13} /> Jump to newest
            <NewCount n={feed.newSince(paused.seen)} />
          </button>
        )}
      </div>
      {scope.kind === 'all' && !history && beforeLines && feed.all[0] === beforeLines[0] && (
        <div className="px-6 -mt-2 mb-3 text-subheadline text-label-3">
          The first lines are the {Math.round((before.until - before.since) / 60_000)} minutes before Flobi Pulse started, from Google's logs{before.capped ? ` (the latest ${before.lines.length})` : ''}. Live lines follow.
        </div>
      )}
      {scope.kind !== 'all' && !history && (
        <div className="px-6 -mt-2 mb-3 text-subheadline text-label-3">
          {cloudMode ? (
            <>
              Reading {scope.kind === 'pod' ? scope.pod : scope.service} from Cloud Logging, a few seconds behind.{' '}
              {cloudReason === 'forbidden' ? 'This key isn’t allowed to read pod logs directly. Whoever manages the team’s key can allow it.' : cloudReason === 'failed' ? 'Its pods aren’t sending their logs directly right now.' : null}
              {cloudReason === 'asked' && (
                <button type="button" className="text-accent ml-1" onClick={() => setForceCloud(false)}>
                  Try the pods directly again
                </button>
              )}
            </>
          ) : (
            <>
              Reading the <span className="font-mono">{follow$.container || 'main'}</span> container of {scope.kind === 'pod' ? scope.pod : `${follow$.podCount} pod${follow$.podCount === 1 ? '' : 's'} of ${scope.service}`} straight from the Kubernetes API, same as <span className="font-mono">kubectl logs -f</span>, no delay.
              {quiet?.items?.length > 0 && !hasLive && ' The pods are connected but quiet, so the lines above are its last 15 minutes from Cloud Logging.'}
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

// A row only renders again when its own props change: as lines stream in, the rows
// already on screen stay as they are and only the new ones render.
const LogRow = memo(function LogRow({ l, rh, who, color }) {
  const lv = LEVEL[l.level] || LEVEL.INFO;
  return (
    <button type="button" onClick={() => inspect('log', l.id, l)} data-copy={l.text} data-copy-label="Copy log line" style={{ height: rh }} className={cx('w-full text-left grid grid-cols-[96px_3px_120px_34px_minmax(0,1fr)] gap-2.5 items-center px-4 hover:bg-fill-4', l.level === 'ERROR' && 'bg-red-tint/50')}>
      <span className="text-label-3 tabular">{clockMs(l.ts)}</span>
      <span className="self-stretch my-1 rounded-full" style={{ background: color }} />
      <span className="truncate text-label-2" title={l.pod}>
        {who}
      </span>
      <span className={cx('h-[16px] rounded-[4px] text-[9.5px] font-bold grid place-items-center font-sans tracking-wide', lv.cls)}>{lv.label}</span>
      <MessageText text={l.text} dim={l.level === 'DEBUG'} />
    </button>
  );
});

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
