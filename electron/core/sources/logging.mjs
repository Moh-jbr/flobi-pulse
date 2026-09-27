// Cloud Logging: history queries (entries:list, REST) and live tail
// (TailLogEntries, gRPC). Google allows 10 live-tail sessions per project and
// 60 entries:list calls per minute per project (shared by everyone), so list
// calls go through a local rate limiter.
import { json } from '../net/http.mjs';
import { openStream, GRPC_CODE } from '../net/grpc.mjs';
import { encodeTailRequest, decodeTailResponse } from '../net/protobuf.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const TAIL_UNAVAILABLE_MESSAGE =
  'Google allows 10 live log streams per project, and all 10 are in use right now (other Flobi Pulse windows or someone streaming in Logs Explorer). Live Traffic will reconnect on its own as soon as one frees up.';

export const RATE_LIMITED_MESSAGE =
  'Google is limiting log reads for this project right now (every Flobi Pulse window on the team shares 60 reads a minute). Wait a minute, then try again.';

export class LoggingClient {
  constructor({ projectId, getToken, invalidateToken, minIntervalMs = 1500, request = json, retryMs = 4_000, backoffMs = 15_000 }) {
    this.projectId = projectId;
    this.getToken = getToken;
    this.invalidateToken = invalidateToken;
    this.minIntervalMs = minIntervalMs;
    this.request = request;
    this.retryMs = retryMs;
    this.backoffMs = backoffMs;
    this.lastCall = 0;
    // Two lanes: what someone clicked on goes before background work (recap,
    // Postgres polling), so a search never waits behind a queue of reads.
    this.lanes = { interactive: [], background: [] };
    this.cooldownUntil = 0; // after a 429, background reads wait this out
    this.busy = false;
  }

  /**
   * One entries:list call, spaced out and rate-limit aware.
   * priority 'interactive' (someone is waiting on screen) jumps the queue, retries a
   * 429 once after a few seconds, then fails with a clear message. 'background'
   * backs off 15/30/45 s without holding up the queue.
   */
  list({ filter, orderBy = 'timestamp desc', pageSize = 1000, pageToken, project = this.projectId, priority = 'background' }) {
    const body = JSON.stringify({ resourceNames: [`projects/${project}`], filter, orderBy, pageSize, ...(pageToken ? { pageToken } : {}) });
    return new Promise((resolve, reject) => {
      this.lanes[priority === 'interactive' ? 'interactive' : 'background'].push({ body, priority, resolve, reject, tries: 0 });
      this._pump();
    });
  }

  async _pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (;;) {
        let task = this.lanes.interactive.shift();
        if (!task && this.lanes.background.length) {
          const wait = this.cooldownUntil - Date.now();
          if (wait > 0) {
            clearTimeout(this._wake);
            this._wake = setTimeout(() => this._pump(), wait);
            break;
          }
          task = this.lanes.background.shift();
        }
        if (!task) break;
        const wait = this.lastCall + this.minIntervalMs - Date.now();
        if (wait > 0) await sleep(wait);
        this.lastCall = Date.now();
        try {
          task.resolve(await this._call(task.body));
        } catch (e) {
          task.tries++;
          if (e.status === 429 && task.priority === 'interactive' && task.tries < 2) {
            await sleep(this.retryMs);
            this.lanes.interactive.unshift(task);
          } else if (e.status === 429 && task.priority !== 'interactive' && task.tries <= 3) {
            this.cooldownUntil = Date.now() + this.backoffMs * task.tries;
            this.lanes.background.unshift(task);
          } else if (e.status === 429) {
            task.reject(Object.assign(new Error(RATE_LIMITED_MESSAGE), { status: 429 }));
          } else task.reject(e);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  async _call(body) {
    return this.request({
      method: 'POST',
      url: 'https://logging.googleapis.com/v2/entries:list',
      headers: { authorization: `Bearer ${await this.getToken()}`, 'content-type': 'application/json' },
      body,
      timeoutMs: 60_000,
    });
  }

  /** Pages through results up to `max` entries. */
  async listAll({ filter, orderBy = 'timestamp desc', max = 2000, pageSize = 1000, project, priority }) {
    const out = [];
    let pageToken;
    do {
      const res = await this.list({ filter, orderBy, pageSize: Math.min(pageSize, max - out.length), pageToken, project, priority });
      out.push(...(res?.entries || []));
      pageToken = res?.nextPageToken;
    } while (pageToken && out.length < max);
    return out;
  }

  /**
   * Opens a live tail and keeps it open (reconnecting when Google ends it).
   * onState(state, message): 'connecting' | 'streaming' | 'unavailable' | 'error' | 'stopped'
   */
  tail({ filter, onEntries, onSuppressed, onState }) {
    let stopped = false;
    let handle = null;
    let wake = null;
    const nap = (ms) =>
      new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        wake = () => {
          clearTimeout(t);
          resolve();
        };
      });

    const loop = async () => {
      let attempt = 0;
      while (!stopped) {
        onState('connecting');
        let token;
        try {
          token = await this.getToken();
        } catch (e) {
          onState('error', e.message);
          await nap(30_000);
          continue;
        }
        const result = await new Promise((resolve) => {
          let gotData = false;
          handle = openStream({
            origin: 'https://logging.googleapis.com',
            path: '/google.logging.v2.LoggingServiceV2/TailLogEntries',
            headers: {
              authorization: `Bearer ${token}`,
              'x-goog-request-params': `resource_names=${encodeURIComponent(`projects/${this.projectId}`)}`,
            },
            request: encodeTailRequest({ resourceNames: [`projects/${this.projectId}`], filter }),
            onOpen: () => {
              attempt = 0;
              onState('streaming');
            },
            onMessage: (buf) => {
              gotData = true;
              const { entries, suppression } = decodeTailResponse(buf);
              if (entries.length) onEntries(entries);
              if (suppression.length) onSuppressed?.(suppression);
            },
            onEnd: (err) => resolve({ err, gotData }),
          });
        });
        handle = null;
        if (stopped) break;
        const { err } = result;
        if (err.code === GRPC_CODE.RESOURCE_EXHAUSTED) {
          onState('unavailable', TAIL_UNAVAILABLE_MESSAGE);
          await nap(60_000);
        } else if (err.code === GRPC_CODE.PERMISSION_DENIED) {
          onState('error', `Your account can't read logs (it needs the Logs Viewer role). ${err.message || ''}`.trim());
          await nap(5 * 60_000);
        } else if (err.code === GRPC_CODE.UNAUTHENTICATED) {
          onState('connecting', 'Refreshing sign-in…');
          this.invalidateToken?.();
          await nap(attempt++ ? 5_000 : 250);
        } else if (err.code === GRPC_CODE.INVALID_ARGUMENT) {
          onState('error', `Google rejected the live log filter: ${err.message}`);
          await nap(5 * 60_000);
        } else {
          // Server-side end (Google closes tails periodically) or network blip.
          await nap(Math.min(30_000, 500 * 2 ** attempt++));
        }
      }
      onState('stopped');
    };
    loop();

    return {
      stop() {
        stopped = true;
        handle?.close();
        wake?.();
      },
      retryNow() {
        wake?.();
      },
    };
  }
}
