// The Costs page's main-process side (core/costs.mjs): readers only for what's set up, the
// guard opened for exactly that and closed on sign-out, the last results shown right away after
// a restart, readers restarted only when what they read changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { CostsService, fileCache } from '../electron/core/costs.mjs';
import { checkRequest, configureGuard, resetGuard, ReadOnlyViolation } from '../electron/core/net/guard.mjs';

const TABLE = 'flobi-billing.billing_export.gcp_billing_export_v1_01A2B3_C4D5E6_F7A8B9';
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const auth = { identity: { email: 'viewer@flobi-prod-2026.iam.gserviceaccount.com' }, getToken: async () => 't' };
const config = { cloudflare: { token: 'cf-token', accountId: ACCOUNT, zones: ['flobi.ai'] }, versions: { owner: '4ow4-Developers' } };
const settings = { bigQueryTable: TABLE, github: { owner: '', kind: 'org', seatPrice: 4, seatCurrency: 'USD' }, items: [{ id: 's', vendor: 'Sentry', item: 'Team', amount: 26, currency: 'USD', cycle: 'monthly', addedAt: 1 }] };

function store(initial = {}) {
  let data = { ...initial };
  return { get: () => data, update: async (p) => void (data = { ...data, ...p }) };
}

const allowed = (url) => assert.equal(checkRequest({ method: 'GET', url }), true, url);
const blocked = (url) => assert.throws(() => checkRequest({ method: 'GET', url }), ReadOnlyViolation, url);

test('live: readers for what’s set up, the guard opened for exactly that, the last results shown at once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  resetGuard();
  configureGuard({ billing: null });
  const built = [];
  const readers = (o) => {
    built.push({ table: o.table?.id, cf: !!o.cf.token, github: o.token && o.owner ? `${o.kind}:${o.owner}` : null });
    return { gcp: { key: `bigquery:${o.table.id}`, read: async () => ({ status: 'ok' }) } };
  };
  const saved = { vendors: { gcp: { key: `bigquery:${TABLE}`, status: 'ok', okAt: Date.now() - 60_000, checkedAt: Date.now() - 60_000, months: {}, complete: [] } }, history: {} };
  const sent = [];
  const s = new CostsService({ dir: os.tmpdir(), stateStore: store({ costs: saved }), onChange: (c) => sent.push(c), readers });
  s.update({ mode: 'live', auth, config, settings, githubToken: 'gh-token' });
  assert.deepEqual(built, [{ table: TABLE, cf: true, github: 'org:4ow4-Developers' }], 'the Versions organization when none is set');
  const c = sent.at(-1);
  assert.equal(c.vendors.find((v) => v.id === 'gcp').okAt, saved.vendors.gcp.okAt, 'what was read before shows right away');
  assert.equal(c.vendors.find((v) => v.id === 'sentry').totals.thisMonth, 26);
  allowed(`https://bigquery.googleapis.com/bigquery/v2/projects/flobi-billing/datasets/billing_export/tables/${TABLE.split('.')[2]}/data`);
  allowed(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/subscriptions`);
  allowed('https://api.github.com/organizations/4ow4-Developers/settings/billing/usage/summary?year=2026&month=9');

  // A connector restart (same settings): nothing starts again.
  s.update({ mode: 'live', auth, config, settings, githubToken: 'gh-token' });
  assert.equal(built.length, 1);
  // Items only: the page is rebuilt, the readers stay.
  s.update({ mode: 'live', auth, config, settings: { ...settings, items: [] }, githubToken: 'gh-token' });
  assert.equal(built.length, 1);
  assert.equal(sent.at(-1).vendors.find((v) => v.id === 'sentry').status, 'off');
  // Another table: new readers, and the old table is closed.
  s.update({ mode: 'live', auth, config, settings: { ...settings, bigQueryTable: 'flobi-billing.billing_export.other_table' }, githubToken: 'gh-token' });
  assert.equal(built.length, 2);
  blocked(`https://bigquery.googleapis.com/bigquery/v2/projects/flobi-billing/datasets/billing_export/tables/${TABLE.split('.')[2]}/data`);

  // Signed out: nothing runs, nothing is shown, the guard is closed again.
  s.update({ mode: 'signed-out' });
  assert.equal(sent.at(-1), null);
  assert.equal(s.watcher, null);
  blocked('https://bigquery.googleapis.com/bigquery/v2/projects/flobi-billing/datasets/billing_export/tables/other_table/data');
  blocked(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/subscriptions`);
});

test('demo: the simulated page, no readers, no network', () => {
  let built = 0;
  const s = new CostsService({ dir: os.tmpdir(), stateStore: store(), onChange: () => {}, readers: () => (built++, {}) });
  s.update({ mode: 'demo', settings });
  assert.equal(built, 0);
  const c = s.state();
  assert.equal(c.mode, 'demo');
  assert.ok(c.total.thisMonth > 0);
  assert.equal(s.refresh().reason, 'demo');
});

test('the BigQuery cache file: missing or broken reads as empty, saves whole', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pulse-costs-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'costs-bigquery.json');
  const cache = fileCache(file);
  assert.equal(await cache.load(), null);
  await fs.writeFile(file, '{"v":1,');
  assert.equal(await cache.load(), null);
  await cache.save({ v: 1, partitions: { 20260928: { rows: 3 } } });
  assert.deepEqual(await cache.load(), { v: 1, partitions: { 20260928: { rows: 3 } } });
});
