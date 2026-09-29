// A logged "__proto__" key must stay a key (C12), in Structs and label maps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writer, decodeTailResponse } from '../electron/core/net/protobuf.mjs';

// Struct.fields entry: key (1) → Value (2).
const structEntry = (w, k, build) => w.message(1, (e) => e.string(1, k).message(2, build));

test('"__proto__" in a jsonPayload, labels and resource labels is kept as an own key', () => {
  const entry = new Writer()
    .message(6, (s) => {
      structEntry(s, '__proto__', (v) => v.message(5, (inner) => structEntry(inner, 'polluted', (x) => x.bool(4, true))));
      structEntry(s, 'msg', (v) => v.string(3, 'hello'));
    })
    .message(11, (e) => e.string(1, '__proto__').string(2, 'label-value'))
    .message(8, (m) => m.string(1, 'k8s_container').message(2, (e) => e.string(1, '__proto__').string(2, 'res-value')));
  const e = decodeTailResponse(new Writer().message(1, (x) => x._push(entry.finish())).finish()).entries[0];

  assert.equal(Object.getPrototypeOf(e.jsonPayload), Object.prototype, 'the prototype is untouched');
  assert.equal(e.jsonPayload.polluted, undefined);
  assert.equal(e.jsonPayload.msg, 'hello');
  assert.ok(Object.hasOwn(e.jsonPayload, '__proto__'));
  assert.deepEqual(Object.getOwnPropertyDescriptor(e.jsonPayload, '__proto__').value, { polluted: true });
  assert.equal(JSON.stringify(e.jsonPayload), '{"__proto__":{"polluted":true},"msg":"hello"}', 'same as JSON.parse would give');
  assert.equal(Object.getOwnPropertyDescriptor(e.labels, '__proto__').value, 'label-value');
  assert.equal(Object.getOwnPropertyDescriptor(e.resource.labels, '__proto__').value, 'res-value');
  assert.equal({}.polluted, undefined, 'nothing global changed');
});
