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

export function checkUrl(url, { timeoutMs = 10_000 } = {}) {
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
      },
      (res) => {
        let certDaysLeft = null;
        try {
          const cert = res.socket.getPeerCertificate?.();
          if (cert?.valid_to) certDaysLeft = Math.floor((Date.parse(cert.valid_to) - Date.now()) / 86_400_000);
        } catch {}
        let read = 0;
        res.on('data', (c) => {
          read += c.length;
          if (read > 256 * 1024) res.destroy();
        });
        const done = () => resolve({ status: res.statusCode, ms: Math.round(performance.now() - started), certDaysLeft, cfRay: res.headers['cf-ray'] || null });
        res.on('end', done);
        res.on('close', done);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`No response in ${timeoutMs / 1000}s`)));
    req.on('error', (e) => resolve({ error: e.code === 'ENOTFOUND' ? 'DNS lookup failed' : e.message, ms: Math.round(performance.now() - started) }));
    req.end();
  });
}

export class UptimeMonitor {
  constructor({ targets = [], intervalMs = 30_000, onResult }) {
    this.intervalMs = intervalMs;
    this.onResult = onResult;
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
        await Promise.all(
          this.targets.map(async (t) => {
            const r = await checkUrl(t.url);
            if (!this.stopped) this.onResult(t, { ...r, at: Date.now(), state: classifyUptime(r) });
          }),
        );
      } catch (e) {
        console.warn('[uptime]', e?.message);
      } finally {
        if (!this.stopped) this.timer = setTimeout(tick, this.intervalMs);
      }
    };
    tick();
    return this;
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}
