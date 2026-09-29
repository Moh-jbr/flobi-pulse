// The past week, loaded from Cloud Logging on start (engine/backfill.mjs): error groups,
// crashes, events and past incidents fill the pages without notifying anyone, in capped
// background reads, newest first. Fake clocks and a fake LoggingClient, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorBook, fingerprint, fingerprintV1 } from '../electron/core/engine/errors.mjs';
import { Pipeline } from '../electron/core/engine/pipeline.mjs';
import { LiveConnector } from '../electron/core/engine/live.mjs';
import { eventFromLogs, collapseEvents, crashesFromEvents, mergeCrashRecords, sameProblem, daySlices, loadPastWeek, PAST_CAPS } from '../electron/core/engine/backfill.mjs';
import { recapFromData } from '../electron/core/engine/recap.mjs';
import { coverage } from '../src/lib/format.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 8, 28, 12, 0);
const iso = (ms) => new Date(ms).toISOString();
const POD = 'flobi-brand-7d9f8c6b5-x2x9z';

let seq = 0;
/** A normalized error line (what the backfill hands the ErrorBook). */
const line = (text, ts, extra = {}) => ({ kind: 'log', id: `i${++seq}:${ts}`, level: 'ERROR', text, service: 'flobi-brand', container: 'flobi-brand', pod: POD, ts, ...extra });
const nest = (message, context = 'BrandService') => `[Nest] 1  - 09/28/2026, 12:00:00 PM   ERROR [${context}] ${message}`;

/** A container log entry as Cloud Logging returns it. */
const errEntry = (t, text, { pod = POD, container = 'flobi-brand', severity = 'ERROR' } = {}) => ({ insertId: `e${++seq}`, timestamp: iso(t), severity, resource: { type: 'k8s_container', labels: { namespace_name: 'flobi', pod_name: pod, container_name: container } }, textPayload: text });
/** An exported Kubernetes event (one entry of the "events" log). */
const evEntry = (t, reason, message, { kind = 'Pod', name = POD, uid = `u-${reason}-${name}`, count = 1, host = 'node-1', type = 'Warning', container = 'flobi-brand' } = {}) => ({
  logName: 'projects/flobi-prod-2026/logs/events',
  timestamp: iso(t),
  jsonPayload: { metadata: { uid }, type, reason, message, count, involvedObject: { kind, name, namespace: kind === 'Node' ? undefined : 'flobi', fieldPath: kind === 'Pod' ? `spec.containers{${container}}` : undefined }, firstTimestamp: iso(t), lastTimestamp: iso(t), source: { component: kind === 'Node' ? 'kernel-monitor' : 'kubelet', host } },
});
const lb5xx = (t, service = 'flobi-gateway') => ({ insertId: `l${++seq}`, timestamp: iso(t), resource: { type: 'http_load_balancer', labels: { backend_service_name: `k8s1-8f2c1a9b-flobi-${service}-80-q7w8e9r0` } }, httpRequest: { requestMethod: 'GET', requestUrl: 'https://api.flobi.ai/x', status: 502, latency: '0.01s' }, jsonPayload: { statusDetails: 'failed_to_connect_to_backend' } });

function pipeline(extra = {}) {
  const clock = { now: T0 };
  const sent = [];
  const p = new Pipeline({ namespace: 'flobi', emit: () => {}, mode: 'live', now: () => clock.now, notify: (a, meta) => sent.push({ a, meta }), ...extra });
  return { p, clock, sent };
}

// ── The ErrorBook ───────────────────────────────────────────────────────────
test('past week: error lines from the logs group like live ones and become known; on a first run nothing is new', () => {
  const book = new ErrorBook({ known: {}, now: T0 });
  const n = book.addPast([line(nest('Folder fd_ppfzbts5zj not found'), T0 - 3 * DAY), line(nest('Folder fd_x8r2m4n6p0 not found'), T0 - 2 * DAY), line(nest('Stripe webhook signature verification failed'), T0 - 30 * MIN)], T0);
  assert.equal(n, 3);
  const groups = book.summary(T0);
  assert.equal(groups.length, 2);
  const folder = groups.find((g) => g.title.startsWith('Folder'));
  assert.deepEqual([folder.count, folder.firstSeen, folder.lastSeen, folder.isNew, folder.active], [2, T0 - 3 * DAY, T0 - 2 * DAY, false, false]);
  const stripe = groups.find((g) => g.title.startsWith('Stripe'));
  assert.deepEqual([stripe.count, stripe.count1h, stripe.active, stripe.isNew], [1, 1, true, false], 'the last hour is in the sparkline');
  // The first run's baseline, as for live errors in its first 15 minutes: known, never "New".
  assert.equal(book.known[folder.id], T0 - 3 * DAY - 7 * DAY);
  assert.equal(book.inBaseline(T0 + 16 * MIN), false, "the load doesn't stretch the baseline");
  const again = book.add(line(nest('Folder fd_k2m4p7x9zq not found'), T0 + 20 * MIN));
  assert.equal(again.isNewGroup, false, 'seen in the past week: never a "new error" later');
  assert.equal(book.summary(T0 + 20 * MIN).find((g) => g.id === folder.id).count, 3);
});

test('past week: on a later run, error types this computer never saw are New when they began in the last day, and still never reported', () => {
  const legacyText = nest('S3 upload failed for file_9wf2gpglg7: ECONNRESET');
  const book = new ErrorBook({ known: { other: 1 }, legacyKnown: { [fingerprintV1('flobi-brand', legacyText)]: T0 - 20 * DAY }, now: T0 });
  book.addPast([line(nest('Presigned URL expired before the upload finished'), T0 - 5 * HOUR), line(nest('Yjs persistence failed'), T0 - 3 * DAY), line(nest('S3 upload failed for file_zz81kd02aa: ECONNRESET'), T0 - 2 * DAY)], T0);
  const byTitle = Object.fromEntries(book.summary(T0).map((g) => [g.title.split(' ')[0], g]));
  assert.equal(byTitle.Presigned.isNew, true, 'first seen 5 hours ago');
  assert.equal(byTitle.Yjs.isNew, false);
  assert.equal(book.known[byTitle.Presigned.id], T0 - 5 * HOUR);
  assert.equal(byTitle.S3.isNew, false, 'known under the old fingerprints');
  assert.equal(book.known[byTitle.S3.id], T0 - 20 * DAY);
  assert.equal(book.add(line(nest('Presigned URL expired before the upload finished'), T0 + MIN)).isNewGroup, false);
  // An error seen live first and then found earlier in the logs: it's been around.
  const live = book.add(line(nest('Brand extraction queue stalled'), T0 + 2 * MIN));
  assert.equal(live.isNewGroup, true);
  book.addPast([line(nest('Brand extraction queue stalled'), T0 - 2 * DAY)], T0 + 3 * MIN);
  assert.equal(book.known[live.group.id], T0 - 2 * DAY);
  assert.equal(book.summary(T0 + 3 * MIN).find((g) => g.id === live.group.id).isNew, false);
});

test('past week: an entry both the live stream and the load delivered counts once, whichever came first', () => {
  const book = new ErrorBook({ known: { other: 1 }, now: T0 });
  const a = line(nest('boom'), T0 - 10_000, { id: 'dup-1' });
  book.add(a);
  assert.equal(book.addPast([{ ...a }], T0), 0);
  const b = line(nest('boom'), T0 - 5_000, { id: 'dup-2' });
  assert.equal(book.addPast([b], T0), 1);
  assert.equal(book.add({ ...b }), null);
  assert.equal(book.summary(T0)[0].count, 2);
  // Remembered only while it matters: until a little after the load.
  book.holdIds(T0 + MIN);
  book.prune(T0 + 2 * MIN);
  assert.equal(book.ids, null);
});

test('past week: counts cover the last 7 days and shrink as hours drop out of it; groups stay a week', () => {
  const book = new ErrorBook({ known: { other: 1 }, now: T0 });
  book.addPast([line(nest('boom'), T0 - 7 * DAY + 30 * MIN), line(nest('boom'), T0 - 2 * DAY), line(nest('boom'), T0 - 10 * MIN), line(nest('ancient'), T0 - 8 * DAY)], T0);
  let [g, ...rest] = book.summary(T0);
  assert.equal(rest.length, 0, 'older than the window: known, but not a group');
  assert.ok(fingerprint('flobi-brand', nest('ancient')) in book.known);
  assert.deepEqual([g.count, g.count1h, g.spark.reduce((a, b) => a + b, 0)], [3, 1, 1]);
  book.prune(T0);
  assert.equal(book.summary(T0)[0].count, 3);
  book.prune(T0 + HOUR);
  [g] = book.summary(T0 + HOUR);
  assert.equal(g.count, 2, 'the oldest hour left the window');
  book.prune(T0 + 5 * DAY);
  assert.equal(book.summary(T0 + 5 * DAY)[0].count, 2, 'whole hours: the one from exactly 7 days ago is still in');
  book.prune(T0 + 5 * DAY + HOUR);
  assert.equal(book.summary(T0 + 5 * DAY + HOUR)[0].count, 1);
  book.prune(T0 + 7 * DAY + MIN);
  assert.equal(book.groups.size, 0, 'not seen for a week');
});

test('past week: the latest occurrences stay the samples, and an older stack never replaces the latest one', () => {
  const book = new ErrorBook({ known: { other: 1 }, now: T0 });
  book.add(line(nest('Cannot read properties of undefined', 'ExceptionsHandler'), T0, { pod: 'p1' }));
  book.add(line("TypeError: Cannot read properties of undefined (reading 'x')", T0 + 1, { pod: 'p1' }));
  book.addPast([line(nest('Cannot read properties of undefined', 'ExceptionsHandler'), T0 - DAY, { pod: 'p0' }), line("TypeError: Cannot read properties of undefined (reading 'y')", T0 - DAY + 1, { pod: 'p0' })], T0);
  const [g] = book.summary(T0);
  assert.equal(g.count, 2, 'the exception line is part of its error, in the past too');
  assert.deepEqual(g.stack, ["TypeError: Cannot read properties of undefined (reading 'x')"]);
  assert.equal(g.samples[g.samples.length - 1].ts, T0);
  assert.deepEqual(g.pods, ['p0', 'p1'], 'live pods last');
});

// ── Through the pipeline ────────────────────────────────────────────────────
test('past week through the pipeline: nothing notifies or opens, error types become known, counts say what they cover', () => {
  const { p, sent } = pipeline({ knownErrors: { other: 1 } });
  try {
    p.initialPhase = false;
    p.liveSince = T0 - HOUR;
    p.setBackfill({ status: 'loading' });
    const rows = [evEntry(T0 - 2 * DAY, 'BackOff', `Back-off restarting failed container flobi-brand in pod ${POD}_flobi(abc)`)].map(eventFromLogs);
    p.addPast({
      errors: [line(nest('Stripe webhook signature verification failed'), T0 - 2 * HOUR), line(nest('Folder fd_x8r2m4n6p0 not found'), T0 - 4 * DAY)],
      events: rows,
      crashes: crashesFromEvents(rows),
      incidents: [{ id: 'restart:flobi-brand:1', kind: 'crash', severity: 'critical', service: 'flobi-brand', title: 'brand restarted (crash loop)', start: T0 - 2 * DAY, end: T0 - 2 * DAY + 5 * MIN }],
    });
    p.setBackfill({ status: 'done', since: T0 - 7 * DAY, until: T0 });
    p.rebuild();
    assert.equal(sent.length, 0);
    assert.equal(p.alerts.active.size, 0);
    assert.ok(fingerprint('flobi-brand', nest('Stripe webhook signature verification failed')) in p.knownErrors());
    const errors = p.section('errors');
    assert.equal(errors.backend.length, 2);
    assert.equal(errors.since, T0 - 7 * DAY);
    assert.equal(coverage(errors.since, T0).label, 'in 7 days');
    assert.equal(p.section('crashes')[0].reason, 'CrashLoopBackOff');
    assert.equal(p.section('events')[0].reason, 'BackOff');
    assert.equal(p.section('alerts').history[0].fromLogs, true);
    assert.equal(p.alerts.summary().counts.critical, 0);
  } finally {
    p.destroy();
  }
});

test('a slice of the past week added twice (a load tried again) counts once', () => {
  const { p } = pipeline({ knownErrors: { other: 1 } });
  try {
    const rows = [evEntry(T0 - DAY, 'BackOff', `Back-off restarting failed container flobi-brand in pod ${POD}_flobi(abc)`)].map(eventFromLogs);
    const slice = { from: T0 - 2 * DAY, until: T0 - DAY + MIN, errors: [line(nest('boom'), T0 - DAY - HOUR)], events: rows, crashes: crashesFromEvents(rows), incidents: [] };
    p.addPast(slice);
    p.addPast(slice);
    assert.equal(p.section('errors').backend[0].count, 1);
    assert.equal(p.section('crashes')[0].times, 1);
  } finally {
    p.destroy();
  }
});

test('a new error type seen live while the past week loads waits for it: dropped if the logs had it, sent if not', () => {
  const { p, clock } = pipeline({ knownErrors: { other: 1 } });
  try {
    p.initialPhase = false;
    p.liveSince = clock.now - 10 * MIN;
    p.setBackfill({ status: 'loading' });
    const live = (text) => ({ kind: 'log', id: `live-${++seq}`, level: 'ERROR', ts: clock.now, service: 'flobi-billing', pod: 'flobi-billing-7d9f8c6b5-bcdfg', text: nest(text, 'StripeWebhook') });
    p.ingest([live('Stripe webhook signature verification failed'), live('Payout batch rejected by the bank')]);
    assert.equal(p.alerts.active.size, 0, 'held while the week loads');
    p.addPast({ errors: [{ ...live('Stripe webhook signature verification failed'), id: 'past-1', ts: clock.now - 2 * DAY }] });
    p.setBackfill({ status: 'done' });
    assert.deepEqual(
      [...p.alerts.active.values()].map((a) => a.title),
      ['New error in billing: Payout batch rejected by the bank'],
    );
    // A load that takes too long doesn't hold them for good: 5 minutes at most.
    p.alerts.active.clear();
    p.setBackfill({ status: 'loading' });
    p.ingest([live('Refund webhook timed out')]);
    clock.now += 6 * MIN;
    p.tick();
    assert.equal(p.alerts.active.size, 1);
  } finally {
    p.destroy();
  }
});

test('crashes from the logs join the live ones: no duplicates, a week at most, newest first', () => {
  const { p } = pipeline();
  try {
    p.crashes = [{ id: 'pod-a/app/3', at: T0 - 2 * HOUR, pod: 'pod-a', container: 'app', service: 'svc-a', reason: 'OOMKilled', exitCode: 137, restarts: 3 }];
    p.addPast({
      crashes: [
        { id: 'logs:pod-a/app:1', at: T0 - 2 * HOUR - 5 * MIN, until: T0 - 2 * HOUR + MIN, pod: 'pod-a', container: 'app', service: 'svc-a', reason: 'CrashLoopBackOff', exitCode: null, restarts: null, times: 4, fromLogs: true },
        { id: 'logs:pod-b/app:2', at: T0 - 3 * DAY, until: T0 - 3 * DAY, pod: 'pod-b', container: 'app', service: 'svc-b', reason: 'LivenessProbe', exitCode: null, restarts: null, times: 1, fromLogs: true },
        { id: 'logs:pod-c/app:3', at: T0 - 8 * DAY, until: T0 - 8 * DAY, pod: 'pod-c', container: 'app', service: 'svc-c', reason: 'CrashLoopBackOff', exitCode: null, restarts: null, times: 1, fromLogs: true },
      ],
    });
    assert.deepEqual(
      p.section('crashes').map((c) => c.id),
      ['pod-a/app/3', 'logs:pod-b/app:2'],
      'the live record (with its exit code) covers the same crash from the logs',
    );
  } finally {
    p.destroy();
  }
});

test('Kubernetes events from the logs fill the Events page; the live copy of the same event wins', () => {
  const { p } = pipeline();
  try {
    p.setK8s('events', [{ metadata: { uid: 'u1' }, type: 'Warning', reason: 'Unhealthy', message: 'Readiness probe failed', involvedObject: { kind: 'Pod', name: POD, namespace: 'flobi' }, count: 5, firstTimestamp: iso(T0 - 50 * MIN), lastTimestamp: iso(T0 - 10 * MIN) }]);
    const past = [evEntry(T0 - 40 * MIN, 'Unhealthy', 'Readiness probe failed', { uid: 'u1', count: 3 }), evEntry(T0 - 2 * DAY, 'FailedScheduling', '0/4 nodes are available: 4 Insufficient memory.', { uid: 'u2' })].map(eventFromLogs);
    p.addPast({ events: past });
    const events = p.section('events');
    assert.deepEqual(events.map((e) => [e.id, e.count, !!e.fromLogs]), [['u1', 5, false], ['u2', 1, true]]);
    assert.equal(events[1].service, 'flobi-brand');
  } finally {
    p.destroy();
  }
});

test('issues rebuilt from the logs: closed, never open or counted, never saved, and hidden where an alert already covered them', () => {
  const { p } = pipeline();
  try {
    p.alerts.loadHistory([{ id: 'crash:pod-a/brand@1', key: 'crash:pod-a/brand', kind: 'crash', service: 'flobi-brand', severity: 'critical', title: 'brand ran out of memory and restarted', openedAt: T0 - 3 * HOUR, lastAt: T0 - 3 * HOUR, resolvedAt: T0 - 150 * MIN }]);
    p.addPast({
      incidents: [
        { id: 'restart:flobi-brand:1', kind: 'crash', severity: 'critical', service: 'flobi-brand', title: 'brand restarted 3× (out of memory)', start: T0 - 3 * HOUR + 2 * MIN, end: T0 - 170 * MIN },
        { id: '5xx:flobi-gateway:2', kind: 'http', severity: 'warning', service: 'flobi-gateway', title: 'gateway: 40 failed requests', start: T0 - 2 * DAY, end: T0 - 2 * DAY + 4 * MIN, view: { to: 'logs', service: 'flobi-gateway' } },
      ],
    });
    const s = p.section('alerts');
    assert.deepEqual(s.history.map((a) => a.title), ['brand ran out of memory and restarted', 'gateway: 40 failed requests']);
    const past = s.history[1];
    assert.deepEqual([past.fromLogs, past.open, past.resolvedAt, past.view.to], [true, false, T0 - 2 * DAY + 4 * MIN, 'logs']);
    assert.deepEqual([s.active.length, s.counts.critical, s.counts.warning], [0, 0, 0]);
    assert.deepEqual(p.historyToSave().map((a) => a.id), ['crash:pod-a/brand@1'], 'rebuilt again next time, never saved');
    // The dedupe rule itself: same kind of problem, same service, overlapping (with 10 minutes of slack).
    const alert = { kind: 'pod', service: 'x', openedAt: T0, resolvedAt: T0 + 5 * MIN };
    assert.equal(sameProblem({ kind: 'crash', service: 'x', openedAt: T0 + 12 * MIN, resolvedAt: T0 + 20 * MIN }, alert, T0), true);
    assert.equal(sameProblem({ kind: 'crash', service: 'x', openedAt: T0 + 16 * MIN, resolvedAt: T0 + 20 * MIN }, alert, T0), false);
    assert.equal(sameProblem({ kind: 'crash', service: 'y', openedAt: T0, resolvedAt: T0 }, alert, T0), false);
    assert.equal(sameProblem({ kind: 'http', service: 'x', openedAt: T0, resolvedAt: T0 }, alert, T0), false);
  } finally {
    p.destroy();
  }
});

// ── Crashes and events in Kubernetes events ─────────────────────────────────
test('crashes in Kubernetes events: crash loops, failed liveness probes, and out-of-memory kills matched by node and time', () => {
  const t = T0 - DAY;
  const backoff = `Back-off restarting failed container flobi-brand in pod ${POD}_flobi(abc)`;
  const rows = [
    // One Event object, exported again as its count went up, after an OOM kill on the pod's node.
    evEntry(t - 30_000, 'OOMKilling', 'Memory cgroup out of memory: Killed process 1 (node)', { kind: 'Node', name: 'node-1', uid: 'oom-1' }),
    evEntry(t, 'BackOff', backoff, { uid: 'b1', count: 1 }),
    evEntry(t + 2 * MIN, 'BackOff', backoff, { uid: 'b1', count: 2 }),
    evEntry(t + 5 * MIN, 'BackOff', backoff, { uid: 'b1', count: 3 }),
    // Two hours later, again: another record, with no OOM kill near it.
    evEntry(t + 2 * HOUR, 'BackOff', backoff, { uid: 'b2' }),
    // A failed liveness probe on another pod, and an OOM kill on another node.
    evEntry(t + HOUR, 'Killing', 'Container flobi-notes failed liveness probe, will be restarted', { name: 'flobi-notes-6b7c8d9f2f-zzzzz', container: 'flobi-notes', uid: 'k1', host: 'node-2' }),
    evEntry(t + HOUR + 30_000, 'OOMKilling', 'Memory cgroup out of memory: Killed process 7 (python3)', { kind: 'Node', name: 'node-3', uid: 'oom-2' }),
    // Not crashes: an image pull back-off, a normal stop, a readiness probe.
    evEntry(t, 'BackOff', 'Back-off pulling image "europe-west1-docker.pkg.dev/x/y:z"', { name: 'flobi-drive-5f6d7c8b9k-bcdfg', uid: 'p1' }),
    evEntry(t, 'Killing', 'Stopping container flobi-drive', { type: 'Normal', name: 'flobi-drive-5f6d7c8b9k-bcdfg', uid: 's1' }),
    evEntry(t, 'Unhealthy', 'Readiness probe failed: context deadline exceeded', { uid: 'r1' }),
  ].map(eventFromLogs);
  const crashes = crashesFromEvents(rows);
  assert.deepEqual(
    crashes.map((c) => [c.pod, c.container, c.reason, c.at, c.until, c.times, c.exitCode]),
    [
      [POD, 'flobi-brand', 'CrashLoopBackOff', t + 2 * HOUR, t + 2 * HOUR, 1, null],
      ['flobi-notes-6b7c8d9f2f-zzzzz', 'flobi-notes', 'LivenessProbe', t + HOUR, t + HOUR, 1, null],
      [POD, 'flobi-brand', 'OOMKilled', t, t + 5 * MIN, 3, null],
    ],
  );
  assert.equal(crashes[2].message, 'Memory cgroup out of memory: Killed process 1 (node)');
  assert.ok(crashes.every((c) => c.fromLogs && c.service === (c.pod === POD ? 'flobi-brand' : 'flobi-notes')));
});

test('the recap (Recent issues, While you were away) calls a crash loop out of memory when its node reported the kill', () => {
  const t = T0 - 3 * HOUR;
  const backoff = `Back-off restarting failed container flobi-brand in pod ${POD}_flobi(abc)`;
  const crashOn = (oomNode) =>
    recapFromData({ since: T0 - DAY, until: T0, namespace: 'flobi' }, { eventsRaw: [evEntry(t - 30_000, 'OOMKilling', 'Memory cgroup out of memory: Killed process 1 (node)', { kind: 'Node', name: oomNode, uid: `oom-${oomNode}`, host: oomNode }), evEntry(t, 'BackOff', backoff, { uid: 'b1', host: 'node-1' })] }).incidents.find((i) => i.kind === 'crash');
  assert.equal(crashOn('node-1').title, 'brand restarted (out of memory)');
  assert.equal(crashOn('node-1').severity, 'critical');
  assert.equal(crashOn('node-2').title, 'brand restarted (crash loop)', 'a kill on another node is someone else\'s');
});

test('one crash loop split between two days of reads is one record', () => {
  const a = { id: 'logs:p/c:1', pod: 'p', container: 'c', reason: 'CrashLoopBackOff', at: T0 - DAY + 5 * MIN, until: T0 - DAY + 20 * MIN, times: 3, message: 'newer' };
  const b = { id: 'logs:p/c:2', pod: 'p', container: 'c', reason: 'OOMKilled', at: T0 - DAY - 20 * MIN, until: T0 - DAY - MIN, times: 2, message: 'Memory cgroup out of memory' };
  const other = { id: 'logs:q/c:3', pod: 'q', container: 'c', reason: 'CrashLoopBackOff', at: T0 - DAY, until: T0 - DAY, times: 1 };
  const merged = mergeCrashRecords(mergeCrashRecords([], [a]), [b, other]);
  assert.equal(merged.length, 2);
  const one = merged.find((c) => c.pod === 'p');
  assert.deepEqual([one.id, one.at, one.until, one.times, one.reason, one.message], ['logs:p/c:1', b.at, a.until, 5, 'OOMKilled', 'Memory cgroup out of memory']);
});

test('an Event exported again as its count went up is one row, with its first time and latest count', () => {
  const rows = [1, 2, 3].map((count) => eventFromLogs(evEntry(T0 - DAY + count * MIN, 'Unhealthy', 'Readiness probe failed', { uid: 'u1', count })));
  const [row, ...rest] = collapseEvents(rows);
  assert.equal(rest.length, 0);
  assert.deepEqual([row.id, row.count, row.at, row.firstAt, row.kind, row.name, row.fromLogs], ['u1', 3, T0 - DAY + 3 * MIN, T0 - DAY + MIN, 'Pod', POD, true]);
});

// ── The load, through LiveConnector ─────────────────────────────────────────
const kindOf = (filter) => (filter.includes('logs/events') ? 'events' : filter.includes('http_load_balancer') ? 'failed' : filter.includes('cloudsql_database') ? 'sql' : filter.includes('severity>=ERROR') ? 'errors' : 'logs');
const rangeOf = (filter) => {
  const m = /timestamp>="([^"]+)" AND timestamp<"([^"]+)"/.exec(filter);
  return [Date.parse(m[1]), Date.parse(m[2])];
};

/** A LoggingClient stand-in: `respond(kind, from, until, max, call)` gives the entries (newest first). */
function fakeLogging(respond = () => []) {
  const calls = [];
  return {
    calls,
    listAll: async (a) => {
      const [from, until] = rangeOf(a.filter);
      const q = { ...a, kind: kindOf(a.filter), from, until };
      calls.push(q);
      return respond(q);
    },
  };
}

function connector({ logging, now = T0, cache = {}, email = 'pulse@flobi-prod-2026.iam.gserviceaccount.com', settings = {} } = {}) {
  const clock = { now };
  const sent = [];
  const p = new Pipeline({ namespace: 'flobi', emit: () => {}, mode: 'live', now: () => clock.now, notify: (a) => sent.push(a) });
  const c = new LiveConnector({ config: { namespace: 'flobi', projectId: 'flobi-prod-2026', cluster: { name: 'flobi-cluster' } }, auth: { identity: { email }, getToken: async () => 'token' }, pipeline: p, settings, pastReadGapMs: 0, pastWeekCache: cache });
  c.logging = logging;
  return { p, c, sent, clock };
}

test('LiveConnector: the past week loads newest first, in capped background reads, and nothing notifies', async () => {
  const busyDay = [T0 - 3 * DAY, T0 - 2 * DAY];
  const logging = fakeLogging(({ kind, from, until, max }) => {
    if (kind === 'logs') return [errEntry(T0 - MIN, 'second', { severity: 'INFO' }), errEntry(T0 - 5 * MIN, 'first', { severity: 'INFO' })];
    if (kind === 'errors' && from === busyDay[0]) return Array.from({ length: max }, (_, i) => errEntry(until - (i + 1) * 60_000, nest('Transcode job 48z6f5wv62 failed: ffmpeg exited with code 1')));
    if (kind === 'errors') return [errEntry(until - HOUR, nest('Folder fd_ppfzbts5zj not found'))];
    if (kind === 'events' && from === T0 - 5 * DAY) return Object.defineProperty([], 'truncated', { value: true });
    if (kind === 'events' && from === T0 - DAY) return [evEntry(T0 - 3 * HOUR, 'BackOff', `Back-off restarting failed container flobi-brand in pod ${POD}_flobi(abc)`)];
    if (kind === 'failed' && from === T0 - DAY) return Array.from({ length: 30 }, (_, i) => lb5xx(T0 - 2 * HOUR + i * 5_000));
    return [];
  });
  const { p, c, sent } = connector({ logging });
  try {
    await c.loadPastWeek({ now: T0 });
    const { calls } = logging;
    assert.equal(calls.length, 23, '7 days × (errors, events, failed requests) + Postgres errors + the Logs page');
    assert.deepEqual([calls[0].kind, calls[0].from, calls[0].until, calls[0].max], ['logs', T0 - 15 * MIN, T0, 500]);
    assert.deepEqual([calls[1].kind, calls[1].from, calls[1].until, calls[1].max], ['sql', T0 - 7 * DAY, T0, 1000]);
    const days = calls.slice(2);
    assert.deepEqual(days.slice(0, 3).map((q) => [q.kind, q.from, q.until, q.max]), [
      ['errors', T0 - DAY, T0, 1000],
      ['events', T0 - DAY, T0, 1000],
      ['failed', T0 - DAY, T0, 1000],
    ], 'the last 24 hours first');
    for (let i = 3; i < days.length; i += 3) {
      assert.ok(days[i].until === days[i - 3].from, 'then day by day, newest first');
      assert.equal(days[i + 1].max, PAST_CAPS.eventsOlder);
    }
    assert.equal(days[days.length - 1].from, T0 - 7 * DAY);
    assert.ok(calls.every((q) => q.priority === 'background' && q.orderBy === 'timestamp desc' && q.pageSize === q.max && q.max <= 1000 && q.maxPages <= 3));
    assert.match(calls[0].filter, /resource\.labels\.cluster_name="flobi-cluster"/);
    assert.doesNotMatch(calls[0].filter, /severity>=WARNING/, 'like the live stream: info lines included');

    assert.equal(sent.length, 0);
    assert.equal(p.alerts.active.size, 0);
    const b = p.section('backfill');
    assert.deepEqual([b.status, b.since, b.until], ['done', T0 - 7 * DAY, T0]);
    assert.deepEqual(b.notes, [
      { kind: 'errors', from: busyDay[0], until: busyDay[1], busy: true, n: 1000 },
      { kind: 'events', from: T0 - 5 * DAY, until: T0 - 4 * DAY, slow: true },
    ]);
    const transcode = p.section('errors').backend.find((g) => g.title.startsWith('Transcode'));
    assert.equal(transcode.count, 1000, 'the most recent 1,000 of that busy day');
    assert.deepEqual(p.section('logsBefore').lines.map((l) => l.text), ['first', 'second'], 'oldest first, before the live lines');
    assert.equal(p.section('crashes')[0].reason, 'CrashLoopBackOff');
    assert.ok(p.section('alerts').history.some((a) => a.fromLogs && a.title === 'gateway: 30 failed requests'));
  } finally {
    c.stop();
    p.destroy();
  }
});

test('LiveConnector: a restart reuses what the last run read and only reads the gap; another account starts over', async () => {
  const cache = {};
  const respond = ({ kind, until }) => (kind === 'errors' ? [errEntry(until - HOUR, nest('Folder fd_ppfzbts5zj not found'))] : []);
  const first = connector({ logging: fakeLogging(respond), cache });
  await first.c.loadPastWeek({ now: T0 });
  first.c.stop();
  first.p.destroy();

  const logging = fakeLogging(respond);
  const later = T0 + 2 * HOUR;
  const second = connector({ logging, cache, now: later });
  try {
    await second.c.loadPastWeek({ now: later });
    assert.deepEqual(logging.calls.map((q) => [q.kind, q.from, q.until]), [
      ['logs', later - 15 * MIN, later],
      ['sql', T0, later],
      ['errors', T0, later],
      ['events', T0, later],
      ['failed', T0, later],
    ]);
    assert.equal(second.p.section('errors').backend[0].count, 8, '7 days from the first run, and the gap');
    assert.equal(second.p.section('backfill').status, 'done');
    assert.equal(second.sent.length, 0);
  } finally {
    second.c.stop();
    second.p.destroy();
  }

  const other = fakeLogging(respond);
  const third = connector({ logging: other, cache, now: later, email: 'someone-else@other.iam.gserviceaccount.com' });
  try {
    await third.c.loadPastWeek({ now: later });
    assert.equal(other.calls.length, 23);
  } finally {
    third.c.stop();
    third.p.destroy();
  }
});

test('LiveConnector: a failed read ends the load with the reason; what came in before stays; no Logs Viewer role is not retried', async () => {
  const logging = fakeLogging(({ kind, from }) => {
    if (kind === 'errors' && from === T0 - 2 * DAY) throw Object.assign(new Error('HTTP 403: The caller does not have permission'), { status: 403 });
    return kind === 'errors' ? [errEntry(T0 - HOUR, nest('Folder fd_ppfzbts5zj not found'))] : [];
  });
  const { p, c, sent } = connector({ logging });
  const later = [];
  c.later = (ms) => later.push(ms);
  try {
    await c.loadPastWeek({ now: T0 });
    const b = p.section('backfill');
    assert.deepEqual([b.status, b.since, b.error], ['error', T0 - DAY, "the service account can't read logs (it needs the Logs Viewer role, see SETUP.md)."]);
    assert.equal(p.section('errors').backend.length, 1);
    assert.equal(p.section('errors').since, T0 - DAY);
    assert.equal(sent.length, 0);
    assert.deepEqual(later, [], 'the same answer next time: not tried again');
  } finally {
    c.stop();
    p.destroy();
  }
});

test('LiveConnector: a load Google cut short tries again a few minutes later, reading only what is missing', async () => {
  let busy = true;
  const logging = fakeLogging(({ kind, from }) => {
    if (busy && kind === 'events' && from === T0 - 3 * DAY) throw Object.assign(new Error('Google is limiting log reads for this project right now.'), { status: 429 });
    return kind === 'errors' ? [errEntry(from + MIN, nest('Folder fd_ppfzbts5zj not found'))] : [];
  });
  const { p, c, sent, clock } = connector({ logging });
  const retries = [];
  c.later = (ms, fn) => retries.push({ ms, fn });
  try {
    await c.loadPastWeek({ now: T0 });
    const b = p.section('backfill');
    assert.equal(b.status, 'error');
    assert.match(b.error, /It tries again in 3 minutes\.$/);
    assert.equal(retries.length, 1);
    assert.equal(retries[0].ms, 3 * MIN);
    busy = false;
    const before = logging.calls.length;
    clock.now = T0 + 3 * MIN;
    await c.loadPastWeek({ now: clock.now, attempt: 1 });
    const again = logging.calls.slice(before);
    assert.deepEqual(again.map((q) => q.kind), ['logs', 'sql', 'errors', 'events', 'failed', ...Array(5 * 3).fill(0).map((_, i) => ['errors', 'events', 'failed'][i % 3])], 'the gap, then the four days it never got to');
    assert.deepEqual([again[2].from, again[2].until], [T0, T0 + 3 * MIN]);
    assert.equal(again[5].until, T0 - 2 * DAY, 'older days pick up where the first load stopped');
    assert.equal(p.section('backfill').status, 'done');
    assert.equal(p.section('errors').backend[0].count, 8, 'two days from the first try, the gap, and the five days left');
    assert.equal(sent.length, 0);
  } finally {
    c.stop();
    p.destroy();
  }
});

test('LiveConnector: stopping (a restart, a sign-out) stops the reads', async () => {
  let c;
  const logging = fakeLogging(({ kind }) => {
    if (kind === 'sql') c.stop();
    return [];
  });
  const made = connector({ logging });
  c = made.c;
  try {
    await c.loadPastWeek({ now: T0 });
    assert.deepEqual(logging.calls.map((q) => q.kind), ['logs', 'sql']);
  } finally {
    made.p.destroy();
  }
});

test('LiveConnector: without info lines in the live stream, the Logs page gets none from before it either', async () => {
  const logging = fakeLogging();
  const { p, c } = connector({ logging, settings: { general: { liveIncludesInfoLogs: false } } });
  try {
    await c.loadPastWeek({ now: T0 });
    assert.match(logging.calls[0].filter, /severity>=WARNING/);
  } finally {
    c.stop();
    p.destroy();
  }
});

test('the load itself: day slices, and what an earlier run read is shown before any read', async () => {
  assert.deepEqual(daySlices(T0 - 2.5 * DAY, T0), [
    { from: T0 - DAY, until: T0 },
    { from: T0 - 2 * DAY, until: T0 - DAY },
    { from: T0 - 2.5 * DAY, until: T0 - 2 * DAY },
  ]);
  const order = [];
  const cache = { key: 'k', slices: [{ from: T0 - DAY, until: T0 - 30_000, errors: [], events: [], crashes: [], incidents: [], notes: [] }] };
  await loadPastWeek({
    now: T0,
    key: 'k',
    cache,
    days: 1,
    read: async (q) => (order.push(`read ${q.kind}`), []),
    process: (raw) => ({ ...raw, errors: [], events: [], crashes: [], incidents: [] }),
    onSlice: (s) => order.push(`slice ${s.until === T0 - 30_000 ? 'cached' : 'new'}`),
    onStatus: (s) => order.push(s.status),
  });
  assert.deepEqual(order, ['loading', 'slice cached', 'done'], 'less than a minute since the last read: nothing to read');
});

test('what a count covers, in words', () => {
  assert.equal(coverage(T0 - 7 * DAY, T0).label, 'in 7 days');
  assert.equal(coverage(T0 - 7 * DAY, T0).sentence, 'in the last 7 days');
  const since = new Date(T0 - 2 * HOUR);
  const hm = `${String(since.getHours()).padStart(2, '0')}:${String(since.getMinutes()).padStart(2, '0')}`;
  assert.match(coverage(T0 - 2 * HOUR, T0).label, new RegExp(`^since (yesterday )?${hm}$`));
  assert.equal(coverage(null, T0).label, '');
});
