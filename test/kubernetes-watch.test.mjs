// Informer pacing (C1), nothing after stop (C2) and the 401 retry (C7), against a
// local fake Kubernetes API server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs';
import { KubeClient, Informer, backoffDelay } from '../electron/core/sources/kubernetes.mjs';

const cert = fs.readFileSync(new URL('./fixtures/k8s-cert.pem', import.meta.url));
const key = fs.readFileSync(new URL('./fixtures/k8s-key.pem', import.meta.url));
const caB64 = cert.toString('base64');
const PODS = '/api/v1/namespaces/flobi/pods';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

/** A fake API server: handler(req, res, url). Records "<t> <method> <url> <auth>" per request. */
function fakeApi(handler) {
  const requests = [];
  const t0 = Date.now();
  const server = https.createServer({ cert, key }, (req, res) => {
    const url = new URL(req.url, 'https://x');
    requests.push({ at: Date.now() - t0, url: req.url, watch: url.searchParams.has('watch'), auth: req.headers.authorization });
    handler(req, res, url);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        requests,
        port: server.address().port,
        close() {
          server.closeAllConnections();
          server.close();
        },
      }),
    ),
  );
}

const list = (items = [], rv = '10') => JSON.stringify({ metadata: { resourceVersion: rv }, items });
const pod = (uid, rv = '11') => ({ metadata: { uid, name: `pod-${uid}`, resourceVersion: rv } });

test('backoff: doubles from the base up to the cap, with ±25 % jitter', () => {
  assert.equal(backoffDelay(0, 1000, 30_000, () => 0.5), 1000);
  assert.equal(backoffDelay(3, 1000, 30_000, () => 0.5), 8000);
  assert.equal(backoffDelay(10, 1000, 30_000, () => 0.5), 30_000);
  assert.equal(backoffDelay(0, 1000, 30_000, () => 0), 750);
  assert.equal(backoffDelay(0, 1000, 30_000, () => 0.9999), 1250);
});

test('a watch that returns 200 and closes at once is retried with backoff, not thousands of times a second', async () => {
  const api = await fakeApi((req, res, url) => {
    if (!url.searchParams.has('watch')) return res.end(list());
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(); // no events, closed at once
  });
  const client = new KubeClient({ endpoint: `127.0.0.1:${api.port}`, caB64, getToken: async () => 'tok' });
  const inf = new Informer(client, 'pods', PODS, { onChange: () => {} }).start(); // default timing: 1 s, 2 s, 4 s…
  await sleep(2500);
  inf.stop();
  api.close();
  const watches = api.requests.filter((r) => r.watch);
  assert.ok(watches.length >= 2 && watches.length <= 3, `watches in 2.5 s: ${watches.length} (${watches.map((w) => w.at).join(', ')} ms)`);
  assert.equal(api.requests.filter((r) => !r.watch).length, 1, 'no relist for a watch that merely ended');
  assert.ok(watches[1].at - watches[0].at >= 700, `first retry after ~1 s, got ${watches[1].at - watches[0].at} ms`);
});

test('an ERROR event (500, e.g. a failing webhook) relists with a growing backoff instead of spinning', async () => {
  const api = await fakeApi((req, res, url) => {
    if (!url.searchParams.has('watch')) return res.end(list([pod('a')]));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(`${JSON.stringify({ type: 'ERROR', object: { kind: 'Status', code: 500, reason: 'InternalError', message: 'conversion webhook failed' } })}\n`);
  });
  const client = new KubeClient({ endpoint: `127.0.0.1:${api.port}`, caB64, getToken: async () => 'tok' });
  const snapshots = [];
  const warn = console.warn;
  console.warn = () => {};
  try {
    const inf = new Informer(client, 'scaledobjects', PODS, { onChange: (k, items) => snapshots.push(items.length), timing: { backoffMs: 40, maxBackoffMs: 400 } }).start();
    await sleep(1300);
    inf.stop();
  } finally {
    console.warn = warn;
    api.close();
  }
  const kinds = api.requests.map((r) => (r.watch ? 'W' : 'L')).join('');
  assert.match(kinds, /^(LW)+L?$/, `every ERROR is followed by a relist: ${kinds}`);
  const lists = api.requests.filter((r) => !r.watch);
  assert.ok(lists.length >= 4 && lists.length <= 8, `relists in 1.3 s: ${lists.length}`);
  const gaps = lists.slice(1).map((r, i) => r.at - lists[i].at);
  assert.ok(gaps[gaps.length - 1] > gaps[0] * 2, `backoff grows: ${gaps.join(', ')} ms`);
  assert.ok(snapshots.every((n) => n === 1), 'the relisted items are still there');
});

test('a healthy watch (it delivered events) resets the backoff', async () => {
  let watches = 0;
  const api = await fakeApi((req, res, url) => {
    if (!url.searchParams.has('watch')) return res.end(list());
    watches++;
    res.writeHead(200, { 'content-type': 'application/json' });
    // Watches 1–4 end at once with nothing; watch 5 delivers a pod first.
    res.end(watches === 5 ? `${JSON.stringify({ type: 'ADDED', object: pod('b', '12') })}\n` : '');
  });
  const client = new KubeClient({ endpoint: `127.0.0.1:${api.port}`, caB64, getToken: async () => 'tok' });
  const inf = new Informer(client, 'pods', PODS, { onChange: () => {}, timing: { backoffMs: 40, maxBackoffMs: 5000 } }).start();
  while (watches < 6) await sleep(20);
  inf.stop();
  api.close();
  const w = api.requests.filter((r) => r.watch).map((r) => r.at);
  const gaps = w.slice(1).map((t, i) => t - w[i]);
  // ~40, 80, 160, 320 ms while failing; after the healthy watch 5, back to ~40.
  assert.ok(gaps[3] > 200, `backoff grew while failing: ${gaps.join(', ')}`);
  assert.ok(gaps[4] < gaps[3] / 2, `reset after the healthy watch: ${gaps.join(', ')}`);
  assert.ok(api.requests.find((r) => r.watch && r.url.includes('resourceVersion=12')), 'resumes from the delivered resourceVersion');
});

test('stop() while the watch waits for its token: no watch is opened, nothing is emitted', async () => {
  const api = await fakeApi((req, res, url) => {
    if (!url.searchParams.has('watch')) return res.end(list([pod('a')]));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write(`${JSON.stringify({ type: 'ADDED', object: pod('zombie', '12') })}\n`);
  });
  const gate = deferred();
  const asked = deferred();
  let calls = 0;
  const getToken = () => (++calls === 1 ? Promise.resolve('tok') : (asked.resolve(), gate.promise));
  const client = new KubeClient({ endpoint: `127.0.0.1:${api.port}`, caB64, getToken });
  const seen = [];
  const inf = new Informer(client, 'pods', PODS, { onChange: (k, items) => seen.push(items.map((i) => i.metadata.name).join(',')) }).start();
  await asked.promise; // listed; the watch is waiting for a token (e.g. a refresh after sleep)
  inf.stop();
  gate.resolve('tok');
  await sleep(300);
  api.close();
  assert.deepEqual(seen, ['pod-a']);
  assert.equal(api.requests.filter((r) => r.watch).length, 0, 'no watch request after stop');
});

test('stop() while the list is in flight: its answer is dropped', async () => {
  const api = await fakeApi((req, res) => setTimeout(() => res.end(list([pod('a')])), 100));
  const client = new KubeClient({ endpoint: `127.0.0.1:${api.port}`, caB64, getToken: async () => 'tok' });
  const seen = [];
  const statuses = [];
  const inf = new Informer(client, 'pods', PODS, { onChange: (k, items) => seen.push(items.length), onStatus: (k, st) => statuses.push(st) }).start();
  await sleep(30);
  inf.stop();
  await sleep(250);
  api.close();
  assert.deepEqual(seen, []);
  assert.deepEqual(statuses, []);
  assert.equal(api.requests.filter((r) => r.watch).length, 0);
});

// ── 401: invalidate the token and retry once ───────────────────────────────
function rotatingToken() {
  const t = { token: 'old', invalidations: 0 };
  t.getToken = async () => t.token;
  t.invalidateToken = () => {
    t.invalidations++;
    t.token = 'new';
  };
  return t;
}

async function authApi({ accept = ['Bearer new'] } = {}) {
  return fakeApi((req, res, url) => {
    if (!accept.includes(req.headers.authorization)) {
      res.statusCode = 401;
      return res.end(JSON.stringify({ kind: 'Status', code: 401, message: 'Unauthorized' }));
    }
    if (url.pathname === '/version') return res.end(JSON.stringify({ gitVersion: 'v1.33.1' }));
    if (url.pathname.endsWith('/log')) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('2026-09-25T03:02:11.000000000Z hello\n');
    }
    if (url.searchParams.has('watch')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(`${JSON.stringify({ type: 'ADDED', object: pod('b') })}\n`);
    }
    return res.end(list([pod('a')]));
  });
}

test('401: GET, logs, watch and follow retry once with a fresh token', async () => {
  const api = await authApi();
  const t = rotatingToken();
  const client = new KubeClient({ endpoint: `127.0.0.1:${api.port}`, caB64, getToken: t.getToken, invalidateToken: t.invalidateToken });

  assert.equal((await client.version()).gitVersion, 'v1.33.1');
  assert.equal(t.invalidations, 1);
  assert.deepEqual(api.requests.map((r) => r.auth), ['Bearer old', 'Bearer new']);

  t.token = 'old'; // Google rotated the key again
  assert.match(await client.previousLogs({ namespace: 'flobi', pod: 'p', container: 'c' }), /hello/);
  assert.equal(t.invalidations, 2);

  t.token = 'old';
  const lines = [];
  const handle = await client.stream(`${PODS}?watch=1`, (l) => lines.push(JSON.parse(l).object.metadata.uid));
  const end = await handle.done;
  assert.equal(end.aborted, false);
  assert.deepEqual(lines, ['b']);
  assert.equal(t.invalidations, 3);

  t.token = 'old';
  const got = [];
  const follow = client.followLogs({ namespace: 'flobi', pod: 'p', container: 'c', onLine: (text) => got.push(text), onStatus: () => {} });
  while (!got.length) await sleep(10);
  follow.stop();
  assert.deepEqual(got, ['hello']);
  assert.equal(t.invalidations, 4);
  api.close();
});

test('401: exactly one retry, and none without a way to refresh the token', async () => {
  const api = await authApi({ accept: [] }); // every token is refused
  const t = rotatingToken();
  const client = new KubeClient({ endpoint: `127.0.0.1:${api.port}`, caB64, getToken: t.getToken, invalidateToken: t.invalidateToken });
  await assert.rejects(client.version(), (e) => e.status === 401);
  assert.equal(api.requests.length, 2);
  await assert.rejects((await client.stream(`${PODS}?watch=1`, () => {})).done, (e) => e.status === 401);
  assert.equal(api.requests.length, 4);

  const plain = new KubeClient({ endpoint: `127.0.0.1:${api.port}`, caB64, getToken: async () => 'old' });
  await assert.rejects(plain.version(), (e) => e.status === 401);
  assert.equal(api.requests.length, 5, 'no invalidateToken: no pointless retry with the same token');
  api.close();
});
