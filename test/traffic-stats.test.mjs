import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TrafficStats } from '../electron/core/engine/traffic.mjs';
import { normalizeEntry } from '../electron/core/engine/normalize.mjs';

const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 25, 10, 0, 0);

test('B13: status 0 (the client left before any response) counts as 4xx, not 5xx', () => {
  const req = normalizeEntry({ timestamp: new Date(T0 - 1000).toISOString(), resource: { type: 'http_load_balancer', labels: {} }, httpRequest: { requestMethod: 'GET', requestUrl: 'https://api.flobi.ai/drive/stream-zip' }, jsonPayload: { statusDetails: 'client_disconnected_before_any_response' } }, { namespace: 'flobi' });
  assert.equal(req.status, 0, 'a missing status stays 0');
  const t = new TrafficStats({ now: T0 - 5 * MIN });
  t.add({ ...req, service: 'flobi-downloads' });
  t.add({ ts: T0 - 900, status: 503, latencyMs: 10, service: 'flobi-downloads', host: 'api.flobi.ai', path: '/x' });
  t.add({ ts: T0 - 800, status: 200, latencyMs: 10, service: 'flobi-downloads', host: 'api.flobi.ai', path: '/x' });
  const s = t.snapshot(T0);
  assert.deepEqual(s.byClass, { '2xx': 1, '3xx': 0, '4xx': 1, '5xx': 1 });
  assert.equal(s.errorRate, 1 / 3);
  assert.equal(s.byService[0].err5xx, 1);
  assert.equal(s.byService[0].err4xx, 1);
  assert.deepEqual(Object.keys(s.failureDetails), [], 'a client disconnect is not a server failure');
  const h = t.history(T0 + MIN);
  assert.deepEqual(h.series.find((r) => r.t === T0), { t: T0, total: 3, e4: 1, e5: 1 });
});

test('B14: snapshot numbers (windows, percentiles, order, top paths, per second)', () => {
  const t = new TrafficStats({ now: T0 - 10 * MIN });
  const add = (ago, service, host, path, status, latencyMs, statusDetails) => t.add({ ts: T0 - ago, service, host, path, status, latencyMs, statusDetails });
  add(250_000, 'flobi-a', 'api', '/x', 200, 100);
  add(100_000, 'flobi-b', 'api', '/y?q=1', 503, 300, 'backend_timeout');
  add(50_000, 'flobi-a', 'ws', '/x', 200, 10);
  add(40_000, 'flobi-b', 'api', '/y', 0, null, 'client_disconnected_before_any_response');
  add(30_000, null, 'api', '/files/1234', 404, 20);
  add(20_000, 'flobi-a', 'ws', '/x', 502, 40, 'response_sent_by_backend');
  add(10_000, 'flobi-b', 'api', '/y', 201, 30);
  const s = t.snapshot(T0);
  assert.equal(s.rpm, 5);
  assert.equal(s.rps, 5 / 60);
  assert.deepEqual(s.byClass, { '2xx': 2, '3xx': 0, '4xx': 2, '5xx': 1 });
  assert.equal(s.errorRate, 0.2);
  assert.equal(s.rate4xx, 0.4);
  assert.deepEqual([s.p50, s.p95, s.p99], [20, 40, 40]);
  assert.deepEqual(s.byService, [
    { service: 'flobi-a', rpm: 0.6, total: 3, err4xx: 0, err5xx: 1, p50: 40, p95: 100, total2m: 2, err5xx2m: 1 },
    { service: 'flobi-b', rpm: 0.6, total: 3, err4xx: 1, err5xx: 1, p50: 30, p95: 300, total2m: 3, err5xx2m: 1 },
    { service: 'unrouted', rpm: 0.2, total: 1, err4xx: 1, err5xx: 0, p50: 20, p95: 20, total2m: 1, err5xx2m: 0 },
  ]);
  assert.deepEqual(s.byHost, [
    { host: 'api', rpm: 3, err5xx: 0, err4xx: 2 },
    { host: 'ws', rpm: 2, err5xx: 1, err4xx: 0 },
  ]);
  assert.deepEqual(s.topPaths, [
    { path: 'api/y', count: 3, err5xx: 1, err4xx: 1, p95: 300 },
    { path: 'ws/x', count: 2, err5xx: 1, err4xx: 0, p95: 40 },
    { path: 'api/x', count: 1, err5xx: 0, err4xx: 0, p95: 100 },
    { path: 'api/files/:id', count: 1, err5xx: 0, err4xx: 1, p95: 20 },
  ]);
  assert.deepEqual(s.failureDetails, { backend_timeout: 1, response_sent_by_backend: 1 });
  assert.equal(s.perSecond.length, 120);
  assert.equal(s.perSecond[119].t, T0);
  assert.deepEqual([s.perSecond[109].c2, s.perSecond[99].c5, s.perSecond[79].c4, s.perSecond[19].c5], [1, 1, 1, 1]);
  assert.equal(s.perSecond.reduce((a, r) => a + r.c2 + r.c3 + r.c4 + r.c5, 0), 6);
  assert.equal(s.lastRequestAt, T0 - 10_000);
  // The oldest request leaves the 5-minute window.
  assert.equal(t.snapshot(T0 + 60_000).byService.find((x) => x.service === 'flobi-a').total, 2);
});

test('B14: only the 25 busiest paths, and at most `cap` requests', () => {
  const t = new TrafficStats({ now: T0 - 10 * MIN, cap: 1000 });
  for (let i = 0; i < 1500; i++) t.add({ ts: T0 - 60_000 + i * 10, status: 200, latencyMs: i, service: 's', host: 'h', path: `/p${i % 40}` });
  const s = t.snapshot(T0);
  assert.equal(s.byService[0].total, 1000, 'the oldest 500 went');
  assert.equal(s.topPaths.length, 25);
  assert.ok(s.topPaths.every((p) => p.count === 25));
  assert.deepEqual(s.topPaths.slice(0, 3).map((p) => p.path), ['h/p20', 'h/p21', 'h/p22'], 'ties: first seen first');
});

test('B14: a snapshot of 60,000 requests is cheap', () => {
  const services = Array.from({ length: 30 }, (_, i) => `flobi-svc-${i}`);
  const hosts = ['api.flobi.ai', 'ws.flobi.ai', 'agents.flobi.ai', 'handoff.zip', 'yjs.flobi.ai'];
  const fill = (n) => {
    const t = new TrafficStats({ now: T0 - 10 * MIN });
    for (let i = 0; i < n; i++) t.add({ ts: T0 - 299_000 + Math.floor((i / n) * 299_000), status: i % 97 === 0 ? 503 : i % 23 === 0 ? 404 : 200, latencyMs: (i * 7919) % 1500, service: services[(i * 31) % 30], host: hosts[i % 5], path: `/p${i % 300}/${i}`, statusDetails: 'response_sent_by_backend' });
    return t;
  };
  // The app snapshots every second, so the code is warm after its first moments.
  const warm = fill(5000);
  for (let k = 0; k < 20; k++) warm.snapshot(T0 + k);
  const t = fill(60_000);
  const times = [];
  for (let k = 0; k < 9; k++) {
    const start = performance.now();
    const s = t.snapshot(T0 + k);
    times.push(performance.now() - start);
    assert.equal(s.byService.length, 30);
  }
  times.sort((a, b) => a - b);
  assert.ok(times[4] < 50, `typical snapshot took ${times[4].toFixed(1)} ms`);
});
