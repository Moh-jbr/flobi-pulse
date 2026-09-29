// Is this computer online? Before anything that got no answer is called down (an uptime check,
// a data source), Flobi Pulse makes sure it isn't this computer that lost its connection: it
// tries two always-up addresses of two different companies (Google's and Cloudflare's), after the
// failure. Neither answering means this computer is offline: nothing turns red and no alert opens
// until one answers again.
//
// Read-only like every other request: the guard lets these two exact addresses through (GET, no
// query, nothing sent).
import https from 'node:https';
import { checkRequest, CONNECTIVITY_PROBES } from './guard.mjs';

/** Always-up addresses of two different companies: any answer at all means the internet works. */
export const PROBES = CONNECTIVITY_PROBES;
const HEADERS = { 'user-agent': 'FlobiPulse/1.0 connectivity', 'cache-control': 'no-cache' };

/** One try: true when the address answered (any HTTP status), false when it couldn't be reached. */
export function probe(url, { timeoutMs = 8000 } = {}) {
  try {
    checkRequest({ method: 'GET', url, headers: HEADERS });
  } catch {
    return Promise.resolve(false);
  }
  const u = new URL(url);
  return new Promise((resolve) => {
    const req = https.request(
      // A fresh connection: a pooled one could hide that the network just went away.
      { method: 'GET', hostname: u.hostname, port: 443, path: u.pathname, agent: false, headers: HEADERS },
      (res) => {
        res.resume();
        resolve(true);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(false));
    req.end();
  });
}

/** True as soon as one of the promises resolves true; false once they've all said no. */
function anyTrue(promises) {
  return new Promise((resolve) => {
    let left = promises.length;
    if (!left) return resolve(false);
    for (const p of promises) {
      Promise.resolve(p)
        .catch(() => false)
        .then((ok) => {
          if (ok) resolve(true);
          else if (--left === 0) resolve(false);
        });
    }
  });
}

export class Connectivity {
  /**
   * @param {{ probe?: (url: string) => Promise<boolean>, probes?: string[],
   *   onChange?: (state: {online: boolean, since: number|null, checkedAt: number}) => void,
   *   now?: () => number, recheckMs?: number, freshMs?: number }} o
   * While offline it looks again every `recheckMs` until the connection is back.
   */
  constructor({ probe: tryOne = probe, probes = PROBES, onChange = () => {}, now = () => Date.now(), recheckMs = 10_000, freshMs = 5_000 } = {}) {
    Object.assign(this, { tryOne, probes, onChange, now, recheckMs, freshMs });
    this.state = { online: true, since: null, checkedAt: 0 };
    this.inflight = null;
    this.latest = null;
    this.timer = null;
    this.stopped = false;
  }

  get online() {
    return this.state.online;
  }

  /**
   * Resolves true when this computer is online. `since`: when what's being judged failed (default:
   * a few seconds ago). A look taken since then is reused (one from before could predate the
   * network going away); offline, one from the last few seconds is too: another failure is no
   * news. Looks asked for meanwhile share one. `force`: the network just changed, so look now;
   * that look has the last word over one already on its way.
   */
  check({ since = null, force = false } = {}) {
    const now = this.now();
    const from = since ?? now - this.freshMs;
    if (!force) {
      if (this.inflight) return this.inflight;
      const { online, checkedAt } = this.state;
      if (checkedAt && (checkedAt >= from || (!online && checkedAt >= now - this.freshMs))) return Promise.resolve(online);
    }
    const token = (this.latest = {});
    // .then runs after this.inflight is set, even when no address could be tried.
    const run = this.tryAll().then((ok) => {
      if (this.latest === token) {
        this.inflight = null;
        this.set(ok);
      }
      return ok;
    });
    this.inflight = run;
    return run;
  }

  /** Something failed at `since` (default: a few seconds ago): is it this computer? Resolves true when it's offline. */
  async offline({ since = null } = {}) {
    return !(await this.check({ since }));
  }

  async tryAll() {
    try {
      return await anyTrue(this.probes.map((u) => this.tryOne(u)));
    } catch {
      return false;
    }
  }

  set(ok) {
    if (this.stopped) return;
    const now = this.now();
    const was = this.state.online;
    this.state = { online: ok, since: ok ? null : was ? now : this.state.since, checkedAt: now };
    clearTimeout(this.timer);
    this.timer = ok ? null : setTimeout(() => this.check({ force: true }).catch(() => {}), this.recheckMs);
    if (ok === was) return;
    try {
      this.onChange(this.state);
    } catch (e) {
      console.warn('[connectivity]', e?.message);
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
