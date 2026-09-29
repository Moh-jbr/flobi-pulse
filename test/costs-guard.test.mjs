// The Costs page through the read-only guard: GET only, exact paths, only what Settings → Costs
// names. BigQuery gets its free table preview of ONE table and nothing else: never a job or a
// query (billed per byte), never another table or dataset, never a write.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { checkRequest, configureGuard, resetGuard, ReadOnlyViolation } from '../electron/core/net/guard.mjs';

const P = 'flobi-billing';
const D = 'billing_export';
const T = 'gcp_billing_export_v1_01A2B3_C4D5E6_F7A8B9';
const BQ = 'https://bigquery.googleapis.com/bigquery/v2';
const TABLE = `${BQ}/projects/${P}/datasets/${D}/tables/${T}`;
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const ZONE = 'fedcba9876543210fedcba9876543210';
const CF = 'https://api.cloudflare.com/client/v4';
const GH = 'https://api.github.com';

const allowed = (url, method = 'GET', extra = {}) => assert.equal(checkRequest({ method, url, headers: { authorization: 'Bearer x' }, ...extra }), true, `${method} ${url}`);
const blocked = (url, method = 'GET', extra = {}) => assert.throws(() => checkRequest({ method, url, ...extra }), ReadOnlyViolation, `${method} ${url}`);

beforeEach(() => {
  resetGuard();
  configureGuard({ billing: null, projectId: 'flobi-prod-2026' });
});

const setBilling = () => configureGuard({ billing: { bigQuery: { project: P, dataset: D, table: T }, cloudflareAccount: ACCOUNT, cloudflareZones: [ZONE], github: { kind: 'org', owner: '4ow4-Developers' } } });

test('BigQuery: nothing is reachable until a billing table is set', () => {
  blocked(TABLE);
  blocked(`${TABLE}/data`);
  blocked(`${TABLE}$20260928/data?maxResults=1`);
});

test('BigQuery: the billing table’s metadata and rows (all of it or one day), GET only', () => {
  setBilling();
  allowed(TABLE); // tables.get
  allowed(`${TABLE}/data`);
  allowed(`${TABLE}$20260928/data?selectedFields=service.description%2Ccost%2Ccurrency&maxResults=10000&formatOptions.useInt64Timestamp=true`);
  allowed(`${TABLE}$20260928/data?selectedFields=cost&maxResults=10000&pageToken=BH4Q`);
  allowed(`${TABLE}$20240229/data?maxResults=1`, 'GET'); // a real leap day
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    blocked(TABLE, method);
    blocked(`${TABLE}/data`, method);
    blocked(`${TABLE}/insertAll`, method);
  }
});

test('BigQuery: never a job or a query, never another table, dataset or project', () => {
  setBilling();
  // Queries and jobs are what BigQuery bills for.
  blocked(`${BQ}/projects/${P}/queries`, 'POST', { body: JSON.stringify({ query: `SELECT SUM(cost) FROM \`${P}.${D}.${T}\`` }) });
  blocked(`${BQ}/projects/${P}/queries`);
  blocked(`${BQ}/projects/${P}/queries/job_123?maxResults=10`);
  blocked(`${BQ}/projects/${P}/jobs`, 'POST', { body: '{}' });
  blocked(`${BQ}/projects/${P}/jobs`);
  blocked(`${BQ}/projects/${P}/jobs/job_123`);
  blocked(`${BQ}/projects/${P}/jobs/job_123/cancel`, 'POST');
  blocked(`${TABLE}/insertAll`, 'POST', { body: '{"rows":[]}' });
  blocked(`${TABLE}/insertAll`);
  // Other tables, datasets and projects; lists of them; the dataset itself.
  blocked(`${BQ}/projects/${P}/datasets/${D}/tables/other_table/data`);
  blocked(`${BQ}/projects/${P}/datasets/${D}/tables/${T}_copy/data`);
  blocked(`${BQ}/projects/${P}/datasets/${D}/tables/${T.slice(0, -1)}/data`);
  blocked(`${BQ}/projects/${P}/datasets/other_dataset/tables/${T}/data`);
  blocked(`${BQ}/projects/someone-else/datasets/${D}/tables/${T}/data`);
  blocked(`${BQ}/projects/${P}/datasets/${D}/tables`);
  blocked(`${BQ}/projects/${P}/datasets/${D}`);
  blocked(`${BQ}/projects/${P}/datasets`);
  blocked(`${BQ}/projects`);
  // Other hosts that also serve BigQuery.
  blocked(`https://www.googleapis.com/bigquery/v2/projects/${P}/datasets/${D}/tables/${T}/data`);
  blocked(`https://bigquerystorage.googleapis.com/v1/projects/${P}/locations/us/sessions`, 'POST');
});

test('BigQuery: only a real day as partition, only the known query keys, no encoded or relative paths', () => {
  setBilling();
  blocked(`${TABLE}$__UNPARTITIONED__/data`);
  blocked(`${TABLE}$2026092810/data`); // an hour
  blocked(`${TABLE}$202609/data`); // a month
  blocked(`${TABLE}$20260231/data`); // no such day
  blocked(`${TABLE}@1727000000000/data`); // a snapshot
  blocked(`${TABLE}$20260928`); // partition metadata isn't needed
  blocked(`${TABLE}%2420260928/data`);
  blocked(`${TABLE}/%2e%2e/other_table/data`);
  blocked(`${TABLE}/../other_table/data`);
  blocked(`${BQ}/projects/${P}/datasets/${D}/tables/${T}//data`);
  blocked(`${TABLE}/data?startIndex=5`);
  blocked(`${TABLE}/data?selectedFields=cost&view=FULL`);
  blocked(`${TABLE}?view=FULL`);
  blocked(`${TABLE}/data#x`);
  blocked(`${TABLE}/data`, 'GET', { headers: { 'X-HTTP-Method-Override': 'POST' } });
});

test('BigQuery: changing the table in Settings moves the one table allowed', () => {
  setBilling();
  allowed(`${TABLE}/data`);
  configureGuard({ billing: { bigQuery: { project: P, dataset: D, table: 'gcp_billing_export_resource_v1_01A2B3_C4D5E6_F7A8B9' } } });
  blocked(`${TABLE}/data`);
  allowed(`${BQ}/projects/${P}/datasets/${D}/tables/gcp_billing_export_resource_v1_01A2B3_C4D5E6_F7A8B9/data`);
  configureGuard({ billing: { bigQuery: null } });
  blocked(`${BQ}/projects/${P}/datasets/${D}/tables/gcp_billing_export_resource_v1_01A2B3_C4D5E6_F7A8B9/data`);
  // A table name the guard can't trust is ignored.
  configureGuard({ billing: { bigQuery: { project: P, dataset: D, table: 'x/../../jobs' } } });
  blocked(`${BQ}/projects/${P}/jobs`);
});

test('BigQuery rules survive a connector restart (resetGuard) and are cleared with billing: null', () => {
  setBilling();
  resetGuard();
  allowed(`${TABLE}/data`);
  configureGuard({ billing: null });
  blocked(`${TABLE}/data`);
});

test('Cloudflare billing: the set account’s plans and usage, the set zones’ plans, GET only', () => {
  blocked(`${CF}/accounts/${ACCOUNT}/subscriptions`);
  blocked(`${CF}/zones/${ZONE}/subscription`);
  setBilling();
  allowed(`${CF}/accounts/${ACCOUNT}/subscriptions`);
  allowed(`${CF}/accounts/${ACCOUNT}/billable-usage?from=2026-09-01&to=2026-09-30`);
  allowed(`${CF}/accounts/${ACCOUNT}/billable-usage`);
  allowed(`${CF}/zones/${ZONE}/subscription`);
  blocked(`${CF}/accounts/${ACCOUNT}/billable-usage?from=2026-09-01&metric=x`);
  blocked(`${CF}/accounts/${ACCOUNT}/subscriptions?page=2`);
  blocked(`${CF}/accounts/${'a'.repeat(32)}/subscriptions`); // another account
  blocked(`${CF}/zones/${'b'.repeat(32)}/subscription`); // a zone not in Settings
  blocked(`${CF}/accounts/${ACCOUNT}/subscriptions`, 'POST', { body: '{}' });
  blocked(`${CF}/accounts/${ACCOUNT}/subscriptions/sub_1`, 'PUT', { body: '{}' });
  blocked(`${CF}/accounts/${ACCOUNT}/subscriptions/sub_1`, 'DELETE');
  blocked(`${CF}/zones/${ZONE}/subscription`, 'PUT', { body: '{}' });
  blocked(`${CF}/zones/${ZONE}/subscription`, 'POST', { body: '{}' });
  blocked(`${CF}/accounts/${ACCOUNT}/billing/profile`);
  blocked(`${CF}/accounts/${ACCOUNT}/billing/profile`, 'PATCH', { body: '{}' });
  blocked(`${CF}/accounts/${ACCOUNT}/billable/usage`);
  blocked(`${CF}/accounts/${ACCOUNT}/billing/credits`);
});

test('GitHub billing: the set organization’s monthly summary and plan, GET only', () => {
  blocked(`${GH}/organizations/4ow4-Developers/settings/billing/usage/summary?year=2026&month=9`);
  setBilling();
  allowed(`${GH}/organizations/4ow4-Developers/settings/billing/usage/summary?year=2026&month=9`);
  allowed(`${GH}/organizations/4ow4-developers/settings/billing/usage/summary?year=2026&month=9`, 'GET', { headers: { authorization: 'Bearer x', accept: 'application/vnd.github+json', 'if-none-match': '"e"' } });
  allowed(`${GH}/orgs/4ow4-Developers`);
  blocked(`${GH}/organizations/4ow4-Developers/settings/billing/usage/summary?year=2026&month=9&repository=x/y`);
  blocked(`${GH}/organizations/4ow4-Developers/settings/billing/usage?year=2026`); // the full report isn't needed
  blocked(`${GH}/organizations/other-org/settings/billing/usage/summary?year=2026&month=9`);
  blocked(`${GH}/users/4ow4-Developers/settings/billing/usage/summary?year=2026&month=9`); // set as an organization
  blocked(`${GH}/orgs/other-org`);
  blocked(`${GH}/orgs/4ow4-Developers/members`);
  blocked(`${GH}/orgs/4ow4-Developers`, 'PATCH', { body: '{}' });
  blocked(`${GH}/organizations/4ow4-Developers/settings/billing/usage/summary?year=2026&month=9`, 'POST', { body: '{}' });
  blocked(`${GH}/organizations/4ow4-Developers/settings/billing/%2e%2e/usage/summary?year=2026&month=9`);
});

test('GitHub billing for a personal account: its own summary only', () => {
  configureGuard({ billing: { github: { kind: 'user', owner: 'dana' } } });
  allowed(`${GH}/users/dana/settings/billing/usage/summary?year=2026&month=8`);
  blocked(`${GH}/organizations/dana/settings/billing/usage/summary?year=2026&month=8`);
  blocked(`${GH}/orgs/dana`);
  blocked(`${GH}/users/someone/settings/billing/usage/summary?year=2026&month=8`);
  blocked(`${GH}/user/settings/billing/usage/summary`);
});

test('the billing rules leave the Versions page and app updates as they were', () => {
  setBilling();
  configureGuard({ github: { owner: '4ow4-Developers', manifestRepo: 'flobi-release', manifestPath: 'repos.json' } });
  allowed(`${GH}/repos/4ow4-Developers/flobi-release/contents/repos.json`);
  allowed(`${GH}/repos/4ow4-Developers/flobi_drive/releases?per_page=15`);
  blocked(`${GH}/repos/4ow4-Developers/flobi_drive/contents/.env`);
  blocked('https://monitoring.googleapis.com/v3/projects/flobi-prod-2026/timeSeries?filter=x');
});
