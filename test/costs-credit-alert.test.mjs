// The low-credits alert (Settings → Costs → OpenRouter / fal): on or off and an amount; the
// Costs page marks the balance below it; the alert says how much is left and what to do, and
// clears once the balance is back above it; while it's on, the balance is checked every 30
// minutes between the 6-hourly reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanCostsSettings, buildCosts, lowCredits, lastMonths, CostsWatcher, BALANCE_MS, DEFAULT_COSTS } from '../electron/core/engine/costs.mjs';
import { evaluateConditions } from '../electron/core/engine/alerts.mjs';
import { OpenRouterBillingReader } from '../electron/core/sources/openrouter-billing.mjs';
import { FalBillingReader } from '../electron/core/sources/fal-billing.mjs';
import { CostsService } from '../electron/core/costs.mjs';
import { checkRequest, configureGuard, resetGuard } from '../electron/core/net/guard.mjs';
import os from 'node:os';

const NOW = new Date(2026, 8, 16, 12).getTime();
const DAY = 86_400_000;
const EMPTY_MODEL = { services: [], pods: [], nodes: [], scaling: [], jobs: { cronjobs: [] }, certificates: [] };
const vendorOf = (model, id) => model.vendors.find((v) => v.id === id);
const withKeys = { openrouter: { hasKey: true }, fal: { hasKey: true } };

/** OpenRouter as read on 16 Sep: $2 a day since 17 Aug, and the credits given. */
function openRouter(credits) {
  const days = {};
  for (let t = Date.UTC(2026, 7, 17); t <= Date.UTC(2026, 8, 15); t += DAY) days[new Date(t).toISOString().slice(0, 10)] = { 'anthropic/claude-sonnet-4.5': 2 };
  return { key: 'openrouter', status: 'ok', okAt: NOW, checkedAt: NOW, days, byok: {}, lastDay: '2026-09-15', credits, creditsNote: null };
}
const fal = (amount) => ({ key: 'fal', status: 'ok', okAt: NOW, checkedAt: NOW - 60_000, months: { '2026-09': { USD: { lines: { 'fal-ai/flux/dev': 30 } } } }, read: { '2026-09': NOW }, balance: { amount, currency: 'USD' }, balanceNote: null, account: 'flobi' });

test('settings: on with an amount, the amount kept when it’s turned off, plain messages otherwise', () => {
  assert.deepEqual(DEFAULT_COSTS.creditAlerts, { openrouter: { on: false, below: null }, fal: { on: false, below: null } });
  const s = cleanCostsSettings({ creditAlerts: { openrouter: { on: true, below: ' $20 ' } } }, {});
  assert.deepEqual(s.creditAlerts, { openrouter: { on: true, below: 20 }, fal: { on: false, below: null } });
  const off = cleanCostsSettings({ creditAlerts: { openrouter: { on: false } } }, s);
  assert.deepEqual(off.creditAlerts.openrouter, { on: false, below: 20 });
  const both = cleanCostsSettings({ creditAlerts: { fal: { on: true, below: '12.5' } } }, off);
  assert.deepEqual(both.creditAlerts, { openrouter: { on: false, below: 20 }, fal: { on: true, below: 12.5 } });
  assert.throws(() => cleanCostsSettings({ creditAlerts: { fal: { on: true, below: '' } } }, {}), /fal: type the amount to alert below/);
  assert.throws(() => cleanCostsSettings({ creditAlerts: { openrouter: { on: true, below: '-5' } } }, {}), /OpenRouter: the amount to alert below is a number above 0/);
  assert.throws(() => cleanCostsSettings({ creditAlerts: { openrouter: { below: 'twenty' } } }, {}), /a number above 0/);
  // Only what's in the patch changes; unknown vendors are ignored.
  const other = cleanCostsSettings({ currency: 'usd', creditAlerts: { replicate: { on: true, below: 5 } } }, both);
  assert.deepEqual(other.creditAlerts, both.creditAlerts);
  assert.equal(cleanCostsSettings({ items: [] }, both).creditAlerts.fal.below, 12.5);
});

test('the Costs page: below the amount it’s alerting; above it or off, it isn’t', () => {
  const settings = { creditAlerts: { openrouter: { on: true, below: 20 }, fal: { on: true, below: 25 } } };
  const m = buildCosts({ vendors: { openrouter: openRouter({ total: 100, used: 88 }), fal: fal(142) } }, settings, { now: NOW, setup: withKeys });
  const or = vendorOf(m, 'openrouter');
  assert.deepEqual([or.creditAlert, or.balance.amount, or.balance.alertBelow, or.balance.alerting], [{ below: 20 }, 12, 20, true]);
  assert.equal(vendorOf(m, 'fal').balance.alerting, false);
  const low = lowCredits(m);
  assert.equal(low.length, 1);
  const { perDay, daysLeft, ...rest } = low[0];
  assert.deepEqual(rest, { id: 'openrouter', name: 'OpenRouter', amount: 12, currency: 'USD', below: 20 });
  assert.ok(perDay > 1.9 && perDay < 2.1, String(perDay)); // $2 a day
  assert.ok(daysLeft >= 5 && daysLeft <= 6, String(daysLeft));
  // Off: nothing alerting, whatever the balance.
  const off = buildCosts({ vendors: { openrouter: openRouter({ total: 100, used: 99 }) } }, {}, { now: NOW, setup: withKeys });
  assert.equal(vendorOf(off, 'openrouter').balance.alerting, undefined);
  assert.deepEqual(lowCredits(off), []);
  // No key (or not read yet): nothing to alert on, but the setting shows.
  const noKey = buildCosts({}, settings, { now: NOW, setup: {} });
  assert.deepEqual([vendorOf(noKey, 'openrouter').creditAlert, vendorOf(noKey, 'openrouter').balance], [{ below: 20 }, undefined]);
  assert.deepEqual(lowCredits(noKey), []);
  assert.deepEqual(lowCredits(null), []);
});

test('the alert: how much is left and how long it lasts, what to do, and used up said as such', () => {
  const cond = (billingCredits) => evaluateConditions({ model: EMPTY_MODEL, traffic: null, uptime: [], database: null, cloudRun: [], cloudflare: null, errorRates: {}, billingCredits }).filter((c) => c.kind === 'costs');
  assert.deepEqual(cond([]), []);
  assert.deepEqual(cond(undefined), []);
  const [or] = cond([{ id: 'openrouter', name: 'OpenRouter', amount: 12.4, currency: 'USD', below: 20, perDay: 3.1, daysLeft: 4 }]);
  assert.equal(or.key, 'credits:openrouter');
  assert.equal(or.severity, 'warning');
  assert.equal(or.title, 'OpenRouter credits are below $20');
  assert.equal(or.detail, '$12.40 left, about 4 days at this month’s pace');
  assert.match(or.impact, /requests through OpenRouter fail/);
  assert.match(or.action, /OpenRouter → Credits/);
  assert.match(or.action, /back above \$20/);
  assert.deepEqual(or.view, { to: 'costs' });
  const [f] = cond([{ id: 'fal', name: 'fal', amount: 0, currency: 'USD', below: 25.5, perDay: 3.5, daysLeft: 0 }]);
  assert.equal(f.title, 'fal credits are used up');
  assert.equal(f.detail, '$0 left');
  assert.match(f.action, /fal → Billing/);
  assert.match(f.action, /\$25\.50/);
  const [eur] = cond([{ id: 'fal', name: 'fal', amount: 7, currency: 'EUR', below: 10, perDay: null, daysLeft: null }]);
  assert.equal(eur.detail, '7 EUR left');
});

test('between reads: the balance every 30 minutes while an alert is on, and not otherwise', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = NOW;
  const calls = [];
  let fails = false;
  const readers = {
    openrouter: { key: 'openrouter', read: async () => ({ status: 'ok' }), balance: async () => (calls.push('or'), fails ? Promise.reject(new Error('down')) : { credits: { total: 100, used: 90 + calls.length }, creditsNote: null }) },
    fal: { key: 'fal', read: async () => ({ status: 'ok' }), balance: async () => (calls.push('fal'), { balance: { amount: 40, currency: 'USD' }, balanceNote: null }) },
    gcp: { key: 'bigquery:x', read: async () => ({ status: 'ok' }) },
  };
  const saved = { vendors: { openrouter: { key: 'openrouter', status: 'ok', okAt: NOW - 3_600_000, credits: { total: 100, used: 50 } }, fal: { key: 'fal', status: 'ok', okAt: NOW - 3_600_000 } } };
  let changes = 0;
  const saves = [];
  const w = new CostsWatcher({ readers, saved, now: () => clock, onChange: () => changes++, onSave: (s) => saves.push(s) });
  const settle = () => new Promise((r) => setImmediate(r));
  w.setBalanceChecks(['openrouter', 'gcp']); // gcp has no balance: ignored
  assert.deepEqual(w.balanceIds, ['openrouter']);
  t.mock.timers.tick(2000); // just turned on: within seconds
  await settle();
  assert.deepEqual(calls, ['or']);
  assert.deepEqual(w.vendors.openrouter.credits, { total: 100, used: 91 });
  assert.equal(w.vendors.openrouter.balanceAt, clock);
  assert.ok(changes > 0 && saves.length > 0, 'shown and saved');
  // Then every 30 minutes; a failed check keeps the last balance.
  fails = true;
  t.mock.timers.tick(BALANCE_MS);
  await settle();
  assert.deepEqual(calls, ['or', 'or']);
  assert.deepEqual(w.vendors.openrouter.credits, { total: 100, used: 91 });
  // fal's turned on too: checked soon; the same list again changes nothing.
  fails = false;
  w.setBalanceChecks(['openrouter', 'fal']);
  w.setBalanceChecks(['fal', 'openrouter']);
  t.mock.timers.tick(2000);
  await settle();
  await settle();
  assert.deepEqual(calls.slice(2).sort(), ['fal', 'or']);
  assert.deepEqual(w.vendors.fal.balance, { amount: 40, currency: 'USD' });
  // All off: no more checks.
  w.setBalanceChecks([]);
  t.mock.timers.tick(BALANCE_MS * 3);
  await settle();
  assert.equal(calls.length, 4);
  // Never read yet: the full read brings it, not the balance check.
  const fresh = new CostsWatcher({ readers, saved: null, now: () => clock });
  fresh.setBalanceChecks(['openrouter']);
  t.mock.timers.tick(2000);
  await settle();
  assert.equal(calls.length, 4);
  fresh.stop();
  w.stop();
});

test('balance reads: OpenRouter’s credits and fal’s balance, through the guard', async () => {
  resetGuard();
  configureGuard({ billing: { openrouter: true, fal: true } });
  const answer = (body) => ({ status: 200, headers: {}, body: Buffer.from(JSON.stringify(body)) });
  const urls = [];
  const send = (body) => async ({ url, headers }) => (checkRequest({ method: 'GET', url, headers }), urls.push(url), answer(body));
  assert.deepEqual(await new OpenRouterBillingReader({ key: 'sk-or-v1-abcdefgh', request: send({ data: { total_credits: 50, total_usage: 41.5 } }) }).balance(), { credits: { total: 50, used: 41.5 }, creditsNote: null });
  assert.deepEqual(await new FalBillingReader({ key: 'k_1:s_2345678', request: send({ username: 'flobi', credits: { current_balance: 9.75, currency: 'USD' } }) }).balance(), { balance: { amount: 9.75, currency: 'USD' }, balanceNote: null, account: 'flobi' });
  assert.deepEqual(urls, ['https://openrouter.ai/api/v1/credits', 'https://api.fal.ai/v1/account/billing?expand=credits']);
  await assert.rejects(new OpenRouterBillingReader({ key: 'sk-or-v1-abcdefgh', request: send({ data: {} }) }).balance(), /didn’t say how many credits/);
  configureGuard({ billing: null });
});

test('service: the alerts that are on decide which balances are checked', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  resetGuard();
  const auth = { identity: { email: 'viewer@flobi-prod-2026.iam.gserviceaccount.com' }, getToken: async () => 't' };
  let data = {};
  const store = { get: () => data, update: async (p) => void (data = { ...data, ...p }) };
  const balance = async () => ({});
  const readers = () => ({ openrouter: { key: 'openrouter', read: async () => ({}), balance }, fal: { key: 'fal', read: async () => ({}), balance } });
  const s = new CostsService({ dir: os.tmpdir(), stateStore: store, onChange: () => {}, readers });
  const keys = { openrouterKey: 'sk-or-v1-abcdefgh', falKey: 'k_1:s_2345678' };
  s.update({ mode: 'live', auth, config: {}, settings: {}, ...keys });
  assert.deepEqual(s.watcher.balanceIds, []);
  const watcher = s.watcher;
  s.update({ mode: 'live', auth, config: {}, settings: { creditAlerts: { fal: { on: true, below: 10 } } }, ...keys });
  assert.equal(s.watcher, watcher, 'an alert setting doesn’t restart the readers');
  assert.deepEqual(s.watcher.balanceIds, ['fal']);
  s.update({ mode: 'live', auth, config: {}, settings: { creditAlerts: { fal: { on: false, below: 10 }, openrouter: { on: true, below: 5 } } }, ...keys });
  assert.deepEqual(s.watcher.balanceIds, ['openrouter']);
  s.stop();
  configureGuard({ billing: null });
});
