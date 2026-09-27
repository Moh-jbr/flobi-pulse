// Turns Cloud Logging entries (from the REST list API or the gRPC tail) into the
// app's compact shapes: request rows, container log lines, Kubernetes events,
// Cloud SQL lines. Pure JS.
import { detectLevel, stripAnsi } from './log-parse.mjs';
import { parseBackendName } from './backend-name.mjs';

let seq = 0;
const nextId = () => `x${Date.now().toString(36)}${(seq++).toString(36)}`;

function toMs(e) {
  if (typeof e.timestampMs === 'number') return e.timestampMs;
  if (e.timestamp) return Date.parse(e.timestamp);
  if (typeof e.receiveTimestampMs === 'number') return e.receiveTimestampMs;
  if (e.receiveTimestamp) return Date.parse(e.receiveTimestamp);
  return Date.now();
}

function latencyMs(h) {
  if (typeof h.latencySeconds === 'number') return Math.round(h.latencySeconds * 1000);
  if (typeof h.latency === 'string') return Math.round(parseFloat(h.latency) * 1000);
  return null;
}

function splitUrl(url) {
  try {
    const u = new URL(url);
    return { host: u.host, path: u.pathname + (u.search.length > 1 ? u.search : '') };
  } catch {
    return { host: '', path: String(url || '') };
  }
}

/**
 * @param {object} e raw LogEntry (REST JSON or decoded proto)
 * @param {{namespace:string, routeToService?:(host:string,path:string)=>string|null, podToService?:(pod:string, container:string)=>string|null}} ctx
 */
export function normalizeEntry(e, ctx = {}) {
  const ts = toMs(e);
  const id = e.insertId ? `${e.insertId}:${ts}` : nextId();
  const type = e.resource?.type || '';
  const labels = e.resource?.labels || {};
  const logName = e.logName || '';

  // ── HTTP request (load balancer / Cloud Run) ──────────────────────────────
  if (e.httpRequest && (type === 'http_load_balancer' || type === 'cloud_run_revision' || type === 'https_lb_rule' || logName.endsWith('/requests'))) {
    const h = e.httpRequest;
    const { host, path } = splitUrl(h.requestUrl);
    let service = null;
    if (type === 'cloud_run_revision') service = labels.service_name || null;
    else {
      const b = parseBackendName(labels.backend_service_name, ctx.namespace);
      service = (b && b.service) || ctx.routeToService?.(host, path) || null;
    }
    const status = Number(h.status || 0);
    return {
      kind: 'request',
      id,
      ts,
      method: h.requestMethod || 'GET',
      host,
      path,
      status,
      latencyMs: latencyMs(h),
      reqSize: Number(h.requestSize || 0),
      respSize: Number(h.responseSize || 0),
      ua: h.userAgent || '',
      ip: h.remoteIp || '',
      referer: h.referer || '',
      protocol: h.protocol || '',
      source: type === 'cloud_run_revision' ? 'cloudrun' : 'lb',
      service,
      statusDetails: e.jsonPayload?.statusDetails || null,
      cache: e.jsonPayload?.cacheDecision?.[0] || (h.cacheHit ? 'HIT' : null),
      trace: e.trace || null,
    };
  }

  // ── Kubernetes event exported to Cloud Logging ───────────────────────────
  if (logName.endsWith('/logs/events') && e.jsonPayload?.involvedObject) {
    const j = e.jsonPayload;
    return {
      kind: 'event',
      id,
      ts: Date.parse(j.lastTimestamp || j.eventTime || j.firstTimestamp || '') || ts,
      type: j.type || 'Normal',
      reason: j.reason || '',
      message: j.message || '',
      objectKind: j.involvedObject.kind,
      objectName: j.involvedObject.name,
      namespace: j.involvedObject.namespace,
      count: j.count || j.series?.count || 1,
    };
  }

  // ── Container log line ────────────────────────────────────────────────────
  if (type === 'k8s_container') {
    const json = e.jsonPayload && Object.keys(e.jsonPayload).length ? e.jsonPayload : null;
    const text = stripAnsi(e.textPayload ?? json?.message ?? json?.msg ?? (json ? JSON.stringify(json) : ''));
    const pod = labels.pod_name || '';
    const container = labels.container_name || '';
    return {
      kind: 'log',
      id,
      ts,
      pod,
      container,
      service: ctx.podToService?.(pod, container) || container || pod,
      level: detectLevel(text, e.severity, json),
      severity: e.severity || 'DEFAULT',
      text: text.length > 8000 ? `${text.slice(0, 8000)}…` : text,
      json: json && Object.keys(json).length > 1 ? json : null,
      source: 'cloud',
    };
  }

  // ── Cloud SQL (Postgres) ──────────────────────────────────────────────────
  if (type === 'cloudsql_database') {
    const text = stripAnsi(e.textPayload ?? e.jsonPayload?.message ?? '');
    return {
      kind: 'cloudsql',
      id,
      ts,
      instance: String(labels.database_id || '').split(':').pop(),
      // "project:instance" + region → the instance's connection name
      connection: labels.database_id && labels.region && String(labels.database_id).includes(':') ? `${String(labels.database_id).split(':')[0]}:${labels.region}:${String(labels.database_id).split(':').pop()}` : null,
      level: detectLevel(text, e.severity),
      severity: e.severity || 'DEFAULT',
      text,
    };
  }

  // ── Cloud Run container logs (renderer) ──────────────────────────────────
  if (type === 'cloud_run_revision') {
    const text = stripAnsi(e.textPayload ?? e.jsonPayload?.message ?? '');
    return {
      kind: 'log',
      id,
      ts,
      pod: labels.revision_name || '',
      container: labels.service_name || '',
      service: labels.service_name || 'cloud-run',
      level: detectLevel(text, e.severity, e.jsonPayload),
      severity: e.severity || 'DEFAULT',
      text,
      json: null,
      source: 'cloudrun',
    };
  }

  return { kind: 'other', id, ts, type, text: e.textPayload || '' };
}

/** A line read straight from the Kubernetes log API (no Cloud Logging metadata). */
export function k8sLogLine({ text, ts, pod, container, service }) {
  let json = null;
  if (text && text[0] === '{') {
    try {
      json = JSON.parse(text);
    } catch {}
  }
  const shown = json ? json.message || json.msg || text : text;
  return { kind: 'log', id: `k${ts}${Math.random().toString(36).slice(2, 7)}`, ts, pod, container, service, level: detectLevel(shown, null, json), text: stripAnsi(shown), json, source: 'k8s' };
}
