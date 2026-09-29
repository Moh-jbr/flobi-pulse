// Kubernetes API (read-only): cluster discovery, list+watch informers, metrics
// polling and pod log streaming. Plain node:https, no client library.
import { json, streamLines, request, HttpError } from '../net/http.mjs';
import { configureGuard, K8S_NAME } from '../net/guard.mjs';

/** How long a pod log stream may take to start before it counts as unreachable. */
const OPEN_TIMEOUT_MS = 15_000;

function assertNames(...names) {
  for (const n of names) if (!K8S_NAME.test(String(n || ''))) throw new Error(`Invalid Kubernetes name: ${String(n).slice(0, 80)}`);
}

/** Exponential backoff with ±25 % jitter, so the informers don't reconnect in step. */
export function backoffDelay(attempt, baseMs = 1000, maxMs = 30_000, random = Math.random) {
  return Math.round(Math.min(maxMs, baseMs * 2 ** attempt) * (0.75 + random() * 0.5));
}

/** A sleep that stop() can cut short, so a stopped loop doesn't linger for minutes. */
function sleeper() {
  let wake = null;
  return {
    nap(ms) {
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(t);
          wake = null;
          resolve();
        };
        const t = setTimeout(done, ms);
        wake = done;
      });
    },
    wake() {
      wake?.();
    },
  };
}

const LOG_TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))(?: ([\s\S]*))?$/;

/**
 * A log line from `timestamps=true` → { ts, text }. The text may contain anything,
 * "\r" and U+2028 included (a plain `.` stops at those and left the prefix in).
 */
export function splitTimestamp(line) {
  const m = LOG_TS.exec(line);
  return m ? { ts: m[1], text: m[2] ?? '' } : { ts: null, text: line };
}

/** A log timestamp as a string that sorts in time order (UTC seconds + nanoseconds). */
function timestampKey(ts) {
  const m = /^(.{19})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(ts || '');
  const sec = m && Date.parse(m[1] + m[3]) / 1000;
  return Number.isFinite(sec) ? `${String(sec).padStart(12, '0')}.${(m[2] || '').padEnd(9, '0')}` : null;
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
  /**
   * @param {{endpoint: string, caB64?: string, getToken: () => Promise<string>, invalidateToken?: (rejected: string) => void}} o
   * invalidateToken (optional) drops the cached token (it gets the rejected one): on
   * HTTP 401 a call is then retried once with a fresh token, instead of reusing a
   * rejected token until it expires.
   */
  constructor({ endpoint, caB64, getToken, invalidateToken }) {
    this.endpoint = endpoint;
    this.base = `https://${endpoint}`;
    this.ca = caB64 ? Buffer.from(caB64, 'base64') : null;
    this.getToken = getToken;
    this.invalidateToken = invalidateToken;
    configureGuard({ kubernetesHost: endpoint });
  }

  /** fn(headers); after a 401, once more with a fresh token (when it can be refreshed).
   *  A caller that stopped while the token was on its way sends nothing (→ null). */
  async _authed(fn, isStopped) {
    const token = await this.getToken();
    if (isStopped?.()) return null;
    try {
      return await fn({ authorization: `Bearer ${token}` });
    } catch (e) {
      if (e?.status !== 401 || !this.invalidateToken) throw e;
      this.invalidateToken(token);
      return fn({ authorization: `Bearer ${await this.getToken()}` });
    }
  }

  async get(path, { timeoutMs = 30_000, isStopped } = {}) {
    return this._authed((headers) => json({ url: this.base + path, ca: this.ca, headers, timeoutMs }), isStopped);
  }

  async getText(path) {
    return this._authed(async (headers) => {
      const res = await request({ url: this.base + path, ca: this.ca, headers: { ...headers, accept: 'text/plain' }, timeoutMs: 30_000, maxBytes: 8 * 1024 * 1024 });
      const text = res.body.toString('utf8');
      if (res.status >= 400) throw new HttpError(res.status, `HTTP ${res.status}`, text);
      return text;
    });
  }

  /**
   * A long-lived GET (watch, log follow) → { done, abort }. A 401 when it opens is
   * retried once with a fresh token. `isStopped` is asked once the token is in: a
   * caller stopped meanwhile gets an already-ended stream and nothing is opened.
   */
  async stream(path, onLine, { idleTimeoutMs = 0, onOpen, isStopped } = {}) {
    let aborted = false;
    let current = null;
    let token = null;
    const stopped = { status: 0, aborted: true, reason: 'stopped' };
    const open = async () => {
      token = await this.getToken();
      if (aborted || isStopped?.()) return null;
      return (current = streamLines({ url: this.base + path, ca: this.ca, headers: { authorization: `Bearer ${token}` }, onLine, onOpen, idleTimeoutMs }));
    };
    if (!(await open())) return { done: Promise.resolve(stopped), abort() {} };
    const done = current.done.catch(async (e) => {
      if (e?.status !== 401 || !this.invalidateToken || aborted) throw e;
      this.invalidateToken(token);
      return (await open()) ? current.done : stopped;
    });
    return {
      done,
      abort() {
        aborted = true;
        current?.abort();
      },
    };
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

  /**
   * Follows a container's logs live. Reconnects (with sinceTime) if the stream
   * drops while the pod is still around, without repeating lines already shown.
   * Returns { stop }. backoffMs and openTimeoutMs are only changed by tests.
   */
  followLogs({ namespace, pod, container, tailLines = 200, onLine, onStatus, backoffMs = 1000, openTimeoutMs = OPEN_TIMEOUT_MS }) {
    assertNames(namespace, pod, container);
    let stopped = false;
    let current = null;
    const pause = sleeper();
    const isStopped = () => stopped;
    // The newest line shown so far: its timestamp as Kubernetes wrote it (for
    // sinceTime), in sortable form, and how many lines were shown at exactly that time.
    let lastTs = null;
    let lastKey = null;
    let atLast = 0;
    const run = async () => {
      let attempt = 0;
      while (!stopped) {
        const q = new URLSearchParams({ container, follow: 'true', timestamps: 'true' });
        if (lastTs) q.set('sinceTime', lastTs);
        else q.set('tailLines', String(tailLines));
        // Kubernetes cuts sinceTime to the whole second, so everything from the start of
        // that second comes again: skip lines older than lastTs, and the first `replay`
        // lines at exactly lastTs (those were shown). Past that, everything is new.
        let resumeKey = lastKey;
        let replay = atLast;
        let fresh = 0;
        // "streaming" only once Kubernetes actually answers. The API server fetches the
        // logs from the node's kubelet and that can hang; after openTimeoutMs it's
        // reported as "unreachable" and retried, instead of looking connected forever.
        let opened = false;
        let openedAt = 0;
        let timer = null;
        try {
          onStatus?.('opening');
          current = await this.stream(
            `/api/v1/namespaces/${namespace}/pods/${pod}/log?${q}`,
            (line) => {
              if (stopped) return;
              const { ts, text } = splitTimestamp(line);
              const key = timestampKey(ts);
              if (key) {
                if (resumeKey) {
                  if (key < resumeKey) return;
                  if (key === resumeKey && replay > 0) {
                    replay--;
                    return;
                  }
                  if (key > resumeKey) resumeKey = null;
                }
                if (!lastKey || key > lastKey) {
                  lastKey = key;
                  lastTs = ts;
                  atLast = 1;
                } else if (key === lastKey) atLast++;
              }
              fresh++;
              onLine(text, ts ? Date.parse(ts) : Date.now());
            },
            {
              isStopped,
              onOpen: () => {
                if (stopped) return;
                opened = true;
                openedAt = Date.now();
                clearTimeout(timer);
                onStatus?.('streaming');
              },
            },
          );
          if (stopped) {
            current.abort();
            break;
          }
          if (!opened) timer = setTimeout(() => !opened && current.abort(), openTimeoutMs);
          await current.done;
          clearTimeout(timer);
          if (!opened && !stopped) onStatus?.('unreachable', `Kubernetes didn't start sending this pod's logs within ${openTimeoutMs / 1000} s.`);
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
        // Only a stream that showed new lines or stayed open a while starts the backoff
        // over: a stopped container ends every follow at once, and is then asked less often.
        if (fresh || (opened && Date.now() - openedAt >= 30_000)) attempt = 0;
        await pause.nap(Math.min(30_000, backoffMs * 2 ** attempt++));
      }
      if (!stopped) onStatus?.('stopped');
    };
    run();
    return {
      stop() {
        stopped = true;
        current?.abort();
        pause.wake();
      },
    };
  }
}

/**
 * List + watch for one resource type. Keeps an in-memory map and calls onChange
 * with the full list whenever something changes.
 *
 * Reconnects are paced: a watch that ends at once (or quietly, before it counts as
 * healthy) or fails with an ERROR event is followed by a backoff of 1 s doubling to
 * 30 s (with jitter), which only a healthy watch (events, or open healthyMs) resets.
 * Without it a watch that closes immediately, or a CRD whose webhook fails, turns
 * into thousands of requests a second. `timing` is only changed by tests.
 */
export class Informer {
  constructor(client, key, path, { onChange, onStatus, slim = (x) => x, timing = {} }) {
    this.client = client;
    this.key = key;
    this.path = path;
    this.onChange = onChange;
    this.onStatus = onStatus;
    this.slim = slim;
    this.timing = { backoffMs: 1000, maxBackoffMs: 30_000, quickMs: 5_000, healthyMs: 60_000, ...timing };
    this.items = new Map();
    this.stopped = false;
    this.current = null;
    this.pause = sleeper();
  }

  start() {
    this._loop();
    return this;
  }

  stop() {
    this.stopped = true;
    this.current?.abort();
    this.pause.wake();
  }

  _emit() {
    if (this.stopped) return; // nothing reaches the app after stop()
    this.onChange(this.key, [...this.items.values()]);
  }

  async _loop() {
    const { backoffMs, maxBackoffMs, quickMs, healthyMs } = this.timing;
    const backoff = (n) => backoffDelay(n, backoffMs, maxBackoffMs);
    const isStopped = () => this.stopped;
    // Failures in a row: list errors, watch errors, watches that ended at once. Only a
    // healthy watch resets it; a successful relist alone doesn't (a watch that fails
    // right after every relist must still back off).
    let attempt = 0;
    while (!this.stopped) {
      try {
        const list = await this.client.get(this.path, { isStopped: () => this.stopped });
        if (this.stopped) break;
        let rv = list?.metadata?.resourceVersion;
        this.items = new Map((list?.items || []).map((o) => [o.metadata.uid, this.slim(o)]));
        this._emit();
        this.onStatus?.(this.key, 'ok');
        for (;;) {
          const sep = this.path.includes('?') ? '&' : '?';
          const url = `${this.path}${sep}watch=1&allowWatchBookmarks=true&timeoutSeconds=290${rv ? `&resourceVersion=${rv}` : ''}`;
          let changed = false;
          let flushTimer = null;
          let events = 0;
          let failure = null; // the ERROR event's status object
          const flush = () => {
            flushTimer = null;
            if (changed) {
              changed = false;
              this._emit();
            }
          };
          const openedAt = Date.now();
          const handle = await this.client.stream(
            url,
            (line) => {
              if (this.stopped || failure) return;
              const ev = JSON.parse(line);
              const obj = ev.object;
              if (ev.type === 'ERROR') {
                // The watch is over (410: its resourceVersion expired; anything else,
                // e.g. a failing conversion webhook, a 500): relist.
                failure = obj || {};
                this.current?.abort();
                return;
              }
              events++;
              if (obj?.metadata?.resourceVersion) rv = obj.metadata.resourceVersion;
              if (ev.type === 'BOOKMARK') return;
              if (ev.type === 'DELETED') this.items.delete(obj.metadata.uid);
              else this.items.set(obj.metadata.uid, this.slim(obj));
              changed = true;
              if (!flushTimer) flushTimer = setTimeout(flush, 150);
            },
            { idleTimeoutMs: 330_000, isStopped },
          );
          this.current = handle;
          if (this.stopped) {
            handle.abort();
            break;
          }
          await handle.done;
          if (flushTimer) {
            clearTimeout(flushTimer);
            flush();
          }
          if (this.stopped) break;
          const lasted = Date.now() - openedAt;
          const healthy = events > 0 || lasted >= healthyMs;
          if (healthy) attempt = 0;
          if (failure) {
            if (failure.code === 410) {
              // Expired: relist right away, unless 410s keep coming (then back off too).
              if (attempt) await this.pause.nap(backoff(attempt - 1));
              attempt++;
            } else {
              console.warn(`[k8s] watching ${this.key} failed (${failure.code || '?'} ${failure.reason || ''}: ${failure.message || ''}); relisting`);
              await this.pause.nap(backoff(attempt++));
            }
            break; // relist
          }
          // Ended at once, or quietly before it was healthy: wait before watching again.
          if (lasted < quickMs || !healthy) await this.pause.nap(backoff(attempt++));
          if (this.stopped) break;
        }
      } catch (e) {
        if (this.stopped) break;
        if (e.status === 404 && OPTIONAL.has(this.key)) {
          this.onStatus?.(this.key, 'absent');
          this.items.clear();
          this._emit();
          await this.pause.nap(10 * 60_000);
          continue;
        }
        if (e.status === 403) {
          this.onStatus?.(this.key, 'forbidden', e.message);
        } else {
          this.onStatus?.(this.key, 'error', e.message);
        }
        await this.pause.nap(backoffDelay(attempt++, backoffMs, 2 * maxBackoffMs));
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
          this.client.get(`/apis/metrics.k8s.io/v1beta1/namespaces/${this.ns}/pods`, { isStopped: () => this.stopped }),
          this.client.get(`/apis/metrics.k8s.io/v1beta1/nodes`, { isStopped: () => this.stopped }).catch(() => ({ items: [] })),
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
