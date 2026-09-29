// Alerting behaviour: hysteresis, notifications, the siren, mutes and the
// model rules behind the alerts. Fake clocks throughout, no sleeping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AlertBook, evaluateConditions } from '../electron/core/engine/alerts.mjs';
import { Alarm } from '../electron/core/engine/alarm.mjs';
import { serviceCopy, memText } from '../electron/core/engine/alert-copy.mjs';
import { buildModel, bytes, slim } from '../electron/core/engine/model.mjs';
import { Pipeline } from '../electron/core/engine/pipeline.mjs';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const T0 = Date.UTC(2026, 8, 28, 12, 0);
const HASH = '7d9f8c6b5';
const iso = (ms) => new Date(ms).toISOString();

/** A Deployment's pod, shaped like the Kubernetes API returns it. */
function pod(name, { app = 'flobi-brand', phase = 'Running', ready = true, waiting, terminated, reason, createdAt = T0 - 60 * MIN, finishedAt, restarts = 0, owner, containers, specContainers } = {}) {
  const state = waiting ? { waiting: { reason: waiting } } : terminated ? { terminated: { reason: terminated, exitCode: terminated === 'Completed' ? 0 : 1, finishedAt: iso(finishedAt ?? createdAt) } } : { running: { startedAt: iso(createdAt) } };
  return {
    metadata: { name, uid: name, labels: { app, 'pod-template-hash': HASH }, ownerReferences: [owner || { kind: 'ReplicaSet', name: `${app}-${HASH}` }], creationTimestamp: iso(createdAt) },
    spec: { nodeName: 'n1', containers: specContainers || [{ name: app, resources: { limits: { memory: '512Mi' } } }] },
    status: {
      phase,
      reason,
      startTime: iso(createdAt),
      conditions: [{ type: 'Ready', status: ready ? 'True' : 'False', lastTransitionTime: iso(finishedAt ?? createdAt) }],
      containerStatuses: containers || [{ name: app, ready, restartCount: restarts, state, lastState: {} }],
    },
  };
}

const dep = (name, replicas, ready = replicas, status = {}) => ({
  metadata: { name, uid: name, generation: 1 },
  spec: { replicas, selector: { matchLabels: { app: name } }, containers: [{ name, resources: { limits: { memory: '512Mi' } } }] },
  status: { replicas, readyReplicas: ready, updatedReplicas: replicas, availableReplicas: ready, observedGeneration: 1, ...status },
});

const cond = (key, severity, extra = {}) => ({ key, kind: 'service', service: 'x', severity, title: `${key} is ${severity}`, ...extra });

function book(opts = {}) {
  const clock = { now: T0 };
  const opened = [];
  const resolved = [];
  const b = new AlertBook({ now: () => clock.now, onOpen: (a, meta) => opened.push({ id: a.id, key: a.key, severity: a.severity, ...meta }), onResolve: (a) => resolved.push(a), ...opts });
  return { b, clock, opened, resolved };
}

function pipeline(extra = {}) {
  const clock = { now: T0 };
  const sent = [];
  const p = new Pipeline({ namespace: 'flobi', emit: () => {}, mode: 'demo', now: () => clock.now, notify: (a, meta) => sent.push({ a, meta }), ...extra });
  return { p, clock, sent };
}

// ── A1: hysteresis ──────────────────────────────────────────────────────────
test('A1: a condition that flickers stays one alert with one notification', () => {
  const { b, clock, opened, resolved } = book();
  const c = cond('svc-down:x', 'critical');
  b.reconcile([c]);
  const id = b.active.get('svc-down:x').id;
  for (let i = 0; i < 10; i++) {
    // gone for one evaluation, back for the next, for well over a minute
    clock.now += 5_000;
    b.reconcile([]);
    const s = b.summary();
    assert.equal(s.active.length, 1, 'it stays open while clearing');
    assert.equal(s.active[0].clearing, true);
    assert.equal(s.active[0].clearingSince, clock.now);
    assert.equal(s.counts.critical, 0, 'a clearing alert is not counted');
    clock.now += 5_000;
    b.reconcile([c]);
    assert.equal(b.summary().active[0].clearing, false);
    assert.equal(b.summary().counts.critical, 1);
  }
  assert.equal(opened.length, 1, 'no new notification when it comes back within the hold');
  assert.equal(b.active.get('svc-down:x').id, id, 'the same alert carries on');
  assert.equal(resolved.length, 0);
});

test('A1: an alert resolves only once its condition stayed gone for the hold (60 s; 120 s for 5xx and error spikes)', () => {
  const { b, clock, resolved } = book();
  b.reconcile([cond('svc-down:x', 'critical'), cond('http5xx:x', 'warning', { holdMs: 2 * MIN })]);
  clock.now += 5_000;
  b.reconcile([]);
  const gone = clock.now;
  clock.now += 59_000;
  b.reconcile([]);
  assert.equal(resolved.length, 0);
  assert.equal(b.active.get('svc-down:x').clearingSince, gone);
  clock.now += 1_000;
  b.reconcile([]);
  assert.deepEqual(resolved.map((a) => a.key), ['svc-down:x']);
  assert.equal(resolved[0].resolvedAt, gone, 'fixed as of when the problem went away');
  clock.now += 59_000;
  b.reconcile([]);
  assert.equal(resolved.length, 1, 'the 5xx alert holds for 2 minutes');
  clock.now += 1_000;
  b.reconcile([]);
  assert.deepEqual(resolved.map((a) => a.key), ['svc-down:x', 'http5xx:x']);
  assert.equal(b.active.size, 0);
  assert.deepEqual(b.summary().recent.map((a) => a.key), ['http5xx:x', 'svc-down:x']);
});

test('A1: coming back within the hold keeps the acknowledgement; after it resolved it is a new alert, still silenced for 30 min', () => {
  const { b, clock, opened } = book();
  const c = cond('pod:p1', 'critical');
  b.reconcile([c]);
  const first = b.active.get('pod:p1');
  b.ack(first.id);
  clock.now += 5_000;
  b.reconcile([]);
  clock.now += 30_000;
  b.reconcile([c]);
  assert.equal(b.active.get('pod:p1'), first);
  assert.equal(first.acked, true, 'Silence stays silenced');
  assert.equal(first.clearingSince, null);
  assert.equal(opened.length, 1);
  clock.now += 5_000;
  b.reconcile([]);
  clock.now += 60_000;
  b.reconcile([]);
  assert.equal(b.active.size, 0);
  clock.now += 5_000;
  b.reconcile([c]);
  assert.equal(opened.length, 2);
  assert.notEqual(b.active.get('pod:p1').id, first.id, 'a new alert');
  assert.equal(opened[1].silenced, true, 'but the same problem, fixed for less than 30 min: it opens silenced');
  assert.equal(b.active.get('pod:p1').acked, true);
  b.reconcile([]);
  const fixed = clock.now;
  clock.now = fixed + 30 * MIN - 1;
  b.reconcile([]);
  assert.equal(b.active.size, 0);
  assert.deepEqual([...b.silenced.keys()], ['key:pod:p1', 'x'], 'not quite 30 minutes: the problem and its service');
  clock.now = fixed + 30 * MIN;
  b.reconcile([c]);
  assert.equal(opened[2].silenced, false, 'fixed for 30 min: a new incident is news again');
});

test('A1: escalation notifies only above the peak; dropping back never does', () => {
  const { b, clock, opened } = book();
  b.reconcile([cond('http5xx:x', 'warning')]);
  const a = b.active.get('http5xx:x');
  b.ack(a.id);
  clock.now += 5_000;
  b.reconcile([cond('http5xx:x', 'critical')]);
  assert.deepEqual(opened.map((o) => [o.severity, o.escalated]), [['warning', false], ['critical', true]]);
  assert.equal(a.acked, false, 'getting worse needs a new look');
  assert.equal(a.peak, 'critical');
  b.ack(a.id);
  for (const sev of ['warning', 'critical', 'warning', 'critical', 'warning']) {
    clock.now += 5_000;
    b.reconcile([cond('http5xx:x', sev)]);
  }
  assert.equal(opened.length, 2, 'back and forth up to the peak is not news');
  assert.equal(a.acked, true);
  const s = b.summary().active[0];
  assert.equal(s.severity, 'warning');
  assert.equal(s.peak, 'critical');
  // A condition that returns from clearing higher than ever is news, though.
  const { b: b2, clock: c2, opened: o2 } = book();
  b2.reconcile([cond('node-down:n1', 'warning')]);
  c2.now += 5_000;
  b2.reconcile([]);
  c2.now += 5_000;
  b2.reconcile([cond('node-down:n1', 'critical')]);
  assert.deepEqual(o2.map((o) => [o.severity, o.escalated]), [['warning', false], ['critical', true]]);
});

test('A1: a crash-looping pod (Error → CrashLoopBackOff ↔ Running/NotReady) is one alert, silenced for good', () => {
  const { b, clock, opened } = book();
  const name = `flobi-brand-${HASH}-bbbbb`;
  const deployments = [dep('flobi-brand', 2, 1)];
  const healthy = pod(`flobi-brand-${HASH}-aaaaa`);
  const step = (status) => {
    const p = status === 'NotReady' ? pod(name, { ready: false }) : status === 'Error' ? pod(name, { ready: false, terminated: 'Error', finishedAt: clock.now }) : pod(name, { ready: false, waiting: status });
    const model = buildModel({ deployments, pods: [healthy, p] }, { now: clock.now });
    b.reconcile(evaluateConditions({ model, now: clock.now }));
    clock.now += 15_000;
  };
  step('Error');
  step('CrashLoopBackOff');
  const alert = b.active.get(`pod:${name}`);
  assert.equal(alert.severity, 'critical');
  b.ack(alert.id); // the Silence button
  for (let i = 0; i < 8; i++) for (const s of ['NotReady', 'Error', 'CrashLoopBackOff']) step(s);
  const podOpens = opened.filter((o) => o.key === `pod:${name}`);
  assert.deepEqual(podOpens.map((o) => [o.severity, o.escalated]), [['warning', false], ['critical', true]], 'opened once, escalated once');
  assert.equal(opened.filter((o) => o.key === 'svc-degraded:flobi-brand').length, 1);
  assert.equal(b.active.get(`pod:${name}`), alert);
  assert.equal(alert.acked, true, "doesn't ring again after Silence");
});

test('A1: through the pipeline a crash loop sends one notification, however many restarts pile up', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { p, clock, sent } = pipeline({ graceMs: 1000 });
  try {
    const name = `flobi-brand-${HASH}-bbbbb`;
    const healthy = pod(`flobi-brand-${HASH}-aaaaa`);
    p.setK8s('deployments', [dep('flobi-brand', 2, 2)]);
    p.setK8s('pods', [healthy, pod(name)]);
    t.mock.timers.tick(1000); // the startup grace period ends with nothing wrong
    let restarts = 0;
    const step = (ms, crashing) => {
      clock.now += ms;
      if (crashing) restarts++;
      const cs = [{ name: 'flobi-brand', ready: false, restartCount: restarts, state: crashing ? { waiting: { reason: 'CrashLoopBackOff' } } : { running: { startedAt: iso(clock.now) } }, lastState: { terminated: { reason: 'OOMKilled', exitCode: 137, finishedAt: iso(clock.now) } } }];
      p.setK8s('deployments', [dep('flobi-brand', 2, 1)]);
      p.setK8s('pods', [healthy, pod(name, { ready: false, containers: cs })]);
      t.mock.timers.tick(3000); // rebuild, then the 2.5 s notification bucket
    };
    for (let i = 0; i < 8; i++) {
      step(15_000, true);
      step(20_000, false);
    }
    assert.equal(sent.length, 1, sent.map((s) => s.a.title).join(' | '));
    const keys = [sent[0].a.key, ...sent[0].meta.related.map((r) => r.key)].sort();
    assert.deepEqual(keys, [`crash:${name}/flobi-brand`, `pod:${name}`, 'svc-degraded:flobi-brand']);
    assert.equal(sent[0].a.severity, 'critical');
    assert.equal(p.alerts.active.get(`crash:${name}/flobi-brand`).count, 8, 'restarts count up on one alert');
    assert.equal(p.crashes.length, 8, 'every restart is still listed');
  } finally {
    p.destroy();
  }
});

test('A1: an alert that cleared before its notification went out is announced only if it comes back', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { p, clock, sent } = pipeline({ graceMs: 1000 });
  try {
    const up = [dep('flobi-director', 1, 1)];
    const down = [dep('flobi-director', 1, 0)];
    p.setK8s('deployments', up);
    p.setK8s('pods', []);
    t.mock.timers.tick(1000);
    clock.now += 5_000;
    p.setK8s('deployments', down);
    t.mock.timers.tick(300);
    const alert = p.alerts.active.get('svc-down:flobi-director');
    assert.ok(alert);
    clock.now += 1_000;
    p.setK8s('deployments', up);
    t.mock.timers.tick(300);
    t.mock.timers.tick(2500);
    assert.equal(sent.length, 0, 'a blip that went away is not announced');
    clock.now += 20_000;
    p.setK8s('deployments', down);
    t.mock.timers.tick(300);
    t.mock.timers.tick(2500);
    assert.equal(sent.length, 1, 'it came back: now it is news');
    assert.equal(sent[0].a.id, alert.id);
    assert.equal(p.unsent.size, 0);
  } finally {
    p.destroy();
  }
});

// ── A2: mutes ───────────────────────────────────────────────────────────────
test('A2: alerts without a service mute by key; service mutes keep working', () => {
  const { b, clock } = book();
  const node = { key: 'node-down:n1', kind: 'node', severity: 'critical', title: 'Node n1 is down' };
  const svc = cond('svc-down:flobi-brand', 'critical', { service: 'flobi-brand' });
  b.reconcile([node, svc, cond('cert:c1', 'warning', { service: undefined })]);
  let s = b.summary();
  const by = (k) => s.active.find((a) => a.key === k);
  assert.equal(by('node-down:n1').muteTarget, 'key:node-down:n1');
  assert.equal(by('svc-down:flobi-brand').muteTarget, 'flobi-brand');
  assert.ok(s.history.every((a) => a.muteTarget));
  b.mute('key:node-down:n1', 30);
  s = b.summary();
  assert.equal(by('node-down:n1').muted, true);
  assert.equal(by('cert:c1').muted, false);
  assert.equal(by('svc-down:flobi-brand').muted, false);
  assert.equal(s.history.find((a) => a.key === 'node-down:n1').muted, true);
  assert.deepEqual(s.muted, { 'key:node-down:n1': T0 + 30 * MIN });
  b.mute('flobi-brand', 60); // what older callers send
  assert.equal(b.isMuted(b.active.get('svc-down:flobi-brand')), true);
  assert.equal(b.summary().active.find((a) => a.key === 'svc-down:flobi-brand').muted, true);
  // The summary is cached, but a mute running out still shows.
  clock.now += 31 * MIN;
  s = b.summary();
  assert.equal(by('node-down:n1').muted, false);
  assert.deepEqual(Object.keys(s.muted), ['flobi-brand']);
  b.mute('flobi-brand', 0);
  assert.equal(b.isMuted(b.active.get('svc-down:flobi-brand')), false);
  // Resolved alerts carry the target too.
  b.reconcile([]);
  clock.now += 2 * MIN;
  b.reconcile([]);
  assert.deepEqual(b.summary().recent.map((a) => a.muteTarget).sort(), ['flobi-brand', 'key:cert:c1', 'key:node-down:n1']);
});

// ── A3: Sentry ──────────────────────────────────────────────────────────────
test('A3: Sentry alerts once when an issue turns regressed or escalating, not on every poll', () => {
  const { p, clock } = pipeline();
  try {
    const issue = (id, substatus, firstAgo = 3 * DAY) => ({ id, project: 'flobi-flow', title: `Error ${id}`, level: 'error', substatus, firstSeen: clock.now - firstAgo, lastSeen: clock.now, users: 2 });
    const sentry = () => p.alerts.history.filter((a) => a.key.startsWith('sentry'));
    const poll = (...issues) => {
      clock.now += MIN;
      p.setSentry({ issues, status: 'ok' });
    };
    p.setSentry({ issues: [issue('1', 'regressed'), issue('2', 'ongoing'), issue('3', 'escalating')] });
    assert.equal(sentry().length, 0, 'the first poll only primes');
    for (let i = 0; i < 40; i++) poll(issue('1', 'regressed'), issue('2', 'ongoing'), issue('3', 'escalating'));
    p.rebuild(); // one-shot alerts expire after 30 min; nothing may reopen them
    assert.equal(sentry().length, 0, 'already regressed/escalating when the app opened: not news');
    poll(issue('1', 'regressed'), issue('2', 'escalating'), issue('3', 'escalating'));
    assert.deepEqual(sentry().map((a) => a.key), ['sentry-escalating:2']);
    for (let i = 0; i < 40; i++) {
      poll(issue('1', 'regressed'), issue('2', 'escalating'), issue('3', 'escalating'));
      if (i === 35) p.rebuild();
    }
    assert.equal(sentry().length, 1, 'no re-alert every 31 minutes');
    assert.equal(sentry()[0].count, 1, "unchanged polls don't count up");
    // An issue that was resolved (so missing from the unresolved list) and is back.
    poll(issue('1', 'regressed'), issue('2', 'escalating'), issue('3', 'escalating'), issue('4', 'regressed'));
    assert.deepEqual(sentry().map((a) => a.key), ['sentry-regressed:4', 'sentry-escalating:2']);
    // A failed poll (no issues in it) changes nothing.
    p.setSentry({ status: 'error', message: 'timeout' });
    poll(issue('1', 'regressed'), issue('2', 'escalating'), issue('3', 'escalating'), issue('4', 'regressed'));
    assert.equal(sentry().length, 2);
  } finally {
    p.destroy();
  }
});

// ── A4: the siren ───────────────────────────────────────────────────────────
function siren({ maxMs = 10 * MIN } = {}) {
  let now = 0;
  const timers = [];
  const played = [];
  const open = new Set();
  const alarm = new Alarm({
    play: (k) => played.push([k, now]),
    stillRinging: (id) => open.has(id),
    repeatMs: 20_000,
    maxMs,
    now: () => now,
    setTimer: (fn, ms) => {
      const tm = { fn, at: now + ms, done: false };
      timers.push(tm);
      return tm;
    },
    clearTimer: (tm) => tm && (tm.done = true),
  });
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      const next = timers.filter((tm) => !tm.done && tm.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      now = next.at;
      next.done = true;
      next.fn();
    }
    now = end;
  };
  const sirens = () => played.filter(([k]) => k === 'critical').map(([, at]) => at);
  return { alarm, open, advance, sirens };
}

test('A4: each critical alert rings at most 10 min from its own first ring; a second one at 9 min only covers itself', () => {
  const { alarm, open, advance, sirens } = siren();
  open.add('a');
  open.add('b');
  alarm.ring(['a']);
  advance(9 * MIN);
  alarm.ring(['b']);
  assert.deepEqual(alarm.state(), { ringing: true, audible: true, ids: ['a', 'b'], since: 0, quietUntil: null });
  advance(MIN + 1);
  assert.deepEqual(alarm.state(), { ringing: true, audible: true, ids: ['b'], since: 9 * MIN, quietUntil: null }, 'a rang its 10 minutes');
  alarm.ring(['a']); // a new notification for a doesn't give it another 10 minutes
  assert.deepEqual(alarm.state().ids, ['b']);
  advance(9 * MIN);
  assert.equal(alarm.ringing, false, 'b rang its 10 minutes too');
  assert.equal(alarm.state().since, null);
  assert.ok(Math.max(...sirens()) < 19 * MIN);
  advance(30 * MIN);
  assert.ok(Math.max(...sirens()) < 19 * MIN);
});

test('A4: a flapping critical alert rung again and again still stops after 10 minutes', () => {
  const { alarm, open, advance, sirens } = siren();
  open.add('a');
  alarm.ring(['a']);
  for (let i = 0; i < 15; i++) {
    advance(MIN);
    alarm.ring(['a']);
  }
  assert.equal(alarm.ringing, false);
  assert.ok(Math.max(...sirens()) < 10 * MIN);
  assert.ok(sirens().length >= 29, 'it did ring every 20 s until then');
});

// ── A5: related alerts ──────────────────────────────────────────────────────
test('A5: one notification per service, with the other alerts as meta.related', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { p, sent } = pipeline({ graceMs: 1000 });
  try {
    p.setK8s('pods', []);
    t.mock.timers.tick(1000);
    p.alerts.happen({ key: 'newerr:g1', kind: 'errors', service: 'flobi-brand', severity: 'warning', title: 'New error in brand' });
    p.alerts.happen({ key: 'crash:p/c', kind: 'crash', service: 'flobi-brand', severity: 'critical', title: 'brand crashed and restarted', detail: 'exit 1' });
    p.alerts.happen({ key: 'pod:p', kind: 'pod', service: 'flobi-brand', severity: 'critical', title: 'brand: a pod keeps crashing' });
    p.alerts.happen({ key: 'node-down:n1', kind: 'node', severity: 'critical', title: 'Node n1 is down' });
    t.mock.timers.tick(2500);
    assert.equal(sent.length, 2);
    const brand = sent.find((s) => s.a.service === 'flobi-brand');
    assert.equal(brand.a.key, 'crash:p/c', 'the worst alert leads, a crash first');
    assert.equal(brand.a.detail, 'exit 1 · +2 related alerts');
    assert.deepEqual(brand.meta.related.map((a) => a.key), ['pod:p', 'newerr:g1']);
    assert.ok(brand.meta.related.every((a) => p.alerts.active.get(a.key) === a), 'the real alert objects, so their ids can ring');
    assert.equal(brand.meta.muted, false);
    const node = sent.find((s) => s.a.key === 'node-down:n1');
    assert.deepEqual(node.meta.related, []);
  } finally {
    p.destroy();
  }
});

test('A5: the startup summary stays a summary and lists every open problem as related', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { p, clock, sent } = pipeline({ graceMs: 1000 });
  try {
    p.setK8s('deployments', [dep('flobi-director', 1, 0)]);
    p.setK8s('pods', []); // the startup grace period starts
    t.mock.timers.tick(300); // director is down while starting up…
    clock.now += 5_000;
    p.setK8s('deployments', [dep('flobi-director', 1, 1)]);
    t.mock.timers.tick(300); // …and fine again (clearing) when the summary goes out
    p.alerts.happen({ key: 'crash:a/b', kind: 'crash', service: 'flobi-brand', severity: 'critical', title: 'brand crashed' });
    p.alerts.happen({ key: 'node-down:n1', kind: 'node', severity: 'warning', title: 'Node n1 is not ready' });
    t.mock.timers.tick(400);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].a.summary, true);
    assert.equal(sent[0].a.severity, 'critical');
    assert.equal(sent[0].a.title, '2 active problems');
    assert.deepEqual(sent[0].meta.related.map((a) => a.key).sort(), ['crash:a/b', 'node-down:n1']);
    // What was clearing at startup is announced if it comes back.
    clock.now += 10_000;
    p.setK8s('deployments', [dep('flobi-director', 1, 0)]);
    t.mock.timers.tick(300);
    t.mock.timers.tick(2500);
    assert.deepEqual(sent.map((s) => s.a.key ?? s.a.id), ['startup-summary', 'svc-down:flobi-director']);
  } finally {
    p.destroy();
  }
});

// ── A6: 5xx thresholds ──────────────────────────────────────────────────────
test('A6: 5xx alerts need several failures: 1/20 nothing, 5/50 warning, 10/60 critical', () => {
  const run = (err5xx2m, total2m) => evaluateConditions({ model: {}, traffic: { byService: [{ service: 'flobi-gateway', total2m, err5xx2m }] }, now: T0 }).filter((c) => c.kind === 'http');
  assert.equal(run(1, 20).length, 0, 'one failed request is not an incident');
  assert.equal(run(4, 20).length, 0, '20%, but only 4 failures');
  assert.equal(run(5, 19).length, 0, 'too few requests to tell');
  const w = run(5, 50);
  assert.equal(w.length, 1);
  assert.equal(w[0].severity, 'warning');
  assert.equal(w[0].holdMs, 2 * MIN);
  assert.equal(run(10, 200)[0].severity, 'warning', '10 failures but only 5% of traffic');
  const c = run(10, 60);
  assert.equal(c[0].severity, 'critical');
  assert.equal(c[0].title, 'gateway: 17% of requests are failing');
  assert.equal(c[0].holdMs, 2 * MIN);
  const spike = evaluateConditions({ model: {}, errorRates: { 'flobi-brand': { now: 60, baseline: 2 }, 'flobi-drive': { now: 12, baseline: 12 } }, now: T0 });
  assert.deepEqual(spike.map((x) => [x.key, x.holdMs]), [['errspike:flobi-brand', 2 * MIN]]);
});

// ── A7: scale-up from zero ──────────────────────────────────────────────────
test('A7: a workload scaled up from zero is starting, not down; still no ready pod after 10 min is down', () => {
  const { p, clock } = pipeline();
  try {
    const svc = () => p.model.services.find((s) => s.name === 'flobi-media-worker');
    p.raw.hpas = [{ metadata: { name: 'flobi-media-worker' }, spec: { scaleTargetRef: { kind: 'Deployment', name: 'flobi-media-worker' }, minReplicas: 0, maxReplicas: 5 }, status: { currentReplicas: 0, desiredReplicas: 0 } }];
    p.raw.deployments = [dep('flobi-media-worker', 0, 0)];
    p.rebuild();
    assert.equal(svc().health, 'idle');
    clock.now += MIN;
    p.raw.deployments = [dep('flobi-media-worker', 1, 0)];
    p.raw.pods = [pod(`flobi-media-worker-${HASH}-aaaaa`, { app: 'flobi-media-worker', ready: false, waiting: 'ContainerCreating', createdAt: clock.now - 5_000 })];
    p.rebuild();
    assert.equal(svc().health, 'deploying');
    assert.deepEqual(svc().reasons, ['Starting from zero: the autoscaler asked for 1 pod']);
    assert.ok(!p.alerts.active.has('svc-down:flobi-media-worker'), 'no siren for a normal start');
    clock.now += 6 * MIN;
    p.rebuild();
    assert.equal(svc().health, 'deploying', 'still within 10 minutes of the scale-up');
    clock.now += 4 * MIN;
    p.rebuild();
    assert.equal(svc().health, 'down', '10 minutes and still no ready pod');
    assert.ok(p.alerts.active.has('svc-down:flobi-media-worker'));
    p.raw.pods = [pod(`flobi-media-worker-${HASH}-bbbbb`, { app: 'flobi-media-worker', ready: false, waiting: 'ContainerCreating', createdAt: clock.now - MIN })];
    p.rebuild();
    assert.equal(svc().health, 'down', 'a replacement pod does not restart the 10 minutes');
    // Once a pod is ready it's just healthy.
    p.raw.deployments = [dep('flobi-media-worker', 1, 1)];
    p.raw.pods = [pod(`flobi-media-worker-${HASH}-aaaaa`, { app: 'flobi-media-worker', createdAt: clock.now - 11 * MIN })];
    p.rebuild();
    assert.equal(svc().health, 'healthy');
    assert.equal(p.startingAt.size, 0);
  } finally {
    p.destroy();
  }
});

test('A7: opened mid-start, a KEDA workload (min 0 by default) with only new pods is starting; a broken pod is down', () => {
  const { p, clock } = pipeline();
  try {
    const svc = () => p.model.services[0];
    p.raw.scaledobjects = [{ metadata: { name: 'flobi-upscaler' }, spec: { scaleTargetRef: { name: 'flobi-upscaler' }, triggers: [{ type: 'rabbitmq' }] } }];
    p.raw.hpas = [{ metadata: { name: 'keda-hpa-flobi-upscaler' }, spec: { scaleTargetRef: { name: 'flobi-upscaler' }, minReplicas: 1, maxReplicas: 4 }, status: { currentReplicas: 1, desiredReplicas: 1 } }];
    p.raw.deployments = [dep('flobi-upscaler', 1, 0)];
    p.raw.pods = [pod(`flobi-upscaler-${HASH}-aaaaa`, { app: 'flobi-upscaler', ready: false, waiting: 'ContainerCreating', createdAt: clock.now - MIN })];
    p.rebuild();
    assert.equal(svc().scaling.min, 0);
    assert.equal(svc().health, 'deploying');
    p.raw.pods = [pod(`flobi-upscaler-${HASH}-aaaaa`, { app: 'flobi-upscaler', ready: false, waiting: 'ImagePullBackOff', createdAt: clock.now - MIN })];
    p.rebuild();
    assert.equal(svc().health, 'down', "a pod that can't start is an outage, starting or not");
    p.raw.pods = [pod(`flobi-upscaler-${HASH}-aaaaa`, { app: 'flobi-upscaler', ready: false, waiting: 'ContainerCreating', createdAt: clock.now - 6 * MIN })];
    p.rebuild();
    assert.equal(svc().health, 'down', 'pods older than 5 minutes are not a fresh start');
  } finally {
    p.destroy();
  }
});

// ── A8: finished pods ───────────────────────────────────────────────────────
test('A8: evicted, preempted and finished pods never make a service degraded or raise pod alerts', () => {
  const now = T0;
  const running = [pod(`flobi-brand-${HASH}-aaaaa`), pod(`flobi-brand-${HASH}-bbbbb`)];
  const evicted = pod(`flobi-brand-${HASH}-ccccc`, { phase: 'Failed', reason: 'Evicted', ready: false, createdAt: now - 3 * DAY, finishedAt: now - 2 * DAY, containers: [] });
  const shutdown = pod(`flobi-brand-${HASH}-ddddd`, { phase: 'Failed', reason: 'NodeShutdown', ready: false, terminated: 'Error', finishedAt: now - 5 * MIN });
  const jobFailed = pod('cleanup-29230000-xxxxx', { app: 'cleanup', phase: 'Failed', ready: false, terminated: 'Error', finishedAt: now - 2 * MIN, owner: { kind: 'Job', name: 'cleanup-29230000' } });
  const jobDone = pod('cleanup-29230030-yyyyy', { app: 'cleanup', phase: 'Succeeded', ready: false, terminated: 'Completed', finishedAt: now - MIN, owner: { kind: 'Job', name: 'cleanup-29230030' } });
  const crashing = pod(`flobi-users-${HASH}-eeeee`, { app: 'flobi-users', ready: false, waiting: 'CrashLoopBackOff' });
  const raw = {
    deployments: [dep('flobi-brand', 2, 2), dep('flobi-users', 1, 0)],
    pods: [...running, evicted, shutdown, jobFailed, jobDone, crashing],
    nodes: [{ metadata: { name: 'n1' }, status: { conditions: [{ type: 'Ready', status: 'True' }] } }],
  };
  const m = buildModel(raw, { now });
  const by = Object.fromEntries(m.pods.map((x) => [x.name, x]));
  const state = (x) => by[x.metadata.name].state;
  assert.equal(state(evicted), 'done');
  assert.equal(by[evicted.metadata.name].status, 'Evicted');
  assert.equal(state(shutdown), 'warn', 'recently finished: shown for 15 minutes');
  assert.equal(by[shutdown.metadata.name].status, 'NodeShutdown');
  assert.equal(state(jobFailed), 'warn');
  assert.equal(state(jobDone), 'done', 'a Job run that finished is simply done');
  assert.equal(state(crashing), 'bad', 'a crash loop is still trouble');
  const brand = m.services.find((s) => s.name === 'flobi-brand');
  assert.equal(brand.health, 'healthy', brand.reasons.join(' · '));
  assert.deepEqual(brand.pods.map((x) => x.name), [...running, shutdown].map((x) => x.metadata.name), 'long-finished pods drop off the list');
  assert.equal(m.nodes[0].pods, 3, 'a node only counts pods that still run');
  const conds = evaluateConditions({ model: m, now });
  assert.deepEqual(conds.filter((c) => c.kind === 'pod').map((c) => c.key), [`pod:${crashing.metadata.name}`]);
  assert.ok(!conds.some((c) => c.key.endsWith(':flobi-brand')), 'no "2 of 2 pods working, the rest were evicted"');
  assert.equal(buildModel(raw, { now: now + 15 * MIN }).pods.find((x) => x.name === shutdown.metadata.name).state, 'done');

  const { p } = pipeline();
  try {
    p.raw = { ...p.raw, ...raw };
    p.rebuild();
    const h = p.health();
    assert.equal(h.counts.pods, 3, 'finished pods are not counted as pods that should be ready');
    assert.equal(h.counts.podsReady, 2);
  } finally {
    p.destroy();
  }
});

// ── A9: sidecars ────────────────────────────────────────────────────────────
test('A9: memory % is per container with a limit, so a sidecar without one does not inflate it', () => {
  const name = `flobi-brand-${HASH}-aaaaa`;
  const make = (limits, usage) => {
    const containers = Object.keys(usage);
    const p = pod(name, {
      specContainers: containers.map((c) => ({ name: c, resources: limits[c] ? { limits: { memory: limits[c] } } : {} })),
      containers: containers.map((c) => ({ name: c, ready: true, restartCount: 0, state: { running: {} } })),
    });
    const podMetrics = new Map([[name, { containers: containers.map((c) => ({ name: c, usage: { memory: usage[c], cpu: '10m' } })) }]]);
    return buildModel({ deployments: [dep('flobi-brand', 1, 1)], pods: [p] }, { podMetrics, now: T0 });
  };
  let m = make({ 'flobi-brand': '512Mi' }, { 'flobi-brand': '300Mi', 'cloud-sql-proxy': '250Mi' });
  assert.equal(m.pods[0].memPct, 300 / 512);
  assert.equal(m.pods[0].mem, 550 * 2 ** 20, 'the pod still shows all it uses');
  assert.equal(m.pods[0].memLimit, 512 * 2 ** 20);
  assert.equal(m.services[0].memPct, 300 / 512, 'was 107%');
  assert.equal(m.services[0].health, 'healthy');
  m = make({ 'flobi-brand': '512Mi', 'cloud-sql-proxy': '256Mi' }, { 'flobi-brand': '300Mi', 'cloud-sql-proxy': '240Mi' });
  assert.equal(m.pods[0].memPct, 240 / 256, 'the fullest limited container counts');
  assert.equal(m.services[0].health, 'degraded');
});

// ── A10: stuck rollouts ─────────────────────────────────────────────────────
test('A10: a rollout Kubernetes gave up on (ProgressDeadlineExceeded) is degraded, not deploying forever', () => {
  const conditions = [{ type: 'Available', status: 'True', reason: 'MinimumReplicasAvailable' }, { type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded', message: 'ReplicaSet "flobi-brand-5c6d7e8f9" has timed out progressing.' }];
  const apiObject = { ...dep('flobi-brand', 2, 2, { replicas: 3, updatedReplicas: 1, conditions }), spec: { replicas: 2, selector: { matchLabels: { app: 'flobi-brand' } }, template: { spec: { containers: [{ name: 'flobi-brand' }] } } } };
  const kept = slim('deployments', apiObject);
  assert.deepEqual(kept.status.conditions, conditions, 'slimming keeps the conditions');
  const pods = [pod(`flobi-brand-${HASH}-aaaaa`), pod(`flobi-brand-${HASH}-bbbbb`), pod('flobi-brand-5c6d7e8f9-ccccc', { ready: false })];
  const m = buildModel({ deployments: [kept], pods }, { now: T0 });
  const s = m.services[0];
  assert.equal(s.health, 'degraded');
  assert.ok(s.reasons.includes("Rollout stuck: new pods didn't become ready in time"), s.reasons.join(' · '));
  const alert = evaluateConditions({ model: m, now: T0 }).find((c) => c.key === 'svc-degraded:flobi-brand');
  assert.equal(alert.title, 'brand: the new version is stuck rolling out');
  const moving = slim('deployments', { ...apiObject, status: { ...apiObject.status, conditions: [{ type: 'Progressing', status: 'True', reason: 'ReplicaSetUpdated' }] } });
  assert.equal(buildModel({ deployments: [moving], pods }, { now: T0 }).services[0].health, 'deploying');
});

// ── A11: at max replicas ────────────────────────────────────────────────────
test('A11: "can\'t scale up" only when at max and it wants more (ScalingLimited, or CPU over target)', () => {
  const at = (extra) => evaluateConditions({ model: { scaling: [{ service: 'flobi-nodes', atMax: true, min: 2, max: 15, cpuNow: 40, cpuTarget: 70, limited: false, ...extra }] }, now: T0 }).filter((c) => c.kind === 'scaling');
  assert.equal(at({}).length, 0, 'at max with idle CPU is fine');
  assert.equal(at({ limited: true })[0].detail, 'The autoscaler wants more pods than it may add');
  assert.equal(at({ cpuNow: 90 })[0].detail, 'CPU 90% (the autoscaler aims for 70%)');
  assert.equal(at({ cpuNow: null, cpuTarget: null }).length, 0);
  assert.equal(at({ atMax: false, cpuNow: 90, limited: true }).length, 0);
  // From the HPA object: ScalingLimited=True at max.
  const hpa = (limited) => ({ metadata: { name: 'flobi-nodes-hpa' }, spec: { scaleTargetRef: { name: 'flobi-nodes' }, minReplicas: 2, maxReplicas: 3, metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { averageUtilization: 70 } } }] }, status: { currentReplicas: 3, desiredReplicas: 3, currentMetrics: [{ resource: { name: 'cpu', current: { averageUtilization: 35 } } }], conditions: [{ type: 'ScalingLimited', status: limited ? 'True' : 'False', reason: limited ? 'TooManyReplicas' : 'DesiredWithinRange' }] } });
  const model = (limited) => buildModel({ deployments: [dep('flobi-nodes', 3)], hpas: [hpa(limited)] }, { now: T0 });
  assert.equal(evaluateConditions({ model: model(false), now: T0 }).filter((c) => c.kind === 'scaling').length, 0);
  assert.deepEqual(evaluateConditions({ model: model(true), now: T0 }).filter((c) => c.kind === 'scaling').map((c) => c.key), ['scale-max:flobi-nodes']);
});

// ── A12: node NotReady ──────────────────────────────────────────────────────
test('A12: a node that just went NotReady is a warning; still down after 3 minutes it is critical', () => {
  const node = (downFor) => ({ metadata: { name: 'gke-spot-1', labels: { 'cloud.google.com/gke-spot': 'true' }, creationTimestamp: iso(T0 - 10 * DAY) }, spec: {}, status: { conditions: [{ type: 'Ready', status: 'False', reason: 'KubeletNotReady', message: 'node is shutting down', lastTransitionTime: iso(T0 - downFor) }] } });
  assert.equal(slim('nodes', node(MIN)).status.conditions[0].lastTransitionTime, iso(T0 - MIN));
  const check = (downFor) => {
    const m = buildModel({ nodes: [slim('nodes', node(downFor))] }, { now: T0 });
    return [m.nodes[0], evaluateConditions({ model: m, now: T0 }).find((c) => c.kind === 'node')];
  };
  let [n, c] = check(MIN);
  assert.equal(n.notReadySince, T0 - MIN);
  assert.equal(c.severity, 'warning', 'no siren for a node that blinks');
  assert.equal(c.key, 'node-down:gke-spot-1');
  [n, c] = check(3 * MIN);
  assert.equal(c.severity, 'critical');
  assert.match(c.detail, /for 3 min$/);
  const ok = buildModel({ nodes: [{ metadata: { name: 'n2' }, status: { conditions: [{ type: 'Ready', status: 'True', lastTransitionTime: iso(T0 - DAY) }] } }] }, { now: T0 });
  assert.equal(ok.nodes[0].notReadySince, null);
  // Through the AlertBook: a chime first, the siren only if it stays down.
  const { b, clock, opened } = book();
  const evalAt = () => b.reconcile(evaluateConditions({ model: buildModel({ nodes: [node(MIN)] }, { now: clock.now }), now: clock.now })); // NotReady since T0 - 1 min
  evalAt();
  clock.now += MIN;
  evalAt();
  assert.deepEqual(opened.map((o) => o.severity), ['warning']);
  clock.now += MIN;
  evalAt();
  assert.deepEqual(opened.map((o) => [o.severity, o.escalated]), [['warning', false], ['critical', true]]);
});

// ── A13: quantities ─────────────────────────────────────────────────────────
test('A13: memory in milli-bytes ("1288490188800m", i.e. 1.2Gi) is read right, so the memory check works', () => {
  assert.equal(bytes('1288490188800m'), 1.2 * 2 ** 30);
  assert.equal(bytes('512Mi'), 512 * 2 ** 20);
  assert.equal(bytes('1G'), 1e9);
  assert.equal(memText('1288490188800m'), '1.2 GB');
  const name = `flobi-brand-${HASH}-aaaaa`;
  const p = pod(name, { specContainers: [{ name: 'flobi-brand', resources: { limits: { memory: '1288490188800m' } } }] });
  const podMetrics = new Map([[name, { containers: [{ name: 'flobi-brand', usage: { memory: '1178Mi', cpu: '100m' } }] }]]);
  const m = buildModel({ deployments: [dep('flobi-brand', 1, 1)], pods: [p] }, { podMetrics, now: T0 });
  assert.ok(Math.abs(m.pods[0].memPct - 1178 / 1228.8) < 1e-9);
  assert.equal(m.services[0].health, 'degraded');
  assert.ok(m.services[0].reasons.includes('Memory at 96% of limit'));
});

// ── A14: stopped services ───────────────────────────────────────────────────
test('A14: a service stopped by hand is "stopped", not "none of its 0 pods are ready"', () => {
  const s = { name: 'flobi-director', kind: 'Deployment', health: 'down', desired: 0, ready: 0, reasons: ['Stopped: scaled to 0 replicas 5 min ago (no autoscaler manages it)'], pods: [], hosts: ['api.flobi.ai/director'] };
  const c = serviceCopy(s);
  assert.equal(c.title, 'director is stopped: it was scaled down to 0 pods');
  assert.equal(c.detail, s.reasons[0]);
  assert.match(c.impact, /^Requests to api\.flobi\.ai\/director are affected\./);
  assert.match(c.action, /kubectl scale deployment flobi-director --replicas=1/);
  assert.equal(serviceCopy({ ...s, kind: 'StatefulSet', name: 'redis' }).action.includes('kubectl scale statefulset redis'), true);
  assert.equal(serviceCopy({ ...s, desired: 1, reasons: ['0 of 1 pods ready'] }).title, "director is down: its pod isn't ready");
  assert.equal(serviceCopy({ ...s, desired: 3, reasons: ['0 of 3 pods ready'] }).title, 'director is down: none of its 3 pods are ready');

  const { p, clock } = pipeline();
  try {
    p.raw.deployments = [dep('flobi-director', 2)];
    p.rebuild();
    clock.now += MIN;
    p.raw.deployments = [dep('flobi-director', 0, 0)];
    p.rebuild();
    assert.equal(p.alerts.active.get('svc-down:flobi-director').title, 'director is stopped: it was scaled down to 0 pods');
    // Scaled back up by hand: starting, not down.
    clock.now += MIN;
    p.raw.deployments = [dep('flobi-director', 2, 0)];
    p.rebuild();
    const svc = p.model.services[0];
    assert.equal(svc.health, 'deploying');
    assert.equal(svc.reasons[0], 'Starting from zero: scaled up to 2 pods');
  } finally {
    p.destroy();
  }
});

// ── A15: error rates ────────────────────────────────────────────────────────
test('A15: error spikes compare a sliding 2 minutes with the 30 minutes before', () => {
  const { p } = pipeline();
  try {
    p.errors.groups = new Map([['g1', { service: 'flobi-brand' }]]);
    const calls = [];
    p.errors.rate = (service, windowMs, now) => (calls.push([service, windowMs, now]), windowMs === 2 * MIN ? 12 : 3);
    const r = p.errorRates()['flobi-brand'];
    assert.deepEqual(calls, [['flobi-brand', 2 * MIN, T0], ['flobi-brand', 32 * MIN, T0]]);
    assert.equal(r.now, 12);
    assert.equal(r.baseline, (3 * 32 - 12 * 2) / 30);
    // An ErrorBook without rate() still works (whole minutes).
    p.errors.rate = undefined;
    p.errors.ratePerMinute = (service, minutes) => (minutes === 2 ? 20 : 2);
    assert.deepEqual(p.errorRates()['flobi-brand'], { now: 20, baseline: (2 * 32 - 20 * 2) / 30 });
  } finally {
    p.destroy();
  }
});

// ── A16/A17: new errors, legacy known errors ────────────────────────────────
test('A16: on a first run, new-error alerts wait for the error baseline, not the whole session', () => {
  const { p, clock } = pipeline({ knownErrors: {}, legacyKnownErrors: { 'flobi-brand:old': 1 } });
  try {
    assert.equal(p.firstRun, undefined);
    assert.equal(p.knownErrors(), p.errors.known);
    p.initialPhase = false;
    p.liveSince = clock.now - 10 * MIN;
    const g = { id: 'flobi-brand:abc', service: 'flobi-brand', title: 'TypeError: x is undefined', context: 'BrandService' };
    p.errors.add = () => ({ isNewGroup: true, group: g });
    let baseline = true;
    p.errors.inBaseline = (now) => (assert.equal(now, clock.now), baseline);
    const line = { kind: 'log', level: 'ERROR', ts: clock.now, service: 'flobi-brand', text: 'TypeError: x is undefined' };
    p.ingest([line]);
    assert.equal(p.alerts.active.size, 0, 'still learning what is usual');
    baseline = false;
    p.ingest([line]);
    assert.equal(p.alerts.active.get('newerr:flobi-brand:abc')?.title, 'New error in brand: TypeError: x is undefined');
    // And still not right after the live stream connects.
    p.alerts.active.clear();
    p.liveSince = clock.now - MIN;
    p.ingest([line]);
    assert.equal(p.alerts.active.size, 0);
  } finally {
    p.destroy();
  }
});

// ── A19: summary ────────────────────────────────────────────────────────────
test('A19: summary() is worked out once per change; clearing alerts are not counted or reported as problems', () => {
  const { b, clock } = book();
  b.reconcile([cond('svc-down:x', 'critical')]);
  const s1 = b.summary();
  assert.equal(b.summary(), s1, 'nothing changed: the same object');
  clock.now += 1_000;
  b.reconcile([cond('svc-down:x', 'critical')]);
  assert.equal(b.summary(), s1, 'the same condition again changes nothing');
  b.reconcile([cond('svc-down:x', 'critical', { detail: 'for 2 min' })]);
  const s2 = b.summary();
  assert.notEqual(s2, s1);
  assert.equal(s2.active[0].detail, 'for 2 min');
  b.reconcile([]);
  assert.equal(b.summary().counts.critical, 0);

  const { p } = pipeline();
  try {
    p.rebuild();
    p.alerts.reconcile([cond('uptime:x', 'critical', { service: undefined })]);
    assert.equal(p.health().overall, 'degraded');
    assert.equal(p.health().headline, 'Active incidents');
    p.alerts.reconcile([]);
    assert.equal(p.health().overall, 'operational', 'a clearing critical alert is not an incident');
  } finally {
    p.destroy();
  }
});
