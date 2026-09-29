// Outside-in checks: hits each public URL the way a user would and records
// status, latency and how many days the TLS certificate has left.
import https from 'node:https';
import { checkRequest, configureGuard } from '../net/guard.mjs';

export function classifyUptime(result) {
  if (result.error) return 'down';
  const s = result.status;
  if (s >= 520 && s <= 527) return 'down'; // Cloudflare: origin unreachable
  if (s >= 500) return 'down';
  if (result.ms > 3000) return 'slow';
  return 'up';
}

/** `ca` is only for tests (a local server with its own certificate). */
export function checkUrl(url, { timeoutMs = 10_000, ca } = {}) {
  try {
    checkRequest({ method: 'GET', url });
  } catch (e) {
    return Promise.resolve({ error: e.message, ms: 0 });
  }
  const u = new URL(url);
  const started = performance.now();
  return new Promise((resolve) => {
    const req = https.request(
      {
        method: 'GET',
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        agent: false, // fresh connection so latency includes TLS, like a real visitor
        headers: { 'user-agent': 'FlobiPulse/1.0 uptime', accept: '*/*', 'cache-control': 'no-cache' },
        ...(ca ? { ca } : {}),
      },
      (res) => {
        let certDaysLeft = null;
        try {
          const cert = res.socket.getPeerCertificate?.();
          if (cert?.valid_to) certDaysLeft = Math.floor((Date.parse(cert.valid_to) - Date.now()) / 86_400_000);
        } catch {}
        let read = 0;
        let enough = false; // stopped reading a big page on purpose
        res.on('data', (c) => {
          read += c.length;
          if (read > 256 * 1024 && !enough) {
            enough = true;
            res.destroy();
          }
        });
        const done = () => {
          const result = { status: res.statusCode, ms: Math.round(performance.now() - started), certDaysLeft, cfRay: res.headers['cf-ray'] || null };
          // The connection dropped before the whole answer arrived: that's not "up".
          resolve(res.complete || enough ? result : { ...result, error: 'The response was cut off' });
        };
        res.on('end', done);
        res.on('close', done);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`No response in ${timeoutMs / 1000}s`)));
    req.on('error', (e) => resolve({ error: e.code === 'ENOTFOUND' ? 'DNS lookup failed' : e.message, code: e.code, ms: Math.round(performance.now() - started) }));
    req.end();
  });
}

export class UptimeMonitor {
  /**
   * isOffline({ since }): resolves true when this computer is offline (net/connectivity.mjs). A
   * check that got no answer at all only counts as the site being down once it's clear this
   * computer is online; offline, it's reported as 'offline', which counts for nothing.
   */
  constructor({ targets = [], intervalMs = 30_000, onResult, isOffline = null, check = checkUrl }) {
    this.intervalMs = intervalMs;
    this.onResult = onResult;
    this.isOffline = isOffline;
    this.checkUrl = check;
    this.timer = null;
    this.setTargets(targets);
  }
  setTargets(targets) {
    this.targets = targets;
    configureGuard({ uptimeUrls: targets.map((t) => t.url) });
  }
  start() {
    this.stopped = false;
    const tick = async () => {
      if (this.stopped) return;
      try {
        await this.round();
      } catch (e) {
        console.warn('[uptime]', e?.message);
      } finally {
        if (!this.stopped) this.timer = setTimeout(tick, this.intervalMs);
      }
    };
    tick();
    return this;
  }

  /**
   * One check of every target. One that failed without a whole answer (none at all, or cut off):
   * is it this computer that's offline? Only a look at the connection taken after the first such
   * failure counts (the network may have gone mid-round).
   */
  async round() {
    const results = await Promise.all(this.targets.map(async (t) => ({ t, r: await this.checkUrl(t.url), at: Date.now() })));
    const failed = results.filter(({ r }) => r.error);
    const offline = failed.length && this.isOffline ? await this.isOffline({ since: Math.min(...failed.map((x) => x.at)) }).catch(() => false) : false;
    if (this.stopped) return;
    for (const { t, r } of results) {
      const away = offline && !!r.error;
      this.onResult(t, { ...r, at: Date.now(), state: away ? 'offline' : classifyUptime(r), ...(away ? { error: 'This computer is offline' } : {}) });
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}
