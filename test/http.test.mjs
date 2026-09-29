// http.mjs: why a stream ended (C17), a stalled or cut-off update download says so
// (C14f), and secrets are scrubbed from messages (C17).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { streamLines, download, redact, errorMessage } from '../electron/core/net/http.mjs';
import { configureGuard } from '../electron/core/net/guard.mjs';

const cert = fs.readFileSync(new URL('./fixtures/k8s-cert.pem', import.meta.url));
const key = fs.readFileSync(new URL('./fixtures/k8s-key.pem', import.meta.url));

function serve(handler) {
  const server = https.createServer({ cert, key }, handler);
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        close() {
          server.closeAllConnections();
          server.close();
        },
      }),
    ),
  );
}

test('streamLines says why a stream ended: the server, stop(), or the network', async () => {
  const srv = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"n":1}\n{"n":2}\n{"n":3}\n');
    if (req.url.includes('timeoutSeconds=1')) return res.end('{"n":4}\n'); // ends normally
    if (req.url.includes('timeoutSeconds=2')) return setTimeout(() => res.socket.destroy(), 30); // connection drops
    // otherwise stays open
  });
  configureGuard({ kubernetesHost: '127.0.0.1' });
  const open = (q, onLine = () => {}) => streamLines({ url: `https://127.0.0.1:${srv.port}/api/v1/namespaces/flobi/pods?watch=1&timeoutSeconds=${q}`, ca: cert, onLine });

  const lines = [];
  assert.deepEqual(await open(1, (l) => lines.push(JSON.parse(l).n)).done, { status: 200, aborted: false });
  assert.deepEqual(lines, [1, 2, 3, 4]);

  assert.deepEqual(await open(2).done, { status: 0, aborted: true, reason: 'network' });

  const got = [];
  let handle = null;
  handle = open(3, (l) => {
    got.push(JSON.parse(l).n);
    handle.abort(); // stop on the first line of a chunk that holds three
  });
  assert.deepEqual(await handle.done, { status: 0, aborted: true, reason: 'stopped' });
  assert.deepEqual(got, [1], 'nothing after abort(), not even the rest of the chunk');
  srv.close();
});

// The update download goes to GitHub's file storage; a test agent points that name at a local server.
const agent = new https.Agent({
  ca: cert,
  checkServerIdentity: () => undefined,
  lookup: (host, opts, cb) => (opts?.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4)),
});
configureGuard({ updateRepo: 'Moh-jbr/flobi-pulse' });

test('update download: stalled and cut-off downloads say so (not just "aborted")', async () => {
  const body = Buffer.alloc(1000, 'u');
  const srv = await serve((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: `https://release-assets.githubusercontent.com:${srv.port}/ok` });
      return res.end();
    }
    res.writeHead(200, { 'content-length': body.length });
    if (req.url === '/ok') return res.end(body);
    res.write(body.subarray(0, 100));
    if (req.url === '/cut') setTimeout(() => res.socket.destroy(), 30);
    // '/stall': nothing more, the connection stays open
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-http-test-'));
  const url = (p) => `https://release-assets.githubusercontent.com:${srv.port}${p}`;
  try {
    const ok = await download({ url: url('/redirect'), file: path.join(dir, 'ok'), agent });
    assert.deepEqual(ok, { sha256: createHash('sha256').update(body).digest('hex'), bytes: 1000 });

    const t0 = Date.now();
    await assert.rejects(download({ url: url('/stall'), file: path.join(dir, 'stall'), idleTimeoutMs: 300, agent }), /The download stalled \(nothing arrived for 0\.3 s\)/);
    assert.ok(Date.now() - t0 < 2000);

    await assert.rejects(download({ url: url('/cut'), file: path.join(dir, 'cut'), agent }), /The download was cut off/);
  } finally {
    srv.close();
    // Windows can hold a just-closed file for a moment: retry instead of failing the run.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('redact: tokens and anything sent as Bearer never reach a message', () => {
  const token = 'cf-0123456789abcdefghijklmnop';
  assert.equal(redact(`bad token ${token}; retry ${token}`, token), 'bad token [redacted]; retry [redacted]');
  assert.equal(redact('proxy echoed Authorization: Bearer ya29.a0AfB_byC-long.token_value'), 'proxy echoed Authorization: Bearer [redacted]');
  assert.equal(redact('HTTP 404 – not found', 'short'), 'HTTP 404 – not found', 'very short "secrets" are ignored');
  assert.equal(redact('HTTP 401 – Missing Bearer authorization header'), 'HTTP 401 – Missing Bearer authorization header', 'words are not tokens');
  assert.equal(redact(undefined), '');
  assert.equal(errorMessage(400, '<html>Authorization: Bearer abcdefgh12345678</html>'), 'HTTP 400 – <html>Authorization: Bearer [redacted]</html>');
  assert.equal(errorMessage(403, '{"error":{"message":"The caller does not have permission"}}'), 'HTTP 403 – The caller does not have permission');
});
