import { test } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import tls from 'node:tls';
import fs from 'node:fs';
import { openStream, frameMessage, FrameParser, GRPC_CODE } from '../electron/core/net/grpc.mjs';
import { configureGuard } from '../electron/core/net/guard.mjs';
import { encodeTailRequest } from '../electron/core/net/protobuf.mjs';

const REQ = encodeTailRequest({ resourceNames: ['projects/flobi-prod-2026'] });

const cert = fs.readFileSync(new URL('./fixtures/tls-cert.pem', import.meta.url));
const key = fs.readFileSync(new URL('./fixtures/tls-key.pem', import.meta.url));
const PATH = '/google.logging.v2.LoggingServiceV2/TailLogEntries';

configureGuard({ projectId: 'flobi-prod-2026' });

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http2.createSecureServer({ cert, key, allowHTTP1: false });
    server.on('stream', handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// Points the real origin (so the guard sees logging.googleapis.com) at the local test server.
const connectTo = (port) => ({
  createConnection: () => tls.connect({ host: '127.0.0.1', port, servername: 'logging.googleapis.com', ca: cert, ALPNProtocols: ['h2'] }),
});

test('frame parser handles split and coalesced frames', () => {
  const p = new FrameParser();
  const a = frameMessage(Buffer.from('hello'));
  const b = frameMessage(Buffer.from('world!'));
  const all = Buffer.concat([a, b]);
  assert.deepEqual(p.push(all.subarray(0, 3)), []);
  const out = p.push(all.subarray(3));
  assert.deepEqual(out.map((m) => m.data.toString()), ['hello', 'world!']);
});

test('streams messages and reports trailers status', async () => {
  let received;
  const server = await startServer((stream, headers) => {
    assert.equal(headers['content-type'], 'application/grpc');
    assert.equal(headers.authorization, 'Bearer T');
    const parser = new FrameParser();
    stream.on('data', (c) => {
      for (const m of parser.push(c)) {
        received = m.data.toString();
        stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
        stream.write(frameMessage(Buffer.from('one')));
        stream.write(frameMessage(Buffer.from('two')));
        stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }));
        stream.end();
      }
    });
  });
  const port = server.address().port;
  const messages = [];
  const end = await new Promise((resolve) => {
    openStream({
      origin: 'https://logging.googleapis.com',
      path: PATH,
      headers: { authorization: 'Bearer T' },
      request: REQ,
      onMessage: (m) => messages.push(m.toString()),
      onEnd: resolve,
      connectOptions: connectTo(port),
    });
  });
  server.close();
  assert.equal(received, REQ.toString());
  assert.deepEqual(messages, ['one', 'two']);
  assert.equal(end.code, GRPC_CODE.OK);
});

test('surfaces RESOURCE_EXHAUSTED (all live-tail slots in use)', async () => {
  const server = await startServer((stream) => {
    stream.respond({
      ':status': 200,
      'content-type': 'application/grpc',
      'grpc-status': String(GRPC_CODE.RESOURCE_EXHAUSTED),
      'grpc-message': encodeURIComponent('Quota exceeded: live tail sessions'),
    }, { endStream: true });
  });
  const port = server.address().port;
  const end = await new Promise((resolve) => {
    openStream({
      origin: 'https://logging.googleapis.com',
      path: PATH,
      request: REQ,
      onMessage: () => {},
      onEnd: resolve,
      connectOptions: connectTo(port),
    });
  });
  server.close();
  assert.equal(end.code, GRPC_CODE.RESOURCE_EXHAUSTED);
  assert.equal(end.codeName, 'RESOURCE_EXHAUSTED');
  assert.match(end.message, /live tail sessions/);
});

test('the guard refuses any other gRPC method', () => {
  assert.throws(() =>
    openStream({ origin: 'https://logging.googleapis.com', path: '/google.logging.v2.LoggingServiceV2/WriteLogEntries', request: Buffer.alloc(0), onMessage() {}, onEnd() {} }),
  );
});
