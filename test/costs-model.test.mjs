// The Costs page's numbers: monthly shares of yearly/quarterly/weekly items, one-time items in
// their month, totals, projection, currencies, last month (never guessed), statuses, the
// Settings check and the 6-hour poller with its Refresh cooldown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { monthlyShare, itemMonths, buildCosts, cleanCostsSettings, CostsWatcher, lastMonths, addMonths, monthKey, POLL_MS, COOLDOWN_MS } from '../electron/core/engine/costs.mjs';
import { demoCosts } from '../electron/core/engine/demo.mjs';

const NOW = new Date(2026, 8, 16, 12).getTime(); // 16 Sep 2026, local time
const MONTHS = lastMonths(NOW);
const [PREV, CUR] = MONTHS.slice(-2);
const LONG_AGO = new Date(2026, 2, 1).getTime();
const round = (n) => (n == null ? n : Math.round(n * 100) / 100);
const vendorOf = (model, id) => model.vendors.find((v) => v.id === id);
const lineOf = (model, id, name) => vendorOf(model, id).lines.find((l) => l.name === name);

test('months: this computer’s calendar, six of them, oldest first', () => {
  assert.equal(CUR, '2026-09');
  assert.deepEqual(MONTHS, ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']);
  assert.equal(addMonths('2026-11', 3), '2027-02');
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(monthKey(new Date(2026, 0, 31, 23, 59).getTime()), '2026-01');
});

test('monthly shares: a twelfth of yearly, a third of quarterly, 52 weeks over 12 months of weekly', () => {
  assert.equal(monthlyShare(26, 'monthly'), 26);
  assert.equal(monthlyShare(240, 'yearly'), 20);
  assert.equal(monthlyShare(90, 'quarterly'), 30);
  assert.equal(round(monthlyShare(10, 'weekly')), 43.33);
  assert.equal(monthlyShare(50, 'one-time'), null);
  assert.equal(monthlyShare('', 'monthly'), null);
});

test('items: recurring ones from the month they were added, one-time ones only in their month', () => {
  const sentry = itemMonths({ amount: 26, cycle: 'monthly', addedAt: new Date(2026, 8, 3).getTime() }, MONTHS);
  assert.equal(sentry[CUR], 26);
  assert.equal(sentry[PREV], null, 'not known before it was added');
  const domain = itemMonths({ amount: 120, cycle: 'yearly', addedAt: LONG_AGO }, MONTHS);
  assert.deepEqual(Object.values(domain), [10, 10, 10, 10, 10, 10]);
  const topUp = itemMonths({ amount: 50, cycle: 'one-time', date: '2026-08-05', addedAt: NOW }, MONTHS);
  assert.equal(topUp['2026-08'], 50);
  assert.equal(topUp[CUR], 0);
  const undated = itemMonths({ amount: 7, cycle: 'one-time', date: '', addedAt: NOW }, MONTHS);
  assert.equal(undated[CUR], 7, 'no date: the month it was added');
});

const gcpRaw = (lines, extra = {}) => ({
  key: 'bigquery:x',
  status: 'ok',
  okAt: NOW - 3_600_000,
  checkedAt: NOW - 3_600_000,
  months: {
    [PREV]: { USD: { lines: { 'Compute Engine': [180, -10], 'Cloud SQL': [60, 0] }, through: new Date(2026, 8, 1).getTime() } },
    [CUR]: { USD: { lines, through: new Date(2026, 8, 11).getTime() } },
  },
  complete: MONTHS,
  ...extra,
});
const setup = { email: 'viewer@flobi-prod-2026.iam.gserviceaccount.com', gcp: { table: 'flobi-billing.billing_export.gcp_billing_export_v1_01A2B3_C4D5E6_F7A8B9' }, cloudflare: { hasToken: true, accountId: 'a'.repeat(32), zones: ['flobi.ai'] }, github: { hasToken: true, owner: '4ow4-Developers', kind: 'org' } };

test('totals: usage as billed, yearly items as their monthly share, one-time items only in their month', () => {
  const settings = {
    items: [
      { id: 's', vendor: 'Sentry', item: 'Team', amount: 26, currency: 'USD', cycle: 'monthly', addedAt: LONG_AGO },
      { id: 'd', vendor: 'Cloudflare', item: 'flobi.ai domain', amount: 120, currency: 'USD', cycle: 'yearly', date: '2027-03-14', addedAt: LONG_AGO },
      { id: 'o', vendor: 'ElevenLabs', item: 'Credits', amount: 50, currency: 'USD', cycle: 'one-time', date: '2026-09-05', addedAt: NOW },
      { id: 'w', vendor: 'Upwork', item: 'Tester', amount: 30, currency: 'USD', cycle: 'weekly', addedAt: LONG_AGO },
    ],
  };
  const m = buildCosts({ vendors: { gcp: gcpRaw({ 'Compute Engine': [100, -5], 'Cloud SQL': [25, 0] }) } }, settings, { now: NOW, setup: { ...setup, cloudflare: { hasToken: false }, github: { hasToken: false } } });
  assert.equal(m.currency, 'USD');
  assert.equal(round(vendorOf(m, 'gcp').totals.thisMonth), 120);
  assert.equal(round(vendorOf(m, 'gcp').totals.lastMonth), 230);
  assert.equal(lineOf(m, 'gcp', 'Compute Engine').credits[CUR], -5);
  // The domain sits in Cloudflare's section although Cloudflare isn't connected.
  assert.equal(round(lineOf(m, 'cloudflare', 'flobi.ai domain').thisMonth), 10);
  assert.equal(vendorOf(m, 'sentry').totals.thisMonth, 26);
  const other = vendorOf(m, 'other');
  assert.equal(round(other.totals.thisMonth), round(50 + (30 * 52) / 12));
  assert.equal(round(other.totals.lastMonth), round((30 * 52) / 12), 'the one-time top-up is only in September');
  assert.equal(round(m.total.thisMonth), round(120 + 10 + 26 + 50 + 130));
  assert.equal(round(m.total.lastMonth), round(230 + 10 + 26 + 130));
  assert.equal(m.total.lastMonthPartial, false);
  // Google AI Studio isn't "not set up": the export was read and has no Gemini API.
  assert.deepEqual(m.notSetUp, ['Cloudflare', 'GitHub', 'OpenRouter', 'fal']);
});

test('projection: usage at this month’s pace, fixed charges as they are; too early is not extrapolated', () => {
  const settings = { items: [{ id: 's', vendor: 'Sentry', amount: 26, cycle: 'monthly', currency: 'USD', addedAt: LONG_AGO }] };
  // Usage through Sep 11 00:00 = 10 of 30 days: 100 so far → 300 for the month.
  const m = buildCosts({ vendors: { gcp: gcpRaw({ 'Compute Engine': [100, 0] }) } }, settings, { now: NOW, setup });
  const gcp = vendorOf(m, 'gcp');
  assert.equal(round(gcp.projection.amount), 300);
  assert.equal(gcp.projection.estimated, true);
  assert.equal(vendorOf(m, 'sentry').projection.amount, 26);
  assert.equal(round(m.total.projected), 326);
  // One day into the month: what's there, not ×30.
  const early = gcpRaw({ 'Compute Engine': [4, 0] });
  early.months[CUR].USD.through = new Date(2026, 8, 2).getTime();
  const e = vendorOf(buildCosts({ vendors: { gcp: early } }, {}, { now: new Date(2026, 8, 2, 8).getTime(), setup }), 'gcp');
  assert.equal(e.projection.amount, 4);
  assert.equal(e.projection.early, true);
});

test('currencies: totals in USD, other currencies through the rate typed in, or left out and named', () => {
  const items = [{ id: 'h', vendor: 'Hetzner', item: 'Backups', amount: 10, currency: 'EUR', cycle: 'monthly', addedAt: LONG_AGO }];
  const without = buildCosts({ vendors: { gcp: gcpRaw({ 'Compute Engine': [100, 0] }) } }, { items }, { now: NOW, setup });
  assert.deepEqual(without.missingRates, ['EUR']);
  assert.deepEqual(without.currencies, ['EUR']);
  assert.equal(round(without.total.thisMonth), 100, 'the EUR item is left out, not guessed');
  assert.equal(vendorOf(without, 'other').totals.thisMonth, null);
  assert.equal(lineOf(without, 'other', 'Backups').thisMonth, 10, 'the line keeps its own amount');
  const withRate = buildCosts({ vendors: { gcp: gcpRaw({ 'Compute Engine': [100, 0] }) } }, { items, rates: { EUR: 1.1 } }, { now: NOW, setup });
  assert.deepEqual(withRate.missingRates, []);
  assert.equal(round(withRate.total.thisMonth), 111);
  // A billing account in EUR and nothing in USD: the page is in EUR.
  const eur = gcpRaw({});
  eur.months = { [CUR]: { EUR: { lines: { 'Compute Engine': [80, 0] }, through: NOW } } };
  const e = buildCosts({ vendors: { gcp: eur } }, {}, { now: NOW, setup: { ...setup, cloudflare: {}, github: {} } });
  assert.equal(e.currency, 'EUR');
  assert.equal(e.total.thisMonth, 80);
});

test('last month: plans and seats come from what was seen then; nothing seen means unknown, not the current price', () => {
  const cfKey = 'cloudflare:x';
  const ghKey = 'github:org:4ow4-developers';
  const pro = { id: 'p', name: 'Pro', zone: 'flobi.ai', price: 25, currency: 'USD', frequency: 'monthly', state: 'Paid', charged: true };
  const yearly = { id: 'y', name: 'Business', zone: 'flobi.dev', price: 2400, currency: 'USD', frequency: 'yearly', state: 'Paid', charged: true };
  const vendors = {
    cloudflare: { key: cfKey, status: 'ok', okAt: NOW, subscriptions: [pro, yearly, { ...pro, id: 't', name: 'Argo', zone: null, price: 5, state: 'Trial', charged: false }], usage: { status: 'ok', months: { [CUR]: { USD: { lines: { 'Workers Standard': 2 } } } }, read: { [CUR]: NOW } } },
    github: { key: ghKey, status: 'ok', okAt: NOW, checkedAt: NOW, months: { [CUR]: { USD: { lines: { Actions: 4 } } }, [PREV]: { USD: { lines: { Actions: 6 } } } }, read: { [CUR]: NOW, [PREV]: NOW }, seats: { plan: 'team', seats: 6, filled: 6 } },
  };
  const history = { [PREV]: { [cfKey]: { subs: [pro] }, [ghKey]: { seats: { plan: 'team', seats: 5, filled: 5 } } } };
  const settings = { github: { owner: '4ow4-Developers', kind: 'org', seatPrice: 4, seatCurrency: 'USD' } };
  const m = buildCosts({ vendors, history }, settings, { now: NOW, setup });
  const cf = vendorOf(m, 'cloudflare');
  assert.equal(lineOf(m, 'cloudflare', 'flobi.ai · Pro').lastMonth, 25);
  assert.equal(lineOf(m, 'cloudflare', 'flobi.dev · Business').thisMonth, 200);
  assert.equal(lineOf(m, 'cloudflare', 'flobi.dev · Business').lastMonth, null, 'not seen last month: unknown');
  assert.equal(lineOf(m, 'cloudflare', 'Argo').thisMonth, 0, 'a trial costs nothing');
  assert.equal(lineOf(m, 'cloudflare', 'Argo').state, 'Trial');
  assert.equal(lineOf(m, 'cloudflare', 'Workers Standard').lastMonth, null, 'usage of a month not read: unknown');
  assert.equal(cf.totals.thisMonth, 25 + 200 + 2);
  assert.equal(cf.partial[PREV], true);
  const seats = lineOf(m, 'github', 'Seats (Team plan)');
  assert.deepEqual([seats.thisMonth, seats.lastMonth, seats.seats], [24, 20, 6]);
  assert.equal(vendorOf(m, 'github').totals.lastMonth, 26);
  assert.equal(m.total.lastMonthPartial, true);
  assert.ok(m.lastMonthGaps.includes('flobi.dev · Business'));
  // A plan seen last month but gone now costs nothing this month.
  const gone = buildCosts({ vendors: { cloudflare: { ...vendors.cloudflare, subscriptions: [] } }, history }, {}, { now: NOW, setup });
  assert.deepEqual([lineOf(gone, 'cloudflare', 'flobi.ai · Pro').thisMonth, lineOf(gone, 'cloudflare', 'flobi.ai · Pro').lastMonth], [0, 25]);
});

test('statuses: not set up (and why), loading, missing permission with the last numbers kept, stale', () => {
  const off = buildCosts({}, {}, { now: NOW, setup: { gcp: { table: '' }, cloudflare: { hasToken: false }, github: { hasToken: true, owner: '' } } });
  assert.deepEqual(off.vendors.map((v) => [v.id, v.status, v.reason]), [
    ['gcp', 'off', 'no-table'],
    ['cloudflare', 'off', 'no-token'],
    ['github', 'off', 'no-owner'],
    ['aistudio', 'off', 'via-gcp'],
    ['openrouter', 'off', 'no-key'],
    ['fal', 'off', 'no-key'],
    ['replicate', 'off', 'manual'],
    ['sentry', 'off', 'manual'],
    ['clerk', 'off', 'manual'],
  ]);
  assert.equal(off.total.thisMonth, null);

  const loading = buildCosts({ vendors: { gcp: { key: 'k', refreshing: true, progress: { done: 3, total: 110 } } } }, {}, { now: NOW, setup });
  assert.equal(vendorOf(loading, 'gcp').status, 'loading');
  assert.deepEqual(vendorOf(loading, 'gcp').progress, { done: 3, total: 110 });

  const denied = gcpRaw({ 'Compute Engine': [100, 0] }, { status: 'forbidden', message: 'needs BigQuery Data Viewer', okAt: NOW - 20 * 3_600_000 });
  const d = vendorOf(buildCosts({ vendors: { gcp: denied } }, {}, { now: NOW, setup }), 'gcp');
  assert.equal(d.status, 'forbidden');
  assert.equal(d.stale, true);
  assert.equal(d.totals.thisMonth, 100, 'the last numbers stay, marked stale');
  assert.equal(d.dataset, 'billing_export');
  assert.equal(d.email, setup.email);
  assert.equal(vendorOf(buildCosts({ vendors: { gcp: gcpRaw({}) } }, {}, { now: NOW, setup }), 'gcp').stale, false);
});

test('Settings → Costs: checked and cleaned, with plain messages', () => {
  const s = cleanCostsSettings({ bigQueryTable: ' flobi-billing:billing_export.gcp_billing_export_v1_01A2B3_C4D5E6_F7A8B9 ', github: { owner: 'https://github.com/4ow4-Developers', seatPrice: '4', seatCurrency: 'usd' }, rates: { eur: '1.08', GBP: '' }, currency: 'usd' }, {}, NOW);
  assert.equal(s.bigQueryTable, 'flobi-billing.billing_export.gcp_billing_export_v1_01A2B3_C4D5E6_F7A8B9');
  assert.deepEqual(s.github, { owner: '4ow4-Developers', kind: 'org', seatPrice: 4, seatCurrency: 'USD' });
  assert.deepEqual(s.rates, { EUR: 1.08 });
  assert.equal(s.currency, 'USD');
  assert.throws(() => cleanCostsSettings({ bigQueryTable: 'SELECT * FROM x' }), /project\.dataset\.table/);
  assert.throws(() => cleanCostsSettings({ github: { owner: 'a b' } }), /letters, numbers and single hyphens/);
  assert.throws(() => cleanCostsSettings({ github: { seatPrice: 'four' } }), /price per seat/);
  assert.throws(() => cleanCostsSettings({ items: [{ vendor: '', amount: 5 }] }), /needs a vendor/);
  assert.throws(() => cleanCostsSettings({ items: [{ vendor: 'Sentry', amount: '' }] }), /Sentry: the amount/);
  assert.throws(() => cleanCostsSettings({ items: [{ vendor: 'Sentry', amount: 26, date: '2026-02-30' }] }), /the date looks like/);
  assert.throws(() => cleanCostsSettings({ rates: { EUR: -1 } }), /EUR rate/);
  // An item keeps the day it was first added; a new one gets today.
  const first = cleanCostsSettings({ items: [{ vendor: 'Sentry', item: 'Team', amount: '26', currency: 'usd', cycle: 'monthly' }] }, {}, NOW);
  const id = first.items[0].id;
  assert.deepEqual({ ...first.items[0], id: 'x' }, { id: 'x', vendor: 'Sentry', item: 'Team', amount: 26, currency: 'USD', cycle: 'monthly', date: '', note: '', addedAt: NOW });
  const later = cleanCostsSettings({ items: [{ ...first.items[0], amount: 29, addedAt: 1 }] }, first, NOW + 86_400_000);
  assert.deepEqual([later.items[0].id, later.items[0].amount, later.items[0].addedAt], [id, 29, NOW]);
  assert.equal(cleanCostsSettings({ items: [{ vendor: 'X', amount: 1, cycle: 'daily' }] }).items[0].cycle, 'monthly');
  // Only what's in the patch changes.
  assert.equal(cleanCostsSettings({ currency: '' }, s).bigQueryTable, s.bigQueryTable);
});

test('demo costs build a full page: every vendor, both months, a projection and a trend', () => {
  const d = demoCosts(NOW);
  const m = buildCosts(d.data, d.settings, { now: NOW, setup: d.setup, mode: 'demo' });
  assert.deepEqual(m.vendors.map((v) => [v.id, v.status]), [['gcp', 'ok'], ['cloudflare', 'ok'], ['github', 'ok'], ['aistudio', 'ok'], ['openrouter', 'ok'], ['fal', 'ok'], ['replicate', 'ok'], ['sentry', 'ok'], ['clerk', 'ok'], ['other', 'ok']]);
  assert.ok(m.total.thisMonth > 300 && m.total.lastMonth > m.total.thisMonth && m.total.projected > m.total.thisMonth, JSON.stringify(m.total));
  assert.deepEqual(m.missingRates, []);
  assert.equal(m.total.lastMonthPartial, false);
  assert.ok(vendorOf(m, 'gcp').showTrend && vendorOf(m, 'cloudflare').showTrend && vendorOf(m, 'github').showTrend);
  assert.equal(vendorOf(m, 'sentry').showTrend, false);
  // Clerk has no billing API: its own section, from what's typed in (not under Other).
  const clerk = vendorOf(m, 'clerk');
  assert.deepEqual(clerk.lines.map((l) => [l.name, l.cycle]), [['Pro plan', 'monthly']]);
  assert.match(clerk.source, /Clerk has no billing API/);
  assert.equal(vendorOf(m, 'other').lines.some((l) => /clerk/i.test(l.vendor || '')), false);
});

// ── The poller ───────────────────────────────────────────────────────────────
function clock(t = NOW) {
  const c = { t, now: () => c.t };
  return c;
}
const reader = (key, fn) => ({ key, read: fn });
const settle = () => new Promise((r) => setImmediate(r));

test('poller: saved results come back after a restart (same account only) and wait until they’re due', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = clock();
  const reads = [];
  const saved = { vendors: { gcp: { key: 'bigquery:a', status: 'ok', months: { x: 1 }, okAt: NOW - POLL_MS / 2 }, github: { key: 'github:org:old', status: 'ok', okAt: NOW } }, history: { '2020-01': { a: 1 }, [CUR]: { k: { seats: { seats: 3 } } } } };
  const w = new CostsWatcher({ readers: { gcp: reader('bigquery:a', async () => (reads.push('gcp'), { status: 'ok' })), github: reader('github:org:new', async () => (reads.push('github'), { status: 'ok' })) }, saved, now: c.now, startDelayMs: 1000 });
  assert.deepEqual(w.vendors.gcp.months, { x: 1 }, 'same table: restored');
  assert.equal(w.vendors.github, undefined, 'another organization: not shown as this one');
  assert.deepEqual(Object.keys(w.history), [CUR], 'history older than 13 months is dropped');
  w.start();
  t.mock.timers.tick(1000);
  await settle();
  assert.deepEqual(reads.sort(), ['gcp', 'github'], 'something was missing: read soon');
  w.stop();

  // Everything recent: wait until the oldest one is 6 hours old.
  const fresh = new CostsWatcher({ readers: { gcp: reader('bigquery:a', async () => (reads.push('again'), { status: 'ok' })) }, saved, now: c.now, startDelayMs: 1000 });
  fresh.start();
  assert.equal(fresh.nextPollAt, NOW + POLL_MS / 2);
  t.mock.timers.tick(POLL_MS / 2 - 1);
  await settle();
  assert.ok(!reads.includes('again'));
  t.mock.timers.tick(1);
  await settle();
  assert.ok(reads.includes('again'));
  fresh.stop();
});

test('poller: Refresh at most once a minute; a failed read keeps the last numbers and says why', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = clock();
  let fail = false;
  const saves = [];
  const w = new CostsWatcher({
    readers: {
      cloudflare: reader('cloudflare:x', async () => {
        if (fail) throw Object.assign(new Error('The Cloudflare token can’t read billing.'), { code: 'forbidden' });
        return { status: 'ok', subscriptions: [{ id: 'p', name: 'Pro', price: 25, frequency: 'monthly', charged: true }] };
      }),
    },
    now: c.now,
    onSave: (s) => saves.push(s),
  });
  assert.deepEqual(w.refresh(), { started: true });
  assert.equal(w.refresh().reason, 'running');
  await settle();
  assert.equal(w.vendors.cloudflare.status, 'ok');
  assert.deepEqual(w.history[CUR]['cloudflare:x'].subs.map((s) => s.name), ['Pro'], 'this month’s plans remembered');
  assert.equal(w.refresh().reason, 'cooldown');
  assert.equal(w.refresh().retryInMs, COOLDOWN_MS);
  c.t += COOLDOWN_MS;
  fail = true;
  assert.deepEqual(w.refresh(), { started: true });
  await settle();
  const v = w.vendors.cloudflare;
  assert.deepEqual([v.status, v.okAt, v.subscriptions.length], ['forbidden', NOW, 1]);
  assert.match(v.message, /can’t read billing/);
  assert.equal(saves.at(-1).vendors.cloudflare.refreshing, undefined, 'saved without the run-time flags');
  // A network error code isn't a status of its own.
  c.t += COOLDOWN_MS;
  w.readers.cloudflare.read = async () => {
    throw Object.assign(new Error('getaddrinfo ENOTFOUND api.cloudflare.com'), { code: 'ENOTFOUND' });
  };
  w.refresh();
  await settle();
  assert.equal(w.vendors.cloudflare.status, 'error');
  w.stop();
  assert.equal(w.refresh().reason, 'off');
});

test('poller: a new month is read a few minutes after it begins, not up to 6 hours later', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const late = new Date(2026, 8, 30, 23, 0).getTime();
  const w = new CostsWatcher({ readers: { gcp: reader('k', async () => ({ status: 'ok' })) }, now: () => late });
  w.schedule(POLL_MS);
  assert.equal(w.nextPollAt, new Date(2026, 9, 1, 0, 5).getTime());
  w.stop();
});

test('GitHub seats: no line until a seat count was seen (only owners see it)', () => {
  const raw = { key: 'github:org:x', status: 'ok', okAt: NOW, months: { [CUR]: { USD: { lines: { Actions: 1 } } } }, read: { [CUR]: NOW }, seats: null, seatsNote: 'GitHub only shows the plan (seats) to owners of the organization.' };
  const m = buildCosts({ vendors: { github: raw } }, { github: { seatPrice: 4 } }, { now: NOW, setup });
  assert.deepEqual(vendorOf(m, 'github').lines.map((l) => l.name), ['Actions']);
  assert.match(vendorOf(m, 'github').seatsNote, /owners/);
});

test('poller: stopped during a read, nothing is shown or saved', async () => {
  let release;
  const saves = [];
  const w = new CostsWatcher({ readers: { gcp: reader('k', () => new Promise((r) => (release = r))) }, onSave: (s) => saves.push(s) });
  w.refresh();
  await settle();
  w.stop();
  release({ status: 'ok', months: {} });
  await settle();
  assert.equal(w.vendors.gcp.okAt, undefined);
  assert.equal(saves.length, 0);
});
