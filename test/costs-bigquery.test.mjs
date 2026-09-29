// Google Cloud costs from the billing export (C: Costs page): only BigQuery's free table preview
// (tabledata.list) and metadata (tables.get), one day's partition at a time, added up per
// invoice month and service (net of credits), cached, and read again only where rows changed.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { BigQueryBillingReader, selectFields, decodeRow, addRows, lineName, invoiceMonth, timestampMs, memoryCache, parseTableRef, dayRange } from '../electron/core/sources/bigquery-billing.mjs';
import { checkRequest, configureGuard, resetGuard } from '../electron/core/net/guard.mjs';

const TABLE = 'flobi-billing.billing_export.gcp_billing_export_v1_01A2B3_C4D5E6_F7A8B9';
const REF = parseTableRef(TABLE);
const MONTHS = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
const NOW = Date.UTC(2026, 8, 28, 12);
const DAY = 86_400_000;

// The standard usage cost export's schema (the parts that matter here, in its order).
const SCHEMA = [
  { name: 'billing_account_id', type: 'STRING' },
  { name: 'service', type: 'RECORD', fields: [{ name: 'id', type: 'STRING' }, { name: 'description', type: 'STRING' }] },
  { name: 'sku', type: 'RECORD', fields: [{ name: 'id', type: 'STRING' }, { name: 'description', type: 'STRING' }] },
  { name: 'usage_start_time', type: 'TIMESTAMP' },
  { name: 'usage_end_time', type: 'TIMESTAMP' },
  { name: 'project', type: 'RECORD', fields: [{ name: 'id', type: 'STRING' }] },
  { name: 'cost', type: 'FLOAT' },
  { name: 'currency', type: 'STRING' },
  { name: 'currency_conversion_rate', type: 'FLOAT' },
  { name: 'credits', type: 'RECORD', mode: 'REPEATED', fields: [{ name: 'name', type: 'STRING' }, { name: 'amount', type: 'FLOAT' }, { name: 'full_name', type: 'STRING' }, { name: 'id', type: 'STRING' }, { name: 'type', type: 'STRING' }] },
  { name: 'invoice', type: 'RECORD', fields: [{ name: 'month', type: 'STRING' }, { name: 'publisher_type', type: 'STRING' }] },
  { name: 'cost_type', type: 'STRING' },
];

const row = (service, cost, month, { credits = [], currency = 'USD', type = 'regular', end = NOW - DAY } = {}) => ({
  billing_account_id: '01A2B3-C4D5E6-F7A8B9',
  service: { id: service.slice(0, 4), description: service },
  sku: { id: 'x', description: `${service} usage` },
  usage_start_time: end - 3_600_000,
  usage_end_time: end,
  project: { id: 'flobi-prod-2026' },
  cost,
  currency,
  currency_conversion_rate: 1,
  credits: credits.map((amount) => ({ name: 'Free tier', amount, full_name: 'Free tier', id: 'ft', type: 'FREE_TIER' })),
  invoice: { month, publisher_type: 'GOOGLE' },
  cost_type: type,
});

/** Encodes a row the way tabledata.list does ({ f: [{ v }] }, numbers and times as strings). */
function encode(obj, fields, int64) {
  const cell = (v, f) => {
    if (f.mode === 'REPEATED') return (v || []).map((x) => ({ v: one(x, f) }));
    return one(v, f);
  };
  const one = (v, f) => {
    if (v == null) return null;
    if (f.type === 'RECORD') return encode(v, f.fields, int64);
    if (f.type === 'TIMESTAMP') return int64 ? String(v * 1000) : (v / 1000).toExponential(9).replace('e+', 'E');
    return String(v);
  };
  return { f: fields.map((f) => ({ v: cell(obj[f.name], f) })) };
}

/** The schema pruned to selectedFields ("a,b.c"), in table order: what the preview returns. */
function prune(fields, selected, prefix = '') {
  const out = [];
  for (const f of fields) {
    const p = prefix ? `${prefix}.${f.name}` : f.name;
    if (selected.includes(p)) out.push(f);
    else if (f.type === 'RECORD' && selected.some((s) => s.startsWith(`${p}.`))) out.push({ ...f, fields: prune(f.fields, selected, p) });
  }
  return out;
}

/** A fake BigQuery: partitions by day ("YYYYMMDD" → rows). Every request passes the real guard. */
function fakeBigQuery({ partitions = {}, created = Date.UTC(2026, 7, 20), partitioning = 'DAY', schema = SCHEMA, fail = null, wholeRecords = false } = {}) {
  const t = { partitions, modified: 1_000, created, calls: [], meta: 0, data: 0, checks: 0 };
  t.request = async ({ url, headers }) => {
    checkRequest({ method: 'GET', url, headers });
    const u = new URL(url);
    t.calls.push(u.pathname.replace(/^.*\/tables\//, '') + u.search);
    const err = fail?.(u);
    if (err) throw Object.assign(new Error(err.message), { status: err.status, body: err.body || '' });
    const base = `/bigquery/v2/projects/${REF.project}/datasets/${REF.dataset}/tables/${REF.table}`;
    const rows = Object.values(t.partitions).reduce((a, r) => a + r.length, 0);
    if (u.pathname === base) {
      t.meta++;
      return { kind: 'bigquery#table', numRows: String(rows), lastModifiedTime: String(t.modified), creationTime: String(t.created), type: 'TABLE', ...(partitioning ? { timePartitioning: { type: partitioning } } : {}), schema: { fields: schema } };
    }
    const m = u.pathname.match(/\$(\d{8})\/data$/);
    assert.ok(m, `reads one day's partition: ${u.pathname}`);
    const list = t.partitions[m[1]] || [];
    const max = Number(u.searchParams.get('maxResults') || 100_000);
    const start = Number(u.searchParams.get('pageToken') || 0);
    const selected = (u.searchParams.get('selectedFields') || '').split(',').filter(Boolean);
    if (max === 1) t.checks++;
    else t.data++;
    const fields = wholeRecords ? schema : prune(schema, selected);
    const page = list.slice(start, start + max);
    return { kind: 'bigquery#tableDataList', totalRows: String(list.length), rows: page.map((r) => encode(r, fields, u.searchParams.get('formatOptions.useInt64Timestamp') === 'true')), ...(start + max < list.length ? { pageToken: String(start + max) } : {}) };
  };
  return t;
}

const reader = (bq, extra = {}) => new BigQueryBillingReader({ table: TABLE, getToken: async () => 'token-123', request: bq.request, pageRows: 2, pauseMs: 0, sleep: async () => {}, ...extra });
const net = (months, month, service, cur = 'USD') => {
  const l = months[month]?.[cur]?.lines?.[service];
  return l ? Math.round((l[0] + l[1]) * 1e6) / 1e6 : undefined;
};

beforeEach(() => {
  resetGuard();
  configureGuard({ billing: { bigQuery: REF } });
});

test('table names: project.dataset.table, also as bq and SQL write them', () => {
  assert.equal(parseTableRef(TABLE).id, TABLE);
  assert.equal(parseTableRef(`flobi-billing:billing_export.${REF.table}`).id, TABLE);
  assert.equal(parseTableRef(` \`${TABLE}\` `).id, TABLE);
  for (const bad of ['', 'billing_export.gcp', 'Flobi.a.b', 'flobi-billing.a.b.c', 'flobi-billing.a.b$20260101', 'flobi-billing.a.b/../../x', 'x.y.z']) assert.equal(parseTableRef(bad), null, bad);
});

test('rows: credits come off the cost, invoice month decides the month, taxes and currencies apart', () => {
  const agg = addRows({}, [
    { service: { description: 'Compute Engine' }, cost: '10.5', currency: 'USD', invoice: { month: '202609' }, credits: [{ amount: '-2.25' }, { amount: '-0.25' }], cost_type: 'regular' },
    // Usage from the end of August billed on September's invoice counts in September.
    { service: { description: 'Compute Engine' }, cost: '1', currency: 'USD', invoice: { month: '202609' }, usage_end_time: String(Date.UTC(2026, 7, 31, 23) * 1000), credits: [] },
    { service: { description: 'Cloud SQL' }, cost: '4', currency: 'EUR', invoice: { month: '202609' }, credits: [] },
    { service: { description: 'Invoice' }, cost: '0.8', currency: 'USD', invoice: { month: '202609' }, cost_type: 'tax', credits: [] },
    { service: { description: 'Support' }, cost: '-1.1', currency: 'USD', invoice: { month: '202608' }, cost_type: 'adjustment', credits: [] },
    { service: { description: 'Compute Engine' }, cost: '9', currency: 'USD', invoice: { month: null } }, // no invoice month: not counted
  ]);
  assert.equal(agg.rows, 6);
  assert.deepEqual(agg.months['2026-09'].USD.lines['Compute Engine'], [11.5, -2.5]);
  assert.deepEqual(agg.months['2026-09'].EUR.lines['Cloud SQL'], [4, 0]);
  assert.deepEqual(agg.months['2026-09'].USD.lines.Tax, [0.8, 0]);
  assert.deepEqual(agg.months['2026-08'].USD.lines.Adjustments, [-1.1, 0]);
  assert.equal(agg.months['2026-09'].USD.through, Date.UTC(2026, 7, 31, 23));
  assert.equal(lineName({ cost_type: 'rounding_error', service: { description: 'x' } }), 'Rounding');
  assert.equal(lineName({}), 'Other');
  assert.equal(invoiceMonth('202613'), null);
  assert.equal(timestampMs('1.7275176E9'), 1_727_517_600_000);
  assert.equal(timestampMs('1727517600000000'), 1_727_517_600_000);
});

test('rows decode from the preview’s pruned records, and from whole records too', () => {
  const sel = selectFields(SCHEMA);
  assert.deepEqual(sel.selected, ['service.description', 'usage_end_time', 'cost', 'currency', 'credits.amount', 'invoice.month', 'cost_type']);
  assert.deepEqual(sel.missing, []);
  const r = row('Cloud Run', 1.25, '202609', { credits: [-0.5] });
  const pruned = decodeRow(encode(r, prune(SCHEMA, sel.selected), true), sel.schema, sel.fields);
  const whole = decodeRow(encode(r, SCHEMA, true), sel.schema, sel.fields);
  for (const d of [pruned, whole]) {
    assert.equal(d.service.description, 'Cloud Run');
    assert.equal(d.invoice.month, '202609');
    assert.equal(Number(d.credits[0].amount), -0.5);
    assert.equal(timestampMs(d.usage_end_time), NOW - DAY);
  }
  assert.deepEqual(selectFields(SCHEMA.filter((f) => f.name !== 'invoice')).missing, ['invoice.month']);
  assert.deepEqual(selectFields(SCHEMA, { top: true }).selected, ['service', 'usage_end_time', 'cost', 'currency', 'credits', 'invoice', 'cost_type']);
});

function sampleTable() {
  return fakeBigQuery({
    partitions: {
      20260801: [row('Compute Engine', 10, '202608')],
      20260827: [row('Cloud SQL', 5, '202608', { credits: [-1] })],
      // Late August usage lands in a September day; September's own usage next to it.
      20260902: [row('Compute Engine', 2, '202608'), row('Compute Engine', 3, '202609'), row('Networking', 0.5, '202609')],
      20260915: [row('Networking', 1, '202609'), row('Invoice', 0.3, '202609', { type: 'tax' })],
      20260927: [row('Compute Engine', 4, '202609', { end: NOW - 13 * 3_600_000 })],
    },
  });
}

test('first read: every day once, newest first, one partition at a time, paged; sums per invoice month', async () => {
  const bq = sampleTable();
  const partials = [];
  const progress = [];
  const res = await reader(bq).read({ months: MONTHS, now: NOW, onPartial: (p) => partials.push(p.complete), onProgress: (p) => progress.push(p) });
  // The export was created on Aug 20 and fills in from the month before: days from Jun 11.
  const days = dayRange('20260611', '20260928');
  assert.equal(bq.data, days.length + 1, 'one read per day, plus a second page for the busy day');
  assert.equal(bq.checks, 0);
  assert.ok(bq.calls.every((c) => !/jobs|queries/.test(c)));
  assert.match(bq.calls[1], /^gcp_billing_export_v1_01A2B3_C4D5E6_F7A8B9\$20260928\/data\?selectedFields=service\.description%2Cusage_end_time%2Ccost%2Ccurrency%2Ccredits\.amount%2Cinvoice\.month%2Ccost_type&maxResults=2&formatOptions\.useInt64Timestamp=true$/);
  assert.equal(net(res.months, '2026-09', 'Compute Engine'), 7);
  assert.equal(net(res.months, '2026-09', 'Networking'), 1.5);
  assert.equal(net(res.months, '2026-09', 'Tax'), 0.3);
  assert.equal(net(res.months, '2026-08', 'Compute Engine'), 12);
  assert.equal(net(res.months, '2026-08', 'Cloud SQL'), 4);
  assert.deepEqual(res.complete, MONTHS);
  assert.equal(res.through, NOW - 13 * 3_600_000);
  assert.equal(progress.at(-1).done, days.length);
  // While reading, this month was complete before last month.
  assert.ok(partials.some((c) => c.includes('2026-09') && !c.includes('2026-08')), JSON.stringify(partials));
});

test('nothing changed since the last read: one metadata read, no rows', async () => {
  const bq = sampleTable();
  const cache = memoryCache();
  await reader(bq, { cache }).read({ months: MONTHS, now: NOW });
  bq.calls.length = bq.data = bq.checks = bq.meta = 0;
  // A new reader (after a restart) with the same cache on disk.
  const res = await reader(bq, { cache }).read({ months: MONTHS, now: NOW + 3_600_000 });
  assert.deepEqual({ meta: bq.meta, data: bq.data, checks: bq.checks }, { meta: 1, data: 0, checks: 0 });
  assert.equal(net(res.months, '2026-09', 'Compute Engine'), 7);
});

test('new rows: only the recent days are counted again, and only the changed ones read', async () => {
  const bq = sampleTable();
  const cache = memoryCache();
  await reader(bq, { cache }).read({ months: MONTHS, now: NOW });
  bq.partitions['20260928'] = [row('Compute Engine', 1, '202609')];
  bq.partitions['20260926'] = [row('Cloud Storage', 0.25, '202609')];
  bq.modified = 2_000;
  bq.calls.length = bq.data = bq.checks = bq.meta = 0;
  const res = await reader(bq, { cache }).read({ months: MONTHS, now: NOW });
  assert.equal(bq.checks, 11, 'Sep 18–28: one row each, to learn their row counts');
  assert.equal(bq.data, 2, 'Sep 26 and 28 read again');
  assert.equal(bq.meta, 2, 'metadata before and after (did an old day change?)');
  assert.equal(net(res.months, '2026-09', 'Compute Engine'), 8);
  assert.equal(net(res.months, '2026-09', 'Cloud Storage'), 0.25);
});

test('a row added to an old day is found through the table’s row count', async () => {
  const bq = sampleTable();
  const cache = memoryCache();
  await reader(bq, { cache }).read({ months: MONTHS, now: NOW });
  bq.partitions['20260801'].push(row('Compute Engine', 6, '202608'));
  bq.modified = 3_000;
  bq.calls.length = bq.data = bq.checks = 0;
  const res = await reader(bq, { cache }).read({ months: MONTHS, now: NOW });
  assert.equal(net(res.months, '2026-08', 'Compute Engine'), 18);
  assert.equal(bq.data, 1, 'only Aug 1 read again');
  // The next check with nothing new is quiet again.
  bq.calls.length = bq.data = bq.checks = bq.meta = 0;
  await reader(bq, { cache }).read({ months: MONTHS, now: NOW });
  assert.deepEqual({ meta: bq.meta, data: bq.data, checks: bq.checks }, { meta: 1, data: 0, checks: 0 });
});

test('the first days after the export is turned on, every day is counted again: Google may still be filling any of them', async () => {
  const bq = sampleTable();
  bq.created = NOW - 2 * DAY;
  const cache = memoryCache();
  await reader(bq, { cache }).read({ months: MONTHS, now: NOW });
  // Google adds more of August to an old day, and keeps writing while the page reads, so the
  // table's row count can't be compared at the end.
  bq.partitions['20260805'] = [row('Compute Engine', 30, '202608'), row('Cloud SQL', 4, '202608')];
  const request = bq.request;
  bq.request = async (o) => {
    if (!/\$\d{8}\/data/.test(o.url)) bq.modified += 1; // every look at the table's metadata finds it changed
    return request(o);
  };
  bq.calls.length = bq.data = bq.checks = 0;
  const res = await reader(bq, { cache }).read({ months: MONTHS, now: NOW });
  assert.equal(net(res.months, '2026-08', 'Compute Engine'), 42);
  assert.equal(net(res.months, '2026-08', 'Cloud SQL'), 8);
  assert.ok(bq.checks > 60, `every day counted (${bq.checks})`);
  // Past those days (and past the 10th, when last month's days are checked too): only the recent ones.
  bq.request = request;
  bq.modified += 1;
  bq.calls.length = bq.data = bq.checks = 0;
  await reader(bq, { cache }).read({ months: ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'], now: Date.UTC(2026, 9, 12, 12) });
  assert.ok(bq.checks <= 11, `recent days only (${bq.checks})`);
});

test('until the 10th, last month’s days are counted again too (late charges); the window moves with the months', async () => {
  const bq = sampleTable();
  const cache = memoryCache();
  await reader(bq, { cache }).read({ months: MONTHS, now: NOW });
  const oct3 = Date.UTC(2026, 9, 3, 12);
  bq.partitions['20260905'] = [row('Cloud DNS', 0.2, '202609')];
  bq.modified = 4_000;
  bq.calls.length = bq.data = bq.checks = 0;
  const res = await reader(bq, { cache }).read({ months: ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'], now: oct3 });
  assert.ok(bq.calls.some((c) => c.startsWith(`${REF.table}$20260905/data?selectedFields=service.description&maxResults=1`)), 'Sep 5 counted again');
  assert.equal(bq.data, 1 + 5, 'Sep 5 read again, and the five new days (Sep 29 – Oct 3)');
  assert.equal(net(res.months, '2026-09', 'Cloud DNS'), 0.2);
  assert.deepEqual(Object.keys(res.months).sort(), ['2026-08', '2026-09']);
});

test('a partition that doesn’t exist is an empty day, not an error', async () => {
  const bq = sampleTable();
  bq.request = ((inner) => async (o) => {
    if (o.url.includes('$20260903/')) throw Object.assign(new Error('HTTP 404 – Not found: Table'), { status: 404 });
    return inner(o);
  })(bq.request);
  const res = await reader(bq).read({ months: MONTHS, now: NOW });
  assert.equal(res.status, 'ok');
  assert.equal(net(res.months, '2026-09', 'Compute Engine'), 7);
});

test('a token Google turned away is renewed once', async () => {
  const bq = sampleTable();
  let first = true;
  const invalidated = [];
  let n = 0;
  const r = reader(bq, {
    getToken: async () => `token-${++n}`,
    invalidateToken: (t) => invalidated.push(t),
    request: async (o) => {
      if (first) {
        first = false;
        throw Object.assign(new Error('HTTP 401'), { status: 401 });
      }
      return bq.request(o);
    },
  });
  const res = await r.read({ months: MONTHS, now: NOW });
  assert.deepEqual(invalidated, ['token-1']);
  assert.equal(res.status, 'ok');
});

test('what goes wrong says what to do: permission, API off, no table, not an export', async () => {
  const cases = [
    [{ status: 403, message: 'HTTP 403 – Access Denied: Table flobi-billing:billing_export.x: Permission bigquery.tables.get denied', body: '{"error":{"code":403,"status":"PERMISSION_DENIED"}}' }, 'forbidden', /BigQuery Data Viewer role on the billing_export dataset/],
    [{ status: 403, message: 'HTTP 403 – BigQuery API has not been used in project 123 before or it is disabled', body: '{"error":{"status":"PERMISSION_DENIED","details":[{"reason":"SERVICE_DISABLED"}]}}' }, 'api-off', /BigQuery API is turned off/],
    [{ status: 404, message: 'HTTP 404 – Not found: Dataset flobi-billing:billing_export' }, 'not-found', /can’t find flobi-billing\.billing_export\.gcp_billing_export_v1_01A2B3_C4D5E6_F7A8B9/],
  ];
  for (const [err, code, text] of cases) {
    const bq = fakeBigQuery({ fail: () => err });
    await assert.rejects(reader(bq).read({ months: MONTHS, now: NOW }), (e) => e.code === code && text.test(e.message) && !e.message.includes('token-123'), code);
  }
  await assert.rejects(reader(fakeBigQuery({ partitioning: null })).read({ months: MONTHS, now: NOW }), (e) => e.code === 'setup' && /daily partitions/.test(e.message));
  await assert.rejects(reader(fakeBigQuery({ schema: SCHEMA.filter((f) => f.name !== 'invoice') })).read({ months: MONTHS, now: NOW }), (e) => e.code === 'setup' && /invoice\.month/.test(e.message));
  assert.throws(() => new BigQueryBillingReader({ table: 'not a table', getToken: async () => 'x' }), (e) => e.code === 'invalid');
});

test('rows come back as whole records too (if BigQuery ignores sub-field selection)', async () => {
  const bq = sampleTable();
  const whole = fakeBigQuery({ partitions: bq.partitions, wholeRecords: true });
  const res = await reader(whole).read({ months: MONTHS, now: NOW });
  assert.equal(net(res.months, '2026-09', 'Compute Engine'), 7);
  assert.equal(net(res.months, '2026-08', 'Cloud SQL'), 4);
});

test('when sub-fields are refused, whole fields are asked for instead', async () => {
  const bq = sampleTable();
  const inner = bq.request;
  bq.request = async (o) => {
    if (/selectedFields=[^&]*\.[^&]*&maxResults=2&/.test(o.url)) throw Object.assign(new Error('HTTP 400 – Invalid field selection credits.amount'), { status: 400, body: '' });
    return inner(o);
  };
  const res = await reader(bq).read({ months: MONTHS, now: NOW });
  assert.equal(net(res.months, '2026-09', 'Compute Engine'), 7);
  assert.ok(bq.calls.some((c) => c.includes('selectedFields=service%2Cusage_end_time%2Ccost%2Ccurrency%2Ccredits%2Cinvoice%2Ccost_type')));
});
