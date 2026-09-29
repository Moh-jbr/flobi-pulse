// Guard additions: the live tail may only read the configured project (C6), Cloud
// Run may be paged (C9), and refusals never repeat secrets from a URL (C17).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { checkRequest, configureGuard, resetGuard, deniedAttempts, displayUrl, ReadOnlyViolation, tailResourceNames } from '../electron/core/net/guard.mjs';
import { openStream } from '../electron/core/net/grpc.mjs';
import { encodeTailRequest } from '../electron/core/net/protobuf.mjs';

const TAIL = 'https://logging.googleapis.com/google.logging.v2.LoggingServiceV2/TailLogEntries';
const RUN = 'https://run.googleapis.com/v2/projects/flobi-prod-2026/locations/europe-west1/services';

beforeEach(() => {
  resetGuard();
  configureGuard({ projectId: 'flobi-prod-2026', sqlProjects: ['flobi-db-prod'], kubernetesHost: '34.77.1.2' });
});

const allowed = (req) => assert.equal(checkRequest(req), true);
const blocked = (req, why) => assert.throws(() => checkRequest(req), (e) => e instanceof ReadOnlyViolation && (!why || why.test(e.message)));
// The request exactly as it's sent (protobuf): that's what the guard reads.
const tail = (resourceNames, extra = {}) => ({ method: 'POST', url: TAIL, body: encodeTailRequest({ resourceNames, ...extra }) });

test('live tail: only the configured project, read from the request bytes themselves', () => {
  allowed(tail(['projects/flobi-prod-2026']));
  allowed(tail(['projects/flobi-prod-2026'], { filter: 'severity>=ERROR', bufferWindowSeconds: 2 }));
  blocked({ method: 'POST', url: TAIL }, /checked on the request it sends/);
  // A description of the request isn't enough any more: it could say something else than the bytes.
  blocked({ method: 'POST', url: TAIL, body: JSON.stringify({ resourceNames: ['projects/flobi-prod-2026'] }) }, /checked on the request it sends/);
  blocked({ method: 'POST', url: TAIL, body: Buffer.from('not protobuf') }, /valid TailLogEntriesRequest/);
  blocked({ method: 'POST', url: TAIL, body: Buffer.from([0x0a, 0x40, 0x61]) }, /valid TailLogEntriesRequest/); // length past the end
  blocked(tail([]), /must name the project/);
  blocked(tail(['projects/someone-else']), /configured project/);
  blocked(tail(['projects/flobi-prod-2026', 'projects/someone-else']), /configured project/);
  // The database's project may be listed (Postgres logs only), never tailed.
  blocked(tail(['projects/flobi-db-prod']), /configured project/);
  blocked(tail(['projects/flobi-prod-2026/locations/global/buckets/_Default/views/_AllLogs']), /configured project/);
  blocked(tail(['organizations/123']), /configured project/);
  blocked(tail(['folders/123', 'projects/flobi-prod-2026']), /configured project/);
  blocked({ ...tail(['projects/flobi-prod-2026']), url: `${TAIL}?alt=json` });
  assert.deepEqual(tailResourceNames(encodeTailRequest({ resourceNames: ['projects/a', 'projects/b'], filter: 'x' })), ['projects/a', 'projects/b']);
});

test('live tail: nothing can be tailed before a project is configured', () => {
  resetGuard();
  blocked(tail(['projects/flobi-prod-2026']), /configured project/);
});

test('openStream sends the request it will send through the guard', () => {
  const opts = (request) => ({ origin: 'https://logging.googleapis.com', path: '/google.logging.v2.LoggingServiceV2/TailLogEntries', request, onMessage() {}, onEnd() {} });
  assert.throws(() => openStream(opts(Buffer.alloc(0))), ReadOnlyViolation);
  assert.throws(() => openStream(opts(encodeTailRequest({ resourceNames: ['projects/someone-else'] }))), ReadOnlyViolation);
});

test('Cloud Run: the service list may be paged, nothing else', () => {
  allowed({ url: RUN });
  allowed({ url: `${RUN}?pageToken=Cg5zZXJ2aWNlLTAwMDAx` });
  allowed({ url: `${RUN}?pageSize=100&pageToken=abc` });
  blocked({ url: `${RUN}?filter=x` });
  blocked({ url: `${RUN}?pageToken=abc&showDeleted=true` });
  blocked({ url: `${RUN}/flobi-artwork-render?pageToken=abc` });
  blocked({ url: 'https://run.googleapis.com/v2/projects/someone-else/locations/europe-west1/services?pageToken=abc' });
  blocked({ method: 'POST', url: `${RUN}?pageToken=abc` });
  blocked({ method: 'DELETE', url: `${RUN}?pageToken=abc` });
});

test('refusals never repeat credentials or query values from the URL', () => {
  const secret = 'sk_live_0123456789abcdef';
  for (const url of [`https://evil.example.com/hook?token=${secret}&x=1`, `https://user:${secret}@evil.example.com/`, `https://api.flobi.ai/other?key=${secret}#frag`]) {
    assert.throws(
      () => checkRequest({ url }),
      (e) => e instanceof ReadOnlyViolation && !e.message.includes(secret) && !JSON.stringify(e.detail).includes(secret),
    );
  }
  assert.ok(!JSON.stringify(deniedAttempts()).includes(secret), 'nor does Settings → Data sources');
  assert.equal(displayUrl(`https://evil.example.com/hook?token=${secret}&x=1&token=2`), 'https://evil.example.com/hook?token=…&x=…');
  assert.equal(displayUrl(`https://user:${secret}@34.77.1.2/api/v1/pods`), 'https://34.77.1.2/api/v1/pods');
  // What the guard refused is still clear.
  assert.throws(() => checkRequest({ url: 'https://34.77.1.2/api/v1/namespaces/flobi/pods/a/log?container=c&command=sh' }), /query parameter "command"/);
});
