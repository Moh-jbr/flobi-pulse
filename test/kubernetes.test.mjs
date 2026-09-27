import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs';
import { KubeClient, Informer } from '../electron/core/sources/kubernetes.mjs';
import { ReadOnlyViolation } from '../electron/core/net/guard.mjs';

const cert = fs.readFileSync(new URL('./fixtures/k8s-cert.pem', import.meta.url));
const key = fs.readFileSync(new URL('./fixtures/k8s-key.pem', import.meta.url));

/** A tiny fake Kubernetes API server: list, watch (with a 410 once), logs. */
function fakeApi() {
  const seen = [];
  let watchCalls = 0;
  const server = https.createServer({ cert, key }, (req, res) => {
    seen.push(`${req.method} ${req.url}`);
    assert.equal(req.headers.authorization, 'Bearer tok');
    const url = new URL(req.url, 'https://x');
    if (url.pathname === '/api/v1/namespaces/flobi/pods' && !url.searchParams.get('watch')) {
      res.end(JSON.stringify({ metadata: { resourceVersion: watchCalls ? '20' : '10' }, items: [{ metadata: { uid: 'a', name: 'pod-a', resourceVersion: '9' } }] }));
      return;
    }
    if (url.pathname === '/api/v1/namespaces/flobi/pods' && url.searchParams.get('watch')) {
      watchCalls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      if (watchCalls === 1) {
        res.write(`${JSON.stringify({ type: 'ADDED', object: { metadata: { uid: 'b', name: 'pod-b', resourceVersion: '11' } } })}\n`);
        res.write(`${JSON.stringify({ type: 'BOOKMARK', object: { metadata: { resourceVersion: '12' } } })}\n`);
        // split a line across chunks
        const line = JSON.stringify({ type: 'DELETED', object: { metadata: { uid: 'a', name: 'pod-a', resourceVersion: '13' } } });
        res.write(line.slice(0, 20));
        setTimeout(() => {
          res.write(`${line.slice(20)}\n`);
          res.write(`${JSON.stringify({ type: 'ERROR', object: { code: 410, message: 'too old' } })}\n`);
          res.end();
        }, 50);
      } else {
        setTimeout(() => res.end(), 2000);
      }
      return;
    }
    if (url.pathname.endsWith('/log')) {
      res.end('2026-09-25T03:02:11.000000000Z first line\n2026-09-25T03:02:12.000000000Z FATAL ERROR: heap out of memory\n');
      return;
    }
    res.statusCode = 404;
    res.end('{"message":"not found"}');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen })));
}

test('informer lists, applies watch events, and relists on 410', async () => {
  const { server, port, seen } = await fakeApi();
  const client = new KubeClient({ endpoint: `127.0.0.1:${port}`, caB64: cert.toString('base64'), getToken: async () => 'tok' });
  const snapshots = [];
  const inf = new Informer(client, 'pods', '/api/v1/namespaces/flobi/pods', { onChange: (k, items) => snapshots.push(items.map((i) => i.metadata.name).sort().join(',')) }).start();
  await new Promise((r) => setTimeout(r, 900));
  inf.stop();
  server.close();
  assert.equal(snapshots[0], 'pod-a');
  assert.ok(snapshots.includes('pod-b'), `after ADDED+DELETED: ${snapshots.join(' | ')}`);
  assert.equal(snapshots[snapshots.length - 1], 'pod-a', 'relisted after 410');
  assert.ok(seen.some((s) => s.includes('watch=1') && s.includes('resourceVersion=10')));
  assert.ok(seen.every((s) => s.startsWith('GET ')));
});

test('previous logs and read-only enforcement', async () => {
  const { server, port } = await fakeApi();
  const client = new KubeClient({ endpoint: `127.0.0.1:${port}`, caB64: cert.toString('base64'), getToken: async () => 'tok' });
  const text = await client.previousLogs({ namespace: 'flobi', pod: 'p', container: 'c' });
  assert.match(text, /heap out of memory/);
  await assert.rejects(() => client.get('/api/v1/namespaces/flobi/secrets'), ReadOnlyViolation);
  await assert.rejects(() => client.get('/api/v1/namespaces/flobi/pods/p/exec?command=sh'), ReadOnlyViolation);
  server.close();
});

test('refuses a server whose certificate does not match the cluster CA', async () => {
  const { server, port } = await fakeApi();
  const other = fs.readFileSync(new URL('./fixtures/tls-cert.pem', import.meta.url));
  const client = new KubeClient({ endpoint: `127.0.0.1:${port}`, caB64: other.toString('base64'), getToken: async () => 'tok' });
  await assert.rejects(() => client.version(), /certificate|self.signed|unable to verify/i);
  server.close();
});
