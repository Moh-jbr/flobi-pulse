// The live tail's connection checks (C4): a connection that stops answering pings,
// a server that never answers, TCP keepalive, and a healthy quiet stream.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import { openStream, GRPC_CODE } from '../electron/core/net/grpc.mjs';
import { configureGuard } from '../electron/core/net/guard.mjs';
import { encodeTailRequest } from '../electron/core/net/protobuf.mjs';

const REQ = encodeTailRequest({ resourceNames: ['projects/flobi-prod-2026'] });

const cert = fs.readFileSync(new URL('./fixtures/tls-cert.pem', import.meta.url));
const key = fs.readFileSync(new URL('./fixtures/tls-key.pem', import.meta.url));
const ORIGIN = 'https://logging.googleapis.com';
const PATH = '/google.logging.v2.LoggingServiceV2/TailLogEntries';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

configureGuard({ projectId: 'flobi-prod-2026' });

function startServer(onStream) {
  return new Promise((resolve) => {
    const server = http2.createSecureServer({ cert, key });
    server.on('stream', onStream);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** Plain TCP relay between client and server; blackhole() stops it passing anything (a dead Wi-Fi / VPN route). */
function relay(port) {
  const pairs = [];
  const server = net.createServer((client) => {
    const up = net.connect(port, '127.0.0.1');
    client.pipe(up);
    up.pipe(client);
    client.on('error', () => {});
    up.on('error', () => {});
    pairs.push([client, up]);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        blackhole() {
          for (const [client, up] of pairs) {
            client.unpipe(up);
            up.unpipe(client);
            client.pause();
            up.pause();
          }
        },
        close() {
          for (const [client, up] of pairs) client.destroy(), up.destroy();
          server.close();
        },
      }),
    ),
  );
}

const connectTo = (port, onSocket) => ({
  createConnection: () => {
    const s = tls.connect({ host: '127.0.0.1', port, servername: 'logging.googleapis.com', ca: cert, ALPNProtocols: ['h2'] });
    onSocket?.(s);
    return s;
  },
});

const answer = (stream) => stream.respond({ ':status': 200, 'content-type': 'application/grpc' }); // then quiet, stream stays open

test('a connection that stops answering pings ends with UNAVAILABLE, so the tail reconnects', async () => {
  const server = await startServer(answer);
  const link = await relay(server.address().port);
  let opened = 0;
  const t0 = Date.now();
  const end = await new Promise((resolve) =>
    openStream({
      origin: ORIGIN,
      path: PATH,
      request: REQ,
      onMessage() {},
      onOpen: () => (opened++, link.blackhole()), // the network goes away right after it opened
      onEnd: resolve,
      pingIntervalMs: 100,
      pingTimeoutMs: 200,
      connectOptions: connectTo(link.port),
    }),
  );
  link.close();
  server.close();
  assert.equal(opened, 1);
  assert.equal(end.code, GRPC_CODE.UNAVAILABLE);
  assert.match(end.message, /no answer to a ping/);
  assert.ok(Date.now() - t0 < 1500, 'noticed within a ping interval plus the ack timeout');
});

test('a quiet but healthy stream stays open (pings are answered)', async () => {
  const server = await startServer(answer);
  let end = null;
  const sockets = [];
  const handle = openStream({
    origin: ORIGIN,
    path: PATH,
    request: REQ,
    onMessage() {},
    onEnd: (e) => (end = e),
    pingIntervalMs: 50,
    pingTimeoutMs: 100,
    connectOptions: connectTo(server.address().port, (s) => {
      const real = s.setKeepAlive.bind(s);
      s.setKeepAlive = (...args) => (sockets.push(args), real(...args));
    }),
  });
  await sleep(600); // a dozen pings
  assert.equal(end, null);
  handle.close();
  server.close();
  assert.equal(end.code, GRPC_CODE.CANCELLED);
  assert.deepEqual(sockets, [[true, 30_000]], 'TCP keepalive is on');
});

test('a server that can’t be reached ends with DEADLINE_EXCEEDED instead of waiting forever', async () => {
  // Accepts the TCP connection, then never says anything (not even TLS): nothing proves it's there.
  const sockets = [];
  const server = net.createServer((s) => sockets.push(s));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  let opened = false;
  const t0 = Date.now();
  const end = await new Promise((resolve) =>
    openStream({
      origin: ORIGIN,
      path: PATH,
      request: REQ,
      onMessage() {},
      onOpen: () => (opened = true),
      onEnd: resolve,
      responseTimeoutMs: 200,
      connectOptions: connectTo(server.address().port),
    }),
  );
  for (const s of sockets) s.destroy();
  server.close();
  assert.equal(opened, false);
  assert.equal(end.code, GRPC_CODE.DEADLINE_EXCEEDED);
  assert.match(end.message, /No answer from logging\.googleapis\.com within 0\.2 s/);
  assert.ok(Date.now() - t0 < 1000);
});

test('a server that holds back its headers but answers pings stays open (a quiet tail)', async () => {
  // Some gRPC servers send the response headers with their first message only; a tail can
  // be quiet for minutes. A connected server that answers pings is alive.
  const streams = [];
  const server = await startServer((stream) => streams.push(stream)); // never responds
  let end = null;
  const handle = openStream({
    origin: ORIGIN,
    path: PATH,
    request: REQ,
    onMessage() {},
    onEnd: (e) => (end = e),
    responseTimeoutMs: 200,
    connectOptions: connectTo(server.address().port),
  });
  await sleep(600);
  assert.equal(end, null, 'still open well past responseTimeoutMs');
  handle.close();
  for (const st of streams) st.destroy();
  server.close();
  assert.equal(end.code, GRPC_CODE.CANCELLED);
});
