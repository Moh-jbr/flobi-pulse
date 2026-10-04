import { test } from 'node:test';
import assert from 'node:assert/strict';
import { podStatus, podState, workloadOf, buildModel, serviceHealth, makeRouter } from '../electron/core/engine/model.mjs';
import { normalizeEntry } from '../electron/core/engine/normalize.mjs';
import { detectLevel, parseNest, isStackFrame } from '../electron/core/engine/log-parse.mjs';
import { ErrorBook, fingerprint, normalizeMessage } from '../electron/core/engine/errors.mjs';
import { AlertBook } from '../electron/core/engine/alerts.mjs';
import { buildRecap, episodes, serviceFromObject } from '../electron/core/engine/recap.mjs';
import { TrafficStats } from '../electron/core/engine/traffic.mjs';
import { Pipeline } from '../electron/core/engine/pipeline.mjs';
import { summarizeInstance } from '../electron/core/sources/cloudsql.mjs';
import { parseBackendName } from '../electron/core/engine/backend-name.mjs';

const iso = (ms) => new Date(ms).toISOString();

function pod(name, { ready = true, waiting, lastTerminated, restarts = 0, phase = 'Running', app = 'flobi-brand', hash = '7d9f8c6b5' } = {}) {
  return {
    metadata: { name, uid: name, labels: { app, 'pod-template-hash': hash }, ownerReferences: [{ kind: 'ReplicaSet', name: `${app}-${hash}` }], creationTimestamp: iso(Date.now() - 3600_000) },
    spec: { nodeName: 'n1', containers: [{ name: app, resources: { limits: { memory: '2Gi', cpu: '1500m' }, requests: { cpu: '500m' } } }] },
    status: {
      phase,
      startTime: iso(Date.now() - 3600_000),
      conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }],
      containerStatuses: [
        {
          name: app,
          ready,
          restartCount: restarts,
          state: waiting ? { waiting: { reason: waiting } } : { running: { startedAt: iso(Date.now() - 60_000) } },
          lastState: lastTerminated ? { terminated: { reason: lastTerminated, exitCode: 137, finishedAt: iso(Date.now() - 30_000) } } : {},
        },
      ],
    },
  };
}

test('pod status mirrors kubectl', () => {
  assert.equal(podStatus(pod('a')), 'Running');
  assert.equal(podStatus(pod('b', { ready: false })), 'NotReady');
  assert.equal(podStatus(pod('c', { ready: false, waiting: 'CrashLoopBackOff', lastTerminated: 'OOMKilled' })), 'CrashLoopBackOff');
  assert.equal(podState('CrashLoopBackOff', pod('c')), 'bad');
  assert.equal(workloadOf(pod('flobi-brand-7d9f8c6b5-x2x9z')), 'flobi-brand');
});

test('service health: down, degraded, healthy', () => {
  const deployment = (name, replicas, ready) => ({ metadata: { name, uid: name, generation: 1 }, spec: { replicas, selector: { matchLabels: { app: name } }, containers: [{ name, resources: { limits: { memory: '2Gi' } } }] }, status: { replicas, readyReplicas: ready, updatedReplicas: replicas, observedGeneration: 1 } });
  const m = buildModel({
    deployments: [deployment('flobi-brand', 2, 1), deployment('flobi-drive', 2, 0), deployment('flobi-users', 2, 2)],
    pods: [
      pod('flobi-brand-7d9f8c6b5-aaaaa'),
      pod('flobi-brand-7d9f8c6b5-bbbbb', { ready: false, waiting: 'CrashLoopBackOff', lastTerminated: 'OOMKilled', restarts: 3 }),
      pod('flobi-users-1234567890-ccccc', { app: 'flobi-users', hash: '1234567890' }),
      pod('flobi-users-1234567890-ddddd', { app: 'flobi-users', hash: '1234567890' }),
    ],
  });
  const by = Object.fromEntries(m.services.map((s) => [s.name, s]));
  assert.equal(by['flobi-brand'].health, 'degraded');
  assert.ok(by['flobi-brand'].reasons.some((r) => /CrashLoopBackOff \(OOMKilled\)/.test(r)));
  assert.equal(by['flobi-drive'].health, 'down');
  assert.equal(by['flobi-users'].health, 'healthy');
  assert.equal(serviceHealth({ desired: 0, podList: [] }).health, 'idle');
});

test('router picks the longest matching ingress path', () => {
  const route = makeRouter([
    { host: 'api.flobi.ai', path: '/', workload: 'flobi-gateway' },
    { host: 'api.flobi.ai', path: '/z/', workload: 'flobi-zip-service' },
    { host: 'api.flobi.ai', path: '/drive/stream-zip', workload: 'flobi-downloads' },
  ]);
  assert.equal(route('api.flobi.ai', '/z/abc'), 'flobi-zip-service');
  assert.equal(route('api.flobi.ai', '/drive/stream-zip?id=1'), 'flobi-downloads');
  assert.equal(route('api.flobi.ai', '/users/me'), 'flobi-gateway');
  assert.equal(route('other.host', '/'), null);
});

test('backend service names map to Kubernetes services', () => {
  assert.deepEqual(parseBackendName('k8s1-8f2c1a9b-flobi-flobi-gateway-80-q7w8e9r0', 'flobi'), { namespace: 'flobi', service: 'flobi-gateway', port: 80 });
  assert.equal(parseBackendName('something-else', 'flobi'), null);
});

test('normalizes load balancer and container entries', () => {
  const req = normalizeEntry(
    {
      insertId: 'i1',
      timestamp: '2026-09-25T03:02:11.250Z',
      resource: { type: 'http_load_balancer', labels: { backend_service_name: 'k8s1-8f2c1a9b-flobi-flobi-gateway-80-q7w8e9r0' } },
      httpRequest: { requestMethod: 'POST', requestUrl: 'https://api.flobi.ai/brand/extract?x=1', status: 503, latency: '1.250s', responseSize: '120' },
      jsonPayload: { statusDetails: 'response_sent_by_backend' },
    },
    { namespace: 'flobi' },
  );
  assert.equal(req.kind, 'request');
  assert.equal(req.service, 'flobi-gateway');
  assert.equal(req.path, '/brand/extract?x=1');
  assert.equal(req.latencyMs, 1250);
  assert.equal(req.status, 503);

  const log = normalizeEntry({ resource: { type: 'k8s_container', labels: { pod_name: 'flobi-brand-x', container_name: 'flobi-brand' } }, textPayload: '[Nest] 1  - 09/25/2026, 3:02:11 AM   ERROR [BrandService] boom', severity: 'ERROR' }, { namespace: 'flobi' });
  assert.equal(log.kind, 'log');
  assert.equal(log.level, 'ERROR');
  assert.equal(log.service, 'flobi-brand');
});

test('level detection trusts text markers over GKE stderr severity', () => {
  assert.equal(detectLevel('[Nest] 1  - 09/25/2026, 3:02:11 AM     LOG [App] ok', 'ERROR'), 'INFO');
  assert.equal(detectLevel('[Nest] 1  - 09/25/2026, 3:02:11 AM    WARN [App] hmm', 'INFO'), 'WARN');
  assert.equal(detectLevel('plain stderr line', 'ERROR'), 'WARN');
  assert.equal(detectLevel('{"level":50}', 'INFO', { level: 50 }), 'ERROR');
  assert.equal(detectLevel('TypeError: x is undefined', 'INFO'), 'ERROR');
  assert.deepEqual(parseNest('[Nest] 1  - 09/25/2026, 3:02:11 AM   ERROR [BrandService] boom'), { context: 'BrandService', message: 'boom' });
  assert.ok(isStackFrame('    at BrandService.extract (/app/dist/brand.service.js:120:15)'));
});

test('error grouping ignores ids, numbers and timestamps', () => {
  const a = normalizeMessage('S3 upload failed for file_9wf2gpglg7: ECONNRESET after 3021ms');
  const b = normalizeMessage('S3 upload failed for file_zz81kd02aa: ECONNRESET after 17ms');
  assert.equal(a, b);
  assert.equal(fingerprint('flobi-drive', 'User 3f6c1a2e-1111-2222-3333-444455556666 not found'), fingerprint('flobi-drive', 'User 9a9a9a9a-aaaa-bbbb-cccc-dddddddddddd not found'));
  assert.notEqual(fingerprint('flobi-drive', 'x failed'), fingerprint('flobi-brand', 'x failed'));
});

test('ErrorBook groups, attaches stack frames, and baselines the first run', () => {
  const now = Date.now();
  const first = new ErrorBook({ known: {} });
  const r = first.add({ level: 'ERROR', text: 'boom 1', service: 's', pod: 'p', ts: now });
  assert.equal(r.isNewGroup, false, 'first run: nothing is "new"');
  first.add({ level: 'ERROR', text: '    at X (/app/a.js:1:2)', service: 's', pod: 'p', ts: now + 5 });
  first.add({ level: 'ERROR', text: 'boom 2', service: 's', pod: 'p2', ts: now + 10 });
  const sum = first.summary(now + 20);
  assert.equal(sum.length, 1);
  assert.equal(sum[0].count, 2);
  assert.equal(sum[0].stack.length, 1);
  assert.equal(sum[0].isNew, false);

  const later = new ErrorBook({ known: first.known });
  assert.equal(later.add({ level: 'ERROR', text: 'boom 3', service: 's', pod: 'p', ts: now }).isNewGroup, false);
  assert.equal(later.add({ level: 'ERROR', text: 'totally different failure', service: 's', pod: 'p', ts: now }).isNewGroup, true);
});

test('AlertBook opens once, resolves when the condition clears, dedupes one-shots', () => {
  const opened = [];
  const resolved = [];
  let now = 0;
  const book = new AlertBook({ now: () => now, onOpen: (a) => opened.push(a.key), onResolve: (a) => resolved.push(a.key) });
  const cond = { key: 'svc-down:x', kind: 'service', service: 'x', severity: 'critical', title: 'x is down' };
  book.reconcile([cond]);
  book.reconcile([cond]);
  assert.deepEqual(opened, ['svc-down:x']);
  book.reconcile([]);
  now += 60_000; // resolves once the condition has stayed clear for the hold
  book.reconcile([]);
  assert.deepEqual(resolved, ['svc-down:x']);
  book.happen({ key: 'crash:1', severity: 'critical', title: 'crash' });
  book.happen({ key: 'crash:1', severity: 'critical', title: 'crash' });
  assert.equal(book.summary().active.find((a) => a.key === 'crash:1').count, 2);
  book.mute('x', 60);
  book.reconcile([cond]);
  assert.equal(book.summary().active.find((a) => a.key === 'svc-down:x').muted, true);
});

test('episodes merge adjacent hot buckets', () => {
  const pts = [0, 1, 2, 5, 6, 10].map((m) => ({ t: m * 60_000, v: 1 }));
  const eps = episodes(pts, 60, () => true, 1);
  assert.equal(eps.length, 3);
  assert.equal(serviceFromObject('Pod', 'flobi-brand-7d9f8c6b5-x2x9z'), 'flobi-brand');
  assert.equal(serviceFromObject('ReplicaSet', 'flobi-brand-7d9f8c6b5'), 'flobi-brand');
});

test('recap rebuilds incidents from free sources only (logs, pods, Cloud SQL, Sentry)', async () => {
  const since = Date.UTC(2026, 8, 24, 23, 0);
  const until = Date.UTC(2026, 8, 25, 9, 0);
  const at = (h, m, s = 0) => Date.UTC(2026, 8, 25, h, m, s);
  const ev = (t, type, reason, message, kind, name) => ({ logName: 'projects/p/logs/events', timestamp: iso(t), jsonPayload: { type, reason, message, involvedObject: { kind, name, namespace: 'flobi' }, lastTimestamp: iso(t) } });
  const lb5xx = Array.from({ length: 120 }, (_, i) => ({
    timestamp: iso(at(3, 5) + i * 1000),
    resource: { type: 'http_load_balancer', labels: { backend_service_name: 'k8s1-8f2c1a9b-flobi-flobi-gateway-80-q7w8e9r0' } },
    httpRequest: { requestMethod: 'GET', requestUrl: 'https://api.flobi.ai/v1/brands', status: 502, latency: '0.01s' },
    jsonPayload: { statusDetails: 'failed_to_connect_to_backend' },
  }));
  const dbErr = (t, container) => ({ timestamp: iso(t), severity: 'ERROR', resource: { type: 'k8s_container', labels: { namespace_name: 'flobi', container_name: container, pod_name: `${container}-abc` } }, textPayload: '[Nest] 1  - 09/25/2026, 4:30:00 AM   ERROR [TypeOrmModule] Unable to connect to the database. Retrying (3)...' });
  const calls = [];
  const logging = {
    listAll: async ({ filter }) => {
      calls.push(filter);
      if (filter.includes('logs/events'))
        return [
          ev(at(4, 0), 'Warning', 'FailedScheduling', '0/3 nodes are available: insufficient memory', 'Pod', 'flobi-media-worker-7c9d8f6b5d-bbbbb'),
          ev(at(5, 0), 'Warning', 'BackOff', 'Back-off restarting failed container flobi-notes in pod flobi-notes-6b7c8d9f2f-zzzzz', 'Pod', 'flobi-notes-6b7c8d9f2f-zzzzz'),
          ev(at(6, 0), 'Normal', 'ScalingReplicaSet', 'Scaled up replica set flobi-notes-aaaa to 1', 'Deployment', 'flobi-notes'),
          ev(at(6, 2), 'Normal', 'ScalingReplicaSet', 'Scaled down replica set flobi-notes-bbbb to 0 from 1', 'Deployment', 'flobi-notes'),
        ];
      if (filter.includes('http_load_balancer')) return lb5xx;
      if (filter.includes('cloudsql_database')) return [{ timestamp: iso(at(4, 31)), textPayload: 'FATAL:  remaining connection slots are reserved for non-replication superuser connections' }];
      if (filter.includes('k8s_container')) return [...Array.from({ length: 6 }, (_, i) => dbErr(at(4, 30, i * 20), 'flobi-brand')), ...Array.from({ length: 6 }, (_, i) => dbErr(at(4, 30, i * 20 + 5), 'flobi-auth'))];
      return [];
    },
  };
  const cloudsql = {
    instances: async () => [{ name: 'flobi-db' }],
    operations: async () => [
      { id: 'op1', type: 'MAINTENANCE', label: 'Maintenance', instance: 'flobi-db', startedAt: at(2, 0), endedAt: at(2, 4), disruptive: true, failed: false },
      { id: 'op2', type: 'BACKUP_VOLUME', label: 'Backup', instance: 'flobi-db', startedAt: at(1, 0), endedAt: at(1, 3), disruptive: false, failed: false },
    ],
  };
  const pods = [{ name: 'flobi-brand-7d9f8c6b5-x2x9z', service: 'flobi-brand', restarts: 5, createdAt: since - 2 * 86_400_000, lastTermination: { reason: 'OOMKilled', exitCode: 137, at: at(3, 5) } }];
  const restartSnapshot = { at: since + 30_000, pods: { 'flobi-brand-7d9f8c6b5-x2x9z': { service: 'flobi-brand', restarts: 2 } } };
  const sentry = { configured: true, issuesSince: async () => [{ id: '1', project: 'flobi-flow', title: 'TypeError: x', count: 10, users: 3, level: 'error', firstSeen: at(7, 0), lastSeen: at(8, 0) }] };

  const r = await buildRecap({ since, until, namespace: 'flobi', projectId: 'p', logging, cloudsql, pods, restartSnapshot, sentry, knownErrors: { a: 1 } });
  const titles = r.incidents.map((i) => i.title);
  const all = titles.join(' | ');
  assert.ok(titles.some((t) => /^brand restarted 3× \(out of memory\)$/.test(t)), all);
  assert.ok(titles.some((t) => /^notes restarted \(crash loop\)$/.test(t)), all);
  assert.ok(titles.some((t) => /^gateway: 120 failed requests$/.test(t)), all);
  assert.match(r.incidents.find((i) => i.kind === 'http').detail, /couldn't reach the pods/);
  assert.ok(titles.some((t) => t === "Services couldn't reach the database"), all);
  assert.ok(titles.some((t) => /Database ran out of connections/.test(t)), all);
  assert.ok(titles.some((t) => t === 'Cloud SQL flobi-db: Maintenance'), all);
  assert.ok(!titles.some((t) => /Backup/.test(t)), 'successful backups are not incidents');
  assert.ok(titles.some((t) => /media-worker: Pods couldn't be scheduled/.test(t)), all);
  assert.ok(titles.some((t) => /1 new frontend error in flobi-flow/.test(t)), all);
  assert.equal(r.deploys.length, 1);
  assert.equal(r.summary.restarts, 4);
  assert.equal(r.summary.restartsExact, false);
  assert.equal(r.summary.requests, null);
  assert.equal(r.summary.failedRequests, 120);
  assert.ok(r.summary.critical >= 2);
  assert.ok(!calls.some((f) => /monitoring/i.test(f)));
});

test('recap ignores a restart snapshot from a different time', async () => {
  const since = Date.UTC(2026, 8, 24, 23, 0);
  const until = since + 3 * 3600_000;
  const pods = [{ name: 'flobi-api-1-abcde', service: 'flobi-api', restarts: 9, createdAt: since - 86_400_000, lastTermination: { reason: 'Error', exitCode: 1, at: since + 3600_000 } }];
  const r = await buildRecap({ since, until, namespace: 'flobi', projectId: 'p', pods, restartSnapshot: { at: since - 86_400_000, pods: { 'flobi-api-1-abcde': { restarts: 0 } } } });
  assert.equal(r.summary.restarts, 1);
  assert.equal(r.summary.restartsExact, false);
  assert.match(r.incidents[0].title, /^api restarted \(crashed, exit code 1\)$/);
});

test('traffic stats compute rates and percentiles', () => {
  const t = new TrafficStats();
  const now = Date.now();
  for (let i = 0; i < 100; i++) t.add({ ts: now - i * 100, status: i < 5 ? 503 : 200, latencyMs: i, service: 'flobi-gateway', host: 'api.flobi.ai', path: '/x' });
  const s = t.snapshot(now);
  assert.equal(s.rpm, 100);
  assert.equal(s.byClass['5xx'], 5);
  assert.equal(s.errorRate, 0.05);
  assert.equal(s.p50, 49);
  assert.equal(s.byService[0].service, 'flobi-gateway');
});

test('traffic history is counted per minute from the live stream', () => {
  const start = Date.UTC(2026, 8, 25, 10, 0, 30);
  const t = new TrafficStats({ now: start });
  for (let i = 0; i < 180; i++) t.add({ ts: start + 30_000 + i * 1000, status: i % 60 === 0 ? 500 : 200, service: 'flobi-gateway', host: 'api.flobi.ai', path: '/x' });
  const h = t.history(start + 30_000 + 180_000 + 1000);
  // 10:00 is partial (app opened at 10:00:30) so it's skipped; 10:01, 10:02, 10:03 are complete.
  assert.deepEqual(h.series.map((x) => x.total), [60, 60, 60]);
  assert.deepEqual(h.series.map((x) => x.e5), [1, 1, 1]);
  assert.deepEqual(h.spark['flobi-gateway'], [60, 60, 60]);
  assert.equal(h.series[0].t, Date.UTC(2026, 8, 25, 10, 2));
});

test('database: apps failing to connect flag the database as unreachable', () => {
  const now = Date.now();
  const p = new Pipeline({ namespace: 'flobi', emit: () => {}, mode: 'demo', now: () => now });
  try {
    p.setDatabase({ instances: [summarizeInstance({ name: 'flobi-db', region: 'europe-west1', state: 'RUNNABLE', databaseVersion: 'POSTGRES_16', settings: { tier: 'db-custom-2-8192', availabilityType: 'REGIONAL', activationPolicy: 'ALWAYS', maintenanceWindow: { day: 7, hour: 3 } } }, 'p')], status: 'ok' });
    let v = p.databaseView(now);
    assert.equal(v.instances[0].status, 'up');
    assert.equal(v.instances[0].version, 'PostgreSQL 16');
    assert.equal(v.instances[0].maintenanceWindow, 'Sun 03:00 UTC');
    assert.equal(v.reachability.unreachable, false);
    const line = (service, text) => ({ kind: 'log', ts: now - 5000, level: 'ERROR', service, text });
    p.ingest([line('flobi-brand', "Error: connect ECONNREFUSED 10.1.0.3:5432"), line('flobi-brand', 'GET /health 200')]);
    assert.equal(p.databaseView(now).reachability.last2m, 1);
    p.ingest([1, 2, 3].map(() => line('flobi-auth', "PrismaClientInitializationError: Can't reach database server at `10.1.0.3`:`5432`")));
    p.ingest([line('flobi-brand', 'Connection terminated unexpectedly')]);
    v = p.databaseView(now);
    assert.equal(v.reachability.unreachable, true);
    assert.equal(p.health().overall, 'outage');
    const stopped = summarizeInstance({ name: 'x', state: 'RUNNABLE', settings: { activationPolicy: 'NEVER' } }, 'p');
    assert.equal(stopped.down, true);
    assert.equal(summarizeInstance({ name: 'y', state: 'MAINTENANCE', settings: {} }, 'p').status, 'maintenance');
  } finally {
    p.destroy();
  }
});

test('pod CPU and memory history comes from metrics-server samples', () => {
  let now = Date.UTC(2026, 8, 25, 10, 0);
  const p = new Pipeline({ namespace: 'flobi', emit: () => {}, mode: 'demo', now: () => now });
  try {
    p.model.pods = [{ name: 'flobi-brand-1-aaaaa', service: 'flobi-brand' }];
    for (let i = 0; i < 4; i++) {
      p.setMetrics({ pods: [{ metadata: { name: 'flobi-brand-1-aaaaa' }, containers: [{ name: 'flobi-brand', usage: { cpu: `${250 * (i + 1)}m`, memory: '512Mi' } }] }], at: now });
      now += 15_000;
    }
    const u = p.usage({ service: 'flobi-brand' });
    assert.equal(u.cpu[0].points.length, 4);
    assert.deepEqual(u.cpu[0].points.map((x) => x.v), [0.25, 0.5, 0.75, 1]);
    assert.equal(u.memory[0].points[0].v, 512 * 2 ** 20);
    assert.deepEqual(p.usage({ service: 'other' }).cpu, []);
    assert.equal(p.restartSnapshot(), null, 'no snapshot before pods are synced');
  } finally {
    p.destroy();
  }
});

test('a Google certificate that failed behind Cloudflare only alerts if the sites are actually down', async () => {
  const { certificateImpact, evaluateConditions } = await import('../electron/core/engine/alerts.mjs');
  const cert = { name: 'flobi-certificate', status: 'ProvisioningFailedPermanently', domains: [{ domain: 'api.flobi.ai', status: 'FailedNotVisible' }, { domain: 'ws.flobi.ai', status: 'FailedNotVisible' }] };
  const up = (host, state) => ({ id: host, url: `https://${host}/health`, state });
  const model = { services: [], pods: [], nodes: [], scaling: [], certificates: [cert] };
  const run = (uptime) => evaluateConditions({ model, traffic: { byService: [] }, uptime, database: {}, cloudRun: [], cloudflare: {}, errorRates: {} }).filter((c) => c.kind === 'certificate');
  assert.equal(certificateImpact(cert, [up('api.flobi.ai', 'up'), up('ws.flobi.ai', 'slow')]).harmless, true);
  assert.equal(run([up('api.flobi.ai', 'up'), up('ws.flobi.ai', 'up')]).length, 0);
  assert.equal(run([up('api.flobi.ai', 'up'), up('ws.flobi.ai', 'pending')]).length, 0, 'waits for the first uptime check');
  assert.equal(run([up('api.flobi.ai', 'up'), up('ws.flobi.ai', 'down')]).length, 1);
  assert.equal(run([up('api.flobi.ai', 'up')]).length, 1, 'a domain nobody checks still alerts');
  assert.equal(run([up('api.flobi.ai', 'up'), up('ws.flobi.ai', 'up')].map((u) => u)).length, 0);
  const caa = { ...cert, domains: [{ domain: 'api.flobi.ai', status: 'FailedCaaForbidden' }] };
  assert.equal(certificateImpact(caa, [up('api.flobi.ai', 'up')]).harmless, false);
});

test('Cloudflare: uses whichever analytics dataset the plan allows, and remembers it', async () => {
  const { CloudflareClient, summarizeEdge, zoneErrorGroups, EDGE_QUERY, EDGE_ADAPTIVE_QUERY } = await import('../electron/core/sources/cloudflare.mjs');
  const now = Date.UTC(2026, 8, 25, 12, 0);
  const iso = (m) => new Date(now - m * 60_000).toISOString();
  const adaptive = {
    zoneTag: 'z1',
    byMinute: [
      { count: 90, sum: { edgeResponseBytes: 9000 }, dimensions: { datetimeMinute: iso(5), edgeResponseStatus: 200 } },
      { count: 7, sum: { edgeResponseBytes: 70 }, dimensions: { datetimeMinute: iso(5), edgeResponseStatus: 522 } },
      { count: 3, sum: { edgeResponseBytes: 30 }, dimensions: { datetimeMinute: iso(30), edgeResponseStatus: 503 } },
    ],
    byCountry: [{ count: 60, dimensions: { clientCountryName: 'LB' } }, { count: 40, dimensions: { clientCountryName: 'AE' } }],
    byCache: [{ count: 25, dimensions: { cacheStatus: 'hit' } }, { count: 75, dimensions: { cacheStatus: 'dynamic' } }],
  };
  const client = new CloudflareClient({ token: 't' });
  const asked = [];
  client.graphql = async (query) => {
    asked.push(query === EDGE_QUERY ? '1m' : query === EDGE_ADAPTIVE_QUERY ? 'adaptive' : 'other');
    if (query === EDGE_QUERY) throw new Error("Cloudflare analytics: zone 'z1' does not have access to the path");
    if (query === EDGE_ADAPTIVE_QUERY) return { viewer: { zones: [adaptive] } };
    throw new Error("Cloudflare analytics: zone 'z1' does not have access to the path"); // per-host errors locked too
  };
  const t = await client.traffic(['z1'], now);
  assert.equal(t.mode, 'adaptive');
  const sum = summarizeEdge(t.zones.get('z1'), 'flobi.ai');
  assert.equal(sum.totals.requests, 100);
  assert.equal(sum.totals.s52x, 7);
  assert.equal(sum.totals.s5xx, 10);
  assert.equal(sum.totals.cached, 25);
  assert.equal(sum.totals.bytes, 9100);
  assert.equal(sum.topCountries[0].country, 'LB');
  assert.equal(sum.series.length, 2);
  await client.traffic(['z1'], now);
  assert.deepEqual(asked, ['1m', 'adaptive', 'adaptive'], "doesn't keep asking for a dataset the plan doesn't have");

  const r = await client.errorsByHost([{ id: 'z1', name: 'flobi.ai' }], now - 15 * 60_000, now, t);
  assert.equal(r.perHost, false);
  assert.deepEqual(r.zones[0].httpRequestsAdaptiveGroups.map((g) => [g.dimensions.clientRequestHTTPHost, g.dimensions.edgeResponseStatus, g.count]), [['flobi.ai', 522, 7]]);
  assert.deepEqual(zoneErrorGroups(t.zones.get('z1'), 'flobi.ai', 0).length, 2);

  const denied = new CloudflareClient({ token: 't' });
  denied.graphql = async () => {
    throw new Error("Cloudflare analytics: zone 'z1' does not have access to the path");
  };
  await assert.rejects(denied.traffic(['z1'], now), /does not have access/);
  const flaky = new CloudflareClient({ token: 't' });
  flaky.graphql = async () => {
    throw new Error('Cloudflare analytics: rate limited');
  };
  await assert.rejects(flaky.traffic(['z1'], now), /rate limited/);
});

test('a service stopped by hand (scaled to 0, no autoscaler) is down, not idle', () => {
  let now = Date.UTC(2026, 8, 25, 12, 0);
  const p = new Pipeline({ namespace: 'flobi', emit: () => {}, mode: 'demo', now: () => now });
  try {
    const dep = (name, replicas) => ({ metadata: { name, namespace: 'flobi', uid: name, generation: 1 }, spec: { replicas, selector: { matchLabels: { app: name } }, template: { spec: { containers: [{ name }] } } }, status: { replicas, readyReplicas: replicas, updatedReplicas: replicas, availableReplicas: replicas, observedGeneration: 1 } });
    const hpa = { metadata: { name: 'flobi-media-worker' }, spec: { scaleTargetRef: { kind: 'Deployment', name: 'flobi-media-worker' }, minReplicas: 0, maxReplicas: 5 }, status: { currentReplicas: 0, desiredReplicas: 0 } };
    p.raw.hpas = [hpa];
    p.raw.deployments = [dep('flobi-director', 2), dep('flobi-media-worker', 1), dep('flobi-old', 0)];
    p.rebuild();
    const h = (n) => p.model.services.find((s) => s.name === n)?.health;
    assert.equal(h('flobi-director'), 'healthy');
    assert.equal(h('flobi-old'), 'idle', 'already at 0 before the app started');
    now += 60_000;
    p.raw.deployments = [dep('flobi-director', 0), dep('flobi-media-worker', 0), dep('flobi-old', 0)];
    p.rebuild();
    assert.equal(h('flobi-director'), 'down');
    assert.match(p.model.services.find((s) => s.name === 'flobi-director').reasons[0], /Stopped: scaled to 0/);
    assert.equal(h('flobi-media-worker'), 'idle', 'its autoscaler scaled it to zero');
    assert.ok(p.alerts.summary().active.some((a) => a.key === 'svc-down:flobi-director'));
    now += 60_000;
    p.raw.deployments = [dep('flobi-director', 2), dep('flobi-media-worker', 0), dep('flobi-old', 0)];
    p.rebuild();
    assert.equal(h('flobi-director'), 'healthy');
  } finally {
    p.destroy();
  }
});

test('a service stopped before the app opened is caught from the scale-down event', () => {
  const now = Date.UTC(2026, 8, 25, 12, 0);
  const p = new Pipeline({ namespace: 'flobi', emit: () => {}, mode: 'demo', now: () => now });
  try {
    p.raw.deployments = [{ metadata: { name: 'flobi-director', namespace: 'flobi', uid: 'd' }, spec: { replicas: 0, selector: { matchLabels: { app: 'flobi-director' } }, template: { spec: { containers: [{ name: 'flobi-director' }] } } }, status: {} }];
    p.setK8s('events', [{ metadata: { uid: 'e1' }, type: 'Normal', reason: 'ScalingReplicaSet', message: 'Scaled down replica set flobi-director-7d9f8c6b5 to 0 from 2', involvedObject: { kind: 'Deployment', name: 'flobi-director' }, lastTimestamp: new Date(now - 5 * 60_000).toISOString() }]);
    p.rebuild();
    assert.equal(p.model.services.find((s) => s.name === 'flobi-director').health, 'down');
  } finally {
    p.destroy();
  }
});

test('certificate warning is explained from DNS: Cloudflare in front, or not in DNS at all', async () => {
  const { certificateImpact } = await import('../electron/core/engine/alerts.mjs');
  const { isCloudflareIp, lookupDomain } = await import('../electron/core/sources/dns.mjs');
  assert.equal(isCloudflareIp('104.21.58.163'), true);
  assert.equal(isCloudflareIp('172.67.161.211'), true);
  assert.equal(isCloudflareIp('2606:4700:3032::6815:3fbc'), true);
  assert.equal(isCloudflareIp('34.117.10.20'), false);
  assert.equal(isCloudflareIp('2600:1901::1'), false);
  const fake = (map) => async (d) => {
    if (!(d in map)) throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' });
    return map[d].map((address) => ({ address }));
  };
  const lk = fake({ 'api.flobi.ai': ['104.21.58.163', '172.67.161.211'], 'direct.flobi.ai': ['34.117.10.20'] });
  assert.deepEqual(await lookupDomain('api.flobi.ai', lk), { addresses: ['104.21.58.163', '172.67.161.211'], none: false, cloudflare: true });
  assert.equal((await lookupDomain('handoff.zip', lk)).none, true);
  assert.equal(await lookupDomain('x', async () => { throw Object.assign(new Error('t'), { code: 'ETIMEOUT' }); }), null);

  const cert = { name: 'flobi-certificate', status: 'ProvisioningFailedPermanently', domains: ['api.flobi.ai', 'ws.flobi.ai', 'handoff.zip'].map((domain) => ({ domain, status: 'FailedNotVisible' })) };
  const dnsInfo = new Map([
    ['api.flobi.ai', { none: false, cloudflare: true }],
    ['ws.flobi.ai', { none: false, cloudflare: true }],
    ['handoff.zip', { none: true, cloudflare: false }],
  ]);
  const r = certificateImpact(cert, [], dnsInfo);
  assert.equal(r.harmless, true);
  assert.match(r.reason, /api\.flobi\.ai and ws\.flobi\.ai point at Cloudflare/);
  assert.match(r.reason, /handoff\.zip isn’t in DNS at all/);
  // A domain that points straight at Google and still failed is a real problem.
  const direct = { ...cert, domains: [{ domain: 'direct.flobi.ai', status: 'FailedNotVisible' }] };
  assert.equal(certificateImpact(direct, [], new Map([['direct.flobi.ai', { none: false, cloudflare: false }]])).harmless, false);
  // Before the first DNS answers: wait, don't alert.
  assert.equal(certificateImpact(cert, [], new Map()).waiting, true);
});

test('a service says which of its figures made it unhealthy', () => {
  const base = { desired: 2, ready: 2, updated: 2, podList: [], recentRestarts: 0, memPct: 0.4 };
  assert.deepEqual(serviceHealth(base).causes, []);
  assert.deepEqual(serviceHealth({ ...base, memPct: 0.95 }).causes, ['mem']);
  assert.deepEqual(serviceHealth({ ...base, ready: 1 }).causes, ['pods']);
  assert.deepEqual(serviceHealth({ ...base, recentRestarts: 2 }).causes, ['restarts']);
  const hot = serviceHealth({ ...base, scaling: { atMax: true, max: 4, cpuTarget: 70, cpuNow: 95 } });
  assert.deepEqual(hot.causes, ['cpu']);
  assert.equal(hot.health, 'degraded');
});

test("a service's CPU line is its busiest pod's usage against its limit, per poll, like the card's figure", () => {
  let now = Date.UTC(2026, 9, 3, 10, 0);
  const p = new Pipeline({ namespace: 'flobi', emit: () => {}, mode: 'demo', now: () => now });
  try {
    p.model.pods = [
      { name: 'flobi-brand-1-aaaaa', service: 'flobi-brand', cpuLimit: 1000, cpuRequest: 100 },
      { name: 'flobi-brand-1-bbbbb', service: 'flobi-brand', cpuLimit: 1000, cpuRequest: 100 },
      { name: 'flobi-ai-1-ccccc', service: 'flobi-ai', cpuLimit: 0, cpuRequest: 0 },
    ];
    const use = (name, cpu) => ({ metadata: { name }, containers: [{ name: 'app', usage: { cpu, memory: '1Mi' } }] });
    for (let i = 0; i < 3; i++) {
      p.setMetrics({ pods: [use('flobi-brand-1-aaaaa', `${100 * (i + 1)}m`), use('flobi-brand-1-bbbbb', '100m'), use('flobi-ai-1-ccccc', '250m')], at: now });
      now += 15_000;
    }
    const brand = p.cpuSpark('flobi-brand');
    assert.equal(brand.unit, 'pct');
    assert.deepEqual(brand.points.map((v) => Math.round(v * 1000) / 1000), [0.1, 0.2, 0.3], 'the busier pod, not the two averaged');
    const ai = p.cpuSpark('flobi-ai');
    assert.equal(ai.unit, 'cores', 'no limit or request: cores, not a made-up %');
    assert.deepEqual(ai.points, [0.25, 0.25, 0.25]);
    assert.equal(p.cpuSpark('flobi-users'), null);
    // An hour later the oldest points are gone.
    now += 60 * 60_000;
    p.setMetrics({ pods: [use('flobi-brand-1-aaaaa', '100m'), use('flobi-brand-1-bbbbb', '100m')], at: now });
    assert.equal(p.cpuSpark('flobi-brand'), null, 'one fresh point is not a line');
    assert.equal(p.serviceCpu.has('flobi-ai'), false);
  } finally {
    p.destroy();
  }
});
