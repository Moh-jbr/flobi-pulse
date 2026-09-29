// Cloudflare 5xx counts (C8), paging of zones / Pages projects and Cloud Run
// services (C9), and tokens kept out of error messages (C17).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CloudflareClient, zoneErrorGroups, normalizeTraffic, EDGE_QUERY, EDGE_ADAPTIVE_QUERY, EDGE_HOURLY_QUERY, HOST_ERRORS_QUERY } from '../electron/core/sources/cloudflare.mjs';
import { listCloudRunServices } from '../electron/core/sources/cloudrun.mjs';
import { checkRequest, configureGuard } from '../electron/core/net/guard.mjs';
import { HttpError } from '../electron/core/net/http.mjs';

const T = (hhmm) => Date.parse(`2026-09-25T${hhmm}:00Z`);
const TOKEN = 'cf-token-0123456789abcdefghij';
const ACCOUNT = '0123456789abcdef0123456789abcdef';

configureGuard({ projectId: 'flobi-prod-2026' });

/** A fake Cloudflare API: every request must pass the real guard first. */
function fakeCloudflare(answer) {
  const calls = [];
  const request = async (opts) => {
    checkRequest({ method: opts.method || 'GET', url: opts.url, headers: opts.headers, body: opts.body });
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: opts.url.replace('https://api.cloudflare.com/client/v4', ''), query: body?.query, variables: body?.variables });
    return answer(calls[calls.length - 1], calls.length);
  };
  return { calls, client: new CloudflareClient({ token: TOKEN, accountId: ACCOUNT, zones: [], request }) };
}

test('hourly data: the current hour counts although it started before a 15-minute window', () => {
  const traffic = {
    mode: '1h',
    rows: [
      { t: T('09:00'), status: [[500, 7]] },
      { t: T('10:00'), status: [[522, 300], [200, 1000]] },
    ],
  };
  // 10:50–11:05: the 10:00 bucket (10:00–11:00) overlaps it; the 09:00 one doesn't.
  assert.deepEqual(zoneErrorGroups(traffic, 'flobi.ai', T('10:50'), T('11:05')), [{ count: 300, dimensions: { clientRequestHTTPHost: 'flobi.ai', edgeResponseStatus: 522 } }]);
  // Minute data: only minutes inside the window.
  const minutes = { mode: '1m', rows: [T('10:49'), T('10:50'), T('11:04'), T('11:05')].map((t) => ({ t, status: [[502, 1]] })) };
  assert.equal(zoneErrorGroups(minutes, 'z', T('10:50'), T('11:05'))[0].count, 2);
  assert.equal(zoneErrorGroups(minutes, 'z', T('10:50'))[0].count, 3, 'no end given: everything since');
});

test('no per-host access (Free plan): the fallback reads the recap’s own range', async () => {
  const since = T('00:00');
  const until = since + 24 * 3600_000;
  const { calls, client } = fakeCloudflare((c) => {
    if (c.query === HOST_ERRORS_QUERY) return { errors: [{ message: 'zone does not have access to the path' }] };
    assert.equal(c.query, EDGE_HOURLY_QUERY, 'a day is read from hourly data, not the 1-hour datasets');
    return {
      data: {
        viewer: {
          zones: [{ zoneTag: 'z1', httpRequests1hGroups: [T('00:00') - 3600_000, T('05:00'), T('23:00')].map((t) => ({ dimensions: { datetime: new Date(t).toISOString() }, sum: { requests: 10, responseStatusMap: [{ edgeResponseStatus: 502, requests: 4 }] } })) }],
        },
      },
    };
  });
  const res = await client.errorsByHost([{ id: 'z1', name: 'flobi.ai' }], since, until);
  assert.equal(res.perHost, false);
  assert.deepEqual(res.zones[0].httpRequestsAdaptiveGroups, [{ count: 8, dimensions: { clientRequestHTTPHost: 'flobi.ai', edgeResponseStatus: 502 } }]);
  assert.deepEqual(calls[1].variables, { zoneTags: ['z1'], since: new Date(since).toISOString(), until: new Date(until).toISOString() });
  assert.equal(client.trafficMode, undefined, 'the live view still starts from the finest dataset');
});

test('a short range with no traffic passed reads just that range from the finest dataset', async () => {
  const until = T('11:05');
  const { calls, client } = fakeCloudflare((c) => (c.query === HOST_ERRORS_QUERY ? { errors: [{ message: 'does not have access to the path' }] } : { data: { viewer: { zones: [] } } }));
  await client.errorsByHost([{ id: 'z1', name: 'flobi.ai' }], until - 15 * 60_000, until);
  assert.equal(calls[1].query, EDGE_QUERY);
  assert.equal(calls[1].variables.since, new Date(until - 15 * 60_000).toISOString());
  assert.equal(client.trafficMode, '1m');
});

test('per-minute adaptive rows come newest first (the row limit cuts the oldest), and still chart in order', () => {
  assert.match(EDGE_ADAPTIVE_QUERY, /byMinute: httpRequestsAdaptiveGroups\(limit: 1000, [^)]*orderBy: \[datetimeMinute_DESC\]\)/);
  assert.equal(checkRequest({ method: 'POST', url: 'https://api.cloudflare.com/client/v4/graphql', body: JSON.stringify({ query: EDGE_ADAPTIVE_QUERY, variables: {} }) }), true, 'still on the guard’s list');
  const zone = { byMinute: [T('10:02'), T('10:01'), T('10:00')].map((t) => ({ count: 5, dimensions: { datetimeMinute: new Date(t).toISOString(), edgeResponseStatus: 200 } })) };
  assert.deepEqual(normalizeTraffic('adaptive', zone).rows.map((r) => r.t), [T('10:00'), T('10:01'), T('10:02')]);
});

test('zones: every page is read (50 per page), up to 10 pages', async () => {
  const zone = (i) => ({ id: `z${i}`, name: `zone${i}.example`, status: 'active', plan: { name: 'Free' }, account: { id: ACCOUNT } });
  const two = fakeCloudflare((c, n) => ({ success: true, result: n === 1 ? Array.from({ length: 50 }, (_, i) => zone(i)) : [zone(50), zone(51), zone(52)], result_info: { page: n, per_page: 50, total_pages: 2, total_count: 53 } }));
  assert.equal((await two.client.zones()).length, 53);
  assert.deepEqual(two.calls.map((c) => c.url), ['/zones?per_page=50', '/zones?per_page=50&page=2']);

  const endless = fakeCloudflare((c, n) => ({ success: true, result: [zone(n)], result_info: { page: n, per_page: 50, total_pages: 99 } }));
  assert.equal((await endless.client.zones()).length, 10);
  assert.equal(endless.calls.length, 10);

  const one = fakeCloudflare(() => ({ success: true, result: [zone(1)] })); // no result_info: one page, as before
  assert.equal((await one.client.zones()).length, 1);
  assert.equal(one.calls.length, 1);
});

test('Pages projects: every page is read', async () => {
  const project = (name) => ({ name, domains: [`${name}.pages.dev`], latest_deployment: { id: `d-${name}`, created_on: '2026-09-25T10:00:00Z', latest_stage: { name: 'deploy', status: 'success' } } });
  const { calls, client } = fakeCloudflare((c, n) => ({ success: true, result: n === 1 ? [project('app'), project('admin')] : [project('docs')], result_info: { page: n, per_page: 2, count: n === 1 ? 2 : 1, total_count: 3 } }));
  assert.deepEqual((await client.pagesProjects()).map((p) => p.name), ['app', 'admin', 'docs']);
  assert.deepEqual(calls.map((c) => c.url), [`/accounts/${ACCOUNT}/pages/projects`, `/accounts/${ACCOUNT}/pages/projects?page=2`]);
});

test('Cloudflare errors never show the token', async () => {
  const echo = fakeCloudflare(() => ({ success: false, errors: [{ message: `Invalid access token ${TOKEN}` }] }));
  await assert.rejects(echo.client.zones(), (e) => !e.message.includes(TOKEN) && /Invalid access token/.test(e.message));
  const http = new CloudflareClient({ token: TOKEN, request: async () => { throw new HttpError(400, `HTTP 400 – bad header: Authorization: Bearer ${TOKEN}`, ''); } });
  await assert.rejects(http.verify(), (e) => e.status === 400 && !e.message.includes(TOKEN));
  const gql = fakeCloudflare(() => ({ errors: [{ message: `token ${TOKEN} lacks Analytics:Read` }] }));
  await assert.rejects(gql.client.traffic(['z1']), (e) => !e.message.includes(TOKEN));
});

test('Cloud Run: every page of services is read, up to 10 pages, through the guard', async () => {
  const service = (name) => ({ name: `projects/flobi-prod-2026/locations/europe-west1/services/${name}`, uri: `https://${name}.run.app`, terminalCondition: { state: 'CONDITION_SUCCEEDED' }, latestReadyRevision: `x/${name}-001`, updateTime: '2026-09-25T10:00:00Z' });
  const urls = [];
  const request = (pages) => async ({ url, headers }) => {
    checkRequest({ url, headers });
    urls.push(url);
    const n = urls.length;
    return { services: [service(`svc-${n}`)], ...(n < pages ? { nextPageToken: `page ${n + 1}` } : {}) };
  };
  const two = await listCloudRunServices({ projectId: 'flobi-prod-2026', location: 'europe-west1', getToken: async () => 't', request: request(2) });
  assert.deepEqual(two.map((s) => s.name), ['svc-1', 'svc-2']);
  assert.equal(urls[1], 'https://run.googleapis.com/v2/projects/flobi-prod-2026/locations/europe-west1/services?pageToken=page+2');
  urls.length = 0;
  const many = await listCloudRunServices({ projectId: 'flobi-prod-2026', location: 'europe-west1', getToken: async () => 't', request: request(Infinity) });
  assert.equal(many.length, 10);
  assert.equal(urls.length, 10);
});
