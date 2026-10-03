// Demo mode: a simulated copy of the Flobi platform that produces the same
// Kubernetes objects and Cloud Logging entries the real APIs return, and feeds
// them through the same pipeline. No credentials, no network. Pure JS.
import { normalizeEntry, k8sLogLine } from './normalize.mjs';
import { fmtDuration } from './recap.mjs';
import { loadPastWeek, processSlice } from './backfill.mjs';
import { lastMonths, DEFAULT_COSTS } from './costs.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NS = 'flobi';
const iso = (ms) => new Date(ms).toISOString();

// Seeded PRNG so screenshots and demos look the same every run.
function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260925);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (a, b) => a + rand() * (b - a);
const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rand() * 16)]).join('');
const alnum = (n) => Array.from({ length: n }, () => 'bcdfghjklmnpqrstvwxz2456789'[Math.floor(rand() * 27)]).join('');

// name, replicas, memLimit(Mi), cpuReq(m), hpa [min,max] | 'keda', exposed routes
export const DEMO_SERVICES = [
  ['flobi-gateway', 2, 512, 250, [2, 10], ['api.flobi.ai/']],
  ['flobi-api-edge', 2, 512, 200, [2, 5], ['api.flobi.ai/v']],
  ['flobi-downloads', 2, 1024, 250, [2, 5], ['api.flobi.ai/drive/stream-zip', 'api.flobi.ai/handoff/stream-zip']],
  ['flobi-zip-service', 2, 512, 200, [2, 5], ['api.flobi.ai/z/']],
  ['flobi-nodes', 2, 2048, 500, [2, 15], ['ws.flobi.ai/']],
  ['flobi-agents', 2, 1536, 500, [2, 10], ['agents.flobi.ai/']],
  ['flobi-gateway-yjs', 1, 512, 200, null, ['yjs.flobi.ai/']],
  ['flobi-handoff', 2, 1024, 250, [2, 5], ['handoff.zip/']],
  ['flobi-brand', 2, 2048, 500, [2, 5], []],
  ['flobi-drive', 2, 512, 250, [2, 5], []],
  ['flobi-users', 2, 512, 200, [2, 5], []],
  ['flobi-billing', 2, 512, 200, [2, 4], []],
  ['flobi-projects', 2, 512, 200, [2, 5], []],
  ['flobi-notes', 2, 1024, 250, [2, 5], []],
  ['flobi-moodboard', 2, 512, 200, [2, 5], []],
  ['flobi-market', 2, 512, 200, [2, 4], []],
  ['flobi-marketplace', 2, 512, 200, [2, 4], []],
  ['flobi-admin', 2, 512, 150, [2, 3], []],
  ['flobi-audit', 2, 512, 150, [2, 3], []],
  ['flobi-apps', 2, 512, 200, [2, 5], []],
  ['flobi-apps-api', 1, 512, 200, 'keda', []],
  ['flobi-media', 2, 1024, 300, [2, 5], []],
  ['flobi-media-api', 2, 2048, 300, [2, 8], []],
  ['flobi-media-worker', 1, 4096, 1000, 'keda', []],
  ['flobi-storage-gateway', 2, 1024, 250, [2, 5], []],
  ['flobi-lumen', 1, 1024, 250, 'keda', []],
  ['flobi-lumen-agent-worker', 1, 1024, 250, 'keda', []],
  ['flobi-upscaler', 1, 1024, 500, 'keda', []],
  ['flobi-face-detection', 1, 3072, 1000, [1, 3], []],
  ['flobi-ai', 1, 2048, 500, null, []],
  ['flobi-artwork', 1, 1024, 300, null, []],
  ['flobi-director', 1, 1024, 250, null, []],
  ['flobi-fabric', 1, 1536, 300, null, []],
  ['flobi-ingest', 1, 3072, 500, null, []],
  ['flobi-jev', 1, 512, 150, null, []],
  ['rabbitmq', 1, 2048, 500, null, []],
  ['redis', 1, 1024, 250, null, []],
];

const CONTEXTS = {
  'flobi-gateway': ['RouterExplorer', 'AuthGuard', 'ProxyService', 'EventsGateway'],
  'flobi-brand': ['BrandService', 'ExtractionService', 'HeadlessRenderClient', 'BrandAgent'],
  'flobi-drive': ['DriveService', 'UploadService', 'FolderService'],
  'flobi-nodes': ['NodeRunner', 'FlowExecutor', 'SocketGateway'],
  'flobi-users': ['UsersService', 'ClerkWebhook', 'WorkspaceService'],
  'flobi-billing': ['BillingService', 'StripeWebhook', 'CreditsService'],
  'flobi-notes': ['NotesService', 'YjsPersistence', 'SharkAgent'],
  default: ['AppService', 'RmqConsumer', 'HealthController'],
};

const INFO_LINES = [
  'Handled {method} {path} {status} in {ms}ms',
  'Consumed message from {queue} ({ms}ms)',
  'Cache hit for {id}',
  'Published event {event} to flobi_exchange',
  'Job {id} completed in {ms}ms',
  'Health check OK',
  'Synced workspace ws_{id}',
];
const WARN_LINES = ['Slow query on {table}: {ms}ms', 'Retrying RabbitMQ publish (attempt 2/3)', 'Rate limit close for org_{id} (92%)', 'Deprecated header x-flobi-client used by {ua}'];
const ERRORS = {
  'flobi-brand': ['Failed to extract brand from https://{domain}/: Timeout after 30000ms', 'HeadlessRenderClient: page crashed while rendering logo sheet', 'OpenRouter 429 Too Many Requests for model {model}'],
  'flobi-drive': ['S3 upload failed for file_{id}: ECONNRESET', 'Folder fd_{id} not found for workspace ws_{id}'],
  'flobi-nodes': ['Run node_{id} failed: OpenRouter 429 Too Many Requests', 'Socket client disconnected unexpectedly (transport close)'],
  'flobi-users': ['Clerk JWT verification failed: token expired', 'Webhook user.updated for user_{id} failed: duplicate key value violates unique constraint "users_email_key"'],
  'flobi-billing': ['Stripe webhook signature verification failed', 'Insufficient credits for org_{id}: needed 40, have 12'],
  'flobi-notes': ['Yjs persistence failed for doc {id}: connection terminated unexpectedly', 'Shark agent step failed: tool call timeout after 60000ms'],
  'flobi-gateway': ['Upstream flobi-brand responded 503 for POST /brand/extract', 'TypeError: Cannot read properties of undefined (reading \'workspaceId\')'],
  'flobi-media-worker': ['Transcode job {id} failed: ffmpeg exited with code 1'],
  'flobi-handoff': ['Zip stream aborted by client after {ms}ms'],
};

// Unexpected exceptions as Nest prints them: its "ERROR [ExceptionsHandler]" line, then the
// exception and its stack frames. In GKE each of these lines is a log entry of its own.
const EXCEPTIONS = {
  'flobi-gateway': [
    "Cannot read properties of undefined (reading 'workspaceId')",
    "TypeError: Cannot read properties of undefined (reading 'workspaceId')",
    '    at WorkspaceGuard.canActivate (/app/dist/common/guards/workspace.guard.js:24:41)',
    '    at GuardsConsumer.tryActivate (/app/node_modules/@nestjs/core/guards/guards-consumer.js:15:34)',
    '    at canActivateFn (/app/node_modules/@nestjs/core/router/router-execution-context.js:134:59)',
    '    at /app/node_modules/@nestjs/core/router/router-execution-context.js:42:37',
    '    at /app/node_modules/@nestjs/core/router/router-proxy.js:9:23',
    '    at Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)',
    '    at next (/app/node_modules/express/lib/router/route.js:149:13)',
    '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
  ],
  'flobi-drive': [
    'duplicate key value violates unique constraint "files_folder_id_name_key"',
    'QueryFailedError: duplicate key value violates unique constraint "files_folder_id_name_key"',
    '    at PostgresQueryRunner.query (/app/node_modules/typeorm/driver/postgres/PostgresQueryRunner.js:219:19)',
    '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
    '    at async InsertQueryBuilder.execute (/app/node_modules/typeorm/query-builder/InsertQueryBuilder.js:106:33)',
    '    at async FilesService.create (/app/dist/files/files.service.js:88:24)',
    '    at async FilesController.upload (/app/dist/files/files.controller.js:41:22)',
    '    at async /app/node_modules/@nestjs/core/router/router-execution-context.js:46:28',
  ],
};

const PATHS = [
  ['GET', '/users/me', 'flobi-gateway', 30, 40],
  ['GET', '/drive/files?folder=fd_{id}', 'flobi-gateway', 60, 60],
  ['POST', '/drive/upload', 'flobi-gateway', 400, 20],
  ['GET', '/projects', 'flobi-gateway', 45, 25],
  ['GET', '/notes/{id}', 'flobi-gateway', 55, 30],
  ['POST', '/brand/extract', 'flobi-gateway', 2400, 6],
  ['GET', '/brand/{id}', 'flobi-gateway', 70, 18],
  ['GET', '/moodboard/boards', 'flobi-gateway', 80, 14],
  ['POST', '/billing/credits/quote', 'flobi-gateway', 90, 8],
  ['GET', '/market/templates', 'flobi-gateway', 110, 12],
  ['GET', '/v/styles/categories', 'flobi-api-edge', 35, 20],
  ['POST', '/v/generate', 'flobi-api-edge', 900, 6],
  ['GET', '/z/zip_{id}', 'flobi-zip-service', 600, 4],
  ['GET', '/drive/stream-zip?id={id}', 'flobi-downloads', 3200, 2],
];
const OTHER_HOSTS = [
  ['agents.flobi.ai', 'GET', '/socket.io/?EIO=4&transport=polling', 'flobi-agents', 25, 16],
  ['ws.flobi.ai', 'GET', '/api/v1/runs/{id}', 'flobi-nodes', 40, 12],
  ['handoff.zip', 'GET', '/t/{id}', 'flobi-handoff', 120, 8],
  ['handoff.zip', 'POST', '/api/transfers', 'flobi-handoff', 350, 3],
  ['yjs.flobi.ai', 'GET', '/health', 'flobi-gateway-yjs', 8, 3],
];
const UAS = ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/139.0', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/139.0 Edg/139.0', 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', 'node-fetch/1.0 (flobi-sites)'];

const fill = (s) =>
  s
    .replace(/\{id\}/g, () => alnum(10))
    .replace(/\{ms\}/g, () => String(Math.round(between(4, 900))))
    .replace(/\{domain\}/g, () => pick(['acme-coffee.com', 'northwind.io', 'studio-lumen.fr', 'bakehouse.co']))
    .replace(/\{model\}/g, () => pick(['anthropic/claude-sonnet', 'google/gemini-flash']))
    .replace(/\{queue\}/g, () => pick(['brand_queue', 'drive_queue', 'media_queue', 'nodes_queue']))
    .replace(/\{event\}/g, () => pick(['file.created', 'brand.updated', 'credits.spent']))
    .replace(/\{table\}/g, () => pick(['files', 'brand_assets', 'workspace_members']))
    .replace(/\{method\}/g, () => pick(['GET', 'POST']))
    .replace(/\{path\}/g, () => pick(['/files', '/me', '/boards']))
    .replace(/\{status\}/g, () => pick(['200', '200', '201']))
    .replace(/\{ua\}/g, () => pick(['flobi-flow/2.4', 'flobi-sites/1.9']));

const nestLine = (level, ctx, msg, ts) => {
  const d = new Date(ts);
  const stamp = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}, ${d.toLocaleTimeString('en-US')}`;
  return `[Nest] 1  - ${stamp}   ${level.padStart(5)} [${ctx}] ${msg}`;
};

export class DemoConnector {
  constructor({ pipeline, lastSeenAt }) {
    this.pipeline = pipeline;
    this.lastSeenAt = lastSeenAt;
    this.timers = [];
    this.followers = new Set();
    this.recentLogs = [];
    this.stopped = false;
    this.clock = () => Date.now();
    this.incident = { brand: null, mediaQueue: 0 };
  }

  start() {
    const p = this.pipeline;
    const now = this.clock();
    p.setSession({
      mode: 'demo',
      identity: { kind: 'demo', email: 'demo@flobi.ai', name: 'Demo mode' },
      projectId: 'flobi-prod-2026',
      namespace: NS,
      cluster: { name: 'flobi-cluster', location: 'europe-west1', endpoint: '34.140.0.1', version: 'v1.33.4-gke.1245000', source: 'demo' },
    });
    for (const k of ['kubernetes', 'metrics', 'cloudsql', 'uptime', 'cloudrun', 'sentry', 'cloudflare']) p.setSource(k, 'ok');
    p.setSource('live', 'streaming');
    this.buildCluster(now);
    this.pushK8s();
    this.seedHistory(now);
    this.seedTrafficHistory(now);
    this.seedUsage(now);
    this.tick(200, () => this.emitTraffic());
    this.tick(250, () => this.emitLogs());
    this.tick(3000, () => this.evolve());
    this.tick(15_000, () => this.emitMetrics());
    this.tick(30_000, () => this.emitUptime());
    this.tick(120_000, () => this.emitDatabase());
    this.emitMetrics();
    this.emitUptime();
    this.emitDatabase();
    this.emitSentry();
    this.emitCloudflare();
    p.setCloudRun([{ name: 'flobi-artwork-render', url: 'https://flobi-artwork-render-374098310188.europe-west1.run.app', ready: true, revision: 'flobi-artwork-render-00042-kiv', updatedAt: now - 2 * 24 * HOUR }]);
    const since = this.lastSeenAt && now - this.lastSeenAt > 10 * MIN ? this.lastSeenAt : now - 10.5 * HOUR;
    this.recap({ since, until: now }).then((r) => p.setRecap({ ...r, auto: true }));
    // The past week, loaded like the live app does it (a bit faster).
    this.later(1_000, () => this.loadPastWeek(now));
    // First incident shortly after start so the alert flow is visible.
    this.later(20_000, () => this.startBrandIncident());
  }

  // ── The past week (see backfill.mjs) ─────────────────────────────────────
  /** Made-up Cloud Logging entries for the week before `now`, read and turned into page data by the live code. */
  loadPastWeek(now) {
    const p = this.pipeline;
    const week = (this.pastWeek ||= this.makePastWeek(now));
    const podToService = (pod) => pod.replace(/-[a-z0-9]{9}-[a-z0-9]{5}$/, '');
    return loadPastWeek({
      now,
      read: async ({ kind, from, until, max }) => {
        await new Promise((r) => setTimeout(r, 200));
        return week[kind].filter((e) => e.t >= from && e.t < until).sort((a, b) => b.t - a.t).slice(0, max).map((e) => e.entry);
      },
      process: (raw) => processSlice({ ...raw, namespace: NS, projectId: 'flobi-prod-2026', podToService }),
      pause: () => new Promise((r) => this.later(100, r)),
      stopped: () => this.stopped,
      onStatus: (state) => p.setBackfill(state),
      onSlice: (slice) => p.addPast(slice),
      onRecentLogs: ({ since, until, entries, capped }) => {
        const lines = entries.map((e) => normalizeEntry(e, { namespace: NS, podToService })).filter((l) => l.kind === 'log');
        p.setLogsBefore({ since, until, capped, lines: lines.sort((a, b) => a.ts - b.ts) });
      },
    });
  }

  makePastWeek(now) {
    const week = { errors: [], events: [], failed: [], sql: [], logs: [] };
    const add = (kind, t, entry) => week[kind].push({ t, entry });
    const oldPods = new Map(); // service → pods since replaced by the ones running now
    const podOf = (svc, t) => {
      const current = this.pods.filter((x) => x.metadata.labels.app === svc && Date.parse(x.metadata.creationTimestamp) < t);
      if (current.length) return pick(current).metadata.name;
      if (!oldPods.has(svc)) oldPods.set(svc, [0, 1].map(() => `${svc}-${alnum(9)}-${alnum(5)}`));
      return pick(oldPods.get(svc));
    };
    const container = (svc, t, text, severity = 'ERROR', pod = podOf(svc, t)) => ({ insertId: alnum(14), timestamp: iso(t), severity, resource: { type: 'k8s_container', labels: { namespace_name: NS, pod_name: pod, container_name: svc, cluster_name: 'flobi-cluster' } }, textPayload: text });
    const error = (svc, t, msg, ctx = pick(CONTEXTS[svc] || CONTEXTS.default), pod) => add('errors', t, container(svc, t, nestLine('ERROR', ctx, msg, t), 'ERROR', pod));
    const node = (i) => this.nodes[i % this.nodes.length].metadata.name;
    // An Event object, exported again each time its count went up (as Kubernetes does).
    const event = (type, reason, kind, name, message, times, { fieldPath, host = node(0), component = kind === 'Pod' ? 'kubelet' : kind === 'Node' ? 'kernel-monitor' : 'deployment-controller' } = {}) => {
      const uid = `past-${alnum(10)}`;
      times.forEach((t, i) => add('events', t, { logName: 'projects/flobi-prod-2026/logs/events', timestamp: iso(t), jsonPayload: { metadata: { uid, name: `${name}.${uid}` }, type, reason, message, involvedObject: { kind, name, namespace: kind === 'Node' ? undefined : NS, fieldPath }, count: i + 1, firstTimestamp: iso(times[0]), lastTimestamp: iso(t), source: { component, host } } }));
    };
    const failed = (svc, t, status, details) => add('failed', t, { insertId: alnum(12), timestamp: iso(t), resource: { type: 'http_load_balancer', labels: { backend_service_name: `k8s1-8f2c1a9b-flobi-${svc}-80-${alnum(8)}` } }, httpRequest: { requestMethod: pick(['GET', 'POST']), requestUrl: `https://api.flobi.ai${pick(['/brand/extract', '/brand/assets', '/drive/files'])}`, status, latency: `${between(0.01, 2).toFixed(3)}s` }, jsonPayload: { statusDetails: details }, severity: 'ERROR' });
    const at = (daysAgo, hour, min = 0) => {
      const d = new Date(now - daysAgo * DAY);
      d.setHours(hour, min, Math.floor(rand() * 60), 0);
      return Math.min(d.getTime(), now - 2 * MIN);
    };
    const spread = (from, ms, n) => Array.from({ length: n }, (_, i) => from + Math.round((i / Math.max(1, n - 1)) * ms));

    // Everyday errors, more in the daytime.
    for (let d = 0; d < 7; d++) {
      for (const [svc, templates] of Object.entries(ERRORS)) {
        const n = Math.round((svc === 'flobi-brand' ? 45 : svc === 'flobi-gateway' ? 18 : 9) * between(0.6, 1.4));
        for (let i = 0; i < n; i++) {
          const t = now - d * DAY - Math.floor(rand() * DAY);
          if (t < now - 7 * DAY + MIN) continue;
          error(svc, t, fill(pick(templates)));
        }
      }
      // The odd unexpected exception: Nest's line, then the exception (frames aren't read).
      for (const svc of Object.keys(EXCEPTIONS)) {
        const t = now - d * DAY - Math.floor(rand() * DAY);
        const pod = podOf(svc, t);
        const [message, header] = EXCEPTIONS[svc];
        add('errors', t, container(svc, t, nestLine('ERROR', 'ExceptionsHandler', message, t), 'ERROR', pod));
        add('errors', t + 1, container(svc, t + 1, header, 'ERROR', pod));
      }
    }
    // A busy day: the media worker failed every transcode for two hours (more errors than one read takes).
    for (const t of spread(at(4, 14, 5), 2 * HOUR, 1400)) error('flobi-media-worker', t, `Transcode job ${alnum(10)} failed: ffmpeg exited with code 1`, 'RmqConsumer');
    // An error spike in drive, and one error type nobody had seen before (2 days ago).
    for (const t of spread(at(2, 11, 20), 9 * MIN, 320)) error('flobi-drive', t, `S3 upload failed for file_${alnum(10)}: ECONNRESET`, 'UploadService');
    for (const t of spread(at(2, 11, 24), 40 * MIN, 14)) error('flobi-drive', t, 'Presigned URL expired before the upload finished (bucket flobi-uploads)', 'UploadService');
    // Yesterday afternoon brand ran out of memory over and over; the gateway couldn't reach it.
    const oom = at(1, 15, 2);
    const brandPod = podOf('flobi-brand', oom);
    event('Warning', 'OOMKilling', 'Node', node(1), 'Memory cgroup out of memory: Killed process 1 (node) total-vm:4101212kB, anon-rss:2097152kB, file-rss:0kB, shmem-rss:0kB', [oom - 40_000, oom + 3 * MIN, oom + 9 * MIN], { host: node(1) });
    event('Warning', 'BackOff', 'Pod', brandPod, `Back-off restarting failed container flobi-brand in pod ${brandPod}_flobi(${alnum(8)})`, spread(oom, 22 * MIN, 11), { fieldPath: 'spec.containers{flobi-brand}', host: node(1) });
    for (const t of spread(oom + 30_000, 4 * MIN, 180)) failed('flobi-gateway', t, 502, 'failed_to_connect_to_backend');
    for (const t of spread(oom + MIN, 20 * MIN, 60)) error('flobi-gateway', t, 'Upstream flobi-brand responded 503 for POST /brand/extract', 'ProxyService');
    // Three days ago notes failed its liveness probe and was restarted.
    const notes = at(3, 9, 40);
    const notesPod = podOf('flobi-notes', notes);
    event('Warning', 'Unhealthy', 'Pod', notesPod, 'Liveness probe failed: Get "http://10.8.1.22:3000/health": context deadline exceeded', spread(notes - 90_000, 80_000, 3), { fieldPath: 'spec.containers{flobi-notes}', host: node(2) });
    event('Normal', 'Killing', 'Pod', notesPod, 'Container flobi-notes failed liveness probe, will be restarted', [notes], { fieldPath: 'spec.containers{flobi-notes}', host: node(2) });
    // Five days ago the media workers couldn't be scheduled for a while.
    event('Warning', 'FailedScheduling', 'Pod', `flobi-media-worker-${alnum(9)}-${alnum(5)}`, '0/4 nodes are available: 4 Insufficient memory. preemption: 0/4 nodes are available: 4 No preemption victims found for incoming pod.', spread(at(5, 16, 10), 14 * MIN, 6), { component: 'default-scheduler' });
    // face-detection's readiness probe times out a few times every day.
    for (let d = 0; d < 7; d++) {
      const pod = podOf('flobi-face-detection', now - d * DAY - 12 * HOUR);
      event('Warning', 'Unhealthy', 'Pod', pod, 'Readiness probe failed: Get "http://10.8.2.14:8000/health": context deadline exceeded (Client.Timeout exceeded while awaiting headers)', spread(at(d, 10 + (d % 5), 15), 20 * MIN, 3 + (d % 4)), { fieldPath: 'spec.containers{flobi-face-detection}', host: node(d) });
    }
    // Deploys (a new replica set up, the old one down) and autoscaling.
    for (const [svc, d, h] of [['flobi-notes', 1, 10], ['flobi-gateway', 2, 17], ['flobi-drive', 4, 12], ['flobi-brand', 6, 11]]) {
      const t = at(d, h, 30);
      event('Normal', 'ScalingReplicaSet', 'Deployment', svc, `Scaled up replica set ${svc}-${alnum(9)} to 2`, [t]);
      event('Normal', 'ScalingReplicaSet', 'Deployment', svc, `Scaled down replica set ${svc}-${alnum(9)} to 0 from 2`, [t + 2 * MIN]);
    }
    for (let d = 0; d < 7; d++) {
      event('Normal', 'SuccessfulRescale', 'HorizontalPodAutoscaler', 'flobi-nodes-hpa', 'New size: 4; reason: cpu resource utilization (percentage of request) above target', [at(d, 13, 0)], { component: 'horizontal-pod-autoscaler' });
      event('Normal', 'SuccessfulRescale', 'HorizontalPodAutoscaler', 'flobi-nodes-hpa', 'New size: 2; reason: All metrics below target', [at(d, 18, 30)], { component: 'horizontal-pod-autoscaler' });
    }
    // Postgres: connection slots ran out one evening, and a couple of deadlocks.
    const sql = (t, text) => add('sql', t, { insertId: alnum(12), timestamp: iso(t), severity: 'ERROR', resource: { type: 'cloudsql_database', labels: { database_id: 'flobi-prod-2026:flobi-prod-pg', region: 'europe-west1' } }, textPayload: text });
    for (const t of spread(at(3, 20, 12), 6 * MIN, 24)) sql(t, 'FATAL:  remaining connection slots are reserved for non-replication superuser connections');
    for (const t of [at(5, 9, 3), at(5, 9, 5)]) sql(t, 'ERROR:  deadlock detected');
    // The Logs page's 15 minutes before the live stream (the live lines seeded at start cover the last 90 s).
    for (const t of spread(now - 16.5 * MIN, 15 * MIN, 480)) {
      const pod = pick(this.pods);
      add('logs', t, { ...this.logEntry(pod, pod.metadata.labels.app, t), timestamp: iso(t), timestampMs: undefined });
    }
    return week;
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.followers.clear();
  }

  tick(ms, fn) {
    this.timers.push(setInterval(() => !this.stopped && fn(), ms));
  }

  later(ms, fn) {
    this.timers.push(setTimeout(() => !this.stopped && fn(), ms));
  }

  // ── Cluster objects ──────────────────────────────────────────────────────
  buildCluster(now) {
    this.nodes = ['a1', 'b7', 'c3', 'd9'].map((s, i) => ({
      metadata: { name: `gke-flobi-cluster-default-pool-${hex(8)}-${s}`, uid: `node-${i}`, labels: { 'cloud.google.com/gke-nodepool': i < 3 ? 'default-pool' : 'spot-pool', 'node.kubernetes.io/instance-type': 'e2-standard-8', 'topology.kubernetes.io/zone': `europe-west1-${'bcdb'[i]}`, ...(i === 3 ? { 'cloud.google.com/gke-spot': 'true' } : {}) }, creationTimestamp: new Date(now - (12 + i * 3) * 24 * HOUR).toISOString() },
      spec: {},
      status: { conditions: [{ type: 'Ready', status: 'True' }, { type: 'MemoryPressure', status: 'False' }, { type: 'DiskPressure', status: 'False' }], allocatable: { cpu: '7910m', memory: '28Gi' }, nodeInfo: { kubeletVersion: 'v1.33.4-gke.1245000' } },
    }));
    this.deployments = [];
    this.pods = [];
    this.hpas = [];
    this.scaledobjects = [];
    this.k8sServices = [];
    const ingressPaths = {};
    for (const [name, replicas, mem, cpu, scale, routes] of DEMO_SERVICES) {
      // Kubernetes names replica sets (and pods) from its own alphabet: no vowels, no 0, 1 or 3.
      const rs = alnum(9);
      const container = { name, image: `europe-west1-docker.pkg.dev/flobi-prod-2026/flobi-repo/${name}:latest`, resources: { requests: { cpu: `${cpu}m`, memory: `${Math.round(mem / 4)}Mi` }, limits: { cpu: `${cpu * 3}m`, memory: `${mem}Mi` } } };
      const d = {
        metadata: { name, uid: `dep-${name}`, labels: { app: name }, generation: 7, creationTimestamp: new Date(now - 40 * 24 * HOUR).toISOString(), annotations: { revision: String(Math.floor(between(3, 40))) } },
        spec: { replicas, selector: { matchLabels: { app: name } }, containers: [container] },
        status: { replicas, readyReplicas: replicas, availableReplicas: replicas, updatedReplicas: replicas, observedGeneration: 7 },
        _rs: rs,
        _mem: mem,
      };
      this.deployments.push(d);
      for (let i = 0; i < replicas; i++) this.pods.push(this.makePod(d, now - between(2, 9) * 24 * HOUR));
      this.k8sServices.push({ metadata: { name, uid: `svc-${name}` }, spec: { selector: { app: name } } });
      if (Array.isArray(scale)) {
        this.hpas.push({ metadata: { name: `${name}-hpa`, uid: `hpa-${name}` }, spec: { scaleTargetRef: { name }, minReplicas: scale[0], maxReplicas: scale[1], metrics: [{ type: 'Resource', resource: { name: 'cpu', target: { averageUtilization: 70 } } }, { type: 'Resource', resource: { name: 'memory', target: { averageUtilization: 80 } } }] }, status: { currentReplicas: replicas, desiredReplicas: replicas, currentMetrics: [{ resource: { name: 'cpu', current: { averageUtilization: Math.round(between(15, 45)) } } }, { resource: { name: 'memory', current: { averageUtilization: Math.round(between(30, 60)) } } }] } });
      } else if (scale === 'keda') {
        this.scaledobjects.push({ metadata: { name, uid: `so-${name}` }, spec: { scaleTargetRef: { name }, minReplicaCount: name === 'flobi-media-worker' ? 1 : 1, maxReplicaCount: name === 'flobi-media-worker' ? 8 : 4, triggers: [{ type: 'rabbitmq' }] } });
        this.hpas.push({ metadata: { name: `keda-hpa-${name}`, uid: `khpa-${name}` }, spec: { scaleTargetRef: { name }, minReplicas: 1, maxReplicas: name === 'flobi-media-worker' ? 8 : 4, metrics: [] }, status: { currentReplicas: replicas, desiredReplicas: replicas } });
      }
      for (const r of routes) {
        const [host, ...rest] = r.split('/');
        (ingressPaths[host] ||= []).push({ path: `/${rest.join('/')}`, backend: { service: { name } } });
      }
    }
    this.ingresses = [{ metadata: { name: 'flobi-ingress', uid: 'ing-1' }, spec: { rules: Object.entries(ingressPaths).map(([host, paths]) => ({ host, http: { paths } })) }, status: { loadBalancer: { ingress: [{ ip: '34.117.52.10' }] } } }];
    this.certificates = [
      { metadata: { name: 'flobi-managed-cert', uid: 'mc-1' }, status: { certificateStatus: 'Active', expireTime: new Date(now + 61 * 24 * HOUR).toISOString(), domainStatus: ['api.flobi.ai', 'ws.flobi.ai', 'agents.flobi.ai', 'yjs.flobi.ai'].map((domain) => ({ domain, status: 'Active' })) } },
      { metadata: { name: 'handoff-zip-cert', uid: 'mc-2' }, status: { certificateStatus: 'Active', expireTime: new Date(now + 44 * 24 * HOUR).toISOString(), domainStatus: [{ domain: 'handoff.zip', status: 'Active' }] } },
    ];
    this.cronjobs = [{ metadata: { name: 'bull-cleanup', uid: 'cj-1' }, spec: { schedule: '*/30 * * * *' }, status: { lastScheduleTime: new Date(now - 11 * MIN).toISOString(), lastSuccessfulTime: new Date(now - 10 * MIN).toISOString() } }];
    this.jobs = [0, 1, 2].map((i) => ({ metadata: { name: `bull-cleanup-${29230000 + i * 30}`, uid: `job-${i}`, ownerReferences: [{ kind: 'CronJob', name: 'bull-cleanup' }] }, status: { startTime: new Date(now - (11 + i * 30) * MIN).toISOString(), completionTime: new Date(now - (10 + i * 30) * MIN).toISOString(), succeeded: 1, conditions: [{ type: 'Complete', status: 'True' }] } }));
    this.events = [];
    this.addEvent('Normal', 'ScalingReplicaSet', 'Deployment', 'flobi-notes', `Scaled up replica set flobi-notes-${hex(9)} to 2`, now - 32 * MIN);
    this.addEvent('Normal', 'ScalingReplicaSet', 'Deployment', 'flobi-notes', `Scaled down replica set flobi-notes-${hex(9)} to 0 from 2`, now - 30 * MIN);
    this.addEvent('Normal', 'ScalingReplicaSet', 'Deployment', 'flobi-gateway', `Scaled up replica set flobi-gateway-${hex(9)} to 2`, now - 12 * MIN);
    this.addEvent('Normal', 'ScalingReplicaSet', 'Deployment', 'flobi-gateway', `Scaled down replica set flobi-gateway-${hex(9)} to 0 from 2`, now - 11 * MIN);
    this.addEvent('Normal', 'SuccessfulRescale', 'HorizontalPodAutoscaler', 'flobi-nodes-hpa', 'New size: 3; reason: cpu resource utilization (percentage of request) above target', now - 26 * MIN);
    this.addEvent('Normal', 'SuccessfulRescale', 'HorizontalPodAutoscaler', 'flobi-nodes-hpa', 'New size: 2; reason: All metrics below target', now - 9 * MIN);
    this.addEvent('Warning', 'Unhealthy', 'Pod', this.pods.find((x) => x.metadata.labels.app === 'flobi-face-detection').metadata.name, 'Readiness probe failed: Get "http://10.8.2.14:8000/health": context deadline exceeded (Client.Timeout exceeded while awaiting headers)', now - 4 * MIN);
    for (const pod of this.pods.slice(0, 12)) this.addEvent('Normal', 'Pulled', 'Pod', pod.metadata.name, `Successfully pulled image "${pod.spec.containers[0].image}" in 2.1s`, now - between(20, 180) * MIN);
    // face-detection runs hot on memory (a persistent "degraded" example)
    this.faceDetectionHot = true;
  }

  makePod(d, startedAt, restarts = 0) {
    const name = `${d.metadata.name}-${d._rs}-${alnum(5)}`;
    return {
      metadata: { name, uid: `pod-${name}`, labels: { app: d.metadata.name, 'pod-template-hash': d._rs }, ownerReferences: [{ kind: 'ReplicaSet', name: `${d.metadata.name}-${d._rs}` }], creationTimestamp: new Date(startedAt).toISOString() },
      spec: { nodeName: pick(this.nodes).metadata.name, containers: d.spec.containers },
      status: {
        phase: 'Running',
        podIP: `10.8.${Math.floor(between(0, 4))}.${Math.floor(between(2, 250))}`,
        startTime: new Date(startedAt).toISOString(),
        conditions: [{ type: 'Ready', status: 'True' }, { type: 'PodScheduled', status: 'True' }],
        containerStatuses: [{ name: d.metadata.name, ready: true, restartCount: restarts, image: d.spec.containers[0].image, state: { running: { startedAt: new Date(startedAt).toISOString() } }, lastState: {} }],
      },
    };
  }

  addEvent(type, reason, kind, name, message, at = this.clock(), count = 1) {
    this.events.unshift({ metadata: { uid: `ev-${alnum(10)}` }, type, reason, message, involvedObject: { kind, name, namespace: NS }, count, firstTimestamp: new Date(at).toISOString(), lastTimestamp: new Date(at).toISOString(), source: { component: kind === 'Pod' ? 'kubelet' : 'deployment-controller' } });
    this.events = this.events.slice(0, 300);
  }

  pushK8s() {
    const p = this.pipeline;
    const sync = (d) => {
      const pods = this.pods.filter((x) => x.metadata.labels.app === d.metadata.name && !x.metadata.deletionTimestamp);
      const ready = pods.filter((x) => x.status.containerStatuses[0].ready).length;
      d.status = { ...d.status, replicas: pods.length, readyReplicas: ready, availableReplicas: ready, updatedReplicas: pods.length };
    };
    this.deployments.forEach(sync);
    p.setK8s('nodes', this.nodes);
    p.setK8s('deployments', this.deployments);
    p.setK8s('pods', this.pods);
    p.setK8s('hpas', this.hpas);
    p.setK8s('scaledobjects', this.scaledobjects);
    p.setK8s('services', this.k8sServices);
    p.setK8s('ingresses', this.ingresses);
    p.setK8s('certificates', this.certificates);
    p.setK8s('cronjobs', this.cronjobs);
    p.setK8s('jobs', this.jobs);
    p.setK8s('events', this.events);
  }

  // ── Scenario ─────────────────────────────────────────────────────────────
  startBrandIncident() {
    const now = this.clock();
    const brandPods = this.pods.filter((x) => x.metadata.labels.app === 'flobi-brand');
    const victim = brandPods[0];
    const cs = victim.status.containerStatuses[0];
    cs.restartCount += 1;
    cs.ready = false;
    cs.lastState = { terminated: { reason: 'OOMKilled', exitCode: 137, startedAt: new Date(now - 3 * HOUR).toISOString(), finishedAt: new Date(now).toISOString() } };
    cs.state = { waiting: { reason: 'CrashLoopBackOff', message: 'back-off 10s restarting failed container=flobi-brand pod=' + victim.metadata.name } };
    victim.status.conditions = [{ type: 'Ready', status: 'False' }, { type: 'PodScheduled', status: 'True' }];
    this.addEvent('Warning', 'BackOff', 'Pod', victim.metadata.name, 'Back-off restarting failed container flobi-brand in pod ' + victim.metadata.name, now);
    this.addEvent('Warning', 'OOMKilling', 'Node', victim.spec.nodeName, 'Memory cgroup out of memory: Killed process 1 (node) total-vm:4101212kB, anon-rss:2097152kB', now);
    this.incident.brand = { pod: victim.metadata.name, until: now + 55_000 };
    this.pushK8s();
    const hpa = this.hpas.find((h) => h.metadata.name === 'flobi-media-worker-hpa' || h.metadata.name === 'keda-hpa-flobi-media-worker');
    if (hpa) this.incident.mediaQueue = 1;
  }

  endBrandIncident() {
    const now = this.clock();
    const victim = this.pods.find((x) => x.metadata.name === this.incident.brand.pod);
    if (victim) {
      const cs = victim.status.containerStatuses[0];
      cs.ready = true;
      cs.state = { running: { startedAt: new Date(now).toISOString() } };
      victim.status.conditions = [{ type: 'Ready', status: 'True' }, { type: 'PodScheduled', status: 'True' }];
      this.addEvent('Normal', 'Started', 'Pod', victim.metadata.name, 'Started container flobi-brand', now);
    }
    this.incident.brand = null;
    this.pushK8s();
    this.later(6 * MIN, () => this.startBrandIncident());
  }

  evolve() {
    const now = this.clock();
    if (this.incident.brand && now > this.incident.brand.until) this.endBrandIncident();
    // KEDA media worker follows a fake queue
    const media = this.deployments.find((d) => d.metadata.name === 'flobi-media-worker');
    const current = this.pods.filter((x) => x.metadata.labels.app === 'flobi-media-worker').length;
    const target = this.incident.mediaQueue ? Math.min(6, current + 1) : Math.max(1, current - 1);
    if (target !== current && rand() < 0.35) {
      if (target > current) this.pods.push(this.makePod(media, now));
      else this.pods.splice(this.pods.findIndex((x) => x.metadata.labels.app === 'flobi-media-worker'), 1);
      media.spec.replicas = target;
      const h = this.hpas.find((x) => x.metadata.name === 'keda-hpa-flobi-media-worker');
      if (h) h.status = { ...h.status, currentReplicas: target, desiredReplicas: target };
      this.addEvent('Normal', 'SuccessfulRescale', 'HorizontalPodAutoscaler', 'keda-hpa-flobi-media-worker', `New size: ${target}; reason: external metric s0-rabbitmq-media_queue above target`, now);
      if (target >= 6) this.incident.mediaQueue = 0;
      this.pushK8s();
    }
    for (const h of this.hpas) {
      const cpu = h.status?.currentMetrics?.[0]?.resource;
      if (cpu) cpu.current.averageUtilization = Math.max(5, Math.min(95, Math.round(cpu.current.averageUtilization + between(-4, 4))));
    }
  }

  // ── Streams ──────────────────────────────────────────────────────────────
  emitTraffic() {
    const now = this.clock();
    const n = Math.round(between(3, 8));
    const raw = [];
    const brandDown = !!this.incident.brand;
    for (let i = 0; i < n; i++) {
      const useApi = rand() < 0.78;
      let host;
      let method;
      let path;
      let svc;
      let base;
      if (useApi) {
        const r = weighted(PATHS, 4);
        [method, path, svc, base] = r;
        host = 'api.flobi.ai';
      } else {
        const r = weighted(OTHER_HOSTS, 5);
        [host, method, path, svc, base] = r;
      }
      path = fill(path);
      let status = rand() < 0.94 ? (method === 'POST' ? 201 : 200) : rand() < 0.2 ? 304 : pick([400, 401, 403, 404, 404, 404, 409, 422, 429]);
      let details = 'response_sent_by_backend';
      if (rand() < 0.002) status = pick([500, 502]);
      if (brandDown && path.startsWith('/brand')) {
        if (rand() < 0.45) {
          status = 503;
          details = 'response_sent_by_backend';
        }
      }
      if (rand() < 0.0008) {
        status = 502;
        details = 'backend_connection_closed_before_data_sent_to_client';
      }
      // Now and then a client gives up before any answer (a closed tab, a cancelled
      // download): the load balancer logs status 0, which isn't a server error.
      if (status < 400 && rand() < 0.003) {
        status = 0;
        details = 'client_disconnected_before_any_response';
      }
      const latency = Math.max(2, base * Math.exp(between(-0.6, 0.9)) * (status >= 500 ? 0.4 : 1));
      raw.push({
        insertId: alnum(12),
        timestampMs: now - Math.floor(rand() * 200),
        logName: 'projects/flobi-prod-2026/logs/requests',
        resource: { type: 'http_load_balancer', labels: { backend_service_name: `k8s1-8f2c1a9b-flobi-${svc}-80-${alnum(8)}`, project_id: 'flobi-prod-2026', zone: 'global' } },
        httpRequest: { requestMethod: method, requestUrl: `https://${host}${path}`, status, latencySeconds: latency / 1000, requestSize: Math.round(between(200, method === 'POST' ? 90_000 : 900)), responseSize: Math.round(between(300, 60_000)), userAgent: pick(UAS), remoteIp: `172.70.${Math.floor(between(1, 250))}.${Math.floor(between(1, 250))}`, protocol: 'HTTP/1.1' },
        jsonPayload: { statusDetails: details },
        severity: status >= 500 ? 'ERROR' : status >= 400 ? 'WARNING' : 'INFO',
      });
    }
    if (rand() < 0.012) {
      raw.push({
        insertId: alnum(12),
        timestampMs: now,
        logName: 'projects/flobi-prod-2026/logs/run.googleapis.com%2Frequests',
        resource: { type: 'cloud_run_revision', labels: { service_name: 'flobi-artwork-render', revision_name: 'flobi-artwork-render-00042-kiv', location: 'europe-west1' } },
        httpRequest: { requestMethod: 'POST', requestUrl: 'https://flobi-artwork-render-374098310188.europe-west1.run.app/render', status: rand() < 0.01 ? 500 : 200, latencySeconds: between(0.8, 2.6), requestSize: 4200, responseSize: 380_000, userAgent: 'node', remoteIp: '10.8.0.4', protocol: 'HTTP/1.1' },
        severity: 'INFO',
      });
    }
    this.pipeline.ingest(raw.map((e) => normalizeEntry(e, { namespace: NS })));
  }

  emitLogs() {
    const now = this.clock();
    const out = [];
    const running = this.pods.filter((x) => x.status.containerStatuses[0].ready);
    const count = Math.round(between(4, 12));
    for (let i = 0; i < count; i++) {
      const pod = pick(running);
      const svc = pod.metadata.labels.app;
      out.push(this.logEntry(pod, svc, now));
    }
    if (this.incident.brand && rand() < 0.5) {
      const gw = pick(running.filter((x) => x.metadata.labels.app === 'flobi-gateway'));
      out.push(this.rawLog(gw, 'flobi-gateway', nestLine('ERROR', 'ProxyService', 'Upstream flobi-brand responded 503 for POST /brand/extract', now), now, 'ERROR'));
    }
    if (rand() < 0.015) out.push(...this.exceptionEntries(pick(Object.keys(EXCEPTIONS)), now, running));
    const lines = out.map((e) => normalizeEntry(e, { namespace: NS, podToService: (pod) => pod.replace(/-[a-z0-9]{9}-[a-z0-9]{5}$/, '') }));
    this.recentLogs.push(...lines);
    if (this.recentLogs.length > 4000) this.recentLogs.splice(0, this.recentLogs.length - 4000);
    this.pipeline.ingest(lines);
    for (const f of this.followers) {
      if (rand() < 0.6) f.push([k8sLogLine({ text: this.textFor(f.service, now), ts: now, pod: f.pod, container: f.container, service: f.service })]);
    }
  }

  textFor(svc, now) {
    const ctx = pick(CONTEXTS[svc] || CONTEXTS.default);
    const r = rand();
    if (r < 0.025 && ERRORS[svc]) return nestLine('ERROR', ctx, fill(pick(ERRORS[svc])), now);
    if (r < 0.08) return nestLine('WARN', ctx, fill(pick(WARN_LINES)), now);
    if (r < 0.1) return nestLine('DEBUG', ctx, fill('Resolved config for {queue}'), now);
    return nestLine('LOG', ctx, fill(pick(INFO_LINES)), now);
  }

  logEntry(pod, svc, now) {
    const ctx = pick(CONTEXTS[svc] || CONTEXTS.default);
    const r = rand();
    const errorTemplates = ERRORS[svc];
    let text;
    let severity = 'INFO';
    if (r < (svc === 'flobi-brand' ? 0.05 : 0.012) && errorTemplates) {
      text = nestLine('ERROR', ctx, fill(pick(errorTemplates)), now);
      severity = 'ERROR';
    } else if (r < 0.07) {
      text = nestLine('WARN', ctx, fill(pick(WARN_LINES)), now);
    } else {
      text = nestLine('LOG', ctx, fill(pick(INFO_LINES)), now);
    }
    return this.rawLog(pod, svc, text, now, severity);
  }

  rawLog(pod, svc, text, ts, severity) {
    return { insertId: alnum(14), timestampMs: ts - Math.floor(rand() * 250), resource: { type: 'k8s_container', labels: { namespace_name: NS, pod_name: pod?.metadata.name || `${svc}-x`, container_name: svc, cluster_name: 'flobi-cluster' } }, textPayload: text, severity };
  }

  /** One unexpected exception on one of the service's pods: a line per entry, a millisecond apart, all on stderr. */
  exceptionEntries(svc, ts, pods = this.pods) {
    const pod = pick(pods.filter((x) => x.metadata.labels.app === svc));
    const [message, ...stack] = EXCEPTIONS[svc];
    return [nestLine('ERROR', 'ExceptionsHandler', message, ts), ...stack].map((text, i) => ({ ...this.rawLog(pod, svc, text, ts, 'ERROR'), timestampMs: ts + i }));
  }

  /**
   * Demo: brand's fullest pod against its memory limit. It climbs 0.8% a minute
   * and drops back to half when it runs out (it did about 36 minutes before the
   * demo starts), so the card warns that it will run out again in ~26 minutes.
   */
  brandMem(t) {
    const climbed = 0.29 + (0.008 * (t - this.startedAt)) / MIN;
    return 0.5 + (((climbed % 0.49) + 0.49) % 0.49);
  }

  /** The other services' memory wanders slowly inside its band instead of jumping every poll. */
  memNext(svc) {
    const band = svc === 'flobi-face-detection' && this.faceDetectionHot ? [0.9, 0.95] : [0.2, 0.55];
    const prev = this.memLevel.get(svc) ?? between(...band);
    const v = Math.min(band[1], Math.max(band[0], prev + between(-0.015, 0.015)));
    this.memLevel.set(svc, v);
    return v;
  }

  /** CPU against the limit, wandering on from the last poll so the card's line carries on from the seeded hour. */
  cpuNext(svc) {
    const v = Math.min(0.32, Math.max(0.03, (this.cpuLevel.get(svc) ?? between(0.05, 0.25)) + between(-0.03, 0.03)));
    this.cpuLevel.set(svc, v);
    return v;
  }

  /** Demo: the cards' last hour of CPU and memory, as if the app had been open for it. */
  seedUsage(now) {
    this.startedAt = now;
    this.memLevel = new Map();
    this.cpuLevel = new Map();
    const cpu = {};
    const mem = {};
    for (const d of this.deployments) {
      const svc = d.metadata.name;
      let c = between(0.05, 0.25);
      cpu[svc] = { unit: 'pct', points: [] };
      mem[svc] = [];
      for (let i = 60; i >= 1; i--) {
        const t = now - i * MIN;
        c = Math.min(0.32, Math.max(0.03, c + between(-0.03, 0.03)));
        cpu[svc].points.push([t, c]);
        this.cpuLevel.set(svc, c);
        mem[svc].push([t, svc === 'flobi-brand' ? this.brandMem(t) : this.memNext(svc)]);
      }
    }
    this.pipeline.restoreUsage({ cpu, mem }, now);
  }

  emitMetrics() {
    const now = this.clock();
    const podsM = this.pods.map((pod) => {
      const svc = pod.metadata.labels.app;
      const d = this.deployments.find((x) => x.metadata.name === svc);
      const limit = d._mem;
      const memFrac = svc === 'flobi-brand' ? this.brandMem(now) - between(0, 0.01) : this.memNext(svc);
      const cpuLimit = parseInt(d.spec.containers[0].resources.limits.cpu, 10);
      return { metadata: { name: pod.metadata.name }, containers: [{ name: svc, usage: { cpu: `${Math.round(cpuLimit * this.cpuNext(svc))}m`, memory: `${Math.round(limit * memFrac)}Mi` } }] };
    });
    const nodesM = this.nodes.map((n) => ({ metadata: { name: n.metadata.name }, usage: { cpu: `${Math.round(between(1800, 5200))}m`, memory: `${Math.round(between(11, 21))}Gi` } }));
    this.pipeline.setMetrics({ pods: podsM, nodes: nodesM, at: this.clock() });
  }

  emitUptime() {
    const targets = [
      ['API gateway', 'https://api.flobi.ai/health', 'backend', 180],
      ['Agents', 'https://agents.flobi.ai/socket.io/?EIO=4&transport=polling', 'backend', 210],
      ['Nodes (ws)', 'https://ws.flobi.ai/api/v1/', 'backend', 190],
      ['Yjs relay', 'https://yjs.flobi.ai/health', 'backend', 160],
      ['flobi.ai', 'https://flobi.ai/', 'frontend', 90],
      ['App', 'https://app.flobi.ai/', 'frontend', 110],
      ['Auth', 'https://auth.flobi.ai/', 'frontend', 95],
      ['Flow', 'https://flow.flobi.ai/', 'frontend', 120],
      ['Drive', 'https://drive.flobi.ai/', 'frontend', 105],
      ['Brands', 'https://brands.flobi.ai/', 'frontend', 115],
      ['Notes', 'https://docs.flobi.ai/', 'frontend', 100],
      ['Market', 'https://market.flobi.ai/', 'frontend', 130],
      ['Handoff', 'https://handoff.flobi.ai/', 'frontend', 3400],
      ['Artwork', 'https://artwork.flobi.ai/', 'frontend', 125],
      ['Projects', 'https://projects.flobi.ai/', 'frontend', 100],
      ['Admin', 'https://admin.flobi.ai/', 'frontend', 95],
    ];
    if (!this.uptimeInit) {
      this.uptimeInit = true;
      this.pipeline.setUptimeTargets(targets.map(([name, url, group]) => ({ id: url, name, url, group })));
    }
    const now = this.clock();
    for (const [name, url, group, base] of targets) {
      const ms = Math.round(base * between(0.7, 1.4));
      this.pipeline.setUptime({ id: url, name, url, group }, { status: 200, ms, certDaysLeft: group === 'frontend' ? 71 : 61, at: now, state: ms > 3000 ? 'slow' : 'up' });
    }
  }

  emitDatabase() {
    const now = this.clock();
    const at = (d, h, m = 0) => {
      const x = new Date(now);
      x.setUTCDate(x.getUTCDate() - d);
      x.setUTCHours(h, m, 0, 0);
      return x.getTime();
    };
    const op = (id, type, label, startedAt, mins, extra = {}) => ({ id, type, label, status: 'DONE', failed: false, error: null, instance: 'flobi-prod-pg', by: null, queuedAt: startedAt, startedAt, endedAt: startedAt + mins * MIN, disruptive: ['MAINTENANCE', 'RESTART', 'FAILOVER', 'UPDATE'].includes(type), ...extra });
    this.pipeline.setDatabase({
      status: 'ok',
      message: null,
      at: now,
      instances: [
        {
          id: 'flobi-prod-2026:europe-west1:flobi-prod-pg',
          name: 'flobi-prod-pg',
          region: 'europe-west1',
          version: 'PostgreSQL 16',
          tier: 'db-custom-4-16384',
          edition: 'ENTERPRISE',
          state: 'RUNNABLE',
          stateText: 'Running',
          status: 'up',
          down: false,
          highAvailability: true,
          diskGb: 100,
          diskAutoResize: true,
          maintenanceWindow: 'Sun 03:00 UTC',
          scheduledMaintenance: null,
          backupsEnabled: true,
          pitr: true,
          replicaOf: null,
          createdAt: now - 400 * 24 * HOUR,
        },
      ],
      operations: [
        op('o1', 'BACKUP_VOLUME', 'Backup', at(0, 2, 4), 3),
        op('o2', 'BACKUP_VOLUME', 'Backup', at(1, 2, 3), 3),
        op('o3', 'UPDATE', 'Settings changed', at(2, 14, 21), 1, { by: 'mohammad@flobi.ai' }),
        op('o4', 'BACKUP_VOLUME', 'Backup', at(2, 2, 5), 4),
        op('o5', 'MAINTENANCE', 'Maintenance', at(4, 3, 0), 6),
        op('o6', 'BACKUP_VOLUME', 'Backup', at(3, 2, 2), 3),
      ].sort((a, b) => b.startedAt - a.startedAt),
      errors: this.pipeline.database.errors.length
        ? this.pipeline.database.errors
        : [
            { kind: 'cloudsql', id: 'sql1', ts: now - 14 * MIN, instance: 'flobi-prod-pg', level: 'ERROR', text: 'ERROR:  duplicate key value violates unique constraint "users_email_key"' },
            { kind: 'cloudsql', id: 'sql2', ts: now - 41 * MIN, instance: 'flobi-prod-pg', level: 'WARN', slow: true, durationMs: 3121.442, text: 'LOG:  duration: 3121.442 ms  statement: SELECT * FROM "files" WHERE "workspaceId" = $1 ORDER BY "updatedAt" DESC' },
            { kind: 'cloudsql', id: 'sql4', ts: now - 73 * MIN, instance: 'flobi-prod-pg', level: 'WARN', slow: true, durationMs: 1840.2, text: 'LOG:  duration: 1840.201 ms  statement: UPDATE "brand_assets" SET "status" = $1 WHERE "brandId" = $2' },
            { kind: 'cloudsql', id: 'sql3', ts: now - 2 * HOUR, instance: 'flobi-prod-pg', level: 'ERROR', text: 'FATAL:  remaining connection slots are reserved for non-replication superuser connections' },
          ],
    });
  }

  /** Pretend the app has been open for an hour so the charts aren't empty. */
  seedTrafficHistory(now) {
    const shares = new Map();
    for (let i = 0; i < 4000; i++) {
      const svc = rand() < 0.78 ? weighted(PATHS, 4)[2] : weighted(OTHER_HOSTS, 5)[3];
      shares.set(svc, (shares.get(svc) || 0) + 1 / 4000);
    }
    const rows = [];
    for (let i = 60; i >= 1; i--) {
      const t = (Math.floor(now / MIN) - i + 1) * MIN;
      const total = Math.round(between(1500, 1800) * (1 + 0.12 * Math.sin(i / 9)));
      const byService = {};
      for (const [svc, share] of shares) byService[svc] = { total: Math.round(total * share), e5: rand() < share * 2 ? 1 : 0 };
      byService['flobi-artwork-render'] = { total: Math.round(between(2, 6)), e5: 0 };
      if (i <= 25 && i >= 22) byService['flobi-brand'] = { total: byService['flobi-brand']?.total || 40, e5: 30 };
      rows.push({ t, total, e4: Math.round(total * between(0.03, 0.05)), e5: Object.values(byService).reduce((a, x) => a + x.e5, 0), byService });
    }
    this.pipeline.traffic.seedHistory(rows, now - 61 * MIN);
  }

  emitSentry() {
    const now = this.clock();
    const mk = (id, project, title, culprit, level, count, users, firstAgo, lastAgo, sub) => ({ id: `demo-${id}`, shortId: `${project.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5)}-${id}`, title, culprit, level, status: 'unresolved', substatus: sub, count, users, firstSeen: now - firstAgo, lastSeen: now - lastAgo, link: 'https://sentry.io/', project, platform: 'javascript-react', unhandled: level !== 'warning', type: title.split(':')[0], spark: Array.from({ length: 24 }, (_, i) => (i > 20 ? Math.round(between(0, count / 6)) : Math.round(between(0, count / 30)))) });
    this.pipeline.setSentry({
      status: 'ok',
      org: { name: 'Flobi', slug: 'flobi' },
      projects: ['flobi-flow', 'flobi-drive', 'flobi-auth', 'flobi-notes', 'flobi-brands', 'flobi-home'].map((slug, i) => ({ id: String(i), slug, name: slug, platform: 'javascript-react' })),
      issues: [
        mk(1, 'flobi-flow', "TypeError: Cannot read properties of undefined (reading 'position')", 'useConnectDrag(src/components/Canvas/CanvasComponents/hooks/useConnectDrag)', 'error', 214, 38, 26 * MIN, 2 * MIN, 'new'),
        mk(2, 'flobi-drive', 'ChunkLoadError: Loading chunk 812 failed.', 'app/drive/[folder]/page', 'error', 91, 57, 3 * 24 * HOUR, 5 * MIN, 'ongoing'),
        mk(3, 'flobi-auth', 'Error: Clerk: Failed to load Clerk JS (network error)', 'ClerkProvider', 'error', 44, 31, 6 * HOUR, 14 * MIN, 'escalating'),
        mk(4, 'flobi-notes', 'RangeError: Maximum call stack size exceeded', 'YjsBinding.onUpdate', 'fatal', 12, 4, 50 * MIN, 22 * MIN, 'new'),
        mk(5, 'flobi-flow', 'ResizeObserver loop completed with undelivered notifications.', 'window', 'warning', 1840, 402, 12 * 24 * HOUR, 1 * MIN, 'ongoing'),
        mk(6, 'flobi-brands', 'AxiosError: Request failed with status code 503', 'brandApi.extract', 'error', 27, 19, 40 * MIN, 1 * MIN, 'regressed'),
        mk(7, 'flobi-home', 'Hydration failed because the server rendered HTML didn\'t match the client', 'app/page', 'warning', 8, 8, 2 * 24 * HOUR, 3 * HOUR, 'ongoing'),
      ],
    });
  }

  emitCloudflare() {
    const now = this.clock();
    const zone = (name, scale, e52x) => {
      const series = Array.from({ length: 60 }, (_, i) => {
        const requests = Math.round(scale * between(0.85, 1.15));
        return { t: now - (59 - i) * MIN, requests, s4xx: Math.round(requests * 0.04), s5xx: Math.round(requests * 0.002) + (i > 56 ? e52x : 0), s52x: i > 56 ? e52x : 0 };
      });
      const sum = (k) => series.reduce((a, x) => a + x[k], 0);
      const requests = sum('requests');
      return { id: hex(32), name, status: 'active', plan: 'Pro Website', zone: name, series, totals: { requests, cached: Math.round(requests * 0.61), bytes: requests * 38_000, threats: Math.round(requests * 0.0004), s2xx: Math.round(requests * 0.92), s3xx: Math.round(requests * 0.03), s4xx: sum('s4xx'), s5xx: sum('s5xx'), s52x: sum('s52x') }, topCountries: [{ country: 'LB', requests: Math.round(requests * 0.31) }, { country: 'AE', requests: Math.round(requests * 0.18) }, { country: 'FR', requests: Math.round(requests * 0.12) }, { country: 'US', requests: Math.round(requests * 0.11) }, { country: 'SA', requests: Math.round(requests * 0.08) }, { country: 'DE', requests: Math.round(requests * 0.05) }] };
    };
    const pg = (name, status, ago, branch, commit, message, domains) => ({ name, domains, subdomain: `${name}.pages.dev`, latest: { id: alnum(8), url: `https://${alnum(8)}.${name}.pages.dev`, environment: 'production', createdAt: now - ago, stage: status === 'failure' ? 'build' : 'deploy', status, endedAt: now - ago + 90_000, branch, commit, message } });
    this.pipeline.setCloudflare({
      status: 'ok',
      at: now,
      zones: [zone('flobi.ai', 2800, 0)],
      hostErrors: [{ host: 'api.flobi.ai', s5xx: 38, s52x: 0, codes: { 502: 12, 503: 26 } }],
      pages: [
        pg('flobi-home', 'success', 2 * HOUR, 'main', 'a41c9e2', 'Update pricing section copy', ['flobi.ai']),
        pg('flobi-flow', 'success', 5 * HOUR, 'main', '9be02d1', 'perf: canvas culling for large boards', ['flow.flobi.ai']),
        pg('flobi-drive', 'success', 26 * HOUR, 'main', '3f5aa70', 'Folder zip progress UI', ['drive.flobi.ai']),
        pg('flobi-auth', 'success', 3 * 24 * HOUR, 'main', '77c1b0e', 'Clerk v6 upgrade', ['auth.flobi.ai']),
        pg('flobi-notes', 'success', 7 * HOUR, 'main', 'c0ffee1', 'Shark agent HITL pause UI', ['notes.flobi.ai']),
        pg('flobi-sites', 'failure', 38 * MIN, 'main', 'e19b4c2', 'Add site theme presets', ['sites.flobi.ai']),
        pg('flobi-brands', 'success', 9 * HOUR, 'main', '51d2e8a', 'Logo sheet export', ['brands.flobi.ai']),
        pg('flobi-market-web', 'active', 3 * MIN, 'main', '0a9f3d6', 'Template detail page', ['market.flobi.ai']),
      ],
    });
  }

  seedHistory(now) {
    // A bit of backlog so Errors and Live Traffic aren't empty on first paint.
    for (let s = 90; s > 0; s--) {
      const ts = now - s * 1000;
      const running = this.pods;
      const lines = [];
      for (let i = 0; i < 6; i++) {
        const pod = pick(running);
        lines.push(normalizeEntry(this.logEntry(pod, pod.metadata.labels.app, ts), { namespace: NS, podToService: (x) => x.replace(/-[a-z0-9]{9}-[a-z0-9]{5}$/, '') }));
      }
      this.pipeline.ingest(lines);
    }
    for (let m = 30; m > 0; m--) {
      const ts = now - m * MIN;
      const pod = pick(this.pods.filter((x) => x.metadata.labels.app === 'flobi-brand'));
      this.pipeline.ingest([normalizeEntry(this.rawLog(pod, 'flobi-brand', nestLine('ERROR', 'ExtractionService', fill(pick(ERRORS['flobi-brand'])), ts), ts, 'ERROR'), { namespace: NS, podToService: () => 'flobi-brand' })]);
    }
    // A few exceptions with their stack traces, so Errors shows one on first paint.
    for (const [svc, ago] of [['flobi-gateway', 47 * MIN], ['flobi-drive', 22 * MIN], ['flobi-gateway', 6 * MIN]]) {
      this.pipeline.ingest(this.exceptionEntries(svc, now - ago).map((e) => normalizeEntry(e, { namespace: NS })));
    }
  }

  // ── On-demand ────────────────────────────────────────────────────────────
  followLogs({ pod, container, service }, onLines, onStatus) {
    const now = this.clock();
    onStatus?.('streaming');
    const history = Array.from({ length: 120 }, (_, i) => {
      const ts = now - (120 - i) * 1500;
      return k8sLogLine({ text: this.textFor(service, ts), ts, pod, container, service });
    });
    onLines(history);
    const f = { pod, container, service, push: onLines };
    this.followers.add(f);
    return () => this.followers.delete(f);
  }

  async previousLogs({ pod, container, service }) {
    const now = this.clock();
    const lines = Array.from({ length: 40 }, (_, i) => this.textFor(service, now - (60 - i) * 2000));
    if (service === 'flobi-brand') {
      lines.push(
        nestLine('LOG', 'HeadlessRenderClient', 'Rendering logo sheet for brand_8f2kd9x1 (48 variants)', now - 9000),
        nestLine('WARN', 'ExtractionService', 'Heap used 1.86 GB of 2.00 GB limit', now - 6000),
        '',
        '<--- Last few GCs --->',
        '[1:0x6a3f1c0]  10912 ms: Mark-Compact 1987.2 (2081.3) -> 1983.9 (2082.1) MB, 1204.1 / 0.0 ms  (average mu = 0.121, current mu = 0.019) allocation failure; scavenge might not succeed',
        '',
        'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
        ' 1: 0xb8a3c0 node::Abort() [node]',
        ' 2: 0xa9a6f8  [node]',
      );
    }
    return lines.map((text, i) => k8sLogLine({ text, ts: now - (lines.length - i) * 1500, pod, container, service }));
  }

  async queryLogs({ service, pod, level, text, from, until, limit = 500 }) {
    await new Promise((r) => setTimeout(r, 400));
    // Before the app started (the logs around a crash from the past week): made-up lines for that time.
    let list = until && until < (this.recentLogs[0]?.ts ?? Date.now()) ? this.pastLines({ service, pod, from: from ?? until - 10 * MIN, until }) : this.recentLogs;
    if (pod) list = list.filter((l) => l.pod === pod);
    if (service) list = list.filter((l) => l.service === service);
    if (level === 'ERROR') list = list.filter((l) => l.level === 'ERROR');
    if (level === 'WARN') list = list.filter((l) => l.level === 'ERROR' || l.level === 'WARN');
    if (text) list = list.filter((l) => l.text.toLowerCase().includes(String(text).toLowerCase()));
    return list.slice(-limit);
  }

  /** Demo: a pod's lines in a range before the app started; brand's end in its out-of-memory crash. */
  pastLines({ service, pod, from, until }) {
    const svc = service || (pod ? pod.replace(/-[a-z0-9]{9}-[a-z0-9]{5}$/, '') : 'flobi-gateway');
    const name = pod || this.pods.find((p) => p.metadata.labels.app === svc)?.metadata.name || `${svc}-x`;
    const n = 36;
    const lines = Array.from({ length: n }, (_, i) => {
      const ts = Math.round(from + ((i + 1) / (n + 2)) * (until - from));
      return { ...k8sLogLine({ text: this.textFor(svc, ts), ts, pod: name, container: svc, service: svc }), source: 'cloud' };
    });
    if (svc === 'flobi-brand') {
      const texts = [nestLine('WARN', 'ExtractionService', 'Heap used 1.86 GB of 2.00 GB limit', until - 9000), 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory', ' 1: 0xb8a3c0 node::Abort() [node]'];
      texts.forEach((text, i) => lines.push({ ...k8sLogLine({ text, ts: until - 9000 + i * 2000, pod: name, container: svc, service: svc }), source: 'cloud' }));
    }
    return lines;
  }

  /** Demo: the service's lines around a request, with the error behind a failed one. */
  async requestLogs({ service, ts, status, method = 'GET', path = '/' }) {
    await new Promise((r) => setTimeout(r, 600));
    const workload = this.deployments.find((d) => d.metadata.name === service || d.metadata.name === `flobi-${service}`)?.metadata.name || service;
    const lines = this.recentLogs.filter((l) => l.service === workload && Math.abs(l.ts - ts) <= 5_000);
    if (status >= 500) {
      const pod = this.pods.find((p) => p.metadata.labels.app === workload)?.metadata.name || `${workload}-7d9f8c6b5-x2x9z`;
      const text = status === 504 ? `ERROR [RequestTimeout] ${method} ${path.split('?')[0]} took longer than 30000ms, gave up` : `ERROR [ExceptionsHandler] ${method} ${path.split('?')[0]} failed: connect ECONNREFUSED 10.8.3.14:5432`;
      lines.push({ kind: 'log', id: `demo-req-${ts}`, ts: ts - 40, pod, container: workload, service: workload, level: 'ERROR', severity: 'ERROR', text, json: null, trace: null, source: 'cloud' });
    }
    return { match: 'time', workload, lines: lines.sort((a, b) => a.ts - b.ts) };
  }

  async usage({ service, range = HOUR }) {
    const now = this.clock();
    const d = this.deployments.find((x) => x.metadata.name === service);
    const pods = this.pods.filter((x) => x.metadata.labels.app === service);
    const n = 60;
    const step = range / n;
    const cpuReq = d ? parseInt(d.spec.containers[0].resources.requests.cpu, 10) : 200;
    const mem = d ? d._mem : 512;
    const walk = (base, j) => {
      let v = base;
      return Array.from({ length: n }, (_, i) => {
        v = Math.max(base * 0.3, v + between(-j, j));
        return { t: now - (n - 1 - i) * step, v };
      });
    };
    return {
      since: now - range,
      collectedSince: now - range,
      cpu: pods.map((pod) => ({ pod: pod.metadata.name, points: walk((cpuReq / 1000) * 0.4, (cpuReq / 1000) * 0.05) })),
      memory: pods.map((pod) => ({ pod: pod.metadata.name, points: walk(mem * 2 ** 20 * (service === 'flobi-brand' ? 0.6 : 0.35), mem * 2 ** 20 * 0.02) })),
    };
  }

  retryLive() {}

  async recap({ since, until }) {
    await new Promise((r) => setTimeout(r, 700));
    const span = until - since;
    const at = (frac) => Math.round(since + span * frac);
    const incidents = [
      { id: 'd1', kind: 'crash', severity: 'critical', service: 'flobi-brand', title: 'brand restarted 3× (out of memory)', detail: 'Memory cgroup out of memory: Killed process 1 (node) total-vm:4101212kB, anon-rss:2097152kB', start: at(0.38), end: at(0.38) + 8 * MIN, view: { to: 'logs', service: 'flobi-brand' } },
      { id: 'd2', kind: 'http', severity: 'critical', service: 'flobi-gateway', title: 'gateway: 1,284 failed requests', detail: "5xx errors over 4 min · mostly the load balancer couldn't reach the pods", start: at(0.385), end: at(0.385) + 4 * MIN, view: { to: 'logs', service: 'flobi-gateway' } },
      { id: 'd7', kind: 'database', severity: 'warning', service: null, title: 'Cloud SQL flobi-prod-pg: Maintenance', detail: 'took 6 min', start: at(0.2), end: at(0.2) + 6 * MIN, view: { to: 'database' } },
      { id: 'd3', kind: 'event', severity: 'warning', service: 'flobi-face-detection', title: 'face-detection: Health checks failing (14×)', detail: 'Readiness probe failed: context deadline exceeded', start: at(0.52), end: at(0.52) + 17 * MIN, view: { to: 'events' } },
      { id: 'd4', kind: 'errors', severity: 'warning', service: 'flobi-drive', title: 'Error spike in drive', detail: `480 errors in ${fmtDuration(10 * MIN)} (usually ~8 per 5 min)`, start: at(0.7), end: at(0.7) + 10 * MIN, view: { to: 'logs', service: 'flobi-drive', level: 'ERROR' } },
      { id: 'd5', kind: 'frontend', severity: 'warning', service: 'flobi-flow', title: '2 new frontend errors in flobi-flow', detail: "TypeError: Cannot read properties of undefined (reading 'position') (214× · 38 users)\nRangeError: Maximum call stack size exceeded (12× · 4 users)", start: at(0.93), end: until, view: { to: 'errors', filter: { source: 'frontend' } } },
      { id: 'd6', kind: 'deploy', severity: 'warning', service: null, title: 'Cloudflare Pages deploy failed: flobi-sites', detail: 'main e19b4c2 Add site theme presets', start: at(0.95), end: at(0.95), view: { to: 'frontends' } },
    ].sort((a, b) => a.start - b.start); // in time order, like the real recap
    return {
      since,
      until,
      generatedAt: this.clock(),
      period: 300,
      headline: '2 critical incidents and 5 warnings',
      summary: { incidents: incidents.length, critical: 2, warning: 5, restarts: 3, restartsExact: true, errors: 2314, newErrorTypes: 2, deploys: 2, requests: null, failedRequests: 1_904, outageMinutes: 4, frontendIssues: 2 },
      incidents,
      deploys: [
        { service: 'flobi-notes', at: at(0.82), rs: 'flobi-notes-6f7d9c' },
        { service: 'flobi-gateway', at: at(0.9), rs: 'flobi-gateway-84b1' },
      ],
      scaling: [
        { service: 'flobi-nodes', changes: 6, peak: 7, sizes: [2, 4, 7, 5, 3, 2], first: at(0.6), last: at(0.75), reason: 'cpu resource utilization (percentage of request) above target' },
        { service: 'flobi-media-worker', changes: 4, peak: 6, sizes: [1, 3, 6, 1], first: at(0.2), last: at(0.3), reason: 'external metric s0-rabbitmq-media_queue above target' },
      ],
      notes: ['Demo data — sign in to see your real history.'],
    };
  }
}

function weighted(list, wIdx) {
  const total = list.reduce((a, r) => a + r[wIdx], 0);
  let x = rand() * total;
  for (const r of list) {
    x -= r[wIdx];
    if (x <= 0) return r;
  }
  return list[0];
}

// ── The Costs page, simulated ────────────────────────────────────────────────
// What the readers would find (see costs.mjs): Google Cloud per service from the billing
// export (the Gemini API in it goes to Google AI Studio), Cloudflare plans and usage, GitHub
// usage and seats, OpenRouter's days and credits, fal's months and balance, plus a few items
// typed in Settings → Costs. Made up, shaped like a small platform's bill, the same on every run.
const costSeed = (s) => {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10_000) / 10_000;
};
const cents = (n) => Math.round(n * 100) / 100;

/** { data: { vendors, history }, settings, setup } for buildCosts(). */
export function demoCosts(now = Date.now()) {
  const months = lastMonths(now, 6);
  const current = months.at(-1);
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  // Google's billing data runs about a day behind; Cloudflare's usage is daily.
  const through = Math.max(start, now - 20 * HOUR - (now % HOUR));
  const today = Math.max(start, new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime());
  const frac = (through - start) / (end - start);
  const dayFrac = (today - start) / (end - start);
  // Each month a little bigger than the one before, give or take a few percent.
  const growth = (i) => 0.8 + i * 0.045;
  const amount = (name, base, m, i, sofar) => cents(base * growth(i) * (1 + (costSeed(`${name}:${m}`) - 0.5) * 0.08) * sofar);
  const monthEnd = (m) => new Date(+m.slice(0, 4), +m.slice(5, 7), 1).getTime();

  const GCP = [
    ['Compute Engine', 356.4, 0],
    ['Cloud SQL', 118.2, 0],
    ['Kubernetes Engine', 73, 0],
    ['Networking', 46.1, 0],
    ['Cloud Storage', 22.35, 0],
    ['Artifact Registry', 4.2, 0],
    ['Cloud Logging', 3.1, 0],
    ['Cloud Run', 1.85, -0.72],
    ['Cloud DNS', 0.8, 0],
    ['Secret Manager', 0.36, -0.06],
    ['Gemini API', 38.4, 0],
  ];
  const gcpMonths = {};
  months.forEach((m, i) => {
    const sofar = m === current ? frac : 1;
    const lines = {};
    for (const [name, base, credit] of GCP) lines[name] = [amount(name, base, m, i, sofar), cents(credit * sofar)];
    gcpMonths[m] = { USD: { lines, through: m === current ? through : monthEnd(m) } };
  });

  const CF_USAGE = [
    ['Workers Standard', 3.2],
    ['R2 Storage', 0.9],
  ];
  const cfUsage = { status: 'ok', message: null, months: {}, read: {} };
  months.forEach((m, i) => {
    const sofar = m === current ? dayFrac : 1;
    cfUsage.months[m] = { USD: { lines: Object.fromEntries(CF_USAGE.map(([n, b]) => [n, amount(n, b, m, i, sofar)])), through: m === current ? today : monthEnd(m) } };
    cfUsage.read[m] = now - 2 * HOUR;
  });
  const renews = new Date(d.getFullYear(), d.getMonth() + 1, 3).getTime();
  const plans = [
    { id: 'demo-zone-pro', name: 'Pro', planId: 'pro', zone: 'flobi.ai', zoneId: '7f0c2e5a9b3d4c1e8f6a2b0c9d8e7f61', price: 25, currency: 'USD', frequency: 'monthly', state: 'Paid', charged: true, periodEnd: renews },
    { id: 'demo-workers-paid', name: 'Workers Paid', planId: null, zone: null, zoneId: null, price: 5, currency: 'USD', frequency: 'monthly', state: 'Paid', charged: true, periodEnd: renews },
  ];

  const ghMonths = {};
  const ghRead = {};
  months.forEach((m, i) => {
    const sofar = m === current ? frac : 1;
    ghMonths[m] = { USD: { lines: { Actions: amount('Actions', 8.64, m, i, sofar), Copilot: cents(38 * sofar), Packages: amount('Packages', 0.42, m, i, sofar) } } };
    ghRead[m] = now - 2 * HOUR;
  });

  // OpenRouter: the Activity API's days (UTC), up to yesterday, since the oldest month shown.
  const OR_MODELS = [
    ['anthropic/claude-sonnet-4.5', 2.35],
    ['openai/gpt-5-mini', 0.62],
    ['google/gemini-2.5-flash', 0.41],
    ['deepseek/deepseek-chat-v3.1', 0.12],
  ];
  const todayUtc = new Date(now).toISOString().slice(0, 10);
  const orDays = {};
  let orUsed = 0;
  for (let t = Date.parse(`${months[0]}-01T00:00:00Z`); ; t += 24 * HOUR) {
    const day = new Date(t).toISOString().slice(0, 10);
    if (day >= todayUtc) break;
    const i = Math.max(0, months.indexOf(day.slice(0, 7)));
    orDays[day] = Object.fromEntries(
      OR_MODELS.map(([model, base]) => {
        const usd = Math.round(base * growth(i) * (0.6 + costSeed(`${model}:${day}`) * 0.8) * 1e6) / 1e6;
        orUsed += usd;
        return [model, usd];
      }),
    );
  }
  const orSpentBefore = 214.8; // before the months shown
  const orCredits = { total: cents(orSpentBefore + orUsed + 86.2), used: cents(orSpentBefore + orUsed) };

  // fal: the Usage API per month and endpoint (up to the last read), and the balance.
  const FAL = [
    ['fal-ai/flux-pro/v1.1-ultra', 48.6],
    ['fal-ai/kling-video/v2.1/pro/image-to-video', 31.5],
    ['fal-ai/flux/dev', 12.8],
    ['fal-ai/recraft-v3', 6.4],
    ['fal-ai/birefnet/v2', 0.9],
  ];
  const falRead = now - 2 * HOUR;
  const falFrac = (Math.max(start, falRead) - start) / (end - start);
  const falMonths = {};
  months.forEach((m, i) => {
    const sofar = m === current ? falFrac : 1;
    falMonths[m] = { USD: { lines: Object.fromEntries(FAL.map(([n, b]) => [n, amount(n, b, m, i, sofar)])) } };
  });

  const cfKey = 'cloudflare:0123456789abcdef0123456789abcdef:flobi.ai';
  const ghKey = 'github:org:4ow4-developers';
  const history = {};
  months.slice(0, -1).forEach((m, i) => {
    history[m] = { [cfKey]: { subs: plans }, [ghKey]: { seats: { plan: 'team', seats: [4, 5, 5, 6, 6][i], filled: [4, 5, 5, 6, 6][i] } } };
  });

  const checked = now - 2 * HOUR;
  const vendors = {
    gcp: { status: 'ok', message: null, key: 'bigquery:flobi-billing.billing_export.gcp_billing_export_v1_01A2B3_C4D5E6_F7A8B9', table: 'flobi-billing.billing_export.gcp_billing_export_v1_01A2B3_C4D5E6_F7A8B9', months: gcpMonths, complete: months, through, rows: 812_406, days: 186, storage: { bytes: 479_500_000, longTermBytes: 212_000_000, bytesPerDay: 2_600_000, expirationDays: null }, checkedAt: checked, okAt: checked },
    cloudflare: { status: 'ok', message: null, key: cfKey, subscriptions: plans, zones: ['flobi.ai'], usage: cfUsage, checkedAt: checked, okAt: checked },
    github: { status: 'ok', message: null, key: ghKey, owner: '4ow4-Developers', kind: 'org', months: ghMonths, read: ghRead, seats: { plan: 'team', seats: 6, filled: 6 }, seatsNote: null, checkedAt: checked, okAt: checked },
    openrouter: { status: 'ok', message: null, key: 'openrouter', days: orDays, byok: {}, lastDay: new Date(Date.parse(`${todayUtc}T00:00:00Z`) - 24 * HOUR).toISOString().slice(0, 10), credits: orCredits, creditsNote: null, checkedAt: checked, okAt: checked },
    fal: { status: 'ok', message: null, key: 'fal', months: falMonths, read: Object.fromEntries(months.map((m) => [m, falRead])), balance: { amount: 142.35, currency: 'USD' }, balanceNote: null, account: 'flobi', checkedAt: checked, okAt: checked },
  };

  const since = new Date(d.getFullYear(), d.getMonth() - 5, 2).getTime();
  const settings = {
    ...DEFAULT_COSTS,
    bigQueryTable: vendors.gcp.table,
    github: { owner: '4ow4-Developers', kind: 'org', seatPrice: 4, seatCurrency: 'USD' },
    items: [
      { id: 'demo-sentry', vendor: 'Sentry', item: 'Team plan', amount: 26, currency: 'USD', cycle: 'monthly', date: '', note: 'Billed on the 14th', addedAt: since },
      { id: 'demo-clerk', vendor: 'Clerk', item: 'Pro plan', amount: 25, currency: 'USD', cycle: 'monthly', date: '', note: '', addedAt: since },
      { id: 'demo-domain', vendor: 'Cloudflare', item: 'flobi.ai domain', amount: 80, currency: 'USD', cycle: 'yearly', date: `${d.getFullYear() + 1}-03-14`, note: 'Cloudflare Registrar', addedAt: since },
      { id: 'demo-replicate', vendor: 'Replicate', item: 'Monthly usage', amount: 35, currency: 'USD', cycle: 'monthly', date: '', note: 'From the last invoices', addedAt: since },
      { id: 'demo-backups', vendor: 'Hetzner', item: 'Storage Box (backups)', amount: 12.97, currency: 'EUR', cycle: 'monthly', date: '', note: '', addedAt: since },
    ],
    rates: { EUR: 1.08 },
  };
  const setup = {
    email: 'flobi-pulse-viewer@flobi-prod-2026.iam.gserviceaccount.com',
    gcp: { table: vendors.gcp.table },
    cloudflare: { hasToken: true, accountId: '0123456789abcdef0123456789abcdef', zones: ['flobi.ai'] },
    github: { hasToken: true, owner: '4ow4-Developers', kind: 'org' },
    openrouter: { hasKey: true },
    fal: { hasKey: true },
  };
  return { data: { vendors, history }, settings, setup };
}
