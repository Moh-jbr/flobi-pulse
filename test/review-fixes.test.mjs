import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Alarm } from '../electron/core/engine/alarm.mjs';
import { AlertBook } from '../electron/core/engine/alerts.mjs';
import { Pipeline } from '../electron/core/engine/pipeline.mjs';
import { TrafficStats } from '../electron/core/engine/traffic.mjs';
import { workloadFromPodName } from '../electron/core/engine/normalize.mjs';
import { summarizeEvent } from '../electron/core/engine/model.mjs';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

// A fake clock with timers, for the alarm.
function clock() {
  let t = 0;
  const timers = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => {
      const h = { fn, at: t + ms };
      timers.push(h);
      return h;
    },
    clearTimer: (h) => {
      const i = timers.indexOf(h);
      if (i >= 0) timers.splice(i, 1);
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const h = timers[0];
        if (!h || h.at > end) break;
        timers.shift();
        t = h.at;
        h.fn();
      }
      t = end;
    },
  };
}

test('a recovering critical alert stays in the siren quietly and rings again if its problem returns', () => {
  const c = clock();
  const plays = [];
  let open = true;
  let recovering = false;
  const alarm = new Alarm({ play: (kind) => plays.push([c.now(), kind]), stillRinging: () => open, sounding: () => open && !recovering, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
  alarm.ring(['a']);
  recovering = true; // the service came back for a moment (a crash loop's ready blip)
  c.advance(20_000);
  assert.equal(alarm.ringing, true, 'kept, in case the problem returns');
  assert.equal(alarm.audible, false);
  alarm.chime();
  assert.deepEqual(plays.map((p) => p[1]), ['critical', 'warning'], 'a quiet siren doesn’t block a warning chime');
  recovering = false; // …and it's back within the hold
  c.advance(20_000);
  assert.deepEqual(plays.filter((p) => p[1] === 'critical').map((p) => p[0]), [0, 40_000]);
  open = false; // resolved for good
  c.advance(20_000);
  assert.equal(alarm.ringing, false);
  // Still capped: 10 minutes from its first ring, recovering or not.
  const plays2 = [];
  const c2 = clock();
  const alarm2 = new Alarm({ play: (k) => plays2.push(c2.now()), stillRinging: () => true, sounding: () => true, now: c2.now, setTimer: c2.setTimer, clearTimer: c2.clearTimer });
  alarm2.ring(['b']);
  c2.advance(15 * MIN);
  assert.ok(Math.max(...plays2) < 10 * MIN);
});

test('an acknowledged crash loop stays one alert while it keeps crashing, and closes 30 min after the last crash', () => {
  let t = 0;
  const opened = [];
  const book = new AlertBook({ now: () => t, onOpen: (a, meta) => opened.push([t, a.id, meta.escalated]) });
  const crash = () => book.happen({ key: 'crash:flobi-brand-x/brand', kind: 'crash', service: 'flobi-brand', severity: 'critical', title: 'brand ran out of memory' });
  const a = crash();
  book.ack(a.id);
  for (let i = 1; i <= 60; i++) {
    t = i * 2 * MIN; // a crash every 2 minutes, for 2 hours
    crash();
    book.reconcile([]);
  }
  assert.equal(opened.length, 1, 'no new notification every 30 minutes');
  assert.equal(book.active.get('crash:flobi-brand-x/brand').acked, true);
  t += 29 * MIN;
  book.reconcile([]);
  assert.ok(book.active.has('crash:flobi-brand-x/brand'));
  t += 2 * MIN;
  book.reconcile([]);
  assert.equal(book.active.has('crash:flobi-brand-x/brand'), false);
});

test('a Sentry issue that drops off the polled page and comes back still regressed is not news', () => {
  let t = 10 * DAY;
  const p = new Pipeline({ namespace: 'flobi', mode: 'demo', emit() {}, notify() {}, now: () => t });
  try {
    const issue = (substatus) => ({ id: '42', substatus, project: 'flobi-flow', title: 'TypeError: x is undefined', firstSeen: t - 2 * DAY, lastSeen: t, users: 3 });
    const regressedAlerts = () => [...p.alerts.active.values()].filter((a) => a.key === 'sentry-regressed:42').length;
    p.setSentry({ issues: [issue('regressed')] }); // primes: already regressed when the app opened
    t += MIN;
    p.setSentry({ issues: [] }); // fell off the first page
    t += MIN;
    p.setSentry({ issues: [issue('regressed')] });
    assert.equal(regressedAlerts(), 0);
    t += MIN;
    p.setSentry({ issues: [issue('ongoing')] });
    t += MIN;
    p.setSentry({ issues: [issue('regressed')] }); // a real change into regressed
    assert.equal(regressedAlerts(), 1);
  } finally {
    p.destroy();
  }
});

test('Job and DaemonSet pod names are not mistaken for a Deployment’s', () => {
  // Kubernetes builds the replica set hash and the pod suffix from consonants and 2,4–9 only.
  assert.equal(workloadFromPodName('migrate-database-x2x9z'), null);
  assert.equal(workloadFromPodName('node-exporter-x2x9z'), null);
  assert.equal(workloadFromPodName('flobi-gateway-5c8f7d9b4c-kq2vx'), 'flobi-gateway');
  assert.equal(workloadFromPodName('bull-cleanup-29230000-x2x9z'), 'bull-cleanup');
});

test('a request with an unreadable timestamp is not counted as recent traffic', () => {
  const stats = new TrafficStats({ now: 0 });
  const now = 1_790_000_000_000;
  stats.add({ ts: NaN, status: 500, latencyMs: 12, service: 'gateway', host: 'api.flobi.ai', path: '/x' });
  stats.add({ ts: now - 1000, status: 200, latencyMs: 12, service: 'gateway', host: 'api.flobi.ai', path: '/y' });
  const snap = stats.snapshot(now);
  assert.equal(snap.rpm, 1);
});

test('an event whose source is an object (raw events, demo mode) shows as text', () => {
  const e = summarizeEvent({ metadata: { uid: 'u1', name: 'x.1' }, type: 'Warning', reason: 'BackOff', message: 'Back-off restarting failed container', involvedObject: { kind: 'Pod', name: 'flobi-brand-x' }, source: { component: 'kubelet', host: 'node-1' }, lastTimestamp: new Date(0).toISOString(), count: 2 });
  assert.equal(typeof e.source, 'string');
  assert.equal(e.source, 'kubelet');
});
