import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline } from '../electron/core/engine/pipeline.mjs';
import { deploysOf } from '../electron/core/engine/recap.mjs';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 3, 10, 0);

function withPipeline(fn) {
  const clock = { now: T0 };
  const p = new Pipeline({ namespace: 'flobi', emit: () => {}, mode: 'demo', now: () => clock.now });
  try {
    p.model.pods = [
      { name: 'flobi-brand-1-aaaaa', service: 'flobi-brand', cpuLimit: 1000, memLimit: 1000 * 2 ** 20 },
      { name: 'flobi-brand-1-bbbbb', service: 'flobi-brand', cpuLimit: 1000, memLimit: 1000 * 2 ** 20 },
      { name: 'flobi-ai-1-ccccc', service: 'flobi-ai', cpuLimit: 1000 },
    ];
    fn(p, clock);
  } finally {
    p.destroy();
  }
}

const use = (name, mi, cpu = '100m') => ({ metadata: { name }, containers: [{ name: 'app', usage: { cpu, memory: `${mi}Mi` } }] });

/** One metrics poll every `every` ms, brand's fuller pod at `memAt(i)` of its limit. */
function polls(p, clock, n, memAt, every = MIN) {
  for (let i = 0; i < n; i++) {
    p.setMetrics({ pods: [use('flobi-brand-1-aaaaa', Math.round(memAt(i) * 1000)), use('flobi-brand-1-bbbbb', 100), use('flobi-ai-1-ccccc', 500)], at: clock.now });
    clock.now += every;
  }
  clock.now -= every;
}

test("a service's memory line is its fullest pod against that pod's limit", () => {
  withPipeline((p, clock) => {
    polls(p, clock, 3, (i) => 0.4 + i * 0.1);
    assert.deepEqual(p.memSpark('flobi-brand').points.map((v) => Math.round(v * 100) / 100), [0.4, 0.5, 0.6]);
    assert.equal(p.memSpark('flobi-ai'), null, 'no memory limit: no line, rather than a % of nothing');
  });
});

test('memory climbing toward its limit says how long until it gets there', () => {
  withPipeline((p, clock) => {
    // 1% of the limit a minute, at 70% now: 30 minutes to go.
    polls(p, clock, 11, (i) => 0.6 + i * 0.01);
    assert.equal(Math.round(p.memEta('flobi-brand', clock.now) / MIN), 30);
  });
});

test('memory that is flat, falling, low, short-lived or far from its limit gives no warning', () => {
  const eta = (n, memAt, every) => {
    let out;
    withPipeline((p, clock) => {
      polls(p, clock, n, memAt, every);
      out = p.memEta('flobi-brand', clock.now);
    });
    return out;
  };
  assert.equal(eta(11, () => 0.8), null, 'flat');
  assert.equal(eta(11, (i) => 0.9 - i * 0.01), null, 'falling');
  assert.equal(eta(11, (i) => 0.2 + i * 0.02), null, 'climbing fast but still under half');
  assert.equal(eta(4, (i) => 0.6 + i * 0.05), null, 'under five minutes of it');
  assert.equal(eta(11, (i) => 0.6 + i * 0.001), null, 'hours away');
  assert.equal(eta(11, (i) => 0.9 + i * 0.01), 0, 'already at the limit');
});

test('only the last 15 minutes decide the pace', () => {
  withPipeline((p, clock) => {
    // Fell sharply for half an hour (a restart), then climbs 1% a minute for 15.
    polls(p, clock, 30, (i) => 0.95 - i * 0.01);
    clock.now += MIN;
    polls(p, clock, 16, (i) => 0.55 + i * 0.01);
    assert.equal(Math.round(p.memEta('flobi-brand', clock.now) / MIN), 30);
  });
});

test("the cards' last hour is saved and comes back after a restart", () => {
  let saved;
  withPipeline((p, clock) => {
    polls(p, clock, 20, (i) => 0.5 + i * 0.01);
    saved = JSON.parse(JSON.stringify(p.usageToSave()));
  });
  assert.equal(saved.cpu['flobi-brand'].unit, 'pct');
  assert.equal(saved.mem['flobi-brand'].length, 20);
  assert.equal(saved.mem['flobi-ai'], undefined);

  withPipeline((p, clock) => {
    clock.now = T0 + 30 * MIN; // started again ten minutes after quitting
    p.restoreUsage(saved, clock.now);
    polls(p, clock, 2, () => 0.9);
    const mem = p.memSpark('flobi-brand');
    assert.equal(mem.points.length, 22, 'the saved points first, then this session’s');
    assert.ok(mem.times.every((t, i) => !i || t > mem.times[i - 1]), 'in time order');
    assert.equal(p.cpuSpark('flobi-brand').points.length, 22);
    assert.equal(p.cpuSpark('flobi-ai').unit, 'pct');
  });

  withPipeline((p, clock) => {
    clock.now = T0 + 70 * MIN; // an hour after the oldest point: only the newest stay
    p.restoreUsage(saved, clock.now);
    assert.equal(p.serviceMem.get('flobi-brand').points.length, 10, 'minutes 10 to 19');
  });
});

test('a saved line arriving after this session began never doubles a minute', () => {
  withPipeline((p, clock) => {
    polls(p, clock, 10, () => 0.5);
    const saved = p.usageToSave();
    // This session already has minutes 5–9; the saved copy holds 0–9.
    for (const map of [p.serviceCpu, p.serviceMem]) for (const h of map.values()) h.points.splice(0, 5);
    p.restoreUsage(saved, clock.now);
    const times = p.memSpark('flobi-brand').times;
    assert.equal(times.length, 10);
    assert.equal(new Set(times).size, 10);
  });
});

test('a saved line that is missing, malformed or from the future is ignored', () => {
  withPipeline((p, clock) => {
    for (const bad of [null, undefined, 'x', { cpu: { 'flobi-brand': { unit: 'furlongs', points: [[T0, 0.5], [T0, 0.6]] } } }, { mem: { 'flobi-brand': [[T0 + 5 * MIN, 0.5], ['x', 1], [T0, 'y']] } }]) p.restoreUsage(bad, clock.now);
    assert.equal(p.serviceCpu.size, 0);
    assert.equal(p.serviceMem.size, 0);
  });
});

test('a deploy in the last hour is marked on its service, an autoscaler resize is not', () => {
  withPipeline((p, clock) => {
    clock.now = T0 + 90 * MIN;
    const ev = (name, message, minsAgo) => ({ kind: 'Deployment', name, reason: 'ScalingReplicaSet', message, at: clock.now - minsAgo * MIN });
    p.events = [
      ev('flobi-notes', 'Scaled up replica set flobi-notes-aaa to 2', 32),
      ev('flobi-notes', 'Scaled down replica set flobi-notes-bbb to 0 from 2', 30),
      ev('flobi-ai', 'Scaled up replica set flobi-ai-ccc to 3', 20), // the same replica set growing: the autoscaler
      ev('flobi-users', 'Scaled up replica set flobi-users-ddd to 1', 66),
      ev('flobi-users', 'Scaled down replica set flobi-users-eee to 0 from 1', 58),
    ];
    const marks = p.recentDeploys(clock.now);
    assert.deepEqual(marks.get('flobi-notes'), [clock.now - 32 * MIN]);
    assert.equal(marks.has('flobi-ai'), false);
    assert.equal(marks.has('flobi-users'), false, 'over an hour ago: off the card');
  });
});

test('deploysOf finds the same deploys the recap always did', () => {
  const e = (objectName, message, at) => ({ reason: 'ScalingReplicaSet', objectKind: 'Deployment', objectName, message, at });
  assert.deepEqual(deploysOf([e('a', 'Scaled up replica set a-new to 2', 0), e('a', 'Scaled down replica set a-old to 0 from 2', 2 * MIN)]), [{ service: 'a', at: 0, rs: 'a-new' }]);
  assert.deepEqual(deploysOf([e('a', 'Scaled up replica set a-new to 2', 0), e('a', 'Scaled down replica set a-old to 0 from 2', 20 * MIN)]), [], 'too far apart to be one rollout');
});
