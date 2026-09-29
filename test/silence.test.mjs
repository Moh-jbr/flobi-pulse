// Silence: what someone silenced stays quiet until it has been fixed for 30 minutes,
// through flaps, follow-up alerts of the same incident and restarts; the siren keeps
// quiet for 5 minutes after it. Fake clocks throughout, no sleeping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AlertBook } from '../electron/core/engine/alerts.mjs';
import { Alarm } from '../electron/core/engine/alarm.mjs';
import { Pipeline } from '../electron/core/engine/pipeline.mjs';

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 28, 12, 0);
const HASH = '7d9f8c6b5';
const iso = (ms) => new Date(ms).toISOString();

function book() {
  const clock = { now: T0 };
  const opened = [];
  const b = new AlertBook({ now: () => clock.now, onOpen: (a, meta) => opened.push({ id: a.id, key: a.key, severity: a.severity, ...meta }) });
  return { b, clock, opened };
}

const cond = (key, severity, service = null) => ({ key, kind: 'service', service, severity, title: `${key} is ${severity}` });

// ── AlertBook ───────────────────────────────────────────────────────────────
test('a silenced crash loop that flaps past the hold stays quiet, and is news again only once fixed for 30 min', () => {
  const { b, clock, opened } = book();
  const podDown = cond('pod:brand-1', 'critical', 'flobi-brand');
  const crash = () => b.happen({ key: 'crash:brand-1/brand', kind: 'crash', service: 'flobi-brand', severity: 'critical', title: 'brand ran out of memory' });
  const crashes = () => {
    crash();
    b.reconcile([podDown]);
  };
  // The pod runs fine for a while between crashes: longer than the 60 s hold, so its alert resolves.
  const runs = (ms) => {
    for (let t = 0; t < ms; t += 15_000) {
      clock.now += 15_000;
      b.reconcile([]);
    }
  };
  crashes();
  const first = b.active.get('pod:brand-1');
  assert.equal(b.silence([first.id, b.active.get('crash:brand-1/brand').id]), 2, 'the Silence button');
  assert.equal(first.acked, true);
  const news = () => opened.filter((o) => !o.silenced).length;
  assert.equal(news(), 2);
  for (let i = 0; i < 6; i++) {
    runs(4 * MIN);
    assert.equal(b.active.has('pod:brand-1'), false, 'resolved: it was fine for longer than the hold');
    crashes();
    const again = b.active.get('pod:brand-1');
    assert.notEqual(again.id, first.id, 'a new alert…');
    assert.equal(again.acked, true, '…that opened acknowledged');
    assert.equal(again.silenced, true);
    assert.equal(opened.at(-1).silenced, true, 'onOpen says so, so nothing announces it');
  }
  assert.equal(news(), 2, 'no news in half an hour of flapping');
  assert.equal(b.summary().active.find((a) => a.key === 'pod:brand-1').silenced, true, 'the UI can show it');

  // Fixed for 29 minutes, then back: still the problem someone silenced.
  runs(29 * MIN);
  crashes();
  assert.equal(opened.at(-1).silenced, true);
  assert.equal(news(), 2);
  // Fixed for 31 minutes (the crash alert closed 30 min after the last crash): news again.
  runs(31 * MIN);
  assert.equal(b.active.size, 0);
  assert.equal(b.silenced.size, 0, 'the silence is over');
  crashes();
  assert.equal(news(), 4, 'the crash and the pod alert notify again');
  assert.equal(b.active.get('pod:brand-1').acked, false);
});

test('the same incident’s other alerts in that service stay quiet; another service is news', () => {
  const { b, clock, opened } = book();
  const pod = cond('pod:brand-1', 'critical', 'flobi-brand');
  b.reconcile([pod]);
  b.silence([b.active.get('pod:brand-1').id]);
  clock.now += 2 * MIN;
  b.reconcile([pod, cond('svc-down:flobi-brand', 'critical', 'flobi-brand'), cond('http5xx:flobi-brand', 'warning', 'flobi-brand'), cond('http5xx:flobi-gateway', 'critical', 'flobi-gateway')]);
  const by = Object.fromEntries(opened.map((o) => [o.key, o]));
  assert.equal(by['svc-down:flobi-brand'].silenced, true, 'the service went down after its pod crash-looped');
  assert.equal(by['http5xx:flobi-brand'].silenced, true);
  assert.equal(by['http5xx:flobi-gateway'].silenced, false, 'a different service: a different problem');
  assert.equal(b.active.get('http5xx:flobi-gateway').acked, false);
  // A worse alert of the same service that's already open and unacknowledged gets quieter too.
  clock.now += 5_000;
  b.reconcile([pod, cond('svc-down:flobi-brand', 'critical', 'flobi-brand'), cond('http5xx:flobi-brand', 'critical', 'flobi-brand')]);
  assert.deepEqual([opened.at(-1).key, opened.at(-1).escalated, opened.at(-1).silenced], ['http5xx:flobi-brand', true, true], 'critical: no worse than what was silenced');
});

test('Silence covers the incident’s other open alerts in that service too, but nothing worse and no other service', () => {
  const { b } = book();
  b.reconcile([cond('pod:brand-1', 'critical', 'flobi-brand'), cond('svc-degraded:flobi-brand', 'warning', 'flobi-brand'), cond('http5xx:flobi-gateway', 'warning', 'flobi-gateway'), cond('node-down:n1', 'warning')]);
  assert.equal(b.silence([b.active.get('pod:brand-1').id]), 1);
  const acked = (key) => [b.active.get(key).acked, !!b.active.get(key).silenced];
  assert.deepEqual(acked('pod:brand-1'), [true, false]);
  assert.deepEqual(acked('svc-degraded:flobi-brand'), [true, true], 'the same incident, already notified: it can’t be announced again');
  assert.deepEqual(acked('http5xx:flobi-gateway'), [false, false]);
  assert.deepEqual(acked('node-down:n1'), [false, false]);
  const { b: b2 } = book();
  b2.reconcile([cond('errspike:flobi-brand', 'warning', 'flobi-brand'), cond('svc-down:flobi-brand', 'critical', 'flobi-brand')]);
  b2.ack(b2.active.get('errspike:flobi-brand').id);
  assert.equal(b2.active.get('svc-down:flobi-brand').acked, false, 'acknowledging a warning leaves a critical alone');
  assert.equal(b2.silence(['nothing-open']), 0);
});

test('an alert of a silenced service that was held back (it cleared before its notification went out) stays quiet when it comes back', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { p, clock, sent } = pipeline();
  try {
    clearInterval(p.timer); // no rebuilds from the (empty) model: this test feeds the conditions itself
    p._endInitialPhase();
    const podDown = cond('pod:brand-1', 'critical', 'flobi-brand');
    const degraded = cond('svc-degraded:flobi-brand', 'warning', 'flobi-brand');
    p.alerts.reconcile([podDown, degraded]);
    clock.now += 1_000;
    p.alerts.reconcile([podDown]); // the service was degraded for a moment
    t.mock.timers.tick(2500);
    assert.deepEqual(sent.map((s) => s.a.key), ['pod:brand-1']);
    assert.equal(p.unsent.size, 1, 'held back: announced only if it comes back');
    p.alerts.silence([p.alerts.active.get('pod:brand-1').id]);
    clock.now += 10_000;
    p.alerts.reconcile([podDown, degraded]); // …and it comes back
    p._sendUnsent();
    t.mock.timers.tick(2500);
    assert.equal(sent.length, 1, sent.map((s) => s.a.title).join(' | '));
    assert.equal(p.unsent.size, 0);
  } finally {
    p.destroy();
  }
});

test('something worse than what was silenced breaks through, and ends that silence', () => {
  const { b, clock, opened } = book();
  const spike = cond('errspike:flobi-brand', 'warning', 'flobi-brand');
  b.reconcile([spike]);
  b.ack(b.active.get('errspike:flobi-brand').id); // Acknowledge (a warning) silences it too
  clock.now += MIN;
  b.reconcile([spike, cond('svc-down:flobi-brand', 'critical', 'flobi-brand')]);
  assert.equal(opened.at(-1).silenced, false, 'a critical after a silenced warning is news');
  assert.equal(b.active.get('svc-down:flobi-brand').acked, false);
  clock.now += MIN;
  b.reconcile([spike, cond('svc-down:flobi-brand', 'critical', 'flobi-brand'), cond('http5xx:flobi-brand', 'warning', 'flobi-brand')]);
  assert.equal(opened.at(-1).silenced, false, "the service isn't silenced any more");
  // The warning's own problem still is: it clears, resolves and comes back quietly.
  b.reconcile([]);
  clock.now += 3 * MIN;
  b.reconcile([]);
  assert.equal(b.active.size, 0);
  b.reconcile([spike]);
  assert.equal(opened.at(-1).silenced, true);

  // A silenced alert that gets worse than it was is news again too.
  const { b: b2, clock: c2, opened: o2 } = book();
  b2.reconcile([cond('http5xx:flobi-brand', 'warning', 'flobi-brand')]);
  b2.silence([b2.active.get('http5xx:flobi-brand').id]);
  c2.now += 5_000;
  b2.reconcile([cond('http5xx:flobi-brand', 'critical', 'flobi-brand')]);
  assert.deepEqual([o2.at(-1).escalated, o2.at(-1).silenced], [true, false]);
  assert.equal(b2.active.get('http5xx:flobi-brand').acked, false, 'it needs a new look');
  assert.equal(b2.silenced.size, 0);
});

test('what’s silenced or muted carries over to a new AlertBook (a reconnect, waking up, a restart)', () => {
  const { b, clock } = book();
  const crashCond = { key: 'crash:brand-1/brand', kind: 'crash', service: 'flobi-brand', severity: 'critical', title: 'brand ran out of memory' };
  const crash = b.happen(crashCond);
  b.reconcile([cond('node-down:n1', 'critical')]);
  b.silence([crash.id]);
  b.mute('key:node-down:n1', 60);
  b.mute('flobi-drive', 1);
  const saved = JSON.parse(JSON.stringify(b.stateToSave()));
  assert.deepEqual(saved, {
    silenced: [
      { scope: 'key:crash:brand-1/brand', severity: 'critical', clearAt: null },
      { scope: 'flobi-brand', severity: 'critical', clearAt: null },
    ],
    muted: { 'key:node-down:n1': T0 + 60 * MIN, 'flobi-drive': T0 + MIN },
  });

  // The next session, 5 minutes later: the crash loop is still going, the node is still down.
  const next = book();
  next.clock.now = clock.now + 5 * MIN;
  next.b.loadState(saved);
  next.b.happen(crashCond);
  next.b.reconcile([cond('node-down:n1', 'critical'), cond('svc-degraded:flobi-brand', 'warning', 'flobi-brand')]);
  const by = Object.fromEntries(next.opened.map((o) => [o.key, o]));
  assert.equal(by['crash:brand-1/brand'].silenced, true);
  assert.equal(by['svc-degraded:flobi-brand'].silenced, true);
  assert.equal(by['node-down:n1'].muted, true, 'the mute for an hour carries over');
  assert.equal(next.b.isMuted({ service: 'flobi-drive' }), false, 'a mute that ran out meanwhile is gone');
  assert.deepEqual(next.b.stateToSave().muted, { 'key:node-down:n1': T0 + 60 * MIN });

  // After a long sleep, a silenced problem that isn't seen again starts its 30 minutes at load time…
  const woke = book();
  woke.clock.now = clock.now + 8 * 60 * MIN;
  woke.b.loadState(saved);
  woke.clock.now += 29 * MIN;
  woke.b.reconcile([]);
  woke.b.happen(crashCond);
  assert.equal(woke.opened.at(-1).silenced, true, 'back within 30 minutes: still quiet');
  const later = book();
  later.clock.now = clock.now + 8 * 60 * MIN;
  later.b.loadState(saved);
  later.clock.now += 30 * MIN;
  later.b.reconcile([]);
  later.b.happen(crashCond);
  assert.equal(later.opened.at(-1).silenced, false, 'not seen for 30 minutes: news again');
  // …and one that had been fixed for a while before the save keeps that time.
  const fixed = book();
  fixed.b.loadState({ silenced: [{ scope: 'flobi-brand', severity: 'critical', clearAt: T0 - 25 * MIN }] });
  fixed.clock.now += 5 * MIN;
  fixed.b.reconcile([]);
  assert.equal(fixed.b.silenced.size, 0);
  // Anything unreadable is left out.
  const junk = book();
  junk.b.loadState({ silenced: [null, { scope: '' }, { scope: 'x', severity: 'toString' }, { scope: 'y', severity: 'loud' }], muted: { a: 'soon', b: -1 } });
  junk.b.loadState('nonsense');
  assert.deepEqual(junk.b.stateToSave(), { silenced: [], muted: {} });
});

// ── The siren's quiet window ────────────────────────────────────────────────
function siren() {
  let now = 0;
  const timers = [];
  const played = [];
  const open = new Set(); // open, unacknowledged, unmuted criticals
  const recovering = new Set();
  const alarm = new Alarm({
    play: (k) => played.push([k, now]),
    stillRinging: (id) => open.has(id),
    sounding: (id) => open.has(id) && !recovering.has(id),
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
  return { alarm, played, open, recovering, advance, sirens };
}

test('after Silence nothing new rings for 5 min; then only what is still open and unacknowledged rings', () => {
  const { alarm, played, open, advance, sirens } = siren();
  open.add('a');
  alarm.ring(['a']);
  assert.deepEqual(alarm.silence({ quietMs: 5 * MIN }), ['a']);
  open.delete('a'); // acknowledged by the Silence
  assert.equal(alarm.state().quietUntil, 5 * MIN);
  advance(MIN);
  for (const id of ['b', 'c', 'd']) open.add(id);
  alarm.ring(['b', 'c', 'd']);
  alarm.chime();
  assert.deepEqual(played, [['critical', 0]], 'no siren, no chime');
  assert.equal(alarm.ringing, false);
  advance(MIN);
  open.delete('b'); // acknowledged meanwhile
  open.delete('d'); // resolved meanwhile
  advance(3 * MIN);
  assert.deepEqual(sirens(), [0, 5 * MIN], 'the window is over: it rings');
  assert.deepEqual(alarm.state().ids, ['c']);
  assert.equal(alarm.state().quietUntil, null);
  // c's 10 minutes start when it actually rang, not when it came up.
  advance(9 * MIN);
  assert.equal(alarm.ringing, true);
  advance(MIN);
  assert.equal(alarm.ringing, false);
  assert.ok(Math.max(...sirens()) >= 14 * MIN && Math.max(...sirens()) < 15 * MIN);
  assert.equal(played.filter(([k]) => k === 'warning').length, 0, 'the skipped chime never plays');
});

test('the quiet window: a recovering alert waits for its problem to come back; a reconnect keeps the window', () => {
  const { alarm, open, recovering, advance, sirens } = siren();
  alarm.silence({ quietMs: 5 * MIN });
  advance(MIN);
  open.add('x');
  alarm.ring(['x']);
  recovering.add('x');
  advance(4 * MIN);
  assert.deepEqual(sirens(), [], 'recovering when the window ended: quiet');
  advance(MIN);
  recovering.delete('x'); // it's back
  alarm.check(); // runs on every alerts update
  assert.deepEqual(sirens(), [6 * MIN]);
  assert.deepEqual(alarm.state().ids, ['x']);

  // reset() (the session restarts) clears the siren but not the window.
  const s = siren();
  s.open.add('y');
  s.alarm.silence({ quietMs: 5 * MIN });
  s.advance(MIN);
  s.alarm.reset();
  assert.equal(s.alarm.quiet, true);
  s.alarm.ring(['y']); // the new session's alert for the same kind of thing
  s.advance(3 * MIN);
  assert.deepEqual(s.sirens(), []);
  s.advance(MIN);
  assert.deepEqual(s.sirens(), [5 * MIN]);
  // Silence with nothing to be quiet about (quietMs 0) leaves the next siren alone.
  const q = siren();
  q.alarm.silence();
  q.open.add('z');
  q.alarm.ring(['z']);
  assert.deepEqual(q.sirens(), [0]);
});

// ── Through the pipeline ────────────────────────────────────────────────────
function pod(name, { app = 'flobi-brand', ready = true, containers } = {}) {
  return {
    metadata: { name, uid: name, labels: { app, 'pod-template-hash': HASH }, ownerReferences: [{ kind: 'ReplicaSet', name: `${app}-${HASH}` }], creationTimestamp: iso(T0 - 60 * MIN) },
    spec: { nodeName: 'n1', containers: [{ name: app, resources: { limits: { memory: '512Mi' } } }] },
    status: { phase: 'Running', startTime: iso(T0 - 60 * MIN), conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }], containerStatuses: containers || [{ name: app, ready, restartCount: 0, state: { running: {} }, lastState: {} }] },
  };
}
const dep = (name, replicas, ready = replicas) => ({
  metadata: { name, uid: name, generation: 1 },
  spec: { replicas, selector: { matchLabels: { app: name } }, containers: [{ name, resources: { limits: { memory: '512Mi' } } }] },
  status: { replicas, readyReplicas: ready, updatedReplicas: replicas, availableReplicas: ready, observedGeneration: 1 },
});

function pipeline(extra = {}) {
  const clock = { now: T0 };
  const sent = [];
  const p = new Pipeline({ namespace: 'flobi', emit: () => {}, mode: 'demo', now: () => clock.now, notify: (a, meta) => sent.push({ a, meta }), ...extra });
  return { p, clock, sent };
}

test('through the pipeline: after Silence a crash loop notifies nothing, however it flaps, until it has been fixed for 30 min', (t) => {
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
      const cs = [{ name: 'flobi-brand', ready: !crashing, restartCount: restarts, state: crashing ? { waiting: { reason: 'CrashLoopBackOff' } } : { running: { startedAt: iso(clock.now) } }, lastState: { terminated: { reason: 'OOMKilled', exitCode: 137, finishedAt: iso(clock.now) } } }];
      p.setK8s('deployments', [dep('flobi-brand', 2, crashing ? 1 : 2)]);
      p.setK8s('pods', [healthy, pod(name, { ready: !crashing, containers: cs })]);
      t.mock.timers.tick(3000); // rebuild, then the 2.5 s notification bucket
    };
    step(15_000, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].a.severity, 'critical');
    // The Silence button: what the siren rang for (main.mjs: the criticals of that notification).
    const ringing = [sent[0].a, ...sent[0].meta.related].filter((a) => a.severity === 'critical').map((a) => a.id);
    assert.equal(p.alerts.silence(ringing), ringing.length);
    // It runs for a few minutes between crashes (every alert resolves in between), for an hour.
    for (let i = 0; i < 12; i++) {
      step(15_000, false);
      step(4 * MIN, false);
      step(15_000, true);
    }
    assert.equal(sent.length, 1, sent.map((s) => s.a.title).join(' | '));
    const podAlert = p.alerts.active.get(`pod:${name}`);
    assert.equal(podAlert.silenced, true, 'the pod alert reopened, quietly');
    assert.equal(p.section('alerts').active.find((a) => a.key === `pod:${name}`).silenced, true);
    // Fixed for good. brand counts as degraded for 15 minutes after its last restart, so it has
    // been fixed for 30 minutes 45 minutes after the last crash: a crash then is news again.
    step(15_000, false);
    for (let i = 0; i < 44; i++) step(MIN, false);
    assert.ok(p.alerts.silenced.size > 0, 'healthy for less than 30 minutes: still silenced');
    for (let i = 0; i < 2; i++) step(MIN, false);
    assert.equal(p.alerts.silenced.size, 0);
    step(15_000, true);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].a.severity, 'critical');
    assert.equal(sent[1].a.acked, false);
  } finally {
    p.destroy();
  }
});

test('the startup summary leaves out silenced and muted problems, and isn’t sent when nothing else is open', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const saved = { silenced: [{ scope: 'flobi-brand', severity: 'critical', clearAt: null }], muted: { 'key:node-down:n1': T0 + 60 * MIN } };
  const quiet = pipeline({ graceMs: 1000 });
  try {
    quiet.p.alerts.loadState(saved); // main.mjs: newPipeline() loads what the last session saved
    quiet.p.setK8s('deployments', [dep('flobi-brand', 1, 0)]);
    quiet.p.setK8s('pods', []);
    quiet.p.alerts.happen({ key: 'node-down:n1', kind: 'node', severity: 'critical', title: 'Node n1 is down' });
    t.mock.timers.tick(300);
    assert.equal(quiet.p.alerts.active.get('svc-down:flobi-brand').silenced, true, 'brand is still down, as it was when silenced');
    t.mock.timers.tick(1000);
    assert.deepEqual(quiet.sent, [], 'no "2 active problems", no siren');
  } finally {
    quiet.p.destroy();
  }
  const mixed = pipeline({ graceMs: 1000 });
  try {
    mixed.p.alerts.loadState(saved);
    mixed.p.setK8s('deployments', [dep('flobi-brand', 1, 0), dep('flobi-director', 1, 0)]);
    mixed.p.setK8s('pods', []);
    t.mock.timers.tick(1300);
    assert.equal(mixed.sent.length, 1);
    const [{ a, meta }] = mixed.sent;
    assert.equal(a.title, '1 active problem');
    assert.deepEqual(meta.related.map((x) => x.key), ['svc-down:flobi-director']);
    assert.equal(meta.muted, false);
  } finally {
    mixed.p.destroy();
  }
});
