// Kubernetes API (read-only): cluster discovery, list+watch informers, metrics
// polling and pod log streaming. Plain node:https, no client library.
import { json, streamLines, request, HttpError } from '../net/http.mjs';
import { configureGuard, K8S_NAME } from '../net/guard.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** How long a pod log stream may take to start before it counts as unreachable. */
const OPEN_TIMEOUT_MS = 15_000;

function assertNames(...names) {
  for (const n of names) if (!K8S_NAME.test(String(n || ''))) throw new Error(`Invalid Kubernetes name: ${String(n).slice(0, 80)}`);
}

/** Finds the control-plane endpoint + CA, from the team config or the GKE API. */
export async function resolveCluster({ config, auth }) {
  const c = config.cluster || {};
  if (c.endpoint && c.caCertificate) {
    return {
      name: c.name,
      location: c.location,
      endpoint: c.endpoint.replace(/^https?:\/\//, '').replace(/\/$/, ''),
      caB64: c.caCertificate,
      source: 'team-config',
    };
  }
  const token = await auth.getToken('platform');
  const url = `https://container.googleapis.com/v1/projects/${config.projectId}/locations/${c.location}/clusters/${c.name}`;
  const cl = await json({ url, headers: { authorization: `Bearer ${token}` } });
  return {
    name: cl.name,
    location: cl.location,
    endpoint: cl.endpoint,
    caB64: cl.masterAuth?.clusterCaCertificate,
    version: cl.currentMasterVersion,
    status: cl.status,
    nodeCount: cl.currentNodeCount,
    autopilot: !!cl.autopilot?.enabled,
    source: 'gke-api',
  };
}

export function resourcePaths(ns) {
  return {
    pods: `/api/v1/namespaces/${ns}/pods`,
    deployments: `/apis/apps/v1/namespaces/${ns}/deployments`,
    statefulsets: `/apis/apps/v1/namespaces/${ns}/statefulsets`,
    services: `/api/v1/namespaces/${ns}/services`,
    events: `/api/v1/namespaces/${ns}/events`,
    nodeEvents: `/api/v1/events?fieldSelector=${encodeURIComponent('involvedObject.kind=Node')}`,
    hpas: `/apis/autoscaling/v2/namespaces/${ns}/horizontalpodautoscalers`,
    scaledobjects: `/apis/keda.sh/v1alpha1/namespaces/${ns}/scaledobjects`,
    nodes: `/api/v1/nodes`,
    jobs: `/apis/batch/v1/namespaces/${ns}/jobs`,
    cronjobs: `/apis/batch/v1/namespaces/${ns}/cronjobs`,
    ingresses: `/apis/networking.k8s.io/v1/namespaces/${ns}/ingresses`,
    certificates: `/apis/networking.gke.io/v1/namespaces/${ns}/managedcertificates`,
    pdbs: `/apis/policy/v1/namespaces/${ns}/poddisruptionbudgets`,
  };
}

// Resources that may not exist on every cluster (CRDs). A 404 is not an error.
const OPTIONAL = new Set(['scaledobjects', 'certificates', 'pdbs', 'statefulsets']);

export class KubeClient {
  constructor({ endpoint, caB64, getToken }) {
    this.endpoint = endpoint;
    this.base = `https://${endpoint}`;
    this.ca = caB64 ? Buffer.from(caB64, 'base64') : null;
    this.getToken = getToken;
    configureGuard({ kubernetesHost: endpoint });
  }

  async headers() {
    return { authorization: `Bearer ${await this.getToken()}` };
  }

  async get(path, { timeoutMs = 30_000 } = {}) {
    return json({ url: this.base + path, ca: this.ca, headers: await this.headers(), timeoutMs });
  }

  async getText(path) {
    const res = await request({ url: this.base + path, ca: this.ca, headers: { ...(await this.headers()), accept: 'text/plain' }, timeoutMs: 30_000, maxBytes: 8 * 1024 * 1024 });
    const text = res.body.toString('utf8');
    if (res.status >= 400) throw new HttpError(res.status, `HTTP ${res.status}`, text);
    return text;
  }

  async stream(path, onLine, { idleTimeoutMs = 0, onOpen } = {}) {
    return streamLines({ url: this.base + path, ca: this.ca, headers: await this.headers(), onLine, onOpen, idleTimeoutMs });
  }

  async version() {
    return this.get('/version');
  }

  /** Logs from the container's previous run (i.e. right before it crashed). */
  async previousLogs({ namespace, pod, container, tailLines = 300 }) {
    assertNames(namespace, pod, container);
    const q = new URLSearchParams({ container, previous: 'true', tailLines: String(tailLines), timestamps: 'true' });
    return this.getText(`/api/v1/namespaces/${namespace}/pods/${pod}/log?${q}`);
  }

  async recentLogs({ namespace, pod, container, tailLines = 300 }) {
    assertNames(namespace, pod, container);
    const q = new URLSearchParams({ container, tailLines: String(tailLines), timestamps: 'true' });
    return this.getText(`/api/v1/namespaces/${namespace}/pods/${pod}/log?${q}`);
  }

  /**
   * Follows a container's logs live. Reconnects (with sinceTime) if the stream
   * drops while the pod is still around. Returns { stop }.
   */
  followLogs({ namespace, pod, container, tailLines = 200, onLine, onStatus }) {
    assertNames(namespace, pod, container);
    let stopped = false;
    let current = null;
    let lastTs = null;
    const run = async () => {
      let attempt = 0;
      while (!stopped) {
        const q = new URLSearchParams({ container, follow: 'true', timestamps: 'true' });
        if (lastTs) q.set('sinceTime', lastTs);
        else q.set('tailLines', String(tailLines));
        // "streaming" only once Kubernetes actually answers. The API server fetches the
        // logs from the node's kubelet and that can hang; after OPEN_TIMEOUT_MS it's
        // reported as "unreachable" and retried, instead of looking connected forever.
        let opened = false;
        let timer = null;
        try {
          onStatus?.('opening');
          current = await this.stream(
            `/api/v1/namespaces/${namespace}/pods/${pod}/log?${q}`,
            (line) => {
              const m = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) (.*)$/);
              if (m) lastTs = m[1];
              onLine(m ? m[2] : line, m ? Date.parse(m[1]) : Date.now());
            },
            {
              onOpen: () => {
                opened = true;
                clearTimeout(timer);
                attempt = 0;
                onStatus?.('streaming');
              },
            },
          );
          if (!opened) timer = setTimeout(() => !opened && current.abort(), OPEN_TIMEOUT_MS);
          await current.done;
          clearTimeout(timer);
          if (!opened && !stopped) onStatus?.('unreachable', `Kubernetes didn't start sending this pod's logs within ${OPEN_TIMEOUT_MS / 1000} s.`);
        } catch (e) {
          clearTimeout(timer);
          if (stopped) break;
          if (e.status === 403) {
            onStatus?.('forbidden', e.message);
            break; // not allowed: retrying won't help
          }
          onStatus?.('error', e.message);
          if (e.status === 404 || e.status === 400) break; // pod or container gone
        }
        if (stopped) break;
        await sleep(Math.min(30_000, 1000 * 2 ** attempt++));
      }
      if (!stopped) onStatus?.('stopped');
    };
    run();
    return {
      stop() {
        stopped = true;
        current?.abort();
      },
    };
  }
}

/**
 * List + watch for one resource type. Keeps an in-memory map and calls onChange
 * with the full list whenever something changes.
 */
export class Informer {
  constructor(client, key, path, { onChange, onStatus, slim = (x) => x }) {
    this.client = client;
    this.key = key;
    this.path = path;
    this.onChange = onChange;
    this.onStatus = onStatus;
    this.slim = slim;
    this.items = new Map();
    this.stopped = false;
    this.current = null;
  }

  start() {
    this._loop();
    return this;
  }

  stop() {
    this.stopped = true;
    this.current?.abort();
  }

  _emit() {
    this.onChange(this.key, [...this.items.values()]);
  }

  async _loop() {
    let attempt = 0;
    while (!this.stopped) {
      try {
        const list = await this.client.get(this.path);
        let rv = list?.metadata?.resourceVersion;
        this.items = new Map((list?.items || []).map((o) => [o.metadata.uid, this.slim(o)]));
        this._emit();
        this.onStatus?.(this.key, 'ok');
        attempt = 0;
        let relist = false;
        while (!this.stopped && !relist) {
          const sep = this.path.includes('?') ? '&' : '?';
          const url = `${this.path}${sep}watch=1&allowWatchBookmarks=true&timeoutSeconds=290${rv ? `&resourceVersion=${rv}` : ''}`;
          let changed = false;
          let flushTimer = null;
          const flush = () => {
            flushTimer = null;
            if (changed) {
              changed = false;
              this._emit();
            }
          };
          this.current = await this.client.stream(url, (line) => {
            const ev = JSON.parse(line);
            const obj = ev.object;
            if (ev.type === 'ERROR') {
              if (obj?.code === 410) relist = true;
              return;
            }
            if (obj?.metadata?.resourceVersion) rv = obj.metadata.resourceVersion;
            if (ev.type === 'BOOKMARK') return;
            if (ev.type === 'DELETED') this.items.delete(obj.metadata.uid);
            else this.items.set(obj.metadata.uid, this.slim(obj));
            changed = true;
            if (!flushTimer) flushTimer = setTimeout(flush, 150);
          }, { idleTimeoutMs: 330_000 });
          await this.current.done;
          if (flushTimer) {
            clearTimeout(flushTimer);
            flush();
          }
          if (relist) break;
        }
      } catch (e) {
        if (this.stopped) break;
        if (e.status === 404 && OPTIONAL.has(this.key)) {
          this.onStatus?.(this.key, 'absent');
          this.items.clear();
          this._emit();
          await sleep(10 * 60_000);
          continue;
        }
        if (e.status === 403) {
          this.onStatus?.(this.key, 'forbidden', e.message);
        } else {
          this.onStatus?.(this.key, 'error', e.message);
        }
        await sleep(Math.min(60_000, 1000 * 2 ** attempt++));
      }
    }
  }
}

/** Polls metrics-server for live CPU/memory usage. */
export class MetricsPoller {
  constructor(client, ns, { intervalMs = 15_000, onMetrics, onStatus }) {
    Object.assign(this, { client, ns, intervalMs, onMetrics, onStatus });
    this.timer = null;
  }
  start() {
    this.stopped = false;
    const tick = async () => {
      if (this.stopped) return;
      try {
        const [pods, nodes] = await Promise.all([
          this.client.get(`/apis/metrics.k8s.io/v1beta1/namespaces/${this.ns}/pods`),
          this.client.get(`/apis/metrics.k8s.io/v1beta1/nodes`).catch(() => ({ items: [] })),
        ]);
        if (this.stopped) return;
        this.onMetrics({ pods: pods?.items || [], nodes: nodes?.items || [], at: Date.now() });
        this.onStatus?.('ok');
      } catch (e) {
        if (!this.stopped) this.onStatus?.('error', e.message);
      }
      if (!this.stopped) this.timer = setTimeout(tick, this.intervalMs);
    };
    tick();
    return this;
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}
