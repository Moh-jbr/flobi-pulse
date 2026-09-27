// Demo mode: a simulated copy of the Flobi platform that produces the same
// Kubernetes objects and Cloud Logging entries the real APIs return, and feeds
// them through the same pipeline. No credentials, no network. Pure JS.
import { normalizeEntry, k8sLogLine } from './normalize.mjs';
import { fmtDuration } from './recap.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NS = 'flobi';

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
    // First incident shortly after start so the alert flow is visible.
    this.later(20_000, () => this.startBrandIncident());
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
      const rs = hex(9).slice(0, 9);
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

  emitMetrics() {
    const podsM = this.pods.map((pod) => {
      const svc = pod.metadata.labels.app;
      const d = this.deployments.find((x) => x.metadata.name === svc);
      const limit = d._mem;
      let memFrac = svc === 'flobi-face-detection' && this.faceDetectionHot ? between(0.9, 0.95) : svc === 'flobi-brand' ? between(0.45, 0.75) : between(0.2, 0.55);
      const cpuReq = parseInt(d.spec.containers[0].resources.requests.cpu, 10);
      return { metadata: { name: pod.metadata.name }, containers: [{ name: svc, usage: { cpu: `${Math.round(cpuReq * between(0.1, 0.9))}m`, memory: `${Math.round(limit * memFrac)}Mi` } }] };
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
      ['Notes', 'https://notes.flobi.ai/', 'frontend', 100],
      ['Market', 'https://market.flobi.ai/', 'frontend', 130],
      ['Handoff', 'https://handoff.flobi.ai/', 'frontend', 3400],
    ];
    if (!this.uptimeInit) {
      this.uptimeInit = true;
      this.pipeline.setUptimeTargets(targets.map(([name, url, group]) => ({ id: url, name, url, group })));
    }
    const now = this.clock();
    for (const [name, url, group, base] of targets) {
      const ms = Math.round(base * between(0.7, 1.4));
      const brandHurts = false;
      const status = brandHurts ? 503 : 200;
      this.pipeline.setUptime({ id: url, name, url, group }, { status, ms, certDaysLeft: group === 'frontend' ? 71 : 61, at: now, state: ms > 3000 ? 'slow' : 'up' });
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

  async queryLogs({ service, level, text, limit = 500 }) {
    await new Promise((r) => setTimeout(r, 400));
    let list = this.recentLogs;
    if (service) list = list.filter((l) => l.service === service);
    if (level === 'ERROR') list = list.filter((l) => l.level === 'ERROR');
    if (level === 'WARN') list = list.filter((l) => l.level === 'ERROR' || l.level === 'WARN');
    if (text) list = list.filter((l) => l.text.toLowerCase().includes(String(text).toLowerCase()));
    return list.slice(-limit);
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
    ];
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
