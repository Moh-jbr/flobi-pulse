// Cloud Logging: the live tail (nothing opened after stop, C2; backoff, C5; what
// the guard sees, C6), listAll's paging budget (C3) and the 401 retry (C7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import tls from 'node:tls';
import fs from 'node:fs';
import { LoggingClient } from '../electron/core/sources/logging.mjs';
import { openStream, GrpcError, GRPC_CODE } from '../electron/core/net/grpc.mjs';
import { configureGuard, resetGuard, tailResourceNames } from '../electron/core/net/guard.mjs';

const cert = fs.readFileSync(new URL('./fixtures/tls-cert.pem', import.meta.url));
const key = fs.readFileSync(new URL('./fixtures/tls-key.pem', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = () => {};

/** A fake openStream: each call runs `script(opts, n)`; the call times are recorded. */
function fakeStreams(script) {
  const calls = [];
  const t0 = Date.now();
  const open = (opts) => {
    calls.push({ at: Date.now() - t0, opts });
    const n = calls.length;
    let ended = false;
    const end = (err) => !ended && ((ended = true), opts.onEnd(err));
    setImmediate(() => script(opts, n, end));
    return { close: () => end(new GrpcError(GRPC_CODE.CANCELLED, 'closed by client')) };
  };
  return { calls, open };
}

const unavailable = () => new GrpcError(GRPC_CODE.UNAVAILABLE, 'stream closed');

test('a server that accepts the tail and then fails is retried with a growing backoff', async () => {
  const { calls, open } = fakeStreams((o, n, end) => {
    o.onOpen();
    end(unavailable());
  });
  const logging = new LoggingClient({ projectId: 'flobi-prod-2026', getToken: async () => 't', openStream: open, tailTiming: { backoffMs: 20, maxBackoffMs: 5000 } });
  const tail = logging.tail({ filter: 'x', onEntries: quiet, onState: quiet });
  await sleep(700);
  tail.stop();
  // 20, 40, 80, 160, 320 ms apart: about 6 tries in 700 ms (not one every 20 ms).
  assert.ok(calls.length >= 4 && calls.length <= 7, `tries in 700 ms: ${calls.length} (${calls.map((c) => c.at).join(', ')})`);
  const gaps = calls.slice(1).map((c, i) => c.at - calls[i].at);
  assert.ok(gaps[gaps.length - 1] >= 4 * gaps[0], `backoff grows: ${gaps.join(', ')}`);
});

/** Tries 1–4 fail at once (gaps ~20, 40, 80, 160 ms); try 5 runs `fifth`, then fails. Gaps between tries. */
async function gapsAround(fifth) {
  const { calls, open } = fakeStreams((o, n, end) => {
    o.onOpen();
    if (n === 5) return fifth(o, () => end(unavailable()));
    end(unavailable());
  });
  const logging = new LoggingClient({ projectId: 'flobi-prod-2026', getToken: async () => 't', openStream: open, tailTiming: { backoffMs: 20, maxBackoffMs: 5000, healthyMs: 60 } });
  const tail = logging.tail({ filter: 'x', onEntries: quiet, onState: quiet });
  while (calls.length < 6) await sleep(5);
  tail.stop();
  return calls.slice(1).map((c, i) => c.at - calls[i].at);
}

test('a tail that delivered a message starts the backoff over', async () => {
  const gaps = await gapsAround((o, fail) => {
    o.onMessage(Buffer.alloc(0)); // an (empty) TailLogEntriesResponse
    fail();
  });
  assert.ok(gaps[3] >= 120, `backoff grew while failing: ${gaps.join(', ')}`);
  assert.ok(gaps[4] < gaps[3] / 2, `back to the start after a message (~20 ms, not ~320): ${gaps.join(', ')}`);
});

test('a tail that stayed up healthyMs starts the backoff over', async () => {
  const gaps = await gapsAround((o, fail) => setTimeout(fail, 80)); // up 80 ms ≥ healthyMs (60)
  // 80 ms up + ~20 ms backoff; without the reset it would be 80 + ~320.
  assert.ok(gaps[4] < 220, `back to the start after a healthy stream: ${gaps.join(', ')}`);
});

test('the tail tells the guard which project it reads', async () => {
  const { calls, open } = fakeStreams(quiet);
  const logging = new LoggingClient({ projectId: 'flobi-prod-2026', getToken: async () => 't', openStream: open });
  const tail = logging.tail({ filter: 'x', onEntries: quiet, onState: quiet });
  while (!calls.length) await sleep(5);
  tail.stop();
  assert.deepEqual(tailResourceNames(calls[0].opts.request), ['projects/flobi-prod-2026'], 'the request the guard reads');
  assert.equal(calls[0].opts.headers['x-goog-request-params'], 'resource_names=projects%2Fflobi-prod-2026');
});

test('a tail the guard refuses reports an error instead of crashing the loop', async () => {
  resetGuard();
  configureGuard({ projectId: 'someone-elses-project' });
  const states = [];
  const logging = new LoggingClient({ projectId: 'flobi-prod-2026', getToken: async () => 't' });
  const tail = logging.tail({ filter: 'x', onEntries: quiet, onState: (s, m) => states.push([s, m]) });
  while (!states.some(([s]) => s === 'error')) await sleep(5);
  tail.stop();
  await sleep(10);
  resetGuard();
  assert.match(states.find(([s]) => s === 'error')[1], /read-only guard.*configured project/);
  assert.equal(states[states.length - 1][0], 'stopped');
});

test('stop() while the tail waits for its token: no gRPC connection is opened', async () => {
  resetGuard();
  configureGuard({ projectId: 'flobi-prod-2026' });
  const server = http2.createSecureServer({ cert, key });
  let sessions = 0;
  server.on('session', () => sessions++);
  server.on('stream', (s) => s.respond({ ':status': 200, 'content-type': 'application/grpc' }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const connectTo = { createConnection: () => tls.connect({ host: '127.0.0.1', port, servername: 'logging.googleapis.com', ca: cert, ALPNProtocols: ['h2'] }) };

  let release;
  const gate = new Promise((r) => (release = r));
  let asked = false;
  const states = [];
  const entries = [];
  const logging = new LoggingClient({
    projectId: 'flobi-prod-2026',
    getToken: () => ((asked = true), gate),
    openStream: (o) => openStream({ ...o, connectOptions: connectTo }),
  });
  const tail = logging.tail({ filter: 'x', onEntries: (e) => entries.push(...e), onState: (s) => states.push(s) });
  while (!asked) await sleep(5);
  tail.stop(); // a connector restart during a token refresh (waking after sleep)
  release('t');
  await sleep(300);
  server.close();
  resetGuard();
  assert.equal(sessions, 0, 'no connection holds one of the 10 live-tail slots');
  assert.deepEqual(states, ['connecting', 'stopped']);
  assert.deepEqual(entries, []);
});

// ── listAll: a budget for slow searches ──────────────────────────────────────
function pager(page) {
  const calls = [];
  const c = new LoggingClient({
    projectId: 'p',
    getToken: async () => 't',
    minIntervalMs: 0,
    request: async ({ body }) => {
      calls.push(JSON.parse(body));
      return page(calls.length);
    },
  });
  return { c, calls };
}

test('listAll stops after 3 empty pages in a row and says the result is cut short', async () => {
  const { c, calls } = pager((n) => (n === 1 ? { entries: [{ n }], nextPageToken: 'more' } : { nextPageToken: 'more' }));
  const out = await c.listAll({ filter: 'f' });
  assert.equal(calls.length, 4);
  assert.ok(Array.isArray(out));
  assert.deepEqual(out, [{ n: 1 }]);
  assert.equal(out.truncated, true);
  assert.deepEqual(Object.keys(out), ['0'], 'still a plain list for callers');
});

test('listAll stops at the page and time budgets', async () => {
  const pages = pager((n) => ({ entries: [{ n }], nextPageToken: 'more' }));
  const byPages = await pages.c.listAll({ filter: 'f', max: 100_000 });
  assert.equal(pages.calls.length, 20);
  assert.equal(byPages.length, 20);
  assert.equal(byPages.truncated, true);

  const slow = pager(async (n) => (await sleep(30), { entries: [{ n }], nextPageToken: 'more' }));
  const byTime = await slow.c.listAll({ filter: 'f', max: 100_000, maxMs: 100 });
  assert.ok(slow.calls.length >= 3 && slow.calls.length <= 5, `pages in 100 ms: ${slow.calls.length}`);
  assert.equal(byTime.truncated, true);
});

test('listAll: a complete result, or one cut by `max`, is not marked as truncated', async () => {
  const { c, calls } = pager((n) => (n < 3 ? { entries: [{ n }], nextPageToken: `p${n}` } : { entries: [{ n }] }));
  const out = await c.listAll({ filter: 'f', pageSize: 1 });
  assert.equal(calls.length, 3);
  assert.equal(calls[1].pageToken, 'p1');
  assert.equal(out.truncated, undefined);
  const capped = pager((n) => ({ entries: [{ n }, { n }], nextPageToken: 'more' }));
  const two = await capped.c.listAll({ filter: 'f', max: 4, pageSize: 2 });
  assert.equal(two.length, 4);
  assert.equal(two.truncated, undefined);
});

// ── 401 on entries:list ──────────────────────────────────────────────────────
test('entries:list retries a 401 once with a fresh token', async () => {
  let token = 'old';
  let invalidations = 0;
  const seen = [];
  const make = (refuseAll, withInvalidate = true) =>
    new LoggingClient({
      projectId: 'p',
      minIntervalMs: 0,
      getToken: async () => token,
      invalidateToken: withInvalidate ? () => ((invalidations++), (token = 'new')) : undefined,
      request: async ({ headers }) => {
        seen.push(headers.authorization);
        if (refuseAll || headers.authorization !== 'Bearer new') throw Object.assign(new Error('HTTP 401 – Request had invalid authentication credentials.'), { status: 401 });
        return { entries: [{ ok: true }] };
      },
    });
  assert.deepEqual((await make(false).list({ filter: 'f' })).entries, [{ ok: true }]);
  assert.deepEqual(seen, ['Bearer old', 'Bearer new']);
  assert.equal(invalidations, 1);

  seen.length = 0;
  await assert.rejects(make(true).list({ filter: 'f' }), (e) => e.status === 401);
  assert.equal(seen.length, 2, 'exactly one retry');

  seen.length = 0;
  token = 'old';
  await assert.rejects(make(false, false).listAll({ filter: 'f' }), (e) => e.status === 401);
  assert.equal(seen.length, 1, 'no invalidateToken: no retry');
});
