// Service-account tokens (C7): concurrent callers share one request per scope, and
// invalidate() really starts over, even while a request is under way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ServiceAccountAuth } from '../electron/core/auth/service-account.mjs';

const pem = fs.readFileSync(new URL('./fixtures/sa-test-key.pem', import.meta.url), 'utf8');
const keyJson = JSON.stringify({ type: 'service_account', project_id: 'flobi-prod-2026', private_key: pem, client_email: 'pulse@flobi-prod-2026.iam.gserviceaccount.com' });

/** An auth whose token requests wait until the test answers them. */
function fakeGoogle() {
  const auth = new ServiceAccountAuth(keyJson);
  const requests = [];
  auth._exchange = (scopes) =>
    new Promise((resolve, reject) => {
      const n = requests.length + 1;
      requests.push({ scopes, answer: (token = `tok-${n}`) => resolve({ access_token: token, expires_in: 3600 }), fail: reject });
    });
  return { auth, requests };
}
const flush = () => new Promise((r) => setImmediate(r));

test('concurrent callers share one token request per scope', async () => {
  const { auth, requests } = fakeGoogle();
  const reads = Array.from({ length: 14 }, () => auth.getToken('read')); // 14 informers starting at once
  const platform = [auth.getToken('platform'), auth.getToken('platform')];
  await flush();
  assert.equal(requests.length, 2);
  requests[0].answer('read-token');
  requests[1].answer('platform-token');
  assert.deepEqual(new Set(await Promise.all(reads)), new Set(['read-token']));
  assert.deepEqual(await Promise.all(platform), ['platform-token', 'platform-token']);
  assert.equal(await auth.getToken('read'), 'read-token', 'then served from the cache');
  assert.equal(requests.length, 2);
});

test('invalidate() drops the cache and a request under way; its answer is not cached', async () => {
  const { auth, requests } = fakeGoogle();
  const before = auth.getToken('read');
  await flush();
  auth.invalidate(); // a 401 came back while a refresh was on its way
  const after = auth.getToken('read');
  await flush();
  assert.equal(requests.length, 2, 'a new request, not the one started before');
  requests[0].answer('stale');
  requests[1].answer('fresh');
  assert.equal(await before, 'stale', 'whoever asked earlier still gets an answer');
  assert.equal(await after, 'fresh');
  assert.equal(await auth.getToken('read'), 'fresh');
  assert.equal(requests.length, 2);
});

test('many 401s for the same token start one refresh, not one each', async () => {
  const { auth, requests } = fakeGoogle();
  const first = auth.getToken('platform');
  await flush();
  requests[0].answer('rejected');
  const rejected = await first;
  // 14 informers get a 401 for it at once; each invalidates and asks again.
  const again = [];
  for (let i = 0; i < 14; i++) {
    auth.invalidate(rejected);
    again.push(auth.getToken('platform'));
  }
  await flush();
  assert.equal(requests.length, 2, 'one refresh for all of them');
  requests[1].answer('fresh');
  assert.deepEqual(new Set(await Promise.all(again)), new Set(['fresh']));
  auth.invalidate('some-token-we-never-had');
  assert.equal(await auth.getToken('platform'), 'fresh', 'an unknown token changes nothing');
  auth.invalidate(); // without a token: always starts over (sign-out, older callers)
  auth.getToken('platform');
  await flush();
  assert.equal(requests.length, 3);
});

test('a failed request is shared by its callers and not remembered', async () => {
  const { auth, requests } = fakeGoogle();
  const a = auth.getToken('read');
  const b = auth.getToken('read');
  await flush();
  requests[0].fail(Object.assign(new Error('HTTP 400 – invalid_grant'), { status: 400 }));
  await assert.rejects(a, /invalid_grant/);
  await assert.rejects(b, /invalid_grant/);
  const c = auth.getToken('read');
  await flush();
  assert.equal(requests.length, 2, 'the next caller asks again');
  requests[1].answer('ok');
  assert.equal(await c, 'ok');
});

test('the Cloud Run scope fallback still works with shared requests', async () => {
  const { auth, requests } = fakeGoogle();
  const a = auth.getToken('read');
  const b = auth.getToken('read');
  await flush();
  requests[0].fail(Object.assign(new Error('HTTP 400 – invalid_scope'), { status: 400, body: '{"error":"invalid_scope"}' }));
  await flush();
  assert.equal(requests.length, 2);
  assert.ok(!requests[1].scopes.some((s) => s.endsWith('/run.readonly')));
  requests[1].answer('narrow');
  assert.deepEqual(await Promise.all([a, b]), ['narrow', 'narrow']);
});
