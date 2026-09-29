// Google Cloud while the billing export isn't whole: the first days after it's turned on, Google
// copies the month before and then catches up to now (up to five days), so the table holds a part
// of a month for a while. The page counts only the months Google is past, never a part of one as
// the whole, says how far it has got, and says so if the export stops updating.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCosts, exportFirstMonth, lastMonths, EXPORT_LAG_MS } from '../electron/core/engine/costs.mjs';
import { BigQueryBillingReader, memoryCache } from '../electron/core/sources/bigquery-billing.mjs';

const TABLE = 'flobi-prod-2026.flobi_billing.gcp_billing_export_v1_01A2B3_C4D5E6_F7A8B9';
const setup = { email: 'viewer@flobi-prod-2026.iam.gserviceaccount.com', gcp: { table: TABLE }, cloudflare: { hasToken: false }, github: { hasToken: false } };
const NOW = Date.UTC(2026, 8, 28, 15); // 28 Sep 2026, 15:00 UTC
const MONTHS = lastMonths(NOW);
const vendorOf = (model, id) => model.vendors.find((v) => v.id === id);
const lineOf = (model, id, name) => vendorOf(model, id).lines.find((l) => l.name === name);

/** What the reader returns for the export: sums per invoice month, how far it goes, the table's age. */
const raw = ({ through, created, location = 'US', months }) => ({
  key: `bigquery:${TABLE}`,
  status: 'ok',
  okAt: NOW,
  checkedAt: NOW,
  table: TABLE,
  months,
  complete: MONTHS,
  through,
  created,
  location,
  rows: 3300,
});
const build = (r) => buildCosts({ vendors: { gcp: r } }, {}, { now: NOW, setup });

test('the export’s first whole month: the month before it began (US or EU), the next one (a region)', () => {
  const sep28 = Date.UTC(2026, 8, 28, 3);
  assert.equal(exportFirstMonth(sep28, 'US'), '2026-08');
  assert.equal(exportFirstMonth(sep28, 'eu'), '2026-08');
  assert.equal(exportFirstMonth(sep28, null), '2026-08', 'not known: taken as multi-region');
  assert.equal(exportFirstMonth(sep28, 'europe-west1'), '2026-10');
  assert.equal(exportFirstMonth(Date.UTC(2026, 8, 1, 9), 'europe-west1'), '2026-09', 'began on the 1st');
  assert.equal(exportFirstMonth(Date.UTC(2026, 0, 12), 'US'), '2025-12');
  assert.equal(exportFirstMonth(0, 'US'), null);
  assert.equal(exportFirstMonth(undefined, 'US'), null);
});

test('turned on today: August is still coming in, so nothing is counted yet (not $30 for August)', () => {
  const r = raw({
    created: Date.UTC(2026, 8, 28, 3),
    through: Date.UTC(2026, 7, 1, 10), // Google has copied up to 1 Aug, 10:00 so far
    months: {
      '2026-07': { USD: { lines: { 'Compute Engine': [40, 0] }, through: Date.UTC(2026, 7, 1, 7) } }, // hours that spill over by invoice month
      '2026-08': { USD: { lines: { 'Compute Engine': [23.18, 0], 'Cloud SQL': [2.67, 0], 'Gemini API': [1.2, 0] }, through: Date.UTC(2026, 7, 1, 10) } },
    },
  });
  const m = build(r);
  const gcp = vendorOf(m, 'gcp');
  assert.deepEqual(gcp.catchingUp, { through: Date.UTC(2026, 7, 1, 10), stuck: false });
  assert.equal(gcp.exportFrom, '2026-08');
  const ce = lineOf(m, 'gcp', 'Compute Engine');
  assert.deepEqual([ce.months['2026-07'], ce.months['2026-08'], ce.months['2026-09']], [null, null, null], 'July isn’t in the export; August isn’t whole yet; September hasn’t started');
  assert.deepEqual([gcp.totals.thisMonth, gcp.totals.lastMonth, gcp.projection.amount, gcp.showTrend, gcp.through], [null, null, null, false, null]);
  assert.equal(m.total.thisMonth, null);
  assert.equal(m.total.lastMonth, null);
  // AI Studio waits for the export too (its Gemini API may not be in yet): not "none".
  const ai = vendorOf(m, 'aistudio');
  assert.deepEqual([ai.status, ai.catchingUp?.through], ['ok', Date.UTC(2026, 7, 1, 10)]);
  const empty = vendorOf(build(raw({ created: Date.UTC(2026, 8, 28, 3), through: null, months: {} })), 'gcp');
  assert.deepEqual(empty.catchingUp, { through: null, stuck: false }, 'nothing has arrived yet');
  assert.equal(vendorOf(build(raw({ created: Date.UTC(2026, 8, 28, 3), through: null, months: {} })), 'aistudio').status, 'ok');
});

test('saved before the page knew when the export began: nothing before the month it has got to counts', () => {
  const r = raw({
    created: undefined,
    location: undefined,
    through: Date.UTC(2026, 7, 1, 10),
    months: {
      '2026-07': { USD: { lines: { 'Compute Engine': [40, 0] }, through: Date.UTC(2026, 7, 1, 7) } },
      '2026-08': { USD: { lines: { 'Compute Engine': [23.18, 0] }, through: Date.UTC(2026, 7, 1, 10) } },
    },
  });
  const gcp = vendorOf(build(r), 'gcp');
  assert.ok(gcp.catchingUp);
  assert.deepEqual([gcp.byMonth['2026-07'], gcp.byMonth['2026-08'], gcp.byMonth['2026-09']], [null, null, null]);
});

test('caught up: August whole, September so far; July still isn’t counted (only a few hours of it are in)', () => {
  const r = raw({
    created: Date.UTC(2026, 8, 28, 3),
    through: Date.UTC(2026, 8, 28, 6),
    months: {
      '2026-07': { USD: { lines: { 'Compute Engine': [40, 0] }, through: Date.UTC(2026, 7, 1, 7) } },
      '2026-08': { USD: { lines: { 'Compute Engine': [1120, -20], 'Cloud SQL': [260, 0], 'Gemini API': [95, 0] }, through: Date.UTC(2026, 8, 1, 7) } },
      '2026-09': { USD: { lines: { 'Compute Engine': [1010, -18], 'Cloud SQL': [240, 0], 'Gemini API': [88, 0] }, through: Date.UTC(2026, 8, 28, 6) } },
    },
  });
  const m = build(r);
  const gcp = vendorOf(m, 'gcp');
  assert.equal(gcp.catchingUp, undefined);
  assert.deepEqual([gcp.totals.lastMonth, gcp.totals.thisMonth], [1360, 1232]);
  assert.equal(lineOf(m, 'gcp', 'Compute Engine').months['2026-07'], null);
  assert.equal(gcp.through, Date.UTC(2026, 8, 28, 6));
  assert.ok(gcp.projection.estimated && gcp.projection.amount > 1232);
  assert.deepEqual([vendorOf(m, 'aistudio').totals.lastMonth, vendorOf(m, 'aistudio').totals.thisMonth], [95, 88]);
  // A day or two behind is normal: still counted.
  const late = build({ ...r, through: NOW - EXPORT_LAG_MS + 3_600_000 });
  assert.equal(vendorOf(late, 'gcp').catchingUp, undefined);
  assert.equal(vendorOf(late, 'gcp').totals.thisMonth, 1232);
});

test('stopped updating: the months it’s past still count, this month doesn’t, and it says so', () => {
  const r = raw({
    created: Date.UTC(2026, 6, 20),
    through: Date.UTC(2026, 8, 10, 12),
    months: {
      '2026-07': { USD: { lines: { 'Compute Engine': [700, 0] }, through: Date.UTC(2026, 7, 1, 7) } },
      '2026-08': { USD: { lines: { 'Compute Engine': [1100, 0] }, through: Date.UTC(2026, 8, 1, 7) } },
      '2026-09': { USD: { lines: { 'Compute Engine': [380, 0] }, through: Date.UTC(2026, 8, 10, 12) } },
    },
  });
  const gcp = vendorOf(build(r), 'gcp');
  assert.deepEqual(gcp.catchingUp, { through: Date.UTC(2026, 8, 10, 12), stuck: true });
  assert.deepEqual([gcp.byMonth['2026-06'], gcp.byMonth['2026-07'], gcp.totals.lastMonth, gcp.totals.thisMonth], [null, 700, 1100, null]);
});

test('a regional dataset: counted from the first whole month after it began', () => {
  const r = raw({
    created: Date.UTC(2026, 8, 12, 9),
    location: 'europe-west1',
    through: Date.UTC(2026, 8, 28, 9),
    months: { '2026-09': { USD: { lines: { 'Compute Engine': [600, 0] }, through: Date.UTC(2026, 8, 28, 9) } } },
  });
  const gcp = vendorOf(build(r), 'gcp');
  assert.equal(gcp.exportFrom, '2026-10');
  assert.equal(gcp.catchingUp, undefined);
  assert.equal(gcp.totals.thisMonth, null, 'September only has the days since the 12th');
  assert.equal(gcp.created, Date.UTC(2026, 8, 12, 9));
});

test('the reader says how far the export goes, when the table was made and where', async () => {
  const day = (d) => `2026${d}`;
  const table = { numRows: '2', numBytes: '4900000', numLongTermBytes: '0', lastModifiedTime: String(NOW - 60_000), creationTime: String(Date.UTC(2026, 8, 28, 3)), location: 'US', timePartitioning: { type: 'DAY' }, schema: { fields: [{ name: 'service', type: 'RECORD', fields: [{ name: 'description', type: 'STRING' }] }, { name: 'cost', type: 'FLOAT' }, { name: 'currency', type: 'STRING' }, { name: 'usage_end_time', type: 'TIMESTAMP' }, { name: 'invoice', type: 'RECORD', fields: [{ name: 'month', type: 'STRING' }] }] } };
  const rows = [
    { f: [{ v: { f: [{ v: 'Compute Engine' }] } }, { v: '23.18' }, { v: 'USD' }, { v: String(Date.UTC(2026, 7, 1, 10) * 1000) }, { v: { f: [{ v: '202608' }] } }] },
    { f: [{ v: { f: [{ v: 'Compute Engine' }] } }, { v: '40' }, { v: 'USD' }, { v: String(Date.UTC(2026, 7, 1, 7) * 1000) }, { v: { f: [{ v: '202607' }] } }] },
  ];
  const request = async ({ url }) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/data')) return u.pathname.includes(`$${day('0928')}`) ? { totalRows: '2', rows } : { totalRows: '0', rows: [] };
    return table;
  };
  const reader = new BigQueryBillingReader({ table: TABLE, getToken: async () => 't', request, cache: memoryCache(), pauseMs: 0, sleep: async () => {} });
  const r = await reader.read({ months: MONTHS, now: NOW });
  assert.equal(r.through, Date.UTC(2026, 7, 1, 10));
  assert.equal(r.created, Date.UTC(2026, 8, 28, 3));
  assert.equal(r.location, 'US');
  // What the page makes of it.
  const gcp = vendorOf(build({ ...r, key: `bigquery:${TABLE}`, okAt: NOW, checkedAt: NOW }), 'gcp');
  assert.ok(gcp.catchingUp && !gcp.catchingUp.stuck);
  assert.equal(gcp.totals.lastMonth, null);
});
