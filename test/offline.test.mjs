// Offline: before anything that got no answer is called down, the app makes sure this computer is
// online (either of two always-up addresses answering, after the failure). Offline, nothing turns
// red and no alert opens or closes, so nothing beeps; back online it carries on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Connectivity, PROBES } from '../electron/core/net/connectivity.mjs';
import { UptimeMonitor } from '../electron/core/sources/uptime.mjs';
import { Pipeline } from '../electron/core/engine/pipeline.mjs';
import { CostsWatcher, POLL_MS } from '../electron/core/engine/costs.mjs';
import { VersionsWatcher } from '../electron/core/engine/versions.mjs';
import { checkRequest, resetGuard, ReadOnlyViolation } from '../electron/core/net/guard.mjs';

const T0 = Date.UTC(2026, 8, 29, 9);
const settle = () => new Promise((r) => setImmediate(r));

function connectivity(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const env = { now: T0, answers: { [PROBES[0]]: false, [PROBES[1]]: false }, tries: [], changes: [] };
  env.c = new Connectivity({
    probe: async (u) => (env.tries.push(u), env.answers[u]),
    now: () => env.now,
    onChange: (s) => env.changes.push({ ...s }),
  });
  return env;
}

test('connectivity: after a failure the two addresses decide; either answering is online, neither offline', async (t) => {
  const e = connectivity(t);
  const { c } = e;
  assert.equal(c.online, true);
  // Something failed: both addresses are tried, and neither answers.
  assert.equal(await c.check({ since: T0 }), false);
  assert.deepEqual(e.tries.sort(), [...PROBES].sort());
  assert.deepEqual(e.changes, [{ online: false, since: T0, checkedAt: T0 }]);
  // Another failure a moment later is no news: nothing tried again.
  e.now += 2_000;
  assert.equal(await c.offline({ since: e.now }), true);
  assert.equal(e.tries.length, 2);
  // Offline, it looks again every 10 seconds; one address answering is enough to be back.
  e.answers[PROBES[1]] = true;
  e.now += 8_000;
  t.mock.timers.tick(10_000);
  await settle();
  await settle();
  assert.equal(c.online, true);
  assert.deepEqual(e.changes.at(-1), { online: true, since: null, checkedAt: T0 + 10_000 });
  // Online: a look taken after the failure is reused, one from before it isn't.
  e.tries.length = 0;
  assert.equal(await c.check({ since: T0 + 9_000 }), true);
  assert.equal(e.tries.length, 0);
  e.answers[PROBES[1]] = false;
  e.now += 60_000;
  // Two failures at once: one look.
  const [a, b] = await Promise.all([c.check({ since: e.now }), c.check({ since: e.now })]);
  assert.deepEqual([a, b], [false, false]);
  assert.equal(e.tries.length, 2);
  c.stop();
});

test('connectivity: when the network changes, a new check has the last word over one on its way', async (t) => {
  const e = connectivity(t);
  const { c } = e;
  const pending = [];
  c.tryOne = () => new Promise((r) => pending.push(r));
  const old = c.check({ since: T0 }); // tried while the Wi-Fi was coming back
  const fresh = c.check({ since: T0 + 1, force: true });
  assert.equal(pending.length, 4, 'not joined: both addresses tried again');
  pending[2](true); // the new check gets an answer
  assert.equal(await fresh, true);
  pending[0](false); // the old one gives up afterwards
  pending[1](false);
  assert.equal(await old, false);
  assert.equal(c.online, true, 'the newer answer stands');
  assert.deepEqual(e.changes, []);
  c.stop();
});

test('connectivity: only the two addresses, GET only, nothing sent', () => {
  resetGuard();
  for (const url of PROBES) assert.equal(checkRequest({ method: 'GET', url, headers: { 'user-agent': 'x', 'cache-control': 'no-cache' } }), true);
  assert.deepEqual(PROBES, ['https://www.gstatic.com/generate_204', 'https://cloudflare.com/cdn-cgi/trace']);
  assert.throws(() => checkRequest({ method: 'POST', url: PROBES[0], body: 'x' }), ReadOnlyViolation);
  assert.throws(() => checkRequest({ method: 'GET', url: `${PROBES[0]}?x=1` }), ReadOnlyViolation);
  assert.throws(() => checkRequest({ method: 'GET', url: 'https://www.gstatic.com/other' }), ReadOnlyViolation);
  assert.throws(() => checkRequest({ method: 'GET', url: 'https://cloudflare.com/' }), ReadOnlyViolation);
});

test('uptime: a failure without a whole answer is checked against the connection first; offline, it counts for nothing', async () => {
  const results = [];
  const asked = [];
  let offline = true;
  let answers = { a: { error: 'DNS lookup failed', code: 'ENOTFOUND', ms: 3 }, b: { error: 'No response in 10s', ms: 10_000 }, c: { status: 200, error: 'The response was cut off', ms: 400 } };
  const m = new UptimeMonitor({
    targets: [
      { id: 'a', name: 'API', url: 'https://api.example.test/health' },
      { id: 'b', name: 'App', url: 'https://app.example.test/' },
      { id: 'c', name: 'Home', url: 'https://www.example.test/' },
    ],
    onResult: (t, r) => results.push([t.id, r.state, r.error ?? null]),
    isOffline: async (o) => (asked.push(o), offline),
    check: async (url) => answers[url.includes('api.') ? 'a' : url.includes('app.') ? 'b' : 'c'],
  });
  const before = Date.now();
  await m.round();
  assert.deepEqual(results, [
    ['a', 'offline', 'This computer is offline'],
    ['b', 'offline', 'This computer is offline'],
    ['c', 'offline', 'This computer is offline'],
  ]);
  assert.equal(asked.length, 1, 'one look for the whole round');
  assert.ok(asked[0].since >= before && asked[0].since <= Date.now(), 'taken after the first failure');
  // Online after all: they're down.
  results.length = 0;
  offline = false;
  await m.round();
  assert.deepEqual(results.map(([id, s]) => [id, s]), [['a', 'down'], ['b', 'down'], ['c', 'down']]);
  // Sites that answered (even with an error page) are judged as they are, without asking.
  results.length = asked.length = 0;
  answers = { a: { status: 503, ms: 80 }, b: { status: 200, ms: 90 }, c: { status: 200, ms: 70 } };
  await m.round();
  assert.deepEqual(results.map(([id, s]) => [id, s]), [['a', 'down'], ['b', 'up'], ['c', 'up']]);
  assert.equal(asked.length, 0);
});

function livePipeline() {
  const clock = { now: T0 };
  const sent = [];
  const trouble = [];
  const p = new Pipeline({ namespace: 'flobi', emit: () => {}, mode: 'live', now: () => clock.now, notify: (a) => sent.push(a), onTrouble: () => trouble.push(clock.now) });
  return { p, clock, sent, trouble };
}
const site = { id: 'api', name: 'API', url: 'https://api.example.test/health', group: 'backend' };
const down = (at) => ({ at, state: 'down', error: 'No response in 10s', ms: 10_000 });

test('pipeline: offline, nothing is called down and no alert opens or closes; back online it carries on', () => {
  const { p, clock, trouble } = livePipeline();
  try {
    p.setUptimeTargets([site]);
    p.setSource('kubernetes', 'ok');
    p.setSource('live', 'streaming');
    p.setSource('sentry', 'off', 'Add a Sentry token');
    // A source that just failed: main is asked to check the connection.
    p.setSource('live', 'error', 'read ECONNRESET');
    assert.equal(trouble.length, 1);
    p.setConnectivity({ online: false, since: T0 });
    const h = p.health();
    assert.deepEqual([h.overall, h.headline, h.offlineSince], ['offline', 'You’re offline', T0]);
    const sources = p.section('sources');
    assert.deepEqual([sources.kubernetes.status, sources.live.status, sources.sentry.status], ['offline', 'offline', 'off'], 'gray, not red; what’s off stays off');
    p.setSource('cloudsql', 'error', 'getaddrinfo ENOTFOUND sqladmin.googleapis.com');
    assert.equal(trouble.length, 1, 'already known to be offline');
    // Offline results count for nothing; even "down" ones open no alert while offline.
    p.setUptime(site, { at: clock.now, state: 'offline', error: 'This computer is offline' });
    p.setUptime(site, { at: clock.now, state: 'offline', error: 'This computer is offline' });
    assert.equal(p.uptime.get('api').failStreak, 0);
    p.setUptime(site, down((clock.now += 30_000)));
    p.setUptime(site, down((clock.now += 30_000)));
    p.rebuild();
    assert.equal(p.alerts.summary().active.length, 0, 'no alert, no beeping');
    // Back online: what's really wrong is an alert again.
    p.setConnectivity({ online: true });
    assert.notEqual(p.health().overall, 'offline');
    assert.equal(p.section('sources').live.status, 'error');
    p.rebuild();
    assert.deepEqual(p.alerts.summary().active.map((a) => a.key), ['uptime:api']);
    // Still failing (a new message) isn't new trouble; failing again after a reconnect is.
    p.setSource('live', 'error', 'read ETIMEDOUT');
    assert.equal(trouble.length, 1);
    p.setSource('live', 'connecting');
    p.setSource('live', 'error', 'read ECONNRESET');
    assert.equal(trouble.length, 2);
  } finally {
    p.destroy();
  }
});

test('pipeline: an alert open before going offline neither resolves nor re-alerts while offline', () => {
  const { p, clock, sent } = livePipeline();
  try {
    p.setUptimeTargets([site]);
    p.setUptime(site, down(clock.now));
    p.setUptime(site, down((clock.now += 30_000)));
    p.rebuild();
    const open = p.alerts.summary().active.map((a) => a.id);
    assert.equal(open.length, 1);
    p.setConnectivity({ online: false });
    // Its condition can't be seen while offline: it doesn't count as fixed.
    p.setUptime(site, { at: (clock.now += 30_000), state: 'offline', error: 'This computer is offline' });
    for (let i = 0; i < 10; i++) {
      clock.now += 60_000;
      p.rebuild();
    }
    assert.deepEqual(p.alerts.summary().active.map((a) => a.id), open);
    assert.equal(p.alerts.summary().active[0].clearing, false);
    p.setConnectivity({ online: true });
    p.setUptime(site, down((clock.now += 30_000)));
    p.rebuild();
    assert.deepEqual(p.alerts.summary().active.map((a) => a.id), open, 'the same alert, not a new one');
    assert.equal(sent.length, 0, 'nothing sent again (demo notifications wait for the grace period)');
  } finally {
    p.destroy();
  }
});

test('costs: a read that got no answer while offline keeps the last numbers, and all is read again a minute later', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clock = { t: Date.UTC(2026, 8, 16, 12) };
  let offline = true;
  let failWith = Object.assign(new Error('getaddrinfo ENOTFOUND api.cloudflare.com'), { code: 'ENOTFOUND' });
  const reads = [];
  const asked = [];
  const ok = { status: 'ok', subscriptions: [{ id: 'p', name: 'Pro', price: 25, frequency: 'monthly', charged: true }] };
  const w = new CostsWatcher({
    readers: {
      cloudflare: { key: 'cloudflare:x', read: async () => (reads.push('cloudflare'), ok) },
      fal: {
        key: 'fal',
        read: async () => {
          reads.push('fal');
          if (failWith) throw failWith;
          return { status: 'ok', months: {} };
        },
      },
    },
    saved: { vendors: { fal: { key: 'fal', status: 'ok', okAt: clock.t - 3_600_000, months: { '2026-09': { USD: { lines: { flux: 3 } } } } } } },
    now: () => clock.t,
    isOffline: async (o) => (asked.push(o), offline),
  });
  w.refresh();
  await settle();
  await settle();
  assert.equal(w.vendors.fal.status, 'ok', 'not shown as an error');
  assert.deepEqual(w.vendors.fal.months, { '2026-09': { USD: { lines: { flux: 3 } } } }, 'the last numbers stay');
  assert.equal(w.vendors.fal.refreshing, false);
  assert.equal(asked.length, 1);
  assert.equal(w.nextPollAt, clock.t + 60_000, 'read again in a minute, not in 6 hours');
  // Back online: read again, the next one 6 hours later.
  offline = false;
  failWith = null;
  reads.length = 0;
  clock.t += 60_000;
  t.mock.timers.tick(60_000);
  await settle();
  await settle();
  assert.deepEqual(reads.sort(), ['cloudflare', 'fal']);
  assert.equal(w.nextPollAt, clock.t + POLL_MS);
  // Online, an error that got no answer is still one (checked, then said).
  failWith = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  clock.t += 120_000;
  w.refresh();
  await settle();
  await settle();
  assert.equal(w.vendors.fal.status, 'error');
  assert.match(w.vendors.fal.message, /ECONNRESET/);
  // One that answered (an HTTP status, a known problem) isn't checked against the connection.
  asked.length = 0;
  failWith = Object.assign(new Error('HTTP 401'), { status: 401 });
  clock.t += 120_000;
  w.refresh();
  await settle();
  await settle();
  assert.equal(asked.length, 0);
  assert.equal(w.vendors.fal.status, 'error');
  w.stop();
});

test('versions: a look that got no answer while offline changes nothing on the page', async () => {
  let offline = true;
  let fail = false;
  const changes = [];
  const w = new VersionsWatcher({
    client: {
      manifest: async () => ({ owner: 'o', repos: { a: { product: 'A' }, b: { product: 'B' } } }),
      releases: async (name) => {
        if (fail) throw Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com'), { code: 'ENOTFOUND' });
        return [{ tag_name: `${name}-v1.0.0`, name: '1.0.0', published_at: '2026-09-01T10:00:00Z', body: '' }];
      },
    },
    manifestRepo: 'm',
    manifestPath: 'repos.json',
    onChange: (s) => changes.push(s),
    now: () => T0,
    isOffline: async () => offline,
  });
  await w.poll();
  const shown = w.state;
  assert.equal(shown.status, 'ok');
  assert.equal(shown.repos.length, 2);
  fail = true;
  await w.poll();
  assert.equal(w.state, shown, 'the same as before, no errors');
  assert.equal(changes.length, 1);
  // Online after all: the errors are real.
  offline = false;
  await w.poll();
  assert.equal(changes.length, 2);
  assert.ok(w.state.repos.every((r) => /ENOTFOUND/.test(r.error)));
});
