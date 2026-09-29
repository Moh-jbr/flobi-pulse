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
  /**
   * invalidateToken (optional): on HTTP 401 a read is retried once with a fresh token.
   * request, openStream and tailTiming are only replaced by tests.
   */
  constructor({ projectId, getToken, invalidateToken, minIntervalMs = 1500, request = json, retryMs = 4_000, backoffMs = 15_000, openStream: open = openStream, tailTiming = {} }) {
    this.projectId = projectId;
    this.getToken = getToken;
    this.invalidateToken = invalidateToken;
    this.minIntervalMs = minIntervalMs;
    this.request = request;
    this.openStream = open;
    this.tailTiming = { backoffMs: 500, maxBackoffMs: 30_000, healthyMs: 30_000, ...tailTiming };
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
    const send = (token) =>
      this.request({
        method: 'POST',
        url: 'https://logging.googleapis.com/v2/entries:list',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body,
        timeoutMs: 60_000,
      });
    const token = await this.getToken();
    try {
      return await send(token);
    } catch (e) {
      // A rejected (revoked, rotated) token: get a fresh one and try once more.
      if (e?.status !== 401 || !this.invalidateToken) throw e;
      this.invalidateToken(token);
      return send(await this.getToken());
    }
  }

  /**
   * Pages through results up to `max` entries, within a budget: Google answers a slow
   * search with empty pages that still carry a nextPageToken, so an unbounded loop
   * could page for minutes on the reads every teammate shares. Stops after 3 empty
   * pages in a row, `maxPages` pages or `maxMs`, and returns what it found; the array
   * then has `truncated: true` (a non-enumerable property, so it's still a plain list).
   */
  async listAll({ filter, orderBy = 'timestamp desc', max = 2000, pageSize = 1000, project, priority, maxPages = 20, maxMs = priority === 'interactive' ? 30_000 : 60_000 }) {
    const started = Date.now();
    const out = [];
    let pageToken;
    let pages = 0;
    let empty = 0;
    do {
      const res = await this.list({ filter, orderBy, pageSize: Math.min(pageSize, max - out.length), pageToken, project, priority });
      const entries = res?.entries || [];
      out.push(...entries);
      pages++;
      empty = entries.length ? 0 : empty + 1;
      pageToken = res?.nextPageToken;
      if (pageToken && out.length < max && (empty >= 3 || pages >= maxPages || Date.now() - started >= maxMs)) {
        Object.defineProperty(out, 'truncated', { value: true });
        break;
      }
    } while (pageToken && out.length < max);
    return out;
  }

  /**
   * Opens a live tail and keeps it open (reconnecting when Google ends it).
   * onState(state, message): 'connecting' | 'streaming' | 'unavailable' | 'error' | 'stopped'
   */
  tail({ filter, onEntries, onSuppressed, onState }) {
    const { backoffMs, maxBackoffMs, healthyMs } = this.tailTiming;
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
      // Reconnects in a row that didn't give a working stream. Merely opening doesn't
      // reset it (a server that accepts and then fails would be hit twice a second);
      // a stream that delivered something or stayed up healthyMs does.
      let attempt = 0;
      while (!stopped) {
        onState('connecting');
        let token;
        try {
          token = await this.getToken();
        } catch (e) {
          if (stopped) break;
          onState('error', e.message);
          await nap(30_000);
          continue;
        }
        // Stopped while the token was on its way (a connector restart after sleep): don't
        // open a stream, it would hold one of the project's 10 live-tail slots for nothing.
        if (stopped) break;
        const resourceNames = [`projects/${this.projectId}`];
        let openedAt = 0;
        let messages = 0;
        let err;
        try {
          err = await new Promise((resolve) => {
            handle = this.openStream({
              origin: 'https://logging.googleapis.com',
              path: '/google.logging.v2.LoggingServiceV2/TailLogEntries',
              headers: {
                authorization: `Bearer ${token}`,
                'x-goog-request-params': `resource_names=${encodeURIComponent(resourceNames[0])}`,
              },
              request: encodeTailRequest({ resourceNames, filter }),
              onOpen: () => {
                if (stopped) return;
                openedAt = Date.now();
                onState('streaming');
              },
              onMessage: (buf) => {
                if (stopped) return;
                messages++;
                const { entries, suppression } = decodeTailResponse(buf);
                if (entries.length) onEntries(entries);
                if (suppression.length) onSuppressed?.(suppression);
              },
              onEnd: resolve,
            });
          });
        } catch (e) {
          // Refused before anything was sent (the read-only guard): retrying soon won't help.
          handle = null;
          if (stopped) break;
          onState('error', e.message);
          await nap(5 * 60_000);
          continue;
        }
        handle = null;
        if (stopped) break;
        if (messages || (openedAt && Date.now() - openedAt >= healthyMs)) attempt = 0;
        if (err.code === GRPC_CODE.RESOURCE_EXHAUSTED) {
          onState('unavailable', TAIL_UNAVAILABLE_MESSAGE);
          await nap(60_000);
        } else if (err.code === GRPC_CODE.PERMISSION_DENIED) {
          onState('error', `Your account can't read logs (it needs the Logs Viewer role). ${err.message || ''}`.trim());
          await nap(5 * 60_000);
        } else if (err.code === GRPC_CODE.UNAUTHENTICATED) {
          onState('connecting', 'Refreshing sign-in…');
          this.invalidateToken?.(token);
          await nap(attempt++ ? 5_000 : 250);
        } else if (err.code === GRPC_CODE.INVALID_ARGUMENT) {
          onState('error', `Google rejected the live log filter: ${err.message}`);
          await nap(5 * 60_000);
        } else {
          // Server-side end (Google closes tails periodically), a dead connection or a blip.
          await nap(Math.min(maxBackoffMs, backoffMs * 2 ** attempt++));
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
