// Tiny protobuf codec for the few Cloud Logging messages Flobi Pulse needs for
// live tailing. Field numbers come from googleapis:
//   google/logging/v2/logging.proto        (TailLogEntriesRequest/Response)
//   google/logging/v2/log_entry.proto      (LogEntry)
//   google/logging/type/http_request.proto (HttpRequest)
//   google/protobuf/{struct,timestamp,duration,any}.proto
//   google/api/monitored_resource.proto    (MonitoredResource)
// Unknown fields are skipped, so the decoder keeps working if Google adds fields.

// ── Writer ───────────────────────────────────────────────────────────────────
export class Writer {
  constructor() {
    this.parts = [];
  }
  _push(buf) {
    this.parts.push(buf);
    return this;
  }
  varint(value) {
    let v = BigInt.asUintN(64, BigInt(value));
    const bytes = [];
    while (v > 0x7fn) {
      bytes.push(Number((v & 0x7fn) | 0x80n));
      v >>= 7n;
    }
    bytes.push(Number(v));
    return this._push(Buffer.from(bytes));
  }
  tag(field, wire) {
    return this.varint((field << 3) | wire);
  }
  string(field, s) {
    if (s == null) return this;
    const b = Buffer.from(String(s), 'utf8');
    return this.tag(field, 2).varint(b.length)._push(b);
  }
  bytes(field, b) {
    return this.tag(field, 2).varint(b.length)._push(b);
  }
  int(field, n) {
    if (n == null) return this;
    return this.tag(field, 0).varint(n);
  }
  bool(field, v) {
    if (v == null) return this;
    return this.tag(field, 0).varint(v ? 1 : 0);
  }
  double(field, n) {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(n);
    return this.tag(field, 1)._push(b);
  }
  message(field, build) {
    const w = new Writer();
    build(w);
    return this.bytes(field, w.finish());
  }
  finish() {
    return Buffer.concat(this.parts);
  }
}

// ── Reader ───────────────────────────────────────────────────────────────────
export class Reader {
  constructor(buf, start = 0, end = buf.length) {
    this.buf = buf;
    this.pos = start;
    this.end = end;
  }
  eof() {
    return this.pos >= this.end;
  }
  varintBig() {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new Error('protobuf: truncated varint');
      const b = this.buf[this.pos++];
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result;
      shift += 7n;
    }
    throw new Error('protobuf: varint too long');
  }
  varint() {
    // Fast path for small values.
    let result = 0;
    let shift = 0;
    const start = this.pos;
    while (this.pos < this.end && shift < 28) {
      const b = this.buf[this.pos++];
      result |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) return result >>> 0;
      shift += 7;
    }
    this.pos = start;
    return Number(BigInt.asIntN(64, this.varintBig()));
  }
  tag() {
    const t = this.varint();
    return { field: t >>> 3, wire: t & 7 };
  }
  lengthDelimited() {
    const len = this.varint();
    const start = this.pos;
    this.pos += len;
    if (this.pos > this.end) throw new Error('protobuf: truncated length-delimited field');
    return [start, this.pos];
  }
  bytes() {
    const [s, e] = this.lengthDelimited();
    return this.buf.subarray(s, e);
  }
  string() {
    const [s, e] = this.lengthDelimited();
    return this.buf.toString('utf8', s, e);
  }
  sub() {
    const [s, e] = this.lengthDelimited();
    return new Reader(this.buf, s, e);
  }
  double() {
    const v = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return v;
  }
  skip(wire) {
    switch (wire) {
      case 0:
        this.varintBig();
        break;
      case 1:
        this.pos += 8;
        break;
      case 2:
        this.lengthDelimited();
        break;
      case 5:
        this.pos += 4;
        break;
      default:
        throw new Error(`protobuf: unsupported wire type ${wire}`);
    }
    if (this.pos > this.end) throw new Error('protobuf: truncated field');
  }
}

// ── google.protobuf.* ────────────────────────────────────────────────────────
export function decodeTimestamp(r) {
  let seconds = 0;
  let nanos = 0;
  while (!r.eof()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 0) seconds = r.varint();
    else if (field === 2 && wire === 0) nanos = r.varint();
    else r.skip(wire);
  }
  return seconds * 1000 + Math.floor(nanos / 1e6);
}

export function decodeDuration(r) {
  let seconds = 0;
  let nanos = 0;
  while (!r.eof()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 0) seconds = r.varint();
    else if (field === 2 && wire === 0) nanos = r.varint();
    else r.skip(wire);
  }
  return seconds + nanos / 1e9;
}

export function decodeValue(r) {
  let value = null;
  while (!r.eof()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 0) {
      r.varint();
      value = null;
    } else if (field === 2 && wire === 1) value = r.double();
    else if (field === 3 && wire === 2) value = r.string();
    else if (field === 4 && wire === 0) value = r.varint() !== 0;
    else if (field === 5 && wire === 2) value = decodeStruct(r.sub());
    else if (field === 6 && wire === 2) value = decodeListValue(r.sub());
    else r.skip(wire);
  }
  return value;
}

export function decodeListValue(r) {
  const out = [];
  while (!r.eof()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) out.push(decodeValue(r.sub()));
    else r.skip(wire);
  }
  return out;
}

export function decodeStruct(r) {
  const out = {};
  while (!r.eof()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) {
      const entry = r.sub();
      let key = '';
      let val = null;
      while (!entry.eof()) {
        const t = entry.tag();
        if (t.field === 1 && t.wire === 2) key = entry.string();
        else if (t.field === 2 && t.wire === 2) val = decodeValue(entry.sub());
        else entry.skip(t.wire);
      }
      out[key] = val;
    } else r.skip(wire);
  }
  return out;
}

function decodeStringMapEntry(r) {
  let key = '';
  let val = '';
  while (!r.eof()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) key = r.string();
    else if (field === 2 && wire === 2) val = r.string();
    else r.skip(wire);
  }
  return [key, val];
}

function decodeAny(r) {
  let typeUrl = '';
  while (!r.eof()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) typeUrl = r.string();
    else r.skip(wire);
  }
  return { '@type': typeUrl };
}

// ── google.api.MonitoredResource ─────────────────────────────────────────────
function decodeMonitoredResource(r) {
  const res = { type: '', labels: {} };
  while (!r.eof()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) res.type = r.string();
    else if (field === 2 && wire === 2) {
      const [k, v] = decodeStringMapEntry(r.sub());
      res.labels[k] = v;
    } else r.skip(wire);
  }
  return res;
}

// ── google.logging.type.HttpRequest ──────────────────────────────────────────
function decodeHttpRequest(r) {
  const h = {};
  while (!r.eof()) {
    const { field, wire } = r.tag();
    switch (field) {
      case 1: h.requestMethod = r.string(); break;
      case 2: h.requestUrl = r.string(); break;
      case 3: h.requestSize = r.varint(); break;
      case 4: h.status = r.varint(); break;
      case 5: h.responseSize = r.varint(); break;
      case 6: h.userAgent = r.string(); break;
      case 7: h.remoteIp = r.string(); break;
      case 8: h.referer = r.string(); break;
      case 9: h.cacheHit = r.varint() !== 0; break;
      case 10: h.cacheValidatedWithOriginServer = r.varint() !== 0; break;
      case 11: h.cacheLookup = r.varint() !== 0; break;
      case 12: h.cacheFillBytes = r.varint(); break;
      case 13: h.serverIp = r.string(); break;
      case 14: h.latencySeconds = decodeDuration(r.sub()); break;
      case 15: h.protocol = r.string(); break;
      default: r.skip(wire);
    }
  }
  return h;
}

export const SEVERITY = {
  0: 'DEFAULT',
  100: 'DEBUG',
  200: 'INFO',
  300: 'NOTICE',
  400: 'WARNING',
  500: 'ERROR',
  600: 'CRITICAL',
  700: 'ALERT',
  800: 'EMERGENCY',
};

// ── google.logging.v2.LogEntry ───────────────────────────────────────────────
// Produces the same shape as the REST JSON representation (camelCase), so the
// rest of the app handles tailed and listed entries identically.
export function decodeLogEntry(r) {
  const e = { labels: {} };
  while (!r.eof()) {
    const { field, wire } = r.tag();
    switch (field) {
      case 2: e.protoPayload = decodeAny(r.sub()); break;
      case 3: e.textPayload = r.string(); break;
      case 4: e.insertId = r.string(); break;
      case 6: e.jsonPayload = decodeStruct(r.sub()); break;
      case 7: e.httpRequest = decodeHttpRequest(r.sub()); break;
      case 8: e.resource = decodeMonitoredResource(r.sub()); break;
      case 9: e.timestampMs = decodeTimestamp(r.sub()); break;
      case 10: e.severity = SEVERITY[r.varint()] || 'DEFAULT'; break;
      case 11: {
        const [k, v] = decodeStringMapEntry(r.sub());
        e.labels[k] = v;
        break;
      }
      case 12: e.logName = r.string(); break;
      case 22: e.trace = r.string(); break;
      case 23: {
        const s = r.sub();
        const loc = {};
        while (!s.eof()) {
          const t = s.tag();
          if (t.field === 1 && t.wire === 2) loc.file = s.string();
          else if (t.field === 2 && t.wire === 0) loc.line = s.varint();
          else if (t.field === 3 && t.wire === 2) loc.function = s.string();
          else s.skip(t.wire);
        }
        e.sourceLocation = loc;
        break;
      }
      case 24: e.receiveTimestampMs = decodeTimestamp(r.sub()); break;
      case 27: e.spanId = r.string(); break;
      default: r.skip(wire);
    }
  }
  if (!e.severity) e.severity = 'DEFAULT';
  return e;
}

// ── TailLogEntries ───────────────────────────────────────────────────────────
export function encodeTailRequest({ resourceNames, filter, bufferWindowSeconds }) {
  const w = new Writer();
  for (const name of resourceNames) w.string(1, name);
  if (filter) w.string(2, filter);
  if (bufferWindowSeconds) w.message(3, (d) => d.int(1, Math.floor(bufferWindowSeconds)));
  return w.finish();
}

export const SUPPRESSION_REASON = { 0: 'unspecified', 1: 'rate_limit', 2: 'not_consumed' };

export function decodeTailResponse(buf) {
  const r = new Reader(buf);
  const entries = [];
  const suppression = [];
  while (!r.eof()) {
    const { field, wire } = r.tag();
    if (field === 1 && wire === 2) entries.push(decodeLogEntry(r.sub()));
    else if (field === 2 && wire === 2) {
      const s = r.sub();
      const info = { reason: 'unspecified', count: 0 };
      while (!s.eof()) {
        const t = s.tag();
        if (t.field === 1 && t.wire === 0) info.reason = SUPPRESSION_REASON[s.varint()] || 'unspecified';
        else if (t.field === 2 && t.wire === 0) info.count = s.varint();
        else s.skip(t.wire);
      }
      suppression.push(info);
    } else r.skip(wire);
  }
  return { entries, suppression };
}
