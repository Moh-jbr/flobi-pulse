// The AI vendors on the Costs page: OpenRouter (usage per day and model, credits) and fal (usage
// per month and endpoint, balance) read with keys the guard only lets read those two things;
// Google AI Studio's Gemini API taken out of the Google Cloud export (counted once); Replicate
// typed in. Unknown stays "—": an OpenRouter month that began before the first read (it keeps 30
// days) is never a part of it passed off as the whole.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { checkRequest, configureGuard, resetGuard, ReadOnlyViolation } from '../electron/core/net/guard.mjs';
import { OpenRouterBillingReader, activityDays, mergeDays } from '../electron/core/sources/openrouter-billing.mjs';
import { FalBillingReader, usageMonths } from '../electron/core/sources/fal-billing.mjs';
import { buildCosts, cleanApiKey, lastMonths, LOW_BALANCE_DAYS } from '../electron/core/engine/costs.mjs';
import { CostsService } from '../electron/core/costs.mjs';

const OR = 'https://openrouter.ai/api/v1';
const FAL = 'https://api.fal.ai/v1';
const NOW = new Date(2026, 8, 16, 12).getTime(); // 16 Sep 2026, local time
const MONTHS = lastMonths(NOW);
const [PREV, CUR] = MONTHS.slice(-2);
const LONG_AGO = new Date(2026, 2, 1).getTime();
const DAY = 86_400_000;
const round = (n) => (n == null ? n : Math.round(n * 100) / 100);
const vendorOf = (model, id) => model.vendors.find((v) => v.id === id);
const lineOf = (model, id, name) => vendorOf(model, id).lines.find((l) => l.name === name);

const allowed = (url, method = 'GET', extra = {}) => assert.equal(checkRequest({ method, url, headers: { authorization: 'Bearer x' }, ...extra }), true, `${method} ${url}`);
const blocked = (url, method = 'GET', extra = {}) => assert.throws(() => checkRequest({ method, url, ...extra }), ReadOnlyViolation, `${method} ${url}`);

beforeEach(() => {
  resetGuard();
  configureGuard({ billing: null, projectId: 'flobi-prod-2026' });
});

/** Every UTC day from `from` to `to` (inclusive), as 'YYYY-MM-DD'. */
function dayRange(from, to) {
  const out = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** A fake transport: what's sent must pass the guard, answers come from `routes` (path → answer). */
function transport(routes, calls = []) {
  return async ({ url, headers = {} }) => {
    checkRequest({ method: 'GET', url, headers });
    calls.push({ url, headers });
    const u = new URL(url);
    const answer = routes[u.pathname];
    if (answer === undefined) throw new Error(`unexpected ${url}`);
    const r = typeof answer === 'function' ? answer(u) : answer;
    if (r instanceof Error) throw r;
    const { status = 200, body = r } = r?.status ? r : {};
    return { status, headers: {}, body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) };
  };
}

// ── The guard ────────────────────────────────────────────────────────────────
test('guard, OpenRouter: nothing until a key is set, then usage (activity) and credits, GET only', () => {
  blocked(`${OR}/activity`);
  blocked(`${OR}/credits`);
  configureGuard({ billing: { openrouter: true } });
  allowed(`${OR}/activity`);
  allowed(`${OR}/activity?date=2026-09-27`);
  allowed(`${OR}/credits`);
  // What a management key could also do: never.
  blocked(`${OR}/keys`);
  blocked(`${OR}/keys`, 'POST', { body: '{"name":"x"}' });
  blocked(`${OR}/keys/abc123`, 'PATCH', { body: '{"disabled":true}' });
  blocked(`${OR}/keys/abc123`, 'DELETE');
  blocked(`${OR}/key`);
  blocked(`${OR}/chat/completions`, 'POST', { body: '{}' });
  blocked(`${OR}/credits/coinbase`, 'POST', { body: '{}' });
  blocked(`${OR}/activity`, 'POST', { body: '{}' });
  blocked(`${OR}/credits`, 'DELETE');
  // Only the day as a query; no filters, no other paths, no tricks.
  blocked(`${OR}/activity?date=2026-09-27&api_key_hash=abc`);
  blocked(`${OR}/activity?group_by=workspace`);
  blocked(`${OR}/credits?x=1`);
  blocked(`${OR}/%61ctivity`);
  blocked(`${OR}/keys/../activity`);
  blocked('https://openrouter.ai/api/v1//activity');
  blocked('https://openrouter.ai/api/v2/activity');
  blocked('https://api.openrouter.ai/api/v1/activity');
  blocked(`${OR}/activity`, 'GET', { headers: { 'X-HTTP-Method-Override': 'DELETE' } });
});

test('guard, fal: nothing until a key is set, then usage and the balance, GET only', () => {
  blocked(`${FAL}/models/usage`);
  blocked(`${FAL}/account/billing?expand=credits`);
  configureGuard({ billing: { fal: true } });
  allowed(`${FAL}/models/usage?start=2026-04-01&timeframe=month&expand=time_series`);
  allowed(`${FAL}/models/usage?start=2026-04-01&timeframe=month&expand=time_series&cursor=Y3Vyc29y`);
  allowed(`${FAL}/account/billing?expand=credits`);
  allowed(`${FAL}/account/billing`);
  // Filters by key or person aren't needed; nothing else an Admin key can do is reachable.
  blocked(`${FAL}/models/usage?start=2026-04-01&api_key_id=k1`);
  blocked(`${FAL}/models/usage?login_username=dana`);
  blocked(`${FAL}/models/usage`, 'POST', { body: '{}' });
  blocked(`${FAL}/account/billing`, 'POST', { body: '{}' });
  blocked(`${FAL}/keys`);
  blocked(`${FAL}/keys`, 'POST', { body: '{}' });
  blocked(`${FAL}/keys/k1`, 'DELETE');
  blocked(`${FAL}/models/requests/by-endpoint?endpoint_id=fal-ai/flux/dev`);
  blocked(`${FAL}/models/%75sage`);
  blocked(`${FAL}/models/../keys`);
  blocked('https://fal.run/fal-ai/flux/dev', 'POST', { body: '{"prompt":"x"}' });
  blocked('https://queue.fal.run/fal-ai/flux/dev', 'POST', { body: '{"prompt":"x"}' });
  blocked('https://rest.alpha.fal.ai/tokens/', 'POST', { body: '{}' });
});

test('guard: the keys’ rules survive a connector restart, close with billing: null, and only true opens them', () => {
  configureGuard({ billing: { openrouter: true, fal: true } });
  resetGuard();
  allowed(`${OR}/credits`);
  allowed(`${FAL}/account/billing?expand=credits`);
  configureGuard({ billing: { openrouter: false } });
  blocked(`${OR}/credits`);
  allowed(`${FAL}/account/billing`, 'GET');
  configureGuard({ billing: null });
  blocked(`${FAL}/account/billing`);
  configureGuard({ billing: { openrouter: 'yes', fal: 1 } });
  blocked(`${OR}/credits`);
  blocked(`${FAL}/account/billing`);
});

// ── OpenRouter ───────────────────────────────────────────────────────────────
const AT = Date.UTC(2026, 8, 28, 9); // 28 Sep 2026, 09:00 UTC

test('OpenRouter reader: the last 30 whole days per model, every one of them known, BYOK apart, today left out', () => {
  const rows = [
    { date: '2026-09-27', model: 'anthropic/claude-sonnet-4.5', usage: 1.5, byok_usage_inference: 0, requests: 10 },
    { date: '2026-09-27', model: 'anthropic/claude-sonnet-4.5', provider_name: 'Google', usage: 0.5 }, // another provider: added up
    { date: '2026-09-27', model: 'openai/gpt-5-mini', usage: 0.25, byok_usage_inference: 2 },
    { date: '2026-09-01', model: 'openai/gpt-5-mini', usage: 0.1 },
    { date: '2026-09-28', model: 'openai/gpt-5-mini', usage: 9 }, // today isn't over
    { date: '2026-09-10', model: 'meta-llama/llama-3.3-70b-instruct:free', usage: 0 }, // free: nothing to count
    { date: 'yesterday', model: 'x', usage: 5 },
  ];
  const { days, byok } = activityDays(rows, AT);
  assert.deepEqual(Object.keys(days), dayRange('2026-08-29', '2026-09-27'));
  assert.deepEqual(days['2026-09-27'], { 'anthropic/claude-sonnet-4.5': 2, 'openai/gpt-5-mini': 0.25 });
  assert.deepEqual(days['2026-09-01'], { 'openai/gpt-5-mini': 0.1 });
  assert.deepEqual(days['2026-09-10'], {});
  assert.equal(days['2026-09-28'], undefined);
  assert.deepEqual(byok, { '2026-09-27': 2 });
});

test('OpenRouter reader: new days replace old ones, a day with usage never turns empty, days before the months shown go', () => {
  const merged = mergeDays({ '2026-03-31': { a: 5 }, '2026-08-20': { a: 1 }, '2026-08-29': { a: 2 }, '2026-08-30': { a: 1 } }, { '2026-08-29': {}, '2026-08-30': { b: 3 }, '2026-08-31': {} }, '2026-04');
  assert.deepEqual(merged, { '2026-08-20': { a: 1 }, '2026-08-29': { a: 2 }, '2026-08-30': { b: 3 }, '2026-08-31': {} });
});

test('OpenRouter reader: one read = activity and credits with the key, through the guard; kept days come along', async () => {
  configureGuard({ billing: { openrouter: true } });
  const calls = [];
  const reader = new OpenRouterBillingReader({
    key: 'sk-or-v1-0123456789abcdef',
    request: transport({ '/api/v1/activity': { data: [{ date: '2026-09-27', model: 'openai/gpt-5-mini', usage: 1.25, byok_usage_inference: 0.5 }] }, '/api/v1/credits': { data: { total_credits: 100.5, total_usage: 25.75 } } }, calls),
  });
  assert.equal(reader.key, 'openrouter');
  const previous = { days: { '2026-08-01': { 'openai/gpt-5-mini': 3 }, '2026-02-10': { x: 1 } }, byok: { '2026-08-01': 1 } };
  const r = await reader.read({ months: lastMonths(AT), now: AT, previous });
  assert.deepEqual(
    calls.map((c) => c.url),
    [`${OR}/activity`, `${OR}/credits`],
  );
  assert.equal(calls[0].headers.authorization, 'Bearer sk-or-v1-0123456789abcdef');
  assert.equal(r.days['2026-09-27']['openai/gpt-5-mini'], 1.25);
  assert.deepEqual(r.days['2026-08-01'], { 'openai/gpt-5-mini': 3 }, 'a day read before is kept');
  assert.equal(r.days['2026-02-10'], undefined, 'older than the months shown');
  assert.deepEqual(r.byok, { '2026-08-01': 1, '2026-09-27': 0.5 });
  assert.equal(r.lastDay, '2026-09-27');
  assert.deepEqual(r.credits, { total: 100.5, used: 25.75 });
  assert.equal(r.creditsNote, null);
});

test('OpenRouter reader: an ordinary API key is refused with what to use instead, and the key never shows', async () => {
  configureGuard({ billing: { openrouter: true } });
  const key = 'sk-or-v1-secretsecretsecret';
  const denied = new OpenRouterBillingReader({ key, request: transport({ '/api/v1/activity': { status: 403, body: { error: { message: 'Only management keys can perform this operation' } } } }) });
  await assert.rejects(denied.read({ months: MONTHS, now: AT }), (e) => e.code === 'forbidden' && /management key/.test(e.message) && !e.message.includes(key));
  const unreachable = new OpenRouterBillingReader({ key, request: transport({ '/api/v1/activity': new Error(`connect ECONNREFUSED (Authorization: Bearer ${key})`) }) });
  await assert.rejects(unreachable.read({ months: MONTHS, now: AT }), (e) => !e.message.includes(key));
  // The credits failing only leaves the balance out.
  const noCredits = new OpenRouterBillingReader({ key, request: transport({ '/api/v1/activity': { data: [] }, '/api/v1/credits': { status: 500, body: 'oops' } }) });
  const r = await noCredits.read({ months: MONTHS, now: AT });
  assert.equal(r.credits, null);
  assert.match(r.creditsNote, /500/);
});

/** OpenRouter as read on 16 Sep: every day from `from` to the 15th, $2 a day of one model. */
function openRouterRaw(from = '2026-08-17', extra = {}) {
  const days = Object.fromEntries(dayRange(from, '2026-09-15').map((d) => [d, { 'anthropic/claude-sonnet-4.5': 2 }]));
  days['2026-09-03']['openai/gpt-5-mini'] = 1;
  return { key: 'openrouter', status: 'ok', okAt: NOW, checkedAt: NOW, days, byok: { '2026-09-02': 1.5 }, lastDay: '2026-09-15', credits: { total: 100, used: 60 }, creditsNote: null, ...extra };
}
const withKeys = { openrouter: { hasKey: true }, fal: { hasKey: true } };

test('OpenRouter: this month from its days; a month that began before the first read is unknown, not a part of it', () => {
  const m = buildCosts({ vendors: { openrouter: openRouterRaw() } }, {}, { now: NOW, setup: withKeys });
  const or = vendorOf(m, 'openrouter');
  assert.equal(or.status, 'ok');
  assert.equal(lineOf(m, 'openrouter', 'anthropic/claude-sonnet-4.5').thisMonth, 30);
  assert.equal(lineOf(m, 'openrouter', 'openai/gpt-5-mini').thisMonth, 1);
  assert.equal(or.totals.thisMonth, 31);
  assert.equal(or.totals.lastMonth, null, 'August began before the first read (OpenRouter keeps 30 days)');
  assert.equal(or.lastDay, '2026-09-15');
  assert.equal(or.through, Date.UTC(2026, 8, 16), 'whole days: through the end of the 15th');
  assert.deepEqual([or.byok.thisMonth, or.byok.lastMonth], [1.5, null]);
  assert.equal(or.balance.amount, 40);
  assert.equal(or.projection.estimated, true);
  // Every day of August read (the app was running then): August is known.
  const whole = vendorOf(buildCosts({ vendors: { openrouter: openRouterRaw('2026-08-01') } }, {}, { now: NOW, setup: withKeys }), 'openrouter');
  assert.equal(whole.totals.lastMonth, 62);
  // A day missing (the app was off for more than 30 days): that month is unknown again.
  const gap = openRouterRaw('2026-08-01');
  delete gap.days['2026-08-05'];
  assert.equal(vendorOf(buildCosts({ vendors: { openrouter: gap } }, {}, { now: NOW, setup: withKeys }), 'openrouter').totals.lastMonth, null);
  // Not read for a few days: this month up to the last day read (and says so); a past month
  // only with all its days.
  const behind = openRouterRaw('2026-08-01');
  for (const d of dayRange('2026-09-11', '2026-09-15')) delete behind.days[d];
  behind.lastDay = '2026-09-10';
  const b = vendorOf(buildCosts({ vendors: { openrouter: behind } }, {}, { now: NOW, setup: withKeys }), 'openrouter');
  assert.deepEqual([b.totals.thisMonth, b.totals.lastMonth, b.through], [21, 62, Date.UTC(2026, 8, 11)]);
  const longAgo = openRouterRaw('2026-07-20');
  for (const d of dayRange('2026-08-11', '2026-09-15')) delete longAgo.days[d];
  longAgo.lastDay = '2026-08-10';
  const l = vendorOf(buildCosts({ vendors: { openrouter: longAgo } }, {}, { now: NOW, setup: withKeys }), 'openrouter');
  assert.deepEqual([l.totals.thisMonth, l.totals.lastMonth, l.through], [null, null, null], 'August only has 10 days read');
});

test('OpenRouter: the first of the month is $0 so far, not unknown; nothing spent shows $0; no key is "not set up"', () => {
  const first = new Date(2026, 8, 1, 12).getTime();
  const raw = { key: 'openrouter', status: 'ok', okAt: first, checkedAt: first, days: Object.fromEntries(dayRange('2026-08-02', '2026-08-31').map((d) => [d, {}])), byok: {}, lastDay: '2026-08-31', credits: null };
  const or = vendorOf(buildCosts({ vendors: { openrouter: raw } }, {}, { now: first, setup: withKeys }), 'openrouter');
  assert.deepEqual(or.lines.map((l) => [l.name, l.thisMonth]), [['Usage', 0]]);
  assert.equal(or.totals.thisMonth, 0);
  assert.equal(or.balance, null);
  const off = buildCosts({}, {}, { now: NOW, setup: {} });
  assert.deepEqual([vendorOf(off, 'openrouter').status, vendorOf(off, 'openrouter').reason], ['off', 'no-key']);
  assert.ok(off.notSetUp.includes('OpenRouter') && off.notSetUp.includes('fal'));
});

test('credits: how long they last at this pace, and "low" under a week or once used up', () => {
  const at = (credits) => vendorOf(buildCosts({ vendors: { openrouter: openRouterRaw('2026-08-17', { credits }) } }, {}, { now: NOW, setup: withKeys }), 'openrouter').balance;
  const plenty = at({ total: 100, used: 60 }); // $40 at about $2.07 a day
  assert.ok(plenty.perDay > 1.9 && plenty.perDay < 2.2, String(plenty.perDay));
  assert.ok(plenty.daysLeft >= 18 && plenty.daysLeft <= 20, String(plenty.daysLeft));
  assert.equal(plenty.low, false);
  const soon = at({ total: 100, used: 90 });
  assert.ok(soon.daysLeft < LOW_BALANCE_DAYS);
  assert.equal(soon.low, true);
  const out = at({ total: 50, used: 50 });
  assert.deepEqual([out.amount, out.daysLeft, out.low], [0, 0, true]);
  // No usage at all: nothing to run out of.
  const idle = openRouterRaw('2026-08-17', { credits: { total: 5, used: 0 } });
  idle.days = Object.fromEntries(Object.keys(idle.days).map((d) => [d, {}]));
  const b = vendorOf(buildCosts({ vendors: { openrouter: idle } }, {}, { now: NOW, setup: withKeys }), 'openrouter').balance;
  assert.deepEqual([b.amount, b.perDay, b.daysLeft, b.low], [5, null, null, false]);
});

// ── fal ──────────────────────────────────────────────────────────────────────
test('fal reader: every month shown by endpoint (every page), the balance and the account, with the key', async () => {
  configureGuard({ billing: { fal: true } });
  const calls = [];
  const months = lastMonths(AT);
  const pages = {
    first: {
      time_series: [
        {
          bucket: '2026-08-01T00:00:00+00:00',
          results: [
            { endpoint_id: 'fal-ai/flux/dev', unit: 'image', quantity: 40, unit_price: 0.025, cost_total: 0.8, currency: 'USD' },
            { endpoint_id: 'fal-ai/birefnet/v2', unit: 'image', quantity: 3, cost_total: 0, currency: 'USD' },
          ],
        },
      ],
      has_more: true,
      next_cursor: 'c2',
    },
    c2: {
      time_series: [
        {
          bucket: '2026-09-01T00:00:00+00:00',
          results: [
            { endpoint_id: 'fal-ai/flux/dev', cost_total: 0.5, currency: 'USD' },
            { endpoint_id: 'fal-ai/kling-video/v2.1/pro/image-to-video', cost_subtotal: 5.6, cost_discount: 0.7, cost_total: 4.9, cost: 4.9, currency: 'USD' },
          ],
        },
        { bucket: '2025-12-01T00:00:00+00:00', results: [{ endpoint_id: 'fal-ai/flux/dev', cost_total: 9, currency: 'USD' }] },
      ],
      has_more: false,
      next_cursor: null,
    },
  };
  const reader = new FalBillingReader({
    key: 'k_0123:s_4567',
    request: transport({ '/v1/models/usage': (u) => pages[u.searchParams.get('cursor') || 'first'], '/v1/account/billing': { username: 'flobi', credits: { current_balance: 24.5, currency: 'USD' } } }, calls),
  });
  const r = await reader.read({ months, now: AT });
  assert.equal(calls[0].headers.authorization, 'Key k_0123:s_4567');
  assert.equal(calls[0].url, `${FAL}/models/usage?start=${months[0]}-01&timeframe=month&expand=time_series`);
  assert.match(calls[1].url, /[?&]cursor=c2(&|$)/);
  assert.equal(calls[2].url, `${FAL}/account/billing?expand=credits`);
  assert.deepEqual(r.months['2026-09'], { USD: { lines: { 'fal-ai/flux/dev': 0.5, 'fal-ai/kling-video/v2.1/pro/image-to-video': 4.9 } } }, 'after the discount');
  assert.deepEqual(r.months['2026-08'], { USD: { lines: { 'fal-ai/flux/dev': 0.8, 'fal-ai/birefnet/v2': 0 } } });
  assert.equal(r.months['2025-12'], undefined, 'not a month shown');
  assert.deepEqual(Object.keys(r.read), months);
  assert.deepEqual(r.balance, { amount: 24.5, currency: 'USD' });
  assert.equal(r.account, 'flobi');
});

test('fal reader: a start further back than fal goes → this month only; an ordinary key → forbidden, never shown', async () => {
  configureGuard({ billing: { fal: true } });
  const months = lastMonths(AT);
  const reader = new FalBillingReader({
    key: 'k_0123:s_4567',
    request: transport({
      '/v1/models/usage': (u) => (u.searchParams.get('start') === `${months[0]}-01` ? { status: 400, body: { error: { message: 'start is too far back' } } } : { time_series: [{ bucket: '2026-09-01T00:00:00Z', results: [{ endpoint_id: 'fal-ai/flux/dev', cost_total: 2, currency: 'USD' }] }] }),
      '/v1/account/billing': { status: 403, body: { error: { message: 'Forbidden' } } },
    }),
  });
  const r = await reader.read({ months, now: AT });
  assert.deepEqual(Object.keys(r.read), ['2026-09']);
  assert.match(r.message, /older months are left out/);
  assert.equal(r.balance, null);
  assert.match(r.balanceNote, /Admin key/);
  const key = 'k_9999:s_secretsecret';
  const refused = new FalBillingReader({ key, request: transport({ '/v1/models/usage': { status: 401, body: `bad key ${key}` } }) });
  await assert.rejects(refused.read({ months, now: AT }), (e) => e.code === 'forbidden' && /Admin key/.test(e.message) && !e.message.includes(key));
  assert.deepEqual(usageMonths([{ bucket: 'soon', results: [{ cost_total: 1 }] }], new Set(months)), {});
});

test('fal: endpoints that cost something, months not read unknown, $0 when nothing was spent, and the balance', () => {
  const raw = { key: 'fal', status: 'ok', okAt: NOW, checkedAt: NOW - 60_000, months: { [CUR]: { USD: { lines: { 'fal-ai/flux/dev': 3, 'fal-ai/birefnet/v2': 0 } } }, [PREV]: { USD: { lines: { 'fal-ai/flux/dev': 9 } } } }, read: { [CUR]: NOW, [PREV]: NOW }, balance: { amount: 24.5, currency: 'USD' }, balanceNote: null, account: 'flobi' };
  const m = buildCosts({ vendors: { fal: raw } }, {}, { now: NOW, setup: withKeys });
  const fal = vendorOf(m, 'fal');
  assert.deepEqual(fal.lines.map((l) => [l.name, l.thisMonth, l.lastMonth, l.months[MONTHS[0]]]), [['fal-ai/flux/dev', 3, 9, null]]);
  assert.equal(fal.account, 'flobi');
  assert.equal(fal.through, NOW - 60_000);
  assert.equal(fal.balance.amount, 24.5);
  const idle = vendorOf(buildCosts({ vendors: { fal: { ...raw, months: {} } } }, {}, { now: NOW, setup: withKeys }), 'fal');
  assert.deepEqual(idle.lines.map((l) => [l.name, l.thisMonth, l.lastMonth]), [['Usage', 0, 0]]);
});

// ── Google AI Studio ─────────────────────────────────────────────────────────
const TABLE = 'flobi-billing.billing_export.gcp_billing_export_v1_01A2B3_C4D5E6_F7A8B9';
const setup = { email: 'viewer@flobi-prod-2026.iam.gserviceaccount.com', gcp: { table: TABLE }, cloudflare: { hasToken: false }, github: { hasToken: false } };
const gcpRaw = (lines, extra = {}) => ({
  key: `bigquery:${TABLE}`,
  status: 'ok',
  okAt: NOW - 3_600_000,
  checkedAt: NOW - 3_600_000,
  months: { [PREV]: { USD: { lines: { 'Compute Engine': [180, 0], 'Gemini API': [22, 0] }, through: new Date(2026, 8, 1).getTime() } }, [CUR]: { USD: { lines, through: new Date(2026, 8, 11).getTime() } } },
  complete: MONTHS,
  ...extra,
});

test('Google AI Studio: the export’s Gemini API lines move out of Google Cloud, so they’re counted once', () => {
  const items = [{ id: 'g', vendor: 'Google AI Studio', item: 'Second billing account', amount: 10, currency: 'USD', cycle: 'monthly', addedAt: LONG_AGO }];
  const m = buildCosts({ vendors: { gcp: gcpRaw({ 'Compute Engine': [100, 0], 'Gemini API': [40, -5] }) } }, { items }, { now: NOW, setup });
  const ai = vendorOf(m, 'aistudio');
  const gcp = vendorOf(m, 'gcp');
  assert.deepEqual(ai.lines.map((l) => l.name), ['Gemini API', 'Second billing account']);
  assert.deepEqual([lineOf(m, 'aistudio', 'Gemini API').thisMonth, lineOf(m, 'aistudio', 'Gemini API').lastMonth], [35, 22]);
  assert.equal(lineOf(m, 'aistudio', 'Gemini API').credits[CUR], -5);
  assert.equal(gcp.lines.some((l) => l.name === 'Gemini API'), false);
  assert.deepEqual([gcp.totals.thisMonth, gcp.totals.lastMonth], [100, 180]);
  assert.deepEqual([ai.totals.thisMonth, ai.totals.lastMonth], [45, 32]);
  assert.equal(round(m.total.thisMonth), 145);
  assert.deepEqual([ai.status, ai.okAt, ai.through], ['ok', gcp.okAt, gcp.through], 'the export’s status and freshness');
  // Its older name counts too.
  const legacy = buildCosts({ vendors: { gcp: gcpRaw({ 'Generative Language API': [3, 0] }) } }, {}, { now: NOW, setup });
  assert.equal(lineOf(legacy, 'aistudio', 'Generative Language API').thisMonth, 3);
});

test('Google AI Studio: none in the export is not "not set up"; no export is; a failing export fails it too', () => {
  const none = buildCosts({ vendors: { gcp: gcpRaw({ 'Compute Engine': [100, 0] }, { months: { [CUR]: { USD: { lines: { 'Compute Engine': [100, 0] }, through: NOW } } } }) } }, {}, { now: NOW, setup });
  assert.deepEqual([vendorOf(none, 'aistudio').status, vendorOf(none, 'aistudio').reason], ['off', 'none']);
  assert.ok(!none.notSetUp.includes('Google AI Studio'));
  const noExport = buildCosts({}, {}, { now: NOW, setup: { ...setup, gcp: { table: '' } } });
  assert.deepEqual([vendorOf(noExport, 'aistudio').status, vendorOf(noExport, 'aistudio').reason], ['off', 'via-gcp']);
  assert.ok(noExport.notSetUp.includes('Google AI Studio'));
  const denied = buildCosts({ vendors: { gcp: gcpRaw({ 'Gemini API': [4, 0] }, { status: 'forbidden', message: 'needs BigQuery Data Viewer' }) } }, {}, { now: NOW, setup });
  assert.equal(vendorOf(denied, 'aistudio').status, 'forbidden');
  assert.equal(vendorOf(denied, 'aistudio').totals.thisMonth, 4, 'the last numbers stay');
  const loading = buildCosts({ vendors: { gcp: { key: `bigquery:${TABLE}`, refreshing: true } } }, {}, { now: NOW, setup });
  assert.equal(vendorOf(loading, 'aistudio').status, 'loading');
});

// ── Typed in ─────────────────────────────────────────────────────────────────
test('typed in: Replicate has its own section; OpenRouter, fal and AI Studio items join theirs', () => {
  const items = [
    { id: 'r', vendor: 'Replicate', item: 'Monthly usage', amount: 35, currency: 'USD', cycle: 'monthly', addedAt: LONG_AGO },
    { id: 'o', vendor: 'openrouter', item: 'Top-up', amount: 20, currency: 'USD', cycle: 'one-time', date: '2026-09-05', addedAt: NOW },
    { id: 'f', vendor: 'fal.ai', item: 'Top-up', amount: 7, currency: 'USD', cycle: 'one-time', date: '2026-09-02', addedAt: NOW },
    { id: 'g', vendor: 'Gemini', item: 'Prepaid', amount: 5, currency: 'USD', cycle: 'monthly', addedAt: LONG_AGO },
    { id: 'e', vendor: 'ElevenLabs', item: 'Creator', amount: 22, currency: 'USD', cycle: 'monthly', addedAt: LONG_AGO },
  ];
  const m = buildCosts({}, { items }, { now: NOW, setup: {} });
  const rep = vendorOf(m, 'replicate');
  assert.deepEqual([rep.status, rep.totals.thisMonth], ['ok', 35]);
  assert.match(rep.source, /Replicate has no billing API/);
  assert.equal(lineOf(m, 'openrouter', 'Top-up').thisMonth, 20);
  assert.equal(lineOf(m, 'fal', 'Top-up').thisMonth, 7);
  assert.equal(lineOf(m, 'aistudio', 'Prepaid').thisMonth, 5);
  assert.deepEqual(vendorOf(m, 'other').lines.map((l) => l.vendor), ['ElevenLabs']);
  assert.equal(round(m.total.thisMonth), 35 + 20 + 7 + 5 + 22);
  // Without an item, Replicate asks for one (not "not set up").
  const off = vendorOf(buildCosts({}, {}, { now: NOW, setup: {} }), 'replicate');
  assert.deepEqual([off.status, off.reason], ['off', 'manual']);
});

test('keys as pasted: trimmed, "Bearer"/"Key" in front dropped, empty removes it, anything else refused', () => {
  assert.equal(cleanApiKey('  sk-or-v1-abc123def456  ', 'OpenRouter'), 'sk-or-v1-abc123def456');
  assert.equal(cleanApiKey('Bearer sk-or-v1-abcdefgh', 'OpenRouter'), 'sk-or-v1-abcdefgh');
  assert.equal(cleanApiKey('Key 1234abcd-ef56:7890ab', 'fal'), '1234abcd-ef56:7890ab');
  assert.equal(cleanApiKey('', 'fal'), null);
  assert.equal(cleanApiKey(null, 'fal'), null);
  assert.throws(() => cleanApiKey('sk-or v1 abc123', 'OpenRouter'), /an OpenRouter key/);
  assert.throws(() => cleanApiKey('abcdefgh\r\nx-evil: 1', 'fal'), /a fal key/);
  assert.throws(() => cleanApiKey('short', 'fal'), /a fal key/);
});

// ── Main-process side ────────────────────────────────────────────────────────
test('service: readers and guard rules only for the keys saved, rebuilt when a key changes, closed on sign-out', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const auth = { identity: { email: 'viewer@flobi-prod-2026.iam.gserviceaccount.com' }, getToken: async () => 't' };
  let data = {};
  const store = { get: () => data, update: async (p) => void (data = { ...data, ...p }) };
  const built = [];
  const sent = [];
  const s = new CostsService({ dir: os.tmpdir(), stateStore: store, onChange: (c) => sent.push(c), readers: (o) => (built.push([o.openrouterKey || null, o.falKey || null]), {}) });
  s.update({ mode: 'live', auth, config: {}, settings: {}, openrouterKey: 'sk-or-v1-abcdefgh' });
  assert.deepEqual(built, [['sk-or-v1-abcdefgh', null]]);
  allowed(`${OR}/credits`);
  blocked(`${FAL}/account/billing`);
  assert.equal(vendorOf(sent.at(-1), 'openrouter').status, 'loading');
  assert.equal(vendorOf(sent.at(-1), 'fal').reason, 'no-key');
  s.update({ mode: 'live', auth, config: {}, settings: {}, openrouterKey: 'sk-or-v1-abcdefgh' });
  assert.equal(built.length, 1, 'same keys: the readers stay');
  s.update({ mode: 'live', auth, config: {}, settings: {}, openrouterKey: 'sk-or-v1-abcdefgh', falKey: 'k_1:s_2345678' });
  assert.deepEqual(built.at(-1), ['sk-or-v1-abcdefgh', 'k_1:s_2345678']);
  allowed(`${FAL}/account/billing?expand=credits`);
  s.update({ mode: 'live', auth, config: {}, settings: {}, falKey: 'k_1:s_2345678' });
  blocked(`${OR}/credits`);
  s.update({ mode: 'signed-out' });
  blocked(`${FAL}/account/billing?expand=credits`);
  s.stop();
});
