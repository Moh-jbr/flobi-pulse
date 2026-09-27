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

export class LoggingClient {
  constructor({ projectId, getToken, invalidateToken, minIntervalMs = 1500 }) {
    this.projectId = projectId;
    this.getToken = getToken;
    this.invalidateToken = invalidateToken;
    this.minIntervalMs = minIntervalMs;
    this.queue = Promise.resolve();
    this.lastCall = 0;
  }

  /** Serialised + spaced entries:list calls, with backoff on 429. */
  list({ filter, orderBy = 'timestamp desc', pageSize = 1000, pageToken, project = this.projectId }) {
    const run = async () => {
      const wait = this.lastCall + this.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      for (let attempt = 0; ; attempt++) {
        this.lastCall = Date.now();
        try {
          return await json({
            method: 'POST',
            url: 'https://logging.googleapis.com/v2/entries:list',
            headers: { authorization: `Bearer ${await this.getToken()}`, 'content-type': 'application/json' },
            body: JSON.stringify({ resourceNames: [`projects/${project}`], filter, orderBy, pageSize, ...(pageToken ? { pageToken } : {}) }),
            timeoutMs: 60_000,
          });
        } catch (e) {
          if (e.status === 429 && attempt < 3) {
            await sleep(15_000 * (attempt + 1));
            continue;
          }
          throw e;
        }
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  /** Pages through results up to `max` entries. */
  async listAll({ filter, orderBy = 'timestamp desc', max = 2000, pageSize = 1000, project }) {
    const out = [];
    let pageToken;
    do {
      const res = await this.list({ filter, orderBy, pageSize: Math.min(pageSize, max - out.length), pageToken, project });
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
