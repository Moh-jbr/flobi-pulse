// Minimal HTTPS client built on node:https. No third-party HTTP library.
// Every call goes through the read-only guard first.
import https from 'node:https';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { checkRequest } from './guard.mjs';

const USER_AGENT = 'FlobiPulse/1.0 (read-only monitor)';
const agents = new Map();

function agentFor(ca) {
  const key = ca ? createHash('sha1').update(ca).digest('hex') : 'default';
  let agent = agents.get(key);
  if (!agent) {
    agent = new https.Agent({ keepAlive: true, maxSockets: 96, ...(ca ? { ca } : {}) });
    agents.set(key, agent);
  }
  return agent;
}

export function destroyAgents() {
  for (const a of agents.values()) a.destroy();
  agents.clear();
}

export class HttpError extends Error {
  constructor(status, message, body, headers) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    // Response headers (rate-limit resets, Retry-After), when there were any.
    this.headers = headers || {};
  }
}

/**
 * Removes secrets from text that people may see (error messages): the given
 * tokens, and anything sent as "Bearer …" that a server or proxy echoed back.
 */
export function redact(text, ...secrets) {
  let s = String(text ?? '');
  for (const secret of secrets) if (secret && String(secret).length >= 8) s = s.split(String(secret)).join('[redacted]');
  // Token-like only (long, with a digit), so "Missing Bearer authorization" stays readable.
  return s.replace(/\b(bearer)\s+(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{16,}/gi, '$1 [redacted]');
}

/** Pulls a human-readable message out of Google / Kubernetes / Cloudflare / Sentry error bodies. */
export function errorMessage(status, text) {
  let msg = '';
  try {
    const j = JSON.parse(text);
    msg =
      j?.error?.message ||
      (typeof j?.error === 'string' ? `${j.error}${j.error_description ? `: ${j.error_description}` : ''}` : '') ||
      j?.message ||
      j?.errors?.[0]?.message ||
      j?.detail ||
      '';
  } catch {
    msg = String(text || '').slice(0, 200);
  }
  return redact(`HTTP ${status}${msg ? ` – ${msg}` : ''}`);
}

/**
 * One request/response. Resolves with the raw body.
 * @returns {Promise<{status:number, headers:object, body:Buffer}>}
 */
export function request({ method = 'GET', url, headers = {}, body = null, ca = null, timeoutMs = 30_000, maxBytes = 64 * 1024 * 1024 }) {
  checkRequest({ method, url, headers, body });
  const u = new URL(url);
  const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method,
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        agent: agentFor(ca),
        headers: {
          'user-agent': USER_AGENT,
          accept: 'application/json',
          ...(payload ? { 'content-length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy(new Error(`Response too large (> ${maxBytes} bytes)`));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Request timed out after ${timeoutMs} ms`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Request + JSON parse. Throws HttpError on status >= 400. */
export async function json(opts) {
  const res = await request(opts);
  const text = res.body.toString('utf8');
  if (res.status >= 400) throw new HttpError(res.status, errorMessage(res.status, text), text, res.headers);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(res.status, `Invalid JSON from ${new URL(opts.url).hostname}`, text);
  }
}

/**
 * Streams a file to disk (app updates), following GitHub's redirect to its file
 * storage. Every hop goes through the guard. Resolves with the file's SHA-256.
 * `agent` is only for tests (a local server standing in for GitHub).
 * @returns {Promise<{sha256: string, bytes: number}>}
 */
export async function download({ url, file, onProgress, maxBytes = 1024 * 1024 * 1024, idleTimeoutMs = 60_000, agent = agentFor(null) }) {
  for (let hop = 0; hop < 5; hop++) {
    const headers = { accept: 'application/octet-stream' };
    checkRequest({ method: 'GET', url, headers });
    const u = new URL(url);
    // When the connection goes quiet the request is destroyed with this error, but the
    // response itself only reports a bare "aborted": keep the reason people should see.
    let stalled = null;
    const res = await new Promise((resolve, reject) => {
      const req = https.get({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, agent, headers: { 'user-agent': USER_AGENT, ...headers } }, resolve);
      req.setTimeout(idleTimeoutMs, () => req.destroy((stalled = new Error(`The download stalled (nothing arrived for ${idleTimeoutMs / 1000} s). Check your connection and try again.`))));
      req.on('error', (e) => reject(stalled || e));
    });
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.resume();
      url = new URL(res.headers.location, url).toString();
      continue;
    }
    if (res.statusCode >= 400) {
      res.resume();
      throw new HttpError(res.statusCode, `HTTP ${res.statusCode} downloading ${u.pathname.split('/').pop()}`);
    }
    const total = Number(res.headers['content-length']) || 0;
    if (total > maxBytes) {
      res.resume();
      throw new Error(`Download too large (${total} bytes)`);
    }
    return await new Promise((resolve, reject) => {
      const hash = createHash('sha256');
      const out = createWriteStream(file);
      let bytes = 0;
      let failed = false;
      const cutOff = () => new Error('The download was cut off. Try again.');
      const fail = (e) => {
        if (failed) return;
        failed = true;
        res.unpipe(out);
        out.destroy();
        reject(stalled || e);
      };
      res.on('data', (c) => {
        bytes += c.length;
        if (bytes > maxBytes) return res.destroy(new Error('Download too large'));
        hash.update(c);
        onProgress?.(bytes, total);
      });
      // A connection dropped mid-file reports a bare "aborted" (ECONNRESET).
      res.on('error', (e) => fail(e?.code === 'ECONNRESET' ? cutOff() : e));
      // It may also just end without an error; the file would never finish.
      res.on('close', () => !res.complete && fail(cutOff()));
      out.on('error', fail);
      out.on('finish', () => {
        if (failed) return;
        if (total && bytes !== total) reject(cutOff());
        else resolve({ sha256: hash.digest('hex'), bytes });
      });
      res.pipe(out);
    });
  }
  throw new Error('Too many redirects');
}

/** application/x-www-form-urlencoded POST (OAuth token endpoints). */
export function form(url, params, extra = {}) {
  return json({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    ...extra,
  });
}

/**
 * Long-lived GET stream (Kubernetes watches and log follows). Calls onLine for
 * every newline-terminated line. Returns { done, abort }. `done` resolves with
 * { status, aborted: false } when the server ends the stream, or with
 * { status: 0, aborted: true, reason } when it ends early: reason 'stopped' after
 * abort(), 'network' when the connection dropped mid-stream.
 */
export function streamLines({ url, headers = {}, ca = null, onLine, onOpen, idleTimeoutMs = 0 }) {
  checkRequest({ method: 'GET', url, headers });
  const u = new URL(url);
  let req;
  let aborted = false;
  const early = () => ({ status: 0, aborted: true, reason: aborted ? 'stopped' : 'network' });
  const done = new Promise((resolve, reject) => {
    req = https.request(
      {
        method: 'GET',
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        agent: agentFor(ca),
        headers: { 'user-agent': USER_AGENT, ...headers },
      },
      (res) => {
        if (res.statusCode >= 400) {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            reject(new HttpError(res.statusCode, errorMessage(res.statusCode, text), text, res.headers));
          });
          return;
        }
        onOpen?.(res);
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buf += chunk;
          let idx;
          // After abort() nothing more is handed out, even from a chunk already received.
          while (!aborted && (idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
            if (line.length) {
              try {
                onLine(line);
              } catch (e) {
                // A bad line must never kill the stream.
                console.warn('[stream] line handler failed:', e?.message);
              }
            }
          }
          if (buf.length > 4 * 1024 * 1024) buf = buf.slice(-1024 * 1024); // runaway line guard
        });
        res.on('end', () => {
          if (buf.length && !aborted) {
            try {
              onLine(buf);
            } catch {}
          }
          resolve(aborted ? early() : { status: res.statusCode, aborted: false });
        });
        res.on('error', (e) => (aborted ? resolve(early()) : reject(e)));
        res.on('aborted', () => resolve(early()));
      },
    );
    if (idleTimeoutMs) req.setTimeout(idleTimeoutMs, () => req.destroy(new Error('stream idle timeout')));
    req.on('error', (e) => (aborted ? resolve(early()) : reject(e)));
    req.end();
  });
  return {
    done,
    abort() {
      aborted = true;
      req?.destroy();
    },
  };
}
