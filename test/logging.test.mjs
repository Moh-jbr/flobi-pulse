import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LoggingClient, RATE_LIMITED_MESSAGE } from '../electron/core/sources/logging.mjs';
import { serviceFilter } from '../electron/core/engine/live.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A fake entries:list: records the order of calls; `fail` decides which answer 429.
function client({ fail = () => false, delay = 20 } = {}) {
  const calls = [];
  const c = new LoggingClient({
    projectId: 'p',
    getToken: async () => 't',
    minIntervalMs: 0,
    retryMs: 10,
    backoffMs: 80,
    request: async ({ body }) => {
      const { filter } = JSON.parse(body);
      calls.push(filter);
      await sleep(delay);
      if (fail(filter, calls)) throw Object.assign(new Error('HTTP 429'), { status: 429 });
      return { entries: [{ filter }] };
    },
  });
  return { c, calls };
}

test('a search someone clicked on goes before queued background reads', async () => {
  const { c, calls } = client();
  const bg = ['bg1', 'bg2', 'bg3'].map((f) => c.list({ filter: f }));
  await sleep(5); // bg1 is in flight
  const mine = c.list({ filter: 'click', priority: 'interactive' });
  await Promise.all([...bg, mine]);
  assert.deepEqual(calls, ['bg1', 'click', 'bg2', 'bg3']);
});

test('a rate-limited background read backs off without holding up a click', async () => {
  let limited = true;
  const { c, calls } = client({ fail: (f) => f === 'bg' && limited && !(limited = false) });
  const bg = c.list({ filter: 'bg' });
  await sleep(40); // bg got its 429 and is cooling down
  const t0 = Date.now();
  await c.list({ filter: 'click', priority: 'interactive' });
  assert.ok(Date.now() - t0 < 70, 'the click did not wait for the background back-off');
  await bg;
  assert.deepEqual(calls, ['bg', 'click', 'bg']);
});

test('a click that stays rate-limited fails with a clear message instead of spinning', async () => {
  const { c, calls } = client({ fail: () => true });
  await assert.rejects(c.list({ filter: 'click', priority: 'interactive' }), (e) => e.status === 429 && e.message === RATE_LIMITED_MESSAGE);
  assert.equal(calls.length, 2, 'one quick retry, then it gives up');
});

test('the service filter matches a workload’s pods, including replaced ones', () => {
  const f = serviceFilter('flobi-brand');
  const re = new RegExp(/pod_name=~"(.+)"\)$/.exec(f)[1]);
  assert.match(f, /container_name="flobi-brand"/);
  for (const pod of ['flobi-brand-7d9f8c6b5-x2x9z', 'flobi-brand-0', 'flobi-brand-abcde']) assert.ok(re.test(pod), pod);
  for (const pod of ['flobi-brand-worker-7d9f8c6b5-x2x9z', 'other-flobi-brand-0']) assert.ok(!re.test(pod), pod);
  assert.equal(serviceFilter('a"b OR x'), serviceFilter('abORx'), 'quotes and spaces never reach the filter');
});
