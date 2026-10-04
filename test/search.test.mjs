import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, deepSearch, snippet } from '../src/lib/search.js';

const NOW = Date.UTC(2026, 9, 4, 0, 0);
const data = {
  services: [
    { name: 'flobi-brand', short: 'brand', health: 'degraded', reasons: ['Memory at 94% of limit'], hosts: ['brand.flobi.ai'] },
    { name: 'flobi-gateway', short: 'gateway', health: 'healthy', reasons: [], hosts: ['api.flobi.ai'] },
  ],
  alerts: { history: [{ id: 'a1', title: 'brand restarted 3× (out of memory)', detail: 'OOMKilled', service: 'flobi-brand', severity: 'critical', openedAt: NOW - 60_000, view: { to: 'crashes' } }] },
  errors: { backend: [{ id: 'g1', service: 'flobi-brand', title: 'TypeError: cannot read properties of undefined (reading "logo")', context: 'ExtractionService', count: 12, lastSeen: NOW - 5000, active: true }], frontend: [] },
  crashes: [{ id: 'c1', service: 'flobi-brand', pod: 'flobi-brand-7d9-abcde', reason: 'OOMKilled', exitCode: 137, at: NOW - 120_000 }],
  events: [{ id: 'e1', reason: 'BackOff', kind: 'Pod', name: 'flobi-brand-7d9-abcde', message: 'Back-off restarting failed container', type: 'Warning', service: 'flobi-brand', at: NOW - 30_000 }],
  pods: [{ name: 'flobi-brand-7d9-abcde', service: 'flobi-brand', state: 'crash', status: 'CrashLoopBackOff', node: 'gke-pool-1' }],
  nodes: [{ name: 'gke-pool-1', ready: true }],
  uptime: [{ id: 'u1', name: 'Sites', url: 'https://sites.flobi.ai/', group: 'frontend', state: 'down', error: 'DNS lookup failed', fromPages: 'flobi-sites' }],
  pages: [{ name: 'flobi-sites', domains: ['sites.flobi.ai'], latest: { status: 'failure', message: 'Add site theme presets', createdAt: NOW - 3600_000 } }],
  logs: [
    { id: 'l1', ts: NOW - 50_000, service: 'flobi-gateway', pod: 'gw-1', level: 'INFO', text: 'GET /health 200' },
    { id: 'l2', ts: NOW - 40_000, service: 'flobi-brand', pod: 'flobi-brand-7d9-abcde', level: 'ERROR', text: 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory' },
    { id: 'l3', ts: NOW - 10_000, service: 'flobi-brand', pod: 'flobi-brand-7d9-abcde', level: 'WARN', text: 'Heap used 1.86 GB of 2.00 GB limit' },
  ],
  traffic: [
    { id: 'r1', ts: NOW - 20_000, method: 'POST', host: 'api.flobi.ai', path: '/brand/extract', status: 503, service: 'flobi-gateway', ip: '104.22.40.133', latencyMs: 30 },
    { id: 'r2', ts: NOW - 15_000, method: 'GET', host: 'api.flobi.ai', path: '/health', status: 401, service: 'flobi-gateway', ip: '104.22.40.133', latencyMs: 12 },
    { id: 'r3', ts: NOW - 5_000, method: 'POST', host: 'api.flobi.ai', path: '/brand/extract', status: 200, service: 'flobi-gateway', ip: '10.0.0.4', latencyMs: 900 },
  ],
};
const ids = (r) => Object.fromEntries(r.groups.map((g) => [g.id, g.items.map((i) => i.key)]));

test('a query is words that must all appear, plus filters', () => {
  assert.deepEqual(parseQuery('Brand  STATUS:5xx "heap out" level:warning in:log'), { terms: ['brand', 'heap out'], filters: { status: '5xx', level: 'warn', in: 'logs' } });
  assert.deepEqual(parseQuery('http://x:80/a'), { terms: ['http://x:80/a'], filters: {} }, 'an unknown key: is just a word');
  assert.deepEqual(parseQuery(''), { terms: [], filters: {} });
});

test('one word finds it everywhere it appears', () => {
  const r = ids(deepSearch('brand', data));
  assert.deepEqual(r.services, ['s:flobi-brand']);
  assert.deepEqual(r.issues, ['a:a1']);
  assert.deepEqual(r.errors, ['e:g1']);
  assert.deepEqual(r.crashes, ['c:c1']);
  assert.deepEqual(r.events, ['ev:e1']);
  assert.deepEqual(r.pods, ['p:flobi-brand-7d9-abcde']);
  assert.deepEqual(r.logs, ['l:l3', 'l:l2'], 'newest first');
  assert.deepEqual(r.requests, ['r:r3', 'r:r1']);
});

test('every word has to match, in any order', () => {
  const r = ids(deepSearch('memory heap', data));
  assert.deepEqual(r.logs, ['l:l2']);
  assert.equal(r.services, undefined, 'brand says "memory" but not "heap"');
  assert.deepEqual(ids(deepSearch('"heap out"', data)).logs, ['l:l2'], 'quoted words together');
});

test('it looks inside messages, IPs, status codes, exit codes and URLs', () => {
  assert.deepEqual(ids(deepSearch('104.22.40.133', data)).requests, ['r:r2', 'r:r1']);
  assert.deepEqual(ids(deepSearch('exit 137', data)).crashes, ['c:c1']);
  assert.deepEqual(ids(deepSearch('back-off', data)).events, ['ev:e1']);
  assert.deepEqual(ids(deepSearch('logo', data)).errors, ['e:g1']);
  assert.deepEqual(ids(deepSearch('sites.flobi.ai', data)).endpoints, ['u:u1']);
  assert.deepEqual(ids(deepSearch('theme presets', data)).pages, ['pg:flobi-sites']);
});

test('filters narrow it down', () => {
  assert.deepEqual(ids(deepSearch('status:5xx', data)), { requests: ['r:r1'] }, 'status keeps only requests');
  assert.deepEqual(ids(deepSearch('status:401', data)), { requests: ['r:r2'] });
  assert.deepEqual(ids(deepSearch('level:error', data)), { logs: ['l:l2'] }, 'level keeps only log lines');
  assert.deepEqual(ids(deepSearch('heap service:gateway', data)), {});
  assert.deepEqual(Object.keys(ids(deepSearch('brand in:logs', data))), ['logs']);
  assert.deepEqual(ids(deepSearch('extract service:gateway status:2xx', data)), { requests: ['r:r3'] });
});

test('a group shows a few and counts all, and its link carries the words', () => {
  const many = { traffic: Array.from({ length: 40 }, (_, i) => ({ id: `r${i}`, ts: NOW - i, method: 'GET', host: 'api.flobi.ai', path: '/health', status: 500, service: 'flobi-gateway' })) };
  const g = deepSearch('health status:5xx', many).groups[0];
  assert.equal(g.total, 40);
  assert.equal(g.items.length, 5);
  assert.deepEqual(g.more.navigate, { to: 'traffic', filter: { q: 'health', status: '5xx' } });
  const logs = deepSearch('heap service:brand level:warn', data).groups[0];
  assert.deepEqual(logs.more.navigate, { to: 'logs', q: 'heap', service: 'flobi-brand', level: 'WARN' });
});

test('a long line is cut around what was found', () => {
  const text = `${'x'.repeat(300)} the needle is here ${'y'.repeat(300)}`;
  const s = snippet(text, ['needle']);
  assert.ok(s.includes('needle'));
  assert.ok(s.startsWith('…') && s.endsWith('…'));
  assert.ok(s.length < 130);
});

test('the same alert or event raised again is one result with a count', () => {
  const again = {
    alerts: { history: [1, 2, 3].map((i) => ({ id: `a${i}`, key: 'probe:face', title: 'face-detection: Health checks failing', detail: 'Client.Timeout', openedAt: NOW - i * 60_000 })) },
    events: [1, 2].map((i) => ({ id: `e${i}`, reason: 'Unhealthy', kind: 'Pod', name: 'face-1', message: 'Client.Timeout exceeded', type: 'Warning', at: NOW - i * 1000 })),
  };
  const r = deepSearch('timeout', again);
  const issues = r.groups.find((g) => g.id === 'issues');
  assert.equal(issues.total, 1);
  assert.equal(issues.items[0].key, 'a:a1', 'the newest');
  assert.match(issues.items[0].sub, /^3 times · /);
  const events = r.groups.find((g) => g.id === 'events');
  assert.equal(events.total, 1);
  assert.match(events.items[0].sub, /^2 times · /);
});
