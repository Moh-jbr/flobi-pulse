// Pod log follow: timestamps on any content, no replayed lines after a reconnect
// (C13), and nothing delivered after stop (C2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs';
import { KubeClient, splitTimestamp } from '../electron/core/sources/kubernetes.mjs';

const cert = fs.readFileSync(new URL('./fixtures/k8s-cert.pem', import.meta.url));
const key = fs.readFileSync(new URL('./fixtures/k8s-key.pem', import.meta.url));
const caB64 = cert.toString('base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeApi(handler) {
  const requests = [];
  const server = https.createServer({ cert, key }, (req, res) => {
    requests.push(new URL(req.url, 'https://x'));
    handler(req, res, requests.length);
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

test('timestamps are split off whatever the line holds (\\r, U+2028, nothing at all)', () => {
  assert.deepEqual(splitTimestamp('2026-09-25T03:02:11.123456789Z plain'), { ts: '2026-09-25T03:02:11.123456789Z', text: 'plain' });
  assert.deepEqual(splitTimestamp('2026-09-25T03:02:11.1Z windows line\r'), { ts: '2026-09-25T03:02:11.1Z', text: 'windows line\r' });
  assert.deepEqual(splitTimestamp('2026-09-25T03:02:11Z a b c\rd'), { ts: '2026-09-25T03:02:11Z', text: 'a b c\rd' });
  assert.deepEqual(splitTimestamp('2026-09-25T03:02:11.5Z '), { ts: '2026-09-25T03:02:11.5Z', text: '' });
  assert.deepEqual(splitTimestamp('2026-09-25T03:02:11.5Z'), { ts: '2026-09-25T03:02:11.5Z', text: '' });
  assert.deepEqual(splitTimestamp('2026-09-25T05:02:11.5+02:00 offset'), { ts: '2026-09-25T05:02:11.5+02:00', text: 'offset' });
  assert.deepEqual(splitTimestamp('no timestamp here'), { ts: null, text: 'no timestamp here' });
});

test('after a reconnect, the lines Kubernetes sends again are dropped', async () => {
  // Connection 1 ends after three lines, two of them in the same nanosecond.
  // Kubernetes cuts sinceTime to the second, so connection 2 starts again at :11.
  const first = ['2026-09-25T03:02:11.100000000Z first', '2026-09-25T03:02:11.500000000Z second\r', '2026-09-25T03:02:11.500000000Z third still third'];
  const second = [
    '2026-09-25T03:02:10.900000000Z from before (not asked for, still dropped)',
    ...first,
    '2026-09-25T03:02:11.500000000Z fourth, same time as the last shown',
    '2026-09-25T03:02:12.000000001Z fifth',
  ];
  const api = await fakeApi((req, res, n) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    if (n === 1) return res.end(`${first.join('\n')}\n`);
    if (n === 2) return res.end(`${second.join('\n')}\n`);
    res.write('2026-09-25T03:02:12.000000001Z fifth\n'); // connection 3: replay only, then quiet
  });
  const client = new KubeClient({ endpoint: `127.0.0.1:${api.port}`, caB64, getToken: async () => 'tok' });
  const got = [];
  const statuses = [];
  const follow = client.followLogs({ namespace: 'flobi', pod: 'p', container: 'c', backoffMs: 20, onLine: (text, ts) => got.push([text, new Date(ts).toISOString()]), onStatus: (s) => statuses.push(s) });
  while (api.requests.length < 3) await sleep(10);
  await sleep(100);
  follow.stop();
  api.close();
  assert.deepEqual(got, [
    ['first', '2026-09-25T03:02:11.100Z'],
    ['second\r', '2026-09-25T03:02:11.500Z'],
    ['third still third', '2026-09-25T03:02:11.500Z'],
    ['fourth, same time as the last shown', '2026-09-25T03:02:11.500Z'],
    ['fifth', '2026-09-25T03:02:12.000Z'],
  ]);
  assert.equal(api.requests[0].searchParams.get('tailLines'), '200');
  assert.equal(api.requests[1].searchParams.get('sinceTime'), '2026-09-25T03:02:11.500000000Z');
  assert.equal(api.requests[2].searchParams.get('sinceTime'), '2026-09-25T03:02:12.000000001Z');
  assert.ok(statuses.includes('streaming'));
});

test('stop() while the follow waits for its token: nothing is opened or delivered', async () => {
  const lines = Array.from({ length: 10 }, (_, i) => `2026-09-25T03:02:1${i}.000000000Z line ${i}`);
  const api = await fakeApi((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write(`${lines.join('\n')}\n`);
  });
  let release;
  const gate = new Promise((r) => (release = r));
  let asked = false;
  const client = new KubeClient({ endpoint: `127.0.0.1:${api.port}`, caB64, getToken: () => ((asked = true), gate) });
  const got = [];
  const statuses = [];
  const follow = client.followLogs({ namespace: 'flobi', pod: 'p', container: 'c', onLine: (t) => got.push(t), onStatus: (s) => statuses.push(s) });
  while (!asked) await sleep(5);
  follow.stop(); // e.g. the panel closed during a token refresh
  release('tok');
  await sleep(300);
  api.close();
  assert.deepEqual(got, []);
  assert.equal(api.requests.length, 0, 'no log request after stop');
  assert.deepEqual(statuses, ['opening']);
});

test('stop() mid-stream: no line of an already received chunk is delivered afterwards', async () => {
  const lines = Array.from({ length: 10 }, (_, i) => `2026-09-25T03:02:1${i}.000000000Z line ${i}`);
  const api = await fakeApi((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write(`${lines.join('\n')}\n`); // one chunk
  });
  const client = new KubeClient({ endpoint: `127.0.0.1:${api.port}`, caB64, getToken: async () => 'tok' });
  const got = [];
  let follow = null;
  follow = client.followLogs({ namespace: 'flobi', pod: 'p', container: 'c', onLine: (t) => (got.push(t), follow.stop()), onStatus: () => {} });
  await sleep(300);
  api.close();
  assert.deepEqual(got, ['line 0']);
});
