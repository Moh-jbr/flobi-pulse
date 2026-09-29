// A minimal gRPC-over-HTTP/2 client (only what Cloud Logging's TailLogEntries
// needs), built on node:http2 so the app ships without a gRPC library.
//
// gRPC framing: each message is prefixed by 1 byte "compressed" flag and a
// 4-byte big-endian length. Status arrives in HTTP/2 trailers (grpc-status,
// grpc-message) or, for immediate failures, in the response headers.
import http2 from 'node:http2';
import zlib from 'node:zlib';
import { checkRequest } from './guard.mjs';

export const GRPC_CODE = {
  OK: 0,
  CANCELLED: 1,
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  ABORTED: 10,
  OUT_OF_RANGE: 11,
  UNIMPLEMENTED: 12,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  DATA_LOSS: 15,
  UNAUTHENTICATED: 16,
};
const CODE_NAME = Object.fromEntries(Object.entries(GRPC_CODE).map(([k, v]) => [v, k]));

export function frameMessage(buf) {
  const header = Buffer.alloc(5);
  header.writeUInt8(0, 0);
  header.writeUInt32BE(buf.length, 1);
  return Buffer.concat([header, buf]);
}

/** Incremental parser for length-prefixed gRPC messages. */
export class FrameParser {
  constructor(maxMessageBytes = 64 * 1024 * 1024) {
    this.buf = Buffer.alloc(0);
    this.max = maxMessageBytes;
  }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    while (this.buf.length >= 5) {
      const compressed = this.buf.readUInt8(0) === 1;
      const len = this.buf.readUInt32BE(1);
      if (len > this.max) throw new Error(`gRPC message too large (${len} bytes)`);
      if (this.buf.length < 5 + len) break;
      out.push({ compressed, data: this.buf.subarray(5, 5 + len) });
      this.buf = this.buf.subarray(5 + len);
    }
    return out;
  }
}

function decodeGrpcMessage(v) {
  if (!v) return '';
  try {
    return decodeURIComponent(String(v));
  } catch {
    return String(v);
  }
}

export class GrpcError extends Error {
  constructor(code, message) {
    super(message || CODE_NAME[code] || `gRPC error ${code}`);
    this.name = 'GrpcError';
    this.code = code;
    this.codeName = CODE_NAME[code] || 'UNKNOWN';
  }
}

/**
 * Opens a client→server + server→client stream, sends one request message and
 * keeps the stream open. onMessage receives each decoded (decompressed) message
 * payload. onEnd is called exactly once with a GrpcError (code OK on clean end).
 *
 * The read-only guard checks the (protobuf) request bytes themselves, exactly as sent.
 *
 * A quiet stream looks the same as a dead one, so the connection is checked: an
 * HTTP/2 ping every pingIntervalMs must be answered within pingTimeoutMs, the server
 * must be reachable (answer headers or a first ping) within responseTimeoutMs, and TCP
 * keepalive is on. Otherwise the stream ends with UNAVAILABLE / DEADLINE_EXCEEDED and
 * the caller reconnects. (Headers alone can't be the test: a gRPC server may hold them
 * back until its first message, and a tail can be quiet for minutes.)
 */
export function openStream({ origin, path, headers = {}, request, onMessage, onOpen, onEnd, pingIntervalMs = 30_000, pingTimeoutMs = 10_000, responseTimeoutMs = 20_000, connectOptions }) {
  checkRequest({ method: 'POST', url: origin + path, headers, body: request });

  const host = new URL(origin).host;
  let ended = false;
  let pingTimer = null;
  let pingDeadline = null;
  let responseTimer = null;
  let encoding = 'identity';
  const parser = new FrameParser();

  const session = http2.connect(origin, connectOptions);
  const finish = (err) => {
    if (ended) return;
    ended = true;
    clearInterval(pingTimer);
    clearTimeout(pingDeadline);
    clearTimeout(responseTimer);
    try {
      session.destroy();
    } catch {}
    onEnd?.(err);
  };

  // After a Wi-Fi or VPN switch the old socket can look open for a quarter of an
  // hour; keepalive lets the OS notice a peer that's gone.
  session.on('connect', (_session, socket) => {
    try {
      socket.setKeepAlive(true, 30_000);
    } catch {}
    // Connected: a first ping answered proves the server is there, headers or not.
    try {
      session.ping((err) => {
        if (!err) clearTimeout(responseTimer);
      });
    } catch {}
  });
  session.on('error', (e) => finish(new GrpcError(GRPC_CODE.UNAVAILABLE, e.message)));
  session.on('goaway', () => {
    /* server will close the stream; 'close' handles it */
  });

  const stream = session.request(
    {
      ':method': 'POST',
      ':path': path,
      'content-type': 'application/grpc',
      te: 'trailers',
      'grpc-accept-encoding': 'identity,gzip',
      'user-agent': 'flobi-pulse/1.0 (hand-rolled grpc)',
      ...headers,
    },
    { endStream: false },
  );

  // Connecting, TLS and a first sign of life must not hang forever either.
  responseTimer = setTimeout(() => finish(new GrpcError(GRPC_CODE.DEADLINE_EXCEEDED, `No answer from ${host} within ${responseTimeoutMs / 1000} s`)), responseTimeoutMs);
  responseTimer.unref?.();

  stream.on('response', (h) => {
    clearTimeout(responseTimer);
    const status = Number(h[':status']);
    if (h['grpc-encoding']) encoding = String(h['grpc-encoding']);
    if (h['grpc-status'] !== undefined) {
      const code = Number(h['grpc-status']);
      finish(new GrpcError(code, decodeGrpcMessage(h['grpc-message'])));
      return;
    }
    if (status !== 200) {
      finish(new GrpcError(status === 401 ? GRPC_CODE.UNAUTHENTICATED : status === 403 ? GRPC_CODE.PERMISSION_DENIED : GRPC_CODE.UNAVAILABLE, `HTTP ${status}`));
      return;
    }
    try {
      onOpen?.();
    } catch {}
  });

  stream.on('data', (chunk) => {
    let msgs;
    try {
      msgs = parser.push(chunk);
    } catch (e) {
      finish(new GrpcError(GRPC_CODE.INTERNAL, e.message));
      stream.close(http2.constants.NGHTTP2_CANCEL);
      return;
    }
    for (const m of msgs) {
      let data = m.data;
      if (m.compressed) {
        try {
          data = encoding === 'gzip' ? zlib.gunzipSync(data) : data;
        } catch (e) {
          finish(new GrpcError(GRPC_CODE.INTERNAL, `decompress failed: ${e.message}`));
          return;
        }
      }
      try {
        onMessage(data);
      } catch (e) {
        console.warn('[grpc] message handler failed:', e?.message);
      }
    }
  });

  stream.on('trailers', (t) => {
    const code = t['grpc-status'] !== undefined ? Number(t['grpc-status']) : GRPC_CODE.UNKNOWN;
    finish(new GrpcError(code, decodeGrpcMessage(t['grpc-message'])));
  });
  stream.on('error', (e) => finish(new GrpcError(GRPC_CODE.UNAVAILABLE, e.message)));
  stream.on('close', () => finish(new GrpcError(GRPC_CODE.UNAVAILABLE, 'stream closed')));

  stream.write(frameMessage(request));

  // A tail can be silent for minutes, so silence proves nothing: a ping that isn't
  // answered in time means the connection is dead. (A ping sent while still
  // connecting is cancelled by node, so those rounds are skipped.)
  const lost = (why) => finish(new GrpcError(GRPC_CODE.UNAVAILABLE, `Lost the connection to ${host} (${why})`));
  pingTimer = setInterval(() => {
    if (ended || pingDeadline || session.connecting) return;
    pingDeadline = setTimeout(() => lost(`no answer to a ping for ${pingTimeoutMs / 1000} s`), pingTimeoutMs);
    pingDeadline.unref?.();
    try {
      session.ping((err) => {
        clearTimeout(pingDeadline);
        pingDeadline = null;
        if (err) lost(err.message);
      });
    } catch (e) {
      lost(e.message);
    }
  }, pingIntervalMs);
  pingTimer.unref?.();

  return {
    close() {
      if (ended) return;
      try {
        stream.close(http2.constants.NGHTTP2_CANCEL);
      } catch {}
      finish(new GrpcError(GRPC_CODE.CANCELLED, 'closed by client'));
    },
  };
}
