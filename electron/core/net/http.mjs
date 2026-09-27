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
  constructor(status, message, body) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
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
  return `HTTP ${status}${msg ? ` – ${msg}` : ''}`;
}

/**
 * One request/response. Resolves with the raw body.
 * @returns {Promise<{status:number, headers:object, body:Buffer, socket?:any}>}
 */
export function request({
  method = 'GET',
  url,
  headers = {},
  body = null,
  ca = null,
  timeoutMs = 30_000,
  signal,
  maxBytes = 64 * 1024 * 1024,
  onSocket,
}) {
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
    if (onSocket) req.on('socket', onSocket);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Request timed out after ${timeoutMs} ms`)));
    req.on('error', reject);
    if (signal) {
      if (signal.aborted) req.destroy(new Error('aborted'));
      else signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    }
    if (payload) req.write(payload);
    req.end();
  });
}

/** Request + JSON parse. Throws HttpError on status >= 400. */
export async function json(opts) {
  const res = await request(opts);
  const text = res.body.toString('utf8');
  if (res.status >= 400) throw new HttpError(res.status, errorMessage(res.status, text), text);
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
 * @returns {Promise<{sha256: string, bytes: number}>}
 */
export async function download({ url, file, onProgress, maxBytes = 1024 * 1024 * 1024, idleTimeoutMs = 60_000 }) {
  for (let hop = 0; hop < 5; hop++) {
    const headers = { accept: 'application/octet-stream' };
    checkRequest({ method: 'GET', url, headers });
    const u = new URL(url);
    const res = await new Promise((resolve, reject) => {
      const req = https.get({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, agent: agentFor(null), headers: { 'user-agent': USER_AGENT, ...headers } }, resolve);
      req.setTimeout(idleTimeoutMs, () => req.destroy(new Error(`Download stalled for ${idleTimeoutMs / 1000} s`)));
      req.on('error', reject);
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
      res.on('data', (c) => {
        bytes += c.length;
        if (bytes > maxBytes) return res.destroy(new Error('Download too large'));
        hash.update(c);
        onProgress?.(bytes, total);
      });
      res.on('error', (e) => (out.destroy(), reject(e)));
      out.on('error', reject);
      out.on('finish', () => (total && bytes !== total ? reject(new Error('The download was cut off. Try again.')) : resolve({ sha256: hash.digest('hex'), bytes })));
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
 * every newline-terminated line. Returns { done, abort }.
 */
export function streamLines({ url, headers = {}, ca = null, onLine, onOpen, idleTimeoutMs = 0 }) {
  checkRequest({ method: 'GET', url, headers });
  const u = new URL(url);
  let req;
  let aborted = false;
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
            reject(new HttpError(res.statusCode, errorMessage(res.statusCode, text), text));
          });
          return;
        }
        onOpen?.(res);
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
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
          if (buf.length) {
            try {
              onLine(buf);
            } catch {}
          }
          resolve({ status: res.statusCode, aborted });
        });
        res.on('error', (e) => (aborted ? resolve({ status: 0, aborted }) : reject(e)));
        res.on('aborted', () => resolve({ status: 0, aborted: true }));
      },
    );
    if (idleTimeoutMs) req.setTimeout(idleTimeoutMs, () => req.destroy(new Error('stream idle timeout')));
    req.on('error', (e) => (aborted ? resolve({ status: 0, aborted }) : reject(e)));
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
