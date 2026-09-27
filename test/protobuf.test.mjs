import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writer, Reader, decodeTailResponse, encodeTailRequest } from '../electron/core/net/protobuf.mjs';

// Independent encoders for test vectors, using the field numbers from
// googleapis log_entry.proto / http_request.proto / struct.proto.
function encValue(w, v) {
  if (v === null) return w.int(1, 0);
  if (typeof v === 'number') return w.double(2, v);
  if (typeof v === 'string') return w.string(3, v);
  if (typeof v === 'boolean') return w.bool(4, v);
  if (Array.isArray(v)) return w.message(6, (l) => v.forEach((x) => l.message(1, (vw) => encValue(vw, x))));
  return w.message(5, (s) => encStruct(s, v));
}
function encStruct(w, obj) {
  for (const [k, v] of Object.entries(obj)) w.message(1, (e) => e.string(1, k).message(2, (vw) => encValue(vw, v)));
  return w;
}
function encTimestamp(w, field, ms) {
  return w.message(field, (t) => t.int(1, Math.floor(ms / 1000)).int(2, (ms % 1000) * 1e6));
}

test('varint round-trips small, large and 64-bit values', () => {
  for (const n of [0, 1, 127, 128, 300, 2 ** 31 - 1, 2 ** 32 + 5, 2 ** 52]) {
    const buf = new Writer().varint(n).finish();
    assert.equal(new Reader(buf).varint(), n);
  }
  const neg = new Writer().varint(-1).finish();
  assert.equal(neg.length, 10);
  assert.equal(new Reader(neg).varint(), -1);
});

test('encodeTailRequest encodes resource names, filter and buffer window', () => {
  const buf = encodeTailRequest({ resourceNames: ['projects/flobi-prod-2026'], filter: 'severity>=ERROR', bufferWindowSeconds: 2 });
  const r = new Reader(buf);
  let t = r.tag();
  assert.deepEqual([t.field, t.wire], [1, 2]);
  assert.equal(r.string(), 'projects/flobi-prod-2026');
  t = r.tag();
  assert.deepEqual([t.field, t.wire], [2, 2]);
  assert.equal(r.string(), 'severity>=ERROR');
  t = r.tag();
  assert.deepEqual([t.field, t.wire], [3, 2]);
  const d = r.sub();
  const dt = d.tag();
  assert.deepEqual([dt.field, dt.wire], [1, 0]);
  assert.equal(d.varint(), 2);
  assert.ok(r.eof());
});

test('decodes a load-balancer request log entry', () => {
  const ts = Date.UTC(2026, 8, 25, 3, 2, 11, 250);
  const entry = new Writer()
    .string(12, 'projects/flobi-prod-2026/logs/requests')
    .message(8, (m) =>
      m
        .string(1, 'http_load_balancer')
        .message(2, (e) => e.string(1, 'backend_service_name').string(2, 'k8s1-abc-flobi-flobi-gateway-80-xyz'))
        .message(2, (e) => e.string(1, 'project_id').string(2, 'flobi-prod-2026')),
    )
    .message(6, (s) => encStruct(s, { statusDetails: 'response_sent_by_backend', '@type': 'lb', nested: { n: 3, ok: true, list: ['a', 1, null] } }))
    .message(7, (h) =>
      h
        .string(1, 'POST')
        .string(2, 'https://api.flobi.ai/brand/extract?x=1')
        .int(3, 1234)
        .int(4, 502)
        .int(5, 9_000_000_000)
        .string(6, 'Mozilla/5.0')
        .string(7, '172.70.1.2')
        .string(8, 'https://app.flobi.ai/')
        .bool(9, false)
        .message(14, (d) => d.int(1, 1).int(2, 250_000_000))
        .string(15, 'HTTP/1.1'),
    )
    .string(4, 'abc123')
    .int(10, 500)
    .message(11, (e) => e.string(1, 'k').string(2, 'v'))
    .string(22, 'projects/flobi-prod-2026/traces/t1')
    .int(99, 7); // an unknown field must be skipped
  encTimestamp(entry, 9, ts);
  encTimestamp(entry, 24, ts + 900);

  const response = new Writer()
    .message(1, (w) => w._push(entry.finish()))
    .message(2, (s) => s.int(1, 1).int(2, 42))
    .finish();

  const { entries, suppression } = decodeTailResponse(response);
  assert.equal(entries.length, 1);
  const e = entries[0];
  assert.equal(e.logName, 'projects/flobi-prod-2026/logs/requests');
  assert.equal(e.resource.type, 'http_load_balancer');
  assert.equal(e.resource.labels.backend_service_name, 'k8s1-abc-flobi-flobi-gateway-80-xyz');
  assert.equal(e.jsonPayload.statusDetails, 'response_sent_by_backend');
  assert.deepEqual(e.jsonPayload.nested, { n: 3, ok: true, list: ['a', 1, null] });
  assert.equal(e.httpRequest.requestMethod, 'POST');
  assert.equal(e.httpRequest.status, 502);
  assert.equal(e.httpRequest.requestSize, 1234);
  assert.equal(e.httpRequest.responseSize, 9_000_000_000);
  assert.equal(e.httpRequest.remoteIp, '172.70.1.2');
  assert.equal(e.httpRequest.latencySeconds, 1.25);
  assert.equal(e.httpRequest.protocol, 'HTTP/1.1');
  assert.equal(e.insertId, 'abc123');
  assert.equal(e.severity, 'ERROR');
  assert.equal(e.labels.k, 'v');
  assert.equal(e.timestampMs, ts);
  assert.equal(e.receiveTimestampMs, ts + 900);
  assert.equal(e.trace, 'projects/flobi-prod-2026/traces/t1');
  assert.deepEqual(suppression, [{ reason: 'rate_limit', count: 42 }]);
});

test('decodes a container text log entry', () => {
  const w = new Writer()
    .string(3, '[Nest] 1  - 09/25/2026 ERROR [BrandService] boom')
    .message(8, (m) => m.string(1, 'k8s_container').message(2, (e) => e.string(1, 'container_name').string(2, 'flobi-brand')));
  const e = decodeTailResponse(new Writer().message(1, (x) => x._push(w.finish())).finish()).entries[0];
  assert.equal(e.textPayload, '[Nest] 1  - 09/25/2026 ERROR [BrandService] boom');
  assert.equal(e.severity, 'DEFAULT');
  assert.equal(e.resource.labels.container_name, 'flobi-brand');
});

test('truncated input throws instead of looping', () => {
  const buf = new Writer().string(3, 'hello world').finish().subarray(0, 5);
  assert.throws(() => decodeTailResponse(new Writer().bytes(1, buf).finish()));
});
