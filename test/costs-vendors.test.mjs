// Cloudflare and GitHub billing for the Costs page: plans, usage per month, seats, and clear
// messages when a token lacks the billing permission. Every request passes the real guard.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CloudflareBillingReader, parseSubscription, usageMonth, NEEDS_BILLING_READ } from '../electron/core/sources/cloudflare-billing.mjs';
import { GitHubBillingReader, productName, summarizeUsage } from '../electron/core/sources/github-billing.mjs';
import { checkRequest, configureGuard, resetGuard } from '../electron/core/net/guard.mjs';
import { HttpError } from '../electron/core/net/http.mjs';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const ZONE = 'fedcba9876543210fedcba9876543210';
const TOKEN = 'cf-billing-token-0123456789abcdef';
const GH_TOKEN = 'github_pat_11ABCDEFG0123456789abcdef';
const MONTHS = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
const NOW = Date.UTC(2026, 8, 28, 12);

beforeEach(() => {
  resetGuard();
  configureGuard({ billing: null });
});

/** A fake Cloudflare API. answer(path) → body, or throws. Zone IDs reach the guard through allowZones. */
function fakeCloudflare(answer) {
  const calls = [];
  const request = async ({ url, headers, method = 'GET' }) => {
    checkRequest({ method, url, headers });
    const path = url.replace('https://api.cloudflare.com/client/v4', '');
    calls.push(path);
    return answer(path);
  };
  configureGuard({ billing: { cloudflareAccount: ACCOUNT } });
  const reader = new CloudflareBillingReader({ token: TOKEN, accountId: ACCOUNT, zones: ['flobi.ai'], request, allowZones: (ids) => configureGuard({ billing: { cloudflareZones: ids } }) });
  return { calls, reader };
}

const zoneList = { success: true, result: [{ id: ZONE, name: 'flobi.ai', status: 'active', plan: { name: 'Pro Website' }, account: { id: ACCOUNT } }, { id: 'a'.repeat(32), name: 'other.dev', status: 'active' }] };
const proPlan = { id: 'sub-zone', currency: 'USD', price: 25, frequency: 'monthly', state: 'Paid', current_period_end: '2026-10-03T00:00:00Z', rate_plan: { id: 'pro', public_name: 'Pro Plan', currency: 'USD' } };
const usageRows = [
  { ServiceName: 'Workers Standard', ContractedCost: 1.25, BillingCurrency: 'USD', ChargePeriodStart: '2026-09-26T00:00:00Z', ChargePeriodEnd: '2026-09-27T00:00:00Z' },
  { ServiceName: 'Workers Standard', ContractedCost: 0.75, BillingCurrency: 'USD', ChargePeriodStart: '2026-09-27T00:00:00Z', ChargePeriodEnd: '2026-09-28T00:00:00Z' },
  { ServiceName: 'R2 Storage', EffectiveCost: '0.4', BillingCurrency: 'USD', ChargePeriodStart: '2026-09-02T00:00:00Z', ChargePeriodEnd: '2026-09-03T00:00:00Z' },
  { ServiceName: 'R2 Storage', ContractedCost: 9, BillingCurrency: 'USD', ChargePeriodStart: '2026-08-31T00:00:00Z', ChargePeriodEnd: '2026-09-01T00:00:00Z' }, // August's
];

test('Cloudflare plans: price per cycle, charged or not by state, zone names attached', () => {
  const p = parseSubscription(proPlan, { id: ZONE, name: 'flobi.ai' });
  assert.deepEqual([p.name, p.zone, p.price, p.frequency, p.charged, p.currency], ['Pro Plan', 'flobi.ai', 25, 'monthly', true, 'USD']);
  assert.equal(parseSubscription({ ...proPlan, state: 'Trial' }).charged, false);
  assert.equal(parseSubscription({ ...proPlan, state: 'Cancelled' }).charged, false);
  assert.equal(parseSubscription({ ...proPlan, state: 'AwaitingPayment' }).charged, true);
  assert.equal(parseSubscription({ ...proPlan, frequency: 'not-applicable' }).frequency, null);
  assert.equal(parseSubscription({ rate_plan: { id: 'business' } }).name, 'Business');
});

test('Cloudflare usage: rows counted in the month their charge period starts, per service', () => {
  const m = usageMonth(usageRows, '2026-09');
  assert.deepEqual(m.USD.lines, { 'Workers Standard': 2, 'R2 Storage': 0.4 });
  assert.equal(m.USD.through, Date.parse('2026-09-28T00:00:00Z'));
  assert.deepEqual(usageMonth(usageRows, '2026-08').USD.lines, { 'R2 Storage': 9 });
  assert.deepEqual(usageMonth(null, '2026-09'), {});
});

test('Cloudflare: account plans, the set zones’ plans (each once), usage for six months, then only what changes', async () => {
  const { calls, reader } = fakeCloudflare((path) => {
    if (path === `/accounts/${ACCOUNT}/subscriptions`) return { success: true, result: [{ ...proPlan, zone: { id: ZONE, name: 'flobi.ai' } }, { id: 'sub-workers', price: 5, currency: 'USD', frequency: 'monthly', state: 'Paid', rate_plan: { public_name: 'Workers Paid' } }] };
    if (path.startsWith('/zones?')) return zoneList;
    if (path === `/zones/${ZONE}/subscription`) return { success: true, result: proPlan };
    if (path.startsWith(`/accounts/${ACCOUNT}/billable-usage?`)) return { success: true, result: usageRows };
    throw new Error(`unexpected ${path}`);
  });
  const res = await reader.read({ months: MONTHS, now: NOW });
  assert.deepEqual(res.subscriptions.map((s) => [s.name, s.price]), [['Pro Plan', 25], ['Workers Paid', 5]]);
  assert.ok(!calls.includes(`/zones/${'a'.repeat(32)}/subscription`), 'only the zones set in Settings');
  assert.equal(calls.filter((c) => c.includes('billable-usage')).length, 6);
  assert.ok(calls.includes(`/accounts/${ACCOUNT}/billable-usage?from=2026-09-01&to=2026-09-30`));
  assert.deepEqual(res.usage.months['2026-09'].USD.lines, { 'Workers Standard': 2, 'R2 Storage': 0.4 });
  assert.equal(res.usage.status, 'ok');
  // Next time: only this month (it's past the 10th, so last month is final).
  calls.length = 0;
  const again = await reader.read({ months: MONTHS, now: NOW + 6 * 3_600_000, previous: res });
  assert.deepEqual(calls.filter((c) => c.includes('billable-usage')), [`/accounts/${ACCOUNT}/billable-usage?from=2026-09-01&to=2026-09-30`]);
  assert.deepEqual(again.usage.months['2026-08'].USD.lines, { 'R2 Storage': 9 }, 'earlier months kept');
});

test('Cloudflare without Billing: Read says which permission to add; usage-based billing missing is just a note', async () => {
  const denied = () => {
    throw new HttpError(403, 'HTTP 403 – Authentication error', '{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}');
  };
  const none = fakeCloudflare((path) => (path.startsWith('/zones?') ? zoneList : denied()));
  await assert.rejects(none.reader.read({ months: MONTHS, now: NOW }), (e) => e.code === 'forbidden' && e.message === NEEDS_BILLING_READ && !e.message.includes(TOKEN));

  const noUsage = fakeCloudflare((path) => {
    if (path.startsWith('/zones?')) return zoneList;
    if (path.includes('billable-usage')) throw new HttpError(404, 'HTTP 404 – Route not found', '');
    return { success: true, result: path.endsWith('/subscriptions') ? [] : proPlan };
  });
  const res = await noUsage.reader.read({ months: MONTHS, now: NOW });
  assert.equal(res.status, 'ok');
  assert.equal(res.subscriptions.length, 1);
  assert.equal(res.usage.status, 'unavailable');
  assert.match(res.usage.message, /self-serve accounts/);

  const noAccount = new CloudflareBillingReader({ token: TOKEN, zones: ['flobi.ai'], request: async () => zoneList });
  assert.equal((await noAccount.readUsage(MONTHS, NOW, null, () => false)).status, 'off');
});

test('Cloudflare errors never show the token', async () => {
  const { reader } = fakeCloudflare((path) => {
    if (path.startsWith('/zones?')) return zoneList;
    throw new HttpError(500, `HTTP 500 – upstream saw Authorization: Bearer ${TOKEN}`, '');
  });
  const res = await reader.read({ months: MONTHS, now: NOW });
  assert.ok(!JSON.stringify(res).includes(TOKEN));
});

/** A fake GitHub API: answer(path) → { status, body, headers }. */
function fakeGitHub(answer, kind = 'org', owner = '4ow4-Developers') {
  const calls = [];
  configureGuard({ billing: { github: { kind, owner } } });
  const request = async ({ url, headers }) => {
    checkRequest({ url, headers });
    const path = url.replace('https://api.github.com', '');
    calls.push(path);
    const { status = 200, body = '', headers: h = {} } = answer(path, headers) || {};
    return { status, headers: h, body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) };
  };
  return { calls, reader: new GitHubBillingReader({ token: GH_TOKEN, owner, kind, request }) };
}

const summary = (items) => ({ timePeriod: { year: 2026, month: 9 }, organization: '4ow4-Developers', usageItems: items });

test('GitHub usage: net amounts (after the free allowances) per product', () => {
  const s = summarizeUsage([
    { product: 'actions', sku: 'actions_linux', grossAmount: 12.4, discountAmount: 8, netAmount: 4.4 },
    { product: 'actions', sku: 'actions_macos', grossAmount: 3, discountAmount: 0, netAmount: 3 },
    { product: 'git_lfs', sku: 'git_lfs_storage', grossAmount: 1, discountAmount: 1, netAmount: 0 },
    { product: 'copilot', sku: 'copilot_for_business', grossAmount: 38, discountAmount: 0 },
  ]);
  assert.deepEqual(s.USD.lines, { Actions: 7.4, 'Git LFS': 0, Copilot: 38 });
  assert.equal(productName('some_new_thing'), 'Some New Thing');
});

test('GitHub: six months of usage summaries, then only this month; seats from the plan', async () => {
  const { calls, reader } = fakeGitHub((path) => {
    if (path.startsWith('/organizations/4ow4-Developers/settings/billing/usage/summary')) return { body: summary([{ product: 'actions', netAmount: path.endsWith('month=9') ? 4.4 : 2 }]), headers: { etag: '"s"' } };
    if (path === '/orgs/4ow4-Developers') return { body: { login: '4ow4-Developers', plan: { name: 'team', space: 976562499, private_repos: 999999, filled_seats: 6, seats: 6 } } };
    return { status: 404, body: { message: 'Not Found' } };
  });
  const res = await reader.read({ months: MONTHS, now: NOW });
  assert.equal(calls.filter((c) => c.includes('usage/summary')).length, 6);
  assert.ok(calls.includes('/organizations/4ow4-Developers/settings/billing/usage/summary?year=2026&month=9'));
  assert.deepEqual(res.months['2026-09'].USD.lines, { Actions: 4.4 });
  assert.deepEqual(res.months['2026-08'].USD.lines, { Actions: 2 });
  assert.deepEqual(res.seats, { plan: 'team', seats: 6, filled: 6 });
  calls.length = 0;
  await reader.read({ months: MONTHS, now: NOW, previous: res });
  assert.deepEqual(calls, ['/organizations/4ow4-Developers/settings/billing/usage/summary?year=2026&month=9', '/orgs/4ow4-Developers']);
});

test('GitHub: a token without Administration: Read says so; the plan hidden from non-owners is a note', async () => {
  const denied = fakeGitHub(() => ({ status: 403, body: { message: 'Resource not accessible by personal access token' } }));
  await assert.rejects(denied.reader.read({ months: MONTHS, now: NOW }), (e) => e.code === 'forbidden' && /Administration: Read-only \(organization permissions\)/.test(e.message) && !e.message.includes(GH_TOKEN));
  const user = fakeGitHub(() => ({ status: 404, body: { message: 'Not Found' } }), 'user', 'dana');
  await assert.rejects(user.reader.read({ months: MONTHS, now: NOW }), (e) => /Plan: Read-only/.test(e.message) && /resource owner must be dana/.test(e.message));
  const limited = fakeGitHub(() => ({ status: 403, headers: { 'x-ratelimit-remaining': '0' }, body: {} }));
  await assert.rejects(limited.reader.read({ months: MONTHS, now: NOW }), /hourly limit/);

  const member = fakeGitHub((path) => (path.startsWith('/orgs/') ? { body: { login: '4ow4-Developers' } } : { body: summary([]) }));
  const res = await member.reader.read({ months: MONTHS, now: NOW });
  assert.equal(res.seats, null);
  assert.match(res.seatsNote, /only shows the plan \(seats\) to owners/);
  // An older month GitHub no longer has is left empty, not an error.
  const old = fakeGitHub((path) => (path.includes('month=4') ? { status: 404, body: {} } : path.startsWith('/orgs/') ? { body: {} } : { body: summary([]) }));
  const r2 = await old.reader.read({ months: MONTHS, now: NOW });
  assert.equal(r2.status, 'ok');
  assert.equal(r2.read['2026-04'], undefined);
});
