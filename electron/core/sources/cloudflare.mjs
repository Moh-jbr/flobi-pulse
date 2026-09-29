// Cloudflare (read-only): edge traffic and errors for the proxied hostnames
// (api.flobi.ai goes through Cloudflare, so 52x "origin unreachable" errors only
// show up here), plus Cloudflare Pages deployment status for the frontends.
// Token permissions: Zone → Zone:Read + Analytics:Read, Account → Cloudflare Pages:Read.
//
// Which analytics datasets a zone may query depends on its plan (the Free plan
// has no 1-minute rollups, for example). Cloudflare answers "does not have
// access to the path" for a locked one, so the client tries them in order and
// remembers the first that works.
import { json, redact } from '../net/http.mjs';
import { configureGuard } from '../net/guard.mjs';

const API = 'https://api.cloudflare.com/client/v4';
const HOUR = 3600_000;
/** Pages read from a paged list (zones, Pages projects) at most. */
const MAX_PAGES = 10;

const ROLLUP_SUM = `sum {
          requests
          cachedRequests
          bytes
          threats
          responseStatusMap { edgeResponseStatus requests }
          countryMap { clientCountryName requests }
        }`;

/** 1-minute rollups (paid plans). */
export const EDGE_QUERY = `query PulseEdge($zoneTags: [string!], $since: Time!, $until: Time!) {
  viewer {
    zones(filter: { zoneTag_in: $zoneTags }) {
      zoneTag
      httpRequests1mGroups(limit: 1000, filter: { datetime_geq: $since, datetime_lt: $until }, orderBy: [datetimeMinute_ASC]) {
        dimensions { datetimeMinute }
        ${ROLLUP_SUM}
      }
    }
  }
}`;

/**
 * Per-minute counts from the adaptive (sampled) dataset. One row per minute and
 * status code, so a busy hour can pass the 1000-row limit: newest first, so what
 * gets cut is the oldest minutes, never the ones happening now.
 */
export const EDGE_ADAPTIVE_QUERY = `query PulseEdgeAdaptive($zoneTags: [string!], $since: Time!, $until: Time!) {
  viewer {
    zones(filter: { zoneTag_in: $zoneTags }) {
      zoneTag
      byMinute: httpRequestsAdaptiveGroups(limit: 1000, filter: { datetime_geq: $since, datetime_lt: $until }, orderBy: [datetimeMinute_DESC]) {
        count
        sum { edgeResponseBytes }
        dimensions { datetimeMinute edgeResponseStatus }
      }
      byCountry: httpRequestsAdaptiveGroups(limit: 10, filter: { datetime_geq: $since, datetime_lt: $until }, orderBy: [count_DESC]) {
        count
        dimensions { clientCountryName }
      }
      byCache: httpRequestsAdaptiveGroups(limit: 20, filter: { datetime_geq: $since, datetime_lt: $until }) {
        count
        dimensions { cacheStatus }
      }
    }
  }
}`;

/** Hourly rollups: the last resort, available on every plan. */
export const EDGE_HOURLY_QUERY = `query PulseEdgeHourly($zoneTags: [string!], $since: Time!, $until: Time!) {
  viewer {
    zones(filter: { zoneTag_in: $zoneTags }) {
      zoneTag
      httpRequests1hGroups(limit: 48, filter: { datetime_geq: $since, datetime_lt: $until }, orderBy: [datetime_ASC]) {
        dimensions { datetime }
        ${ROLLUP_SUM}
      }
    }
  }
}`;

/** 5xx per hostname (adaptive dataset). */
export const HOST_ERRORS_QUERY = `query PulseHostErrors($zoneTags: [string!], $since: Time!, $until: Time!) {
  viewer {
    zones(filter: { zoneTag_in: $zoneTags }) {
      zoneTag
      httpRequestsAdaptiveGroups(limit: 200, filter: { datetime_geq: $since, datetime_lt: $until, edgeResponseStatus_geq: 500 }, orderBy: [count_DESC]) {
        count
        dimensions { clientRequestHTTPHost edgeResponseStatus }
      }
    }
  }
}`;

// Only these exact queries may ever be sent (the guard compares the full text).
configureGuard({ graphQLQueries: [EDGE_QUERY, EDGE_ADAPTIVE_QUERY, EDGE_HOURLY_QUERY, HOST_ERRORS_QUERY] });

/** Cloudflare's answer when a dataset isn't included in the zone's plan (or the token lacks Analytics: Read). */
export function isNoAccess(e) {
  return /does not have access to the path/i.test(e?.message || '');
}

const CACHED = new Set(['hit', 'stale', 'updating', 'revalidated']);

/**
 * Turns any of the three dataset shapes into one: rows of
 * { t, requests, cached, bytes, threats, status: [[code, n]] } plus zone-level
 * countries (and cache hits for the adaptive dataset).
 */
export function normalizeTraffic(mode, zone) {
  if (!zone) return { mode, rows: [], countries: [], cached: null };
  if (mode === 'adaptive') {
    const byT = new Map();
    for (const g of zone.byMinute || []) {
      const t = Date.parse(g.dimensions.datetimeMinute);
      let row = byT.get(t);
      if (!row) byT.set(t, (row = { t, requests: 0, cached: null, bytes: 0, threats: null, status: [] }));
      row.requests += g.count || 0;
      row.bytes += g.sum?.edgeResponseBytes || 0;
      row.status.push([g.dimensions.edgeResponseStatus, g.count || 0]);
    }
    const cacheTotal = (zone.byCache || []).reduce((a, g) => a + (g.count || 0), 0);
    return {
      mode,
      rows: [...byT.values()].sort((a, b) => a.t - b.t),
      countries: (zone.byCountry || []).map((g) => [g.dimensions.clientCountryName, g.count || 0]),
      cached: cacheTotal ? (zone.byCache || []).filter((g) => CACHED.has(String(g.dimensions.cacheStatus).toLowerCase())).reduce((a, g) => a + (g.count || 0), 0) : null,
    };
  }
  const groups = zone.httpRequests1mGroups || zone.httpRequests1hGroups || [];
  const countries = new Map();
  const rows = groups.map((g) => {
    const s = g.sum || {};
    for (const c of s.countryMap || []) countries.set(c.clientCountryName, (countries.get(c.clientCountryName) || 0) + (c.requests || 0));
    return { t: Date.parse(g.dimensions.datetimeMinute || g.dimensions.datetime), requests: s.requests || 0, cached: s.cachedRequests || 0, bytes: s.bytes || 0, threats: s.threats || 0, status: (s.responseStatusMap || []).map((r) => [r.edgeResponseStatus, r.requests || 0]) };
  });
  return { mode, rows, countries: [...countries.entries()], cached: null };
}

/**
 * Free plan fallback when per-hostname errors are locked: counts 5xx per zone
 * from the traffic rows. Returns the adaptive-groups shape the callers expect.
 * A row is a bucket starting at `t` (an hour on hourly data, else a minute) and
 * counts when it overlaps [sinceMs, untilMs): on hourly data the current hour
 * started before a 15-minute window, and skipping it hid its errors 45 min an hour.
 */
export function zoneErrorGroups(traffic, name, sinceMs = 0, untilMs = Infinity) {
  const bucket = traffic?.mode === '1h' ? HOUR : 60_000;
  const byCode = new Map();
  for (const r of traffic?.rows || []) {
    if (r.t + bucket <= sinceMs || r.t >= (untilMs ?? Infinity)) continue;
    for (const [code, n] of r.status) if (code >= 500) byCode.set(code, (byCode.get(code) || 0) + n);
  }
  return [...byCode.entries()].map(([code, count]) => ({ count, dimensions: { clientRequestHTTPHost: name, edgeResponseStatus: code } }));
}

const MODES = [
  { mode: '1m', query: EDGE_QUERY, window: 60 * 60_000 },
  { mode: 'adaptive', query: EDGE_ADAPTIVE_QUERY, window: 60 * 60_000 },
  { mode: '1h', query: EDGE_HOURLY_QUERY, window: 24 * HOUR },
];

export class CloudflareClient {
  /** `request` is only replaced by tests. */
  constructor({ token, accountId, zones = [], request = json }) {
    this.token = token;
    this.accountId = accountId;
    this.zoneNames = zones;
    this.request = request;
    this.trafficMode = undefined; // '1m' | 'adaptive' | '1h' once known
    this.perHost = undefined;
  }

  get configured() {
    return !!this.token;
  }

  _headers() {
    return { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' };
  }

  /** The request, with the token scrubbed from any error it produces. */
  async _send(opts) {
    try {
      return await this.request(opts);
    } catch (e) {
      if (e && typeof e.message === 'string') e.message = redact(e.message, this.token);
      throw e;
    }
  }

  async _raw(path) {
    const res = await this._send({ url: `${API}${path}`, headers: this._headers(), timeoutMs: 30_000 });
    if (res && res.success === false) throw new Error(redact(res.errors?.[0]?.message || 'Cloudflare API error', this.token));
    return res;
  }

  async _get(path) {
    return (await this._raw(path))?.result;
  }

  /**
   * Every page of a paged list, up to MAX_PAGES. The first request is the one the
   * app always sent; later pages add `page=N` while result_info says there are more.
   */
  async _list(path, perPage) {
    const out = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const q = new URLSearchParams({ ...(perPage ? { per_page: String(perPage) } : {}), ...(page > 1 ? { page: String(page) } : {}) }).toString();
      const res = await this._raw(q ? `${path}?${q}` : path);
      const items = Array.isArray(res?.result) ? res.result : [];
      out.push(...items);
      const info = res?.result_info || {};
      const pages = Number(info.total_pages) || (info.total_count && info.per_page ? Math.ceil(info.total_count / info.per_page) : 0);
      if (!items.length || !pages || page >= pages) break;
    }
    return out;
  }

  async graphql(query, variables) {
    const res = await this._send({ method: 'POST', url: `${API}/graphql`, headers: this._headers(), body: JSON.stringify({ query, variables }), timeoutMs: 45_000 });
    if (res?.errors?.length) throw new Error(redact(`Cloudflare analytics: ${res.errors[0].message}`, this.token));
    return res?.data;
  }

  async verify() {
    const r = await this._get('/user/tokens/verify');
    return { status: r?.status };
  }

  async zones() {
    const all = await this._list('/zones', 50); // 50 is the most Cloudflare returns per page
    const wanted = new Set(this.zoneNames.map((z) => z.toLowerCase()));
    return all
      .filter((z) => !wanted.size || wanted.has(z.name.toLowerCase()))
      .map((z) => ({ id: z.id, name: z.name, status: z.status, plan: z.plan?.name, accountId: z.account?.id }));
  }

  /**
   * Recent edge traffic per zone, from the finest dataset the plan allows.
   * With `since`, it covers [since, until] (e.g. a recap's range) instead of the
   * dataset's usual window, skipping datasets too fine to span that range.
   * @returns {Promise<{mode:string, windowMs:number, zones: Map<string, object>}>} zoneTag → normalized traffic
   */
  async traffic(zoneIds, until = Date.now(), since = null) {
    if (this.trafficMode && this.trafficMode !== '1m' && Date.now() - this.trafficModeAt > 6 * HOUR) this.trafficMode = undefined; // plans change
    const start = Math.max(0, MODES.findIndex((m) => m.mode === this.trafficMode));
    const modes = MODES.slice(start);
    const span = since == null ? 0 : until - since;
    let lastNoAccess = null;
    // A dataset passed over for the range says nothing about the plan: then the
    // remembered mode (used by the live view) stays as it was.
    let skipped = false;
    for (const [i, m] of modes.entries()) {
      if (span > m.window && i < modes.length - 1) {
        skipped = true;
        continue;
      }
      const from = since == null ? until - m.window : Math.max(since, until - m.window);
      try {
        const data = await this.graphql(m.query, { zoneTags: zoneIds, since: new Date(from).toISOString(), until: new Date(until).toISOString() });
        if (!skipped) {
          if (this.trafficMode !== m.mode) this.trafficModeAt = Date.now();
          this.trafficMode = m.mode;
        }
        const zones = new Map((data?.viewer?.zones || []).map((z) => [z.zoneTag, normalizeTraffic(m.mode, z)]));
        return { mode: m.mode, windowMs: until - from, zones };
      } catch (e) {
        if (!isNoAccess(e)) throw e;
        lastNoAccess = e;
      }
    }
    if (!skipped) this.trafficMode = undefined;
    throw lastNoAccess;
  }

  async hostErrors(zoneIds, since, until) {
    const data = await this.graphql(HOST_ERRORS_QUERY, { zoneTags: zoneIds, since: new Date(since).toISOString(), until: new Date(until).toISOString() });
    return data?.viewer?.zones || [];
  }

  /**
   * 5xx per hostname when the plan allows it, otherwise per zone.
   * @param {{id:string, name:string}[]} zones
   * @param {{zones: Map<string, object>}} [traffic] traffic already fetched for this window
   * @returns {Promise<{perHost:boolean, zones:object[]}>}
   */
  async errorsByHost(zones, since, until, traffic = null) {
    if (this.perHost === false && Date.now() - this.perHostCheckedAt > 6 * HOUR) this.perHost = undefined; // re-check now and then (plan upgrades)
    const ids = zones.map((z) => z.id);
    if (this.perHost !== false) {
      try {
        const res = await this.hostErrors(ids, since, until);
        this.perHost = true;
        return { perHost: true, zones: res };
      } catch (e) {
        if (!isNoAccess(e)) throw e;
        this.perHost = false;
        this.perHostCheckedAt = Date.now();
      }
    }
    // Without traffic already fetched for this window (the recap), read it for [since, until].
    const t = traffic || (await this.traffic(ids, until, since));
    return { perHost: false, zones: ids.map((id) => ({ zoneTag: id, httpRequestsAdaptiveGroups: zoneErrorGroups(t.zones.get(id), zones.find((x) => x.id === id)?.name || id, since, until) })) };
  }

  async pagesProjects(accountId = this.accountId) {
    if (!accountId) return [];
    const list = await this._list(`/accounts/${accountId}/pages/projects`);
    return list.map((p) => {
      const d = p.latest_deployment || p.canonical_deployment || {};
      const stage = d.latest_stage || {};
      return {
        name: p.name,
        domains: p.domains || [],
        subdomain: p.subdomain,
        latest: d.id
          ? {
              id: d.id,
              url: d.url,
              environment: d.environment,
              createdAt: Date.parse(d.created_on),
              stage: stage.name,
              status: stage.status, // success | failure | active | idle | canceled
              endedAt: stage.ended_on ? Date.parse(stage.ended_on) : null,
              branch: d.deployment_trigger?.metadata?.branch,
              commit: d.deployment_trigger?.metadata?.commit_hash?.slice(0, 7),
              message: d.deployment_trigger?.metadata?.commit_message,
            }
          : null,
      };
    });
  }
}

/** Folds normalized traffic into totals + a per-point series for the UI. */
export function summarizeEdge(traffic, name) {
  const rows = traffic?.rows || [];
  const series = [];
  const totals = { requests: 0, cached: 0, bytes: 0, threats: 0, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, s52x: 0 };
  let hasThreats = false;
  for (const r of rows) {
    const point = { t: r.t, requests: r.requests, s4xx: 0, s5xx: 0, s52x: 0 };
    totals.requests += r.requests;
    totals.cached += r.cached || 0;
    totals.bytes += r.bytes || 0;
    if (r.threats != null) (hasThreats = true), (totals.threats += r.threats);
    for (const [code, n] of r.status) {
      if (code >= 520 && code <= 527) {
        totals.s52x += n;
        point.s52x += n;
      }
      if (code >= 500) {
        totals.s5xx += n;
        point.s5xx += n;
      } else if (code >= 400) {
        totals.s4xx += n;
        point.s4xx += n;
      } else if (code >= 300) totals.s3xx += n;
      else totals.s2xx += n;
    }
    series.push(point);
  }
  if (traffic?.cached != null) totals.cached = traffic.cached;
  if (!hasThreats) totals.threats = null;
  const topCountries = [...(traffic?.countries || [])].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([country, requests]) => ({ country, requests }));
  const windowLabel = traffic?.mode === '1h' ? 'last 24 hours' : 'last hour';
  return { zone: name, totals, series, topCountries, windowLabel, mode: traffic?.mode || null };
}
