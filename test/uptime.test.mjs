// Uptime checks (C10): an answer cut off mid-body is "down", not "up".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs';
import { checkUrl, classifyUptime } from '../electron/core/sources/uptime.mjs';
import { configureGuard } from '../electron/core/net/guard.mjs';

const cert = fs.readFileSync(new URL('./fixtures/k8s-cert.pem', import.meta.url)); // valid for 127.0.0.1
const key = fs.readFileSync(new URL('./fixtures/k8s-key.pem', import.meta.url));

async function site() {
  const server = https.createServer({ cert, key }, (req, res) => {
    if (req.url === '/ok') return res.end('fine');
    if (req.url === '/big') return res.end(Buffer.alloc(600 * 1024, 'x')); // read only up to 256 KB
    if (req.url === '/cut') {
      res.writeHead(200, { 'content-length': 1000 });
      res.write('only ten b');
      return setTimeout(() => res.socket.destroy(), 20);
    }
    if (req.url === '/cut-chunked') {
      res.writeHead(200, { 'content-type': 'text/html' }); // chunked
      res.write('<html>half a page');
      return setTimeout(() => res.socket.destroy(), 20);
    }
    res.statusCode = 503;
    res.end('down');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `https://127.0.0.1:${server.address().port}`;
  const urls = ['/ok', '/big', '/cut', '/cut-chunked', '/503'].map((p) => base + p);
  configureGuard({ uptimeUrls: urls });
  return { server, url: (p) => base + p };
}

test('a response cut off mid-body is down, with a plain reason', async () => {
  const { server, url } = await site();
  try {
    for (const p of ['/cut', '/cut-chunked']) {
      const r = await checkUrl(url(p), { ca: cert });
      assert.equal(r.status, 200);
      assert.equal(r.error, 'The response was cut off', p);
      assert.equal(classifyUptime(r), 'down', p);
    }
  } finally {
    server.close();
  }
});

test('complete answers are judged as before (a big page is read only in part and still up)', async () => {
  const { server, url } = await site();
  try {
    const ok = await checkUrl(url('/ok'), { ca: cert });
    assert.equal(ok.error, undefined);
    assert.equal(classifyUptime(ok), 'up');
    assert.ok(Number.isFinite(ok.certDaysLeft));
    const big = await checkUrl(url('/big'), { ca: cert });
    assert.equal(big.error, undefined);
    assert.equal(classifyUptime(big), 'up');
    const down = await checkUrl(url('/503'), { ca: cert });
    assert.equal(classifyUptime(down), 'down');
  } finally {
    server.close();
  }
});
