// The past week, rebuilt from Cloud Logging when the app starts, so a new install (or
// one that was closed) doesn't open on empty pages: error groups, container crashes,
// Kubernetes events (Kubernetes itself keeps them for about an hour), past incidents
// for Recent issues, and the last 15 minutes of logs for the Logs page.
//
// Reads are entries:list only (free), and every teammate's app shares the project's
// 60 of them a minute, so the load is small and slow on purpose: one read at a time,
// spaced out, at background priority (a search someone is waiting on goes first),
// newest first (the last 24 hours, then day by day), each read capped. A restart
// (waking up, a settings change) reuses what the previous run read and only reads the
// gap. Nothing loaded here ever notifies. Pure JS: demo mode runs it in the browser.
import { normalizeEntry, workloadFromPodName } from './normalize.mjs';
import { recapFromData, eventOccurrences } from './recap.mjs';
import { slim, summarizeEvent } from './model.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const PAST_DAYS = 7;
/**
 * The most entries one read asks for. Errors, events and failed requests are read per day
 * (events: the newest day gets more), Postgres errors once for the week, and the Logs page's
 * last 15 minutes once. That's 23 reads for a whole week (7 days × 3, plus 2).
 */
export const PAST_CAPS = { errors: 1000, events: 1000, eventsOlder: 350, failed: 1000, sql: 1000, logs: 500 };
export const RECENT_LOGS_MS = 15 * MIN;
/** Between two reads of the past-week load: at most ~20 reads a minute from one app. */
export const PAST_READ_GAP_MS = 2500;

/** [from, until) cut into days, newest first (the oldest one may be shorter). */
export function daySlices(from, until, size = DAY) {
  const out = [];
  for (let end = until; end > from; end -= size) out.push({ from: Math.max(from, end - size), until: end });
  return out;
}

// ── Kubernetes events ────────────────────────────────────────────────────────

/**
 * One exported Kubernetes event (an entry of the "events" log) → a row shaped like the live
 * ones on the Events page (same id: the Event object's uid), plus the container it names and
 * the node that reported it. Kubernetes exports an Event object again each time its count
 * goes up, so one object can come back many times.
 */
export function eventFromLogs(entry) {
  const j = entry?.jsonPayload;
  if (!j?.involvedObject) return null;
  const at = Date.parse(j.series?.lastObservedTime || j.lastTimestamp || j.eventTime || j.firstTimestamp || '') || Date.parse(entry.timestamp || '') || null;
  if (!at) return null;
  const row = summarizeEvent(slim('events', j));
  return {
    ...row,
    at,
    firstAt: Math.min(row.firstAt || at, at),
    container: /\{([^}]+)\}/.exec(j.involvedObject.fieldPath || '')?.[1] || null,
    node: j.source?.host || j.reportingInstance || null,
    fromLogs: true,
  };
}

/** The same Event object seen twice: its latest state, and when it first happened. */
export function mergeEventRows(a, b) {
  const newer = b.at > a.at || (b.at === a.at && (b.count || 1) > (a.count || 1)) ? b : a;
  return { ...newer, count: Math.max(a.count || 1, b.count || 1), firstAt: Math.min(a.firstAt ?? a.at, b.firstAt ?? b.at) };
}

/** Rows → one per Event object. */
export function collapseEvents(rows) {
  const byId = new Map();
  for (const r of rows) {
    const had = byId.get(r.id);
    byId.set(r.id, had ? mergeEventRows(had, r) : r);
  }
  return [...byId.values()];
}

// ── Crashes ──────────────────────────────────────────────────────────────────
const CRASH_GAP = 30 * MIN;

const containerOf = (e) => e.container || /container "?([a-z0-9](?:[-a-z0-9]*[a-z0-9])?)"?/i.exec(e.message || '')?.[1] || null;

/**
 * Container crashes in exported Kubernetes events (rows from eventFromLogs): a container that
 * keeps crashing ("Back-off restarting failed container"), one killed for failing its liveness
 * or startup probe, and out-of-memory kills (a node's OOMKilling event names no pod: it counts
 * for a pod that crashed on that node within the few minutes after it). One record per pod and
 * container for crashes less than 30 minutes apart. Events carry no exit code, so there is none.
 */
export function crashesFromEvents(events, { podToService } = {}) {
  const points = [];
  const ooms = [];
  for (const e of events) {
    if (e.kind === 'Node' && e.reason === 'OOMKilling') {
      ooms.push(e);
      continue;
    }
    if (e.kind !== 'Pod') continue;
    const reason =
      e.reason === 'BackOff' && /restarting failed container/i.test(e.message)
        ? 'CrashLoopBackOff'
        : e.reason === 'Killing' && /liveness probe/i.test(e.message)
          ? 'LivenessProbe'
          : e.reason === 'Killing' && /startup probe/i.test(e.message)
            ? 'StartupProbe'
            : null;
    if (reason) points.push({ ...e, reason, container: containerOf(e) });
  }
  const episodes = new Map(); // pod/container → [{ at, until, points }]
  for (const p of points.sort((a, b) => a.at - b.at)) {
    const key = `${p.name}/${p.container || ''}`;
    const list = episodes.get(key) || [];
    const last = list[list.length - 1];
    if (last && p.at - last.until <= CRASH_GAP) {
      last.until = p.at;
      last.points.push(p);
    } else list.push({ at: p.at, until: p.at, points: [p] });
    episodes.set(key, list);
  }
  const out = [];
  for (const list of episodes.values()) {
    for (const ep of list) {
      const first = ep.points[0];
      const last = ep.points[ep.points.length - 1];
      const oom = first.node ? ooms.find((o) => o.name === first.node && ep.points.some((p) => o.at >= p.at - 3 * MIN && o.at <= p.at + 30_000)) : null;
      out.push({
        id: `logs:${first.name}/${first.container || ''}:${ep.at}`,
        at: ep.at,
        until: ep.until,
        pod: first.name,
        service: podToService?.(first.name, first.container) || workloadFromPodName(first.name) || first.name,
        container: first.container,
        reason: oom ? 'OOMKilled' : last.reason,
        exitCode: null,
        message: oom ? oom.message : last.message,
        restarts: null,
        // How many times Kubernetes reported it (each back-off, each kill).
        times: eventOccurrences(ep.points.map((p) => ({ uid: p.id, count: p.count, t: p.at }))),
        node: first.node || null,
        fromLogs: true,
      });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Adds crash records from the logs to a list of them: the same pod and container within 30 minutes is one record. */
export function mergeCrashRecords(list, more, max = 300) {
  const out = list.slice();
  for (const c of more) {
    const i = out.findIndex((x) => x.pod === c.pod && x.container === c.container && c.at <= x.until + CRASH_GAP && c.until >= x.at - CRASH_GAP);
    if (i < 0) {
      out.push({ ...c });
      continue;
    }
    const x = out[i];
    const newer = c.until > x.until ? c : x;
    const oom = x.reason === 'OOMKilled' ? x : c.reason === 'OOMKilled' ? c : null;
    out[i] = { ...x, at: Math.min(x.at, c.at), until: Math.max(x.until, c.until), times: (x.times || 1) + (c.times || 1), reason: oom ? 'OOMKilled' : newer.reason, message: (oom || newer).message };
  }
  return out.sort((a, b) => b.at - a.at).slice(0, max);
}

/** A live crash record (from the pod's status) already covers this one from the logs. */
export function crashCovered(past, live) {
  return live.some((c) => c.pod === past.pod && c.container === past.container && c.at >= past.at - 10 * MIN && c.at <= (past.until ?? past.at) + 10 * MIN);
}

// ── Recent issues ────────────────────────────────────────────────────────────

/** An incident the recap rebuilt from the logs, as an entry of Recent issues: never open, never saved. */
export function pastIssue(inc, svcToWorkload) {
  const service = inc.service ? svcToWorkload?.get?.(inc.service) || inc.service : null;
  return {
    id: `logs:${inc.id}`,
    key: `logs:${inc.id}`,
    kind: inc.kind,
    severity: inc.severity,
    peak: inc.severity,
    title: inc.title,
    detail: inc.detail || null,
    impact: null,
    action: null,
    service,
    openedAt: inc.start,
    lastAt: inc.end ?? inc.start,
    resolvedAt: inc.end ?? inc.start,
    oneShot: true,
    acked: false,
    clearingSince: null,
    view: inc.view || null,
    fromLogs: true,
  };
}

// Which alert kinds describe the same kind of problem as which incidents from the logs.
const FAMILY = { crash: 'workload', pod: 'workload', service: 'workload', event: 'workload', scaling: 'workload', job: 'workload', http: 'http', errors: 'errors', database: 'database', node: 'node' };

/**
 * An issue from the logs that an alert (saved from an earlier run, or raised live) already
 * covers: the same kind of problem, for the same service (when both name one), at the same time.
 */
export function sameProblem(past, alert, now = Date.now()) {
  if ((FAMILY[past.kind] || past.kind) !== (FAMILY[alert.kind] || alert.kind)) return false;
  if (past.service && alert.service && past.service !== alert.service) return false;
  const end = alert.resolvedAt ?? (alert.open ? now : alert.lastAt ?? alert.openedAt);
  return past.openedAt <= end + 10 * MIN && (past.resolvedAt ?? past.openedAt) >= alert.openedAt - 10 * MIN;
}

// ── One slice ────────────────────────────────────────────────────────────────

/** An error line, without what the Errors page doesn't use (kept in memory for a week). */
const slimLine = (l) => ({ kind: 'log', id: l.id, ts: l.ts, pod: l.pod, container: l.container, service: l.service, level: l.level, text: l.text.length > 4000 ? l.text.slice(0, 4000) : l.text });

/**
 * One slice of the past, from raw Cloud Logging entries to what the pages show: error lines
 * (for the Errors page's groups), event rows, the crashes in them, and the incidents the
 * recap finds (Recent issues). `sqlRaw` may cover more than the slice.
 */
export function processSlice({ from, until, errorsRaw, eventsRaw, failedRaw, sqlRaw, namespace, projectId, podToService, caps = PAST_CAPS, notes = [] }) {
  const ctx = { namespace, podToService };
  const errors = (errorsRaw || []).map((e) => normalizeEntry(e, ctx)).filter((l) => l.kind === 'log').map(slimLine);
  const exported = (eventsRaw || []).map(eventFromLogs).filter(Boolean);
  const sql = sqlRaw
    ? sqlRaw.filter((e) => {
        const t = Date.parse(e.timestamp);
        return t >= from && t < until;
      })
    : null;
  let incidents = [];
  try {
    // A day at a time, so short problems stand out as they do in a one-day recap. New error
    // types aren't incidents here: the Errors page marks them.
    const recap = recapFromData({ since: from, until, namespace, projectId, knownErrors: {}, podToService, caps: { errors: caps.errors, failed: caps.failed } }, { eventsRaw: eventsRaw || null, errorRaw: errorsRaw || null, lbRaw: failedRaw || null, sqlLogs: sql });
    incidents = recap.incidents.filter((i) => !String(i.id).startsWith('newerrors:'));
  } catch (e) {
    console.warn('[past week] incidents:', e.message);
  }
  return { from, until, errors, events: collapseEvents(exported), crashes: crashesFromEvents(exported, { podToService }), incidents, notes };
}

// ── The load ─────────────────────────────────────────────────────────────────

/**
 * Loads the past week: what an earlier run already read (`cache`, when it's for the same
 * `key`) at once, then the last 15 minutes of logs, then the rest, newest first.
 * @param {object} o
 * @param {(q: {kind: 'logs'|'sql'|'errors'|'events'|'failed', from: number, until: number, max: number}) => Promise<object[]>} o.read
 *   raw entries for [from, until), newest first, at most `max`; an array with `truncated` when Google's search gave up early
 * @param {(raw: object) => object} o.process  raw entries of one day → what the pages show (processSlice with the context)
 * @param {number} o.now
 * @param {(slice: object) => void} o.onSlice
 * @param {(state: object) => void} [o.onStatus]  { status: 'loading'|'done'|'error', since, until, notes, error }
 * @param {(block: {since: number, until: number, entries: object[], capped: boolean}) => void} [o.onRecentLogs]
 * @param {{key?: string, slices?: object[]}} [o.cache]  kept between runs
 * @param {string} [o.key]  what the cache belongs to (project, namespace, account)
 * @param {() => Promise<void>} [o.pause]  between two reads
 * @param {() => boolean} [o.stopped]
 * @returns {Promise<{status: 'done'} | {status: 'error', error: string, code: number|null} | undefined>} undefined when stopped
 */
export async function loadPastWeek(o) {
  const { read, process: build, now, onSlice } = o;
  const caps = { ...PAST_CAPS, ...o.caps };
  const pause = o.pause || (() => Promise.resolve());
  const stopped = o.stopped || (() => false);
  const windowFrom = now - (o.days || PAST_DAYS) * DAY;
  const cache = o.cache || null;
  if (cache && cache.key !== o.key) Object.assign(cache, { key: o.key, slices: [] });
  const kept = (cache?.slices || []).filter((s) => s.until > windowFrom).sort((a, b) => b.until - a.until);
  if (cache) cache.slices = kept;
  const notes = kept.flatMap((s) => s.notes || []);
  let since = kept.length ? Math.min(...kept.map((s) => s.from)) : null;
  let until = kept.length ? kept[0].until : null;
  const status = (state) => o.onStatus?.({ since, until, notes: notes.slice(), ...state });
  const note = (kind, from, to, list, max, into) => {
    const n = list.truncated ? { kind, from, until: to, slow: true } : list.length >= max ? { kind, from, until: to, busy: true, n: max } : null;
    if (n) {
      notes.push(n);
      into?.push(n);
    }
  };

  status({ status: 'loading' });
  // Read by an earlier run: shown at once (a moment between days, so nothing else waits long).
  for (const s of kept) {
    if (stopped()) return;
    onSlice(s);
    await new Promise((r) => setTimeout(r, 0));
  }
  const ranges = [];
  if (!kept.length) ranges.push(...daySlices(windowFrom, now));
  else {
    if (now - until >= MIN) ranges.push(...daySlices(until, now));
    if (since - windowFrom >= HOUR) ranges.push(...daySlices(windowFrom, since));
  }

  let reads = 0;
  const next = async () => {
    if (reads++) await pause();
    return !stopped();
  };
  try {
    if (o.onRecentLogs) {
      if (!(await next())) return;
      const from = now - RECENT_LOGS_MS;
      const entries = await read({ kind: 'logs', from, until: now, max: caps.logs });
      if (stopped()) return;
      o.onRecentLogs({ since: from, until: now, entries, capped: entries.length >= caps.logs });
    }
    if (ranges.length) {
      // Postgres errors for everything about to be read, in one go: each day takes its part.
      if (!(await next())) return;
      const sqlFrom = Math.min(...ranges.map((r) => r.from));
      const sqlUntil = Math.max(...ranges.map((r) => r.until));
      const sqlRaw = await read({ kind: 'sql', from: sqlFrom, until: sqlUntil, max: caps.sql });
      if (stopped()) return;
      note('sql', sqlFrom, sqlUntil, sqlRaw, caps.sql);
      for (const [i, r] of ranges.entries()) {
        const raw = {};
        const sliceNotes = [];
        for (const kind of ['errors', 'events', 'failed']) {
          if (!(await next())) return;
          const max = kind === 'events' && i > 0 ? caps.eventsOlder : caps[kind];
          raw[kind] = await read({ kind, from: r.from, until: r.until, max });
          if (stopped()) return;
          note(kind, r.from, r.until, raw[kind], max, sliceNotes);
        }
        const slice = build({ from: r.from, until: r.until, errorsRaw: raw.errors, eventsRaw: raw.events, failedRaw: raw.failed, sqlRaw, caps, notes: sliceNotes });
        cache?.slices.push(slice);
        onSlice(slice);
        since = since == null ? r.from : Math.min(since, r.from);
        until = until == null ? r.until : Math.max(until, r.until);
        if (i < ranges.length - 1) status({ status: 'loading' });
      }
    }
    status({ status: 'done' });
    return { status: 'done' };
  } catch (e) {
    if (stopped()) return undefined;
    const end = { status: 'error', error: e.message || String(e), code: e.status ?? null };
    status(end);
    return end;
  }
}
