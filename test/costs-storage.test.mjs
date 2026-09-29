// How much of BigQuery's free 10 GiB the billing export uses (Costs page): the table's size from
// tables.get, its growth from the days read, the level ("getting close" from 80%), the days to
// keep and the one-time command that keeps them, and the alert that says when it's close.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bigQueryStorage, BQ_FREE_BYTES, BQ_MIN_KEEP_DAYS, BQ_MAX_KEEP_DAYS, parseTableRef, buildCosts } from '../electron/core/engine/costs.mjs';
import { BigQueryBillingReader } from '../electron/core/sources/bigquery-billing.mjs';
import { evaluateConditions } from '../electron/core/engine/alerts.mjs';
import { demoCosts } from '../electron/core/engine/demo.mjs';

const TABLE = 'flobi-billing.billing_export.gcp_billing_export_v1_01A2B3_C4D5E6_F7A8B9';
const REF = parseTableRef(TABLE);
const GiB = 1024 ** 3;
const MB = 1024 ** 2;
const DAY = 86_400_000;
const EMPTY_MODEL = { services: [], pods: [], nodes: [], scaling: [], jobs: { cronjobs: [] }, certificates: [] };

test('storage: its share of the free 10 GiB, and "getting close" from 80%, "about full" from 95%', () => {
  const at = (share) => bigQueryStorage({ bytes: share * BQ_FREE_BYTES, bytesPerDay: 2 * MB }, REF);
  assert.equal(BQ_FREE_BYTES, 10 * GiB);
  assert.equal(at(0.04).level, 'ok');
  assert.equal(at(0.79).level, 'ok');
  assert.equal(at(0.8).level, 'near');
  assert.equal(at(0.94).level, 'near');
  assert.equal(at(0.95).level, 'full');
  assert.equal(at(1.2).level, 'full');
  assert.equal(bigQueryStorage(null, REF), null);
  assert.equal(bigQueryStorage({ bytes: 5 }, null), null);
});

test('storage: the days to keep settle it around half the free storage, between 200 and 400 days', () => {
  // Small and slow: the most the page ever keeps.
  const small = bigQueryStorage({ bytes: 0.4 * GiB, bytesPerDay: 2.6 * MB }, REF);
  assert.equal(small.keepDays, BQ_MAX_KEEP_DAYS);
  assert.equal(small.settlesAt, 2.6 * MB * 400);
  // Fast: 20 MB a day settles 5 GiB at 256 days.
  const fast = bigQueryStorage({ bytes: 8.5 * GiB, bytesPerDay: 20 * MB }, REF);
  assert.equal(fast.keepDays, 256);
  assert.ok(fast.settlesAt <= BQ_FREE_BYTES / 2);
  // Very fast: never fewer days than the page's six months need, even if it stays bigger.
  const huge = bigQueryStorage({ bytes: 9.8 * GiB, bytesPerDay: 60 * MB }, REF);
  assert.equal(huge.keepDays, BQ_MIN_KEEP_DAYS);
  // Growth unknown (the first read isn't in yet): 400.
  assert.equal(bigQueryStorage({ bytes: 1 * GiB, bytesPerDay: null }, REF).keepDays, BQ_MAX_KEEP_DAYS);
});

test('storage: the command keeps that many days on this table, and nothing else', () => {
  const s = bigQueryStorage({ bytes: 8.7 * GiB, bytesPerDay: 30_000_000 }, REF);
  assert.equal(s.command, `ALTER TABLE \`${TABLE}\`\nSET OPTIONS (partition_expiration_days = ${s.keepDays});`);
  assert.doesNotMatch(s.command, /DELETE|DROP|TRUNCATE|expiration_timestamp/i, 'never deletes the table, only old days');
});

test('storage: with an expiration already set it levels off; with none, when it would pass 10 GiB', () => {
  const capped = bigQueryStorage({ bytes: 1 * GiB, bytesPerDay: 5 * MB, expirationDays: 400 }, REF);
  assert.equal(capped.cappedAt, 5 * MB * 400);
  assert.equal(capped.daysToFree, null);
  const open = bigQueryStorage({ bytes: 9 * GiB, bytesPerDay: GiB / 8 }, REF);
  assert.equal(open.daysToFree, 8);
  assert.equal(open.cappedAt, null);
});

test('reader: size from tables.get, growth from the last 30 days read at the table’s bytes per row', () => {
  const reader = new BigQueryBillingReader({ table: TABLE, getToken: async () => 't' });
  const now = Date.UTC(2026, 8, 28, 12);
  const day = (ms) => new Date(ms).toISOString().slice(0, 10).replaceAll('-', '');
  const partitions = {};
  for (let i = 1; i <= 40; i++) partitions[day(now - i * DAY)] = { rows: i <= 30 ? 4000 : 99_999, months: {} }; // older days don't count
  partitions[day(now)] = { rows: 10, months: {} }; // today is still coming in: not counted either
  const s = reader.storage({ partitions }, { rows: 1_000_000, bytes: 600_000_000, longTermBytes: 0, expirationMs: 400 * DAY }, now);
  assert.equal(s.bytes, 600_000_000);
  assert.equal(s.bytesPerDay, 4000 * 600);
  assert.equal(s.expirationDays, 400);
  assert.equal(reader.storage({ partitions: {} }, { rows: 0, bytes: 0, longTermBytes: 0, expirationMs: 0 }, now).bytesPerDay, null);
});

test('the Costs page gets it on Google Cloud, demo included', () => {
  const d = demoCosts(Date.UTC(2026, 8, 16, 12));
  const model = buildCosts(d.data, d.settings, { now: Date.UTC(2026, 8, 16, 12), setup: d.setup, mode: 'demo' });
  const gcp = model.vendors.find((v) => v.id === 'gcp');
  assert.equal(gcp.storage.level, 'ok');
  assert.ok(gcp.storage.bytes > 0 && gcp.storage.share < 0.1);
  assert.match(gcp.storage.command, /^ALTER TABLE `flobi-billing\.billing_export\.gcp_billing_export_v1_/);
});

test('alert: a warning once it is getting close (with what to do), none before', () => {
  const cond = (storage) => evaluateConditions({ model: EMPTY_MODEL, traffic: null, uptime: [], database: null, cloudRun: [], cloudflare: null, errorRates: {}, billingStorage: storage }).filter((c) => c.key === 'bq-storage');
  assert.deepEqual(cond(bigQueryStorage({ bytes: 3 * GiB, bytesPerDay: 2 * MB }, REF)), []);
  assert.deepEqual(cond(null), []);
  const [c] = cond(bigQueryStorage({ bytes: 8.7 * GiB, bytesPerDay: 30_000_000 }, REF));
  assert.equal(c.severity, 'warning');
  assert.equal(c.kind, 'costs');
  assert.equal(c.title, 'Billing data in BigQuery is at 8.7 of the free 10 GB');
  assert.match(c.detail, /passes 10 GB in about 7 weeks/);
  assert.match(c.action, /keeps the last \d+ days/);
  assert.deepEqual(c.view, { to: 'costs' });
  const [capped] = cond(bigQueryStorage({ bytes: 8.2 * GiB, bytesPerDay: 20 * MB, expirationDays: 440 }, REF));
  assert.match(capped.detail, /levels off around 8\.6 GB/);
});
