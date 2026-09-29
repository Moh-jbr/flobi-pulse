import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorBook, fingerprint, fingerprintV1, normalizeMessage } from '../electron/core/engine/errors.mjs';
import { detectLevel, isStackFrame, isExceptionHeader, DB_CONN_ERROR } from '../electron/core/engine/log-parse.mjs';
import { normalizeEntry, k8sLogLine, workloadFromPodName } from '../electron/core/engine/normalize.mjs';
import { workloadOf } from '../electron/core/engine/model.mjs';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const T0 = Date.UTC(2026, 8, 25, 10, 0, 0);
const POD = 'flobi-brand-7d9f8c6b5-x2x9z';

/** A container log entry as Cloud Logging returns it. */
const entry = (text, { ts = T0, pod = POD, container = 'flobi-brand', severity = 'ERROR', json, stream } = {}) => ({
  insertId: `i${ts}${Math.random()}`,
  timestampMs: ts,
  severity,
  ...(stream ? { logName: `projects/flobi-prod-2026/logs/${stream}` } : {}),
  resource: { type: 'k8s_container', labels: { namespace_name: 'flobi', pod_name: pod, container_name: container } },
  ...(json ? { jsonPayload: json } : { textPayload: text }),
});
const errorLine = (text, ts = T0, extra = {}) => ({ level: 'ERROR', text, service: 's', pod: 'p', ts, ...extra });

// The exact reproduction: one Nest exception, every stdout/stderr line its own GKE entry.
const NEST_EXCEPTION = [
  "[Nest] 1  - 09/25/2026, 10:00:00 AM   ERROR [ExceptionsHandler] Cannot read properties of undefined (reading 'x')",
  "TypeError: Cannot read properties of undefined (reading 'x')",
  '    at BrandService.extract (/app/dist/brand/brand.service.js:42:17)',
  '    at async BrandController.extract (/app/dist/brand/brand.controller.js:20:5)',
  '    at Object.handler [as handle] (/app/dist/x.js:1:2)',
  '    at new Promise (<anonymous>)',
  '    at async /app/node_modules/@nestjs/core/router/router-execution-context.js:46:28',
  '    at node:internal/process/task_queues:95:5',
];

test('B1: one Nest exception printed line by line is one error group, with the exception and all frames as its stack', () => {
  const book = new ErrorBook({ known: { other: 1 }, now: T0 });
  const results = NEST_EXCEPTION.map((text, i) => book.add(normalizeEntry(entry(text, { ts: T0 + i }), { namespace: 'flobi' })));
  assert.equal(results.filter(Boolean).length, 1, 'only the Nest line is an error of its own');
  assert.equal(results[0].isNewGroup, true);
  const groups = book.summary(T0 + 1000);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].title, "Cannot read properties of undefined (reading 'x')");
  assert.equal(groups[0].context, 'ExceptionsHandler');
  assert.equal(groups[0].count, 1);
  assert.deepEqual(groups[0].stack, NEST_EXCEPTION.slice(1).map((l) => l.trim()));
});

test('B1: every V8 frame shape is a stack frame and an ERROR line; other lines are not frames', () => {
  const frames = [
    ...NEST_EXCEPTION.slice(2),
    '    at Array.map (<anonymous>)',
    '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
    '    at /app/dist/main.js:10:5',
    '    at file:///app/dist/main.mjs:10:5',
    '    at async Promise.all (index 0)',
    '    at eval (eval at <anonymous> (/app/x.js:1:1), <anonymous>:1:1)',
    '    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1555:16) {',
    '    at Object.<anonymous> (/app/x.js:1:1)',
    '    at Array.forEach (native)',
    '    at Layer.handle [as handle_request] (/app/node_modules/express/lib/router/layer.js:95:5)',
    'at X (/app/a.js:1:2)',
  ];
  for (const f of frames) {
    assert.ok(isStackFrame(f), f);
    assert.equal(detectLevel(f, 'ERROR'), 'ERROR', f);
    assert.equal(detectLevel(f, 'INFO'), 'ERROR', f);
  }
  for (const t of ['at least one field must be set', 'at 10:30:00 the job failed', '    at', 'Retrying at 10:30', 'at /login (redirect)', NEST_EXCEPTION[0], NEST_EXCEPTION[1]]) assert.equal(isStackFrame(t), false, t);
});

test('B1: exception header lines', () => {
  for (const h of ["TypeError: Cannot read properties of undefined (reading 'x')", 'Error: boom', 'Error', 'PrismaClientKnownRequestError: ', 'QueryFailedError: duplicate key', '[Error: ENOENT: no such file or directory]', 'Error [ERR_HTTP_HEADERS_SENT]: Cannot set headers after they are sent to the client', 'NotFoundException: Folder not found']) {
    assert.ok(isExceptionHeader(h), h);
    assert.equal(detectLevel(h, 'ERROR'), 'ERROR', h);
  }
  for (const t of ['Errors: 3', 'ErrorBoundary caught it', 'Error while fetching', 'ERROR: duplicate key', 'Exception in thread', NEST_EXCEPTION[0]]) assert.equal(isExceptionHeader(t), false, t);
  assert.equal(detectLevel('QueryFailedError: relation "x" does not exist', null), 'ERROR', 'no severity (the Kubernetes log API)');
  assert.equal(detectLevel('Error: none found, using the defaults', 'INFO'), 'INFO', 'on stdout it can be just a message');
});

test('B1: an exception line joins the error just before it (same pod, ≤ 3 s), otherwise it is an error of its own', () => {
  const book = new ErrorBook({ known: { other: 1 } });
  assert.ok(book.add(errorLine('[Nest] 1  - 09/25/2026, 10:00:00 AM   ERROR [JobService] Failed to process job')));
  assert.equal(book.add(errorLine('Error: connect ECONNREFUSED 10.1.0.3:6379', T0 + 5)), null, 'joins the Nest line');
  assert.equal(book.add(errorLine('    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1555:16)', T0 + 6)), null);
  const [g] = book.summary(T0 + 10);
  assert.deepEqual(g.stack, ['Error: connect ECONNREFUSED 10.1.0.3:6379', 'at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1555:16)']);

  // No error before it: console.error(err) prints the exception and its frames on their own.
  const alone = new ErrorBook({ known: { other: 1 } });
  const r = alone.add(errorLine('QueryFailedError: relation "files" does not exist'));
  assert.equal(r?.group.title, 'QueryFailedError: relation "files" does not exist');
  alone.add(errorLine('    at PostgresQueryRunner.query (/app/node_modules/typeorm/driver/postgres/PostgresQueryRunner.js:219:19)', T0 + 1));
  assert.equal(alone.summary(T0 + 10)[0].stack.length, 1);
  // The next exception printed right after is another error, not part of the first one's stack.
  assert.ok(alone.add(errorLine('TypeError: x is not a function', T0 + 2)));
  assert.equal(alone.summary(T0 + 10).length, 2);

  // Too late, or from another pod: an error of its own.
  const other = new ErrorBook({ known: { other: 1 } });
  other.add(errorLine('[Nest] 1  - 09/25/2026, 10:00:00 AM   ERROR [A] failed'));
  assert.ok(other.add(errorLine('TypeError: late', T0 + 3001)));
  assert.ok(other.add(errorLine('TypeError: elsewhere', T0 + 10, { pod: 'p2' })));
  assert.equal(other.summary(T0 + 5000).length, 3);
});

test('B1: a group shows the stack of its latest occurrence, not every occurrence appended', () => {
  const book = new ErrorBook({ known: { other: 1 } });
  for (let n = 0; n < 5; n++) NEST_EXCEPTION.forEach((text, i) => book.add(errorLine(text, T0 + n * 10_000 + i)));
  const [g] = book.summary(T0 + MIN);
  assert.equal(g.count, 5);
  assert.equal(g.stack.length, NEST_EXCEPTION.length - 1);
});

test('B2: ids are masked, ordinary words are not', () => {
  const same = (a, b) => assert.equal(fingerprint('s', a), fingerprint('s', b), `${a} ≠ ${b}`);
  same('Folder fd_ppfzbts5zj not found for workspace ws_cnn7qmkwq6', 'Folder fd_x8r2m4n6p0 not found for workspace ws_bcdfghjklm');
  same('Record clx9k2m3n0000qwerty123abc not found', 'Record cm1abcdefg0001hijklmnop99 not found');
  same('Doc 6v7mnsxrwp missing', 'Doc k2m4p7x9zq missing');
  same('Doc V1StGXR8_Z5jdHi6B-myT missing', 'Doc Uakgb_J5m9g-0JDMbcJqLJ missing');
  same('Pod flobi-brand-7d9f8c6b5-x2x9z crashed', 'Pod flobi-brand-84b1c2d6f-q7w8e crashed');
  same('Pod bull-cleanup-29230000-x2x9z crashed', 'Pod bull-cleanup-29230030-bdfgh crashed');
  same('Pod redis-0 crashed', 'Pod redis-2 crashed');
  same('Bad token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'Bad token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyXzIifQ.c2lnbmF0dXJlLXZhbHVlLWhlcmU');
  same('payload aGVsbG8gd29ybGQgdGhpcyBpcyBhIHRlc3Q= rejected', 'payload dGhpcyBpcyBhbm90aGVyIHRlc3QgYmxvYg== rejected');
  same('Stripe pi_3MtwBwLkdIwHu7ix28a3tqPa failed', 'Stripe pi_1NgWq2LkdIwHu7ixK4bc9zQe failed');
  assert.equal(normalizeMessage('Docs 6v7mnsxrwp,k2m4p7x9zq fd_x8r2m4n6p0_ws_bcdfghjklm'), 'Docs <id>,<id> fd_<id>_ws_<id>', 'side by side');
  // everything masked before stays masked
  same('User 3f6c1a2e-1111-2222-3333-444455556666 at 2026-09-25T10:00:00Z from 10.1.0.3', 'User 9a9a9a9a-aaaa-bbbb-cccc-dddddddddddd at 2026-09-26T11:22:33Z from 10.1.0.4');
  same('Mail to jane@example.com failed after 3021ms', 'Mail to joe@example.org failed after 17ms');

  const words = ['v2', 'utf8', 'e2e', 'base64', 'http2', 'S3', 'x86_64', 'user_id', 'team_id', 'created_at', 'workspace_members', 'ECONNREFUSED', 'PrismaClientKnownRequestError', 'HeadlessRenderClient', 'ERR_HTTP2_STREAM_ERROR', 'Content-Type', 'flobi-brand'];
  for (const w of words) assert.ok(normalizeMessage(`failed near ${w} here`).includes(w), w);
  assert.notEqual(fingerprint('s', 'relation "workspace_members" does not exist'), fingerprint('s', 'relation "workspace_invites" does not exist'));
  // A JSON message's text is the message: distinct messages stay distinct, ids inside are masked.
  assert.notEqual(fingerprint('s', '{"statusCode":500,"message":"Stripe webhook signature verification failed"}'), fingerprint('s', '{"statusCode":500,"message":"Yjs persistence failed: connection terminated unexpectedly"}'));
  same('{"message":"Folder fd_ppfzbts5zj not found"}', '{"message":"Folder fd_x8r2m4n6p0 not found"}');
});

test('B2: fingerprintV1 is the fingerprint of app versions ≤ 1.0.3, unchanged', () => {
  // Recorded with the 1.0.3 code.
  const recorded = [
    ['flobi-brand', "[Nest] 1  - 09/25/2026, 10:00:00 AM   ERROR [ExceptionsHandler] Cannot read properties of undefined (reading 'x')", 'flobi-brand:1y3py3n'],
    ['flobi-brand', "TypeError: Cannot read properties of undefined (reading 'x')", 'flobi-brand:1icwk15'],
    ['flobi-drive', 'S3 upload failed for file_9wf2gpglg7: ECONNRESET after 3021ms', 'flobi-drive:yxjynd'],
    ['flobi-drive', 'Folder fd_ppfzbts5zj not found for workspace ws_cnn7qmkwq6', 'flobi-drive:gkhfd1'],
    ['flobi-drive', 'User 3f6c1a2e-1111-2222-3333-444455556666 not found', 'flobi-drive:1cvbp4s'],
    ['flobi-users', 'Webhook user.updated for user_2NNEqL2nrIRdJ194 failed: duplicate key value violates unique constraint "users_email_key"', 'flobi-users:1b1v0zc'],
    ['flobi-users', 'Clerk JWT verification failed: token expired at 2026-09-25T10:00:00.123Z for jane.doe+test@example.com', 'flobi-users:1asu9yk'],
    ['flobi-gateway', 'Upstream flobi-brand responded 503 for POST https://api.flobi.ai/brand/extract?x=1&y=2 from 10.8.3.14:5432', 'flobi-gateway:1ahl16d'],
    ['flobi-gateway', '\u001b[31m[Nest] 1  - 09/25/2026, 10:00:00 AM   ERROR\u001b[39m [ProxyService] socket hang up 0123456789abcdef0123', 'flobi-gateway:1ecwcp8'],
    ['flobi-notes', "Yjs persistence failed for doc 'this is a very long quoted string value': connection terminated unexpectedly", 'flobi-notes:1bqj2nj'],
    ['flobi-billing', 'Insufficient credits for org_k2m4p7x9zq: needed 40, have 12.5 (limit 1.5MB, took 20s)', 'flobi-billing:lxcau5'],
    ['flobi-media-worker', 'Transcode job clx9k2m3n0000qwerty123abc failed: ffmpeg exited with code 1\n    at Transcoder.run (/app/x.js:1:2)', 'flobi-media-worker:kmn6dp'],
    ['flobi-nodes', 'Run node_abcdef failed: OpenRouter 429 Too Many Requests on pod flobi-nodes-7d9f8c6b5-x2x9z', 'flobi-nodes:1rni7kp'],
    ['flobi-brand', '{"statusCode":500,"message":"Stripe webhook signature verification failed","error":"Internal Server Error"}', 'flobi-brand:tg1nb2'],
    ['flobi-brand', '[object Object]', 'flobi-brand:1xgwj33'],
    ['unknown', '   leading and    trailing   spaces   ', 'unknown:cb73wf'],
    ['flobi-ai', 'Token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U rejected', 'flobi-ai:qmn0b2'],
    ['flobi-ai', 'x86_64 utf8 base64 http2 S3 v2 e2e user_id team_id brand_assets workspace_members', 'flobi-ai:p97v34'],
    ['svc', '', 'svc:ztntfp'],
    ['svc', 'A'.repeat(400), 'svc:s6hqqm'],
  ];
  for (const [service, text, fp] of recorded) assert.equal(fingerprintV1(service, text), fp, text);
});

test('B2: errors known before the fingerprints changed are not new', () => {
  const text = 'S3 upload failed for file_9wf2gpglg7: ECONNRESET after 3021ms';
  const legacyKnown = { [fingerprintV1('flobi-drive', text)]: T0 - 10 * DAY };
  // The first run after the update is also a baseline (see the next test): adoption is
  // checked after it, when the machine has known errors under the new fingerprints.
  const book = new ErrorBook({ known: { other: 1 }, legacyKnown, now: T0 });
  assert.equal(book.inBaseline(T0), false);
  const r = book.add(errorLine('S3 upload failed for file_zz81kd02aa: ECONNRESET after 17ms', T0, { service: 'flobi-drive' }));
  assert.equal(r.isNewGroup, false);
  assert.equal(book.known[fingerprint('flobi-drive', text)], T0 - 10 * DAY, 'known under the new fingerprint from now on');
  assert.equal(book.summary(T0).find((g) => g.service === 'flobi-drive').isNew, false);

  // Old versions fell back to the container name for pods that were gone.
  const upstream = 'Upstream flobi-brand-7d9f8c6b5-x2x9z timed out';
  const byContainer = new ErrorBook({ known: { other: 1 }, legacyKnown: { [fingerprintV1('brand', upstream)]: T0 - DAY } });
  assert.equal(byContainer.add(errorLine(upstream, T0, { service: 'flobi-brand', container: 'brand' })).isNewGroup, false);

  // Something neither map knows is new.
  assert.equal(book.add(errorLine('Stripe webhook signature verification failed', T0, { service: 'flobi-billing' })).isNewGroup, true);
});

test('B2: a 15-minute baseline whenever the new map is empty (first run, or first run after the update)', () => {
  const first = new ErrorBook({ known: {}, legacyKnown: null, now: T0 });
  assert.equal(first.inBaseline(T0 + 14 * MIN), true);
  assert.equal(first.inBaseline(T0 + 15 * MIN), false);
  assert.equal(first.add(errorLine('boom', T0 + MIN)).isNewGroup, false);
  assert.equal(first.add(errorLine('later failure', T0 + 20 * MIN)).isNewGroup, true);
  // Updated from 1.0.3: lines that only now count as errors have no old fingerprint to match.
  const updated = new ErrorBook({ known: {}, legacyKnown: { a: 1 }, now: T0 });
  assert.equal(updated.inBaseline(T0), true);
  assert.equal(updated.add(errorLine('Error: a line 1.0.3 never counted', T0 + MIN)).isNewGroup, false);
  assert.equal(new ErrorBook({ known: { a: 1 }, now: T0 }).inBaseline(T0), false);
  assert.equal(new ErrorBook({ known: {}, now: () => T0 }).inBaseline(T0 + MIN), true, 'a clock works too');
});

test('B2: at most 1500 groups; the one not seen for the longest goes, and stays known', () => {
  const book = new ErrorBook({ known: { other: 1 } });
  const kind = (i) => `failure kind ${String.fromCharCode(97 + (i % 26), 97 + (Math.floor(i / 26) % 26), 97 + Math.floor(i / 676))}`;
  for (let i = 0; i < 1500; i++) book.add(errorLine(kind(i), T0 + i));
  assert.equal(book.groups.size, 1500);
  book.add(errorLine(kind(0), T0 + 2000)); // seen again: now the most recent
  book.add(errorLine('one more failure', T0 + 2001));
  assert.equal(book.groups.size, 1500);
  const titles = new Set([...book.groups.values()].map((g) => g.title));
  assert.ok(titles.has(kind(0)), 'recently seen group kept');
  assert.ok(!titles.has(kind(1)), 'least recently seen group dropped');
  assert.equal(book.add(errorLine(kind(1), T0 + 3000)).isNewGroup, false, 'a dropped group is still known');
  assert.ok(book.summary(T0 + 3000).length <= 1500);
});

test('B2: known errors are capped by when they were last seen, not first seen', () => {
  const known = {};
  const longStanding = 'long standing failure';
  known[fingerprint('s', longStanding)] = T0 - 30 * DAY; // the oldest of all, and still happening
  for (let i = 0; i < 5000; i++) known[`s:old${i}`] = T0 - DAY + i; // not seen while the app ran
  const book = new ErrorBook({ known, now: T0 });
  book.add(errorLine(longStanding, T0));
  for (let i = 0; i < 20; i++) book.add(errorLine(`fresh failure ${String.fromCharCode(97 + i)}`, T0 + i));
  book.prune(T0 + MIN);
  assert.equal(Object.keys(book.known).length, 5000);
  assert.ok(fingerprint('s', longStanding) in book.known, 'still known');
  for (let i = 0; i < 21; i++) assert.ok(!(`s:old${i}` in book.known), `old${i} forgotten first`);
  assert.ok('s:old21' in book.known);
  assert.equal(new ErrorBook({ known: book.known }).add(errorLine(longStanding, T0 + DAY)).isNewGroup, false);
});

test('B3: the last error per pod is forgotten after a minute, so pruned groups can go', () => {
  const book = new ErrorBook({ known: { other: 1 }, retentionMs: 60 * MIN });
  for (let d = 0; d < 30; d++) for (let k = 0; k < 100; k++) book.add(errorLine('boom', T0 + d * DAY + k * 1000, { pod: `p-${d}-${k}` }));
  const now = T0 + 30 * DAY;
  book.prune(now);
  assert.equal(book.lastByPod.size, 0);
  assert.equal(book.groups.size, 0);
  // Recent ones stay, so a stack trace still finds its error.
  book.add(errorLine('fresh', now - 10_000, { pod: 'p' }));
  book.prune(now);
  assert.equal(book.lastByPod.size, 1);
  book.add(errorLine('    at X (/app/a.js:1:2)', now - 9_000, { pod: 'p' }));
  assert.equal(book.summary(now)[0].stack.length, 1);
});

test('B4: a steady 12 errors a minute reads ~12/min at any point of the minute', () => {
  const book = new ErrorBook({ known: { other: 1 } });
  let next = T0;
  const until = (now) => {
    for (; next <= now; next += 5000) book.add(errorLine('boom', next, { service: 'flobi-brand', pod: `p${next}` }));
  };
  for (let now = T0 + 5 * MIN; now < T0 + 7 * MIN; now += 1000) {
    until(now);
    const r = book.rate('flobi-brand', 2 * MIN, now);
    assert.ok(Math.abs(r - 12) <= 0.6, `${new Date(now).toISOString()}: ${r}`);
    assert.equal(book.ratePerMinute('flobi-brand', 2, now), r);
  }
  assert.equal(book.rate('nobody', 2 * MIN, T0 + 7 * MIN), 0);
  // A burst in the last 10 seconds is seen right away, without waiting for the minute to end.
  const burst = new ErrorBook({ known: { other: 1 } });
  for (let i = 0; i < 40; i++) burst.add(errorLine('boom', T0 + 50_000 + i * 250, { service: 'x', pod: `p${i}` }));
  assert.equal(burst.rate('x', 2 * MIN, T0 + 60_000), 20);
  assert.deepEqual(burst.perMinute('x', 3, T0 + 2 * MIN), [0, 40, 0]);
});

test('B5: a JSON message object is compact JSON, not "[object Object]"', () => {
  const a = normalizeEntry(entry(null, { stream: 'stdout', json: { message: { statusCode: 500, message: 'Stripe webhook signature verification failed' } } }), { namespace: 'flobi' });
  const b = normalizeEntry(entry(null, { stream: 'stdout', json: { message: { statusCode: 500, message: 'Yjs persistence failed: connection terminated unexpectedly' } } }), { namespace: 'flobi' });
  assert.equal(a.text, '{"statusCode":500,"message":"Stripe webhook signature verification failed"}');
  const book = new ErrorBook({ known: { other: 1 } });
  book.add(a);
  book.add(b);
  assert.equal(book.summary(T0).length, 2);
  const big = normalizeEntry(entry(null, { json: { message: { items: Array.from({ length: 2000 }, (_, i) => `item ${i}`) } } }), { namespace: 'flobi' });
  assert.ok(big.text.length <= 4001 && big.text.startsWith('{"items":["item 0"'));
  const k8s = k8sLogLine({ text: JSON.stringify({ level: 'error', message: { code: 'E_QUOTA', detail: 'over quota' } }), ts: T0, pod: POD, container: 'flobi-brand', service: 'flobi-brand' });
  assert.equal(k8s.text, '{"code":"E_QUOTA","detail":"over quota"}');
  assert.equal(k8s.level, 'ERROR');
});

test('B6: a structured entry keeps the severity the app gave it', () => {
  // On stdout, ERROR can only come from the app (GKE's default there is INFO).
  const line = normalizeEntry(entry(null, { stream: 'stdout', json: { message: 'Payment provider rejected the charge', orderId: 'o1' } }), { namespace: 'flobi' });
  assert.equal(line.level, 'ERROR');
  assert.ok(new ErrorBook({ known: { other: 1 } }).add(line), 'reaches the Errors page');
  // On stderr (or an unknown stream) ERROR is also GKE's default for a level-less JSON line,
  // so it proves nothing: without a marker in the text it stays a warning.
  assert.equal(normalizeEntry(entry(null, { stream: 'stderr', json: { message: 'cache warmed', keys: 12 } }), { namespace: 'flobi' }).level, 'WARN');
  assert.equal(normalizeEntry(entry(null, { json: { message: 'cache warmed', keys: 12 } }), { namespace: 'flobi' }).level, 'WARN');
  assert.equal(normalizeEntry(entry(null, { stream: 'stderr', json: { message: 'Unhandled rejection: boom', keys: 12 } }), { namespace: 'flobi' }).level, 'ERROR', 'a marker still counts');
  assert.equal(normalizeEntry(entry(null, { severity: 'WARNING', json: { message: 'Retrying' } }), { namespace: 'flobi' }).level, 'WARN');
  assert.equal(normalizeEntry(entry(null, { severity: 'INFO', json: { message: 'ERROR count reset' } }), { namespace: 'flobi' }).level, 'INFO');
  assert.equal(detectLevel('x', 'ERROR', { level: 30 }), 'INFO', "the payload's own level still wins");
  // Plain text: every stderr line is "ERROR" in GKE, so a line without any marker is a warning.
  assert.equal(normalizeEntry(entry('plain stderr line'), { namespace: 'flobi' }).level, 'WARN');
});

test('B7: unix-socket database connection failures', () => {
  for (const t of [
    'Error: connect ECONNREFUSED /cloudsql/flobi-prod-2026:europe-west1:flobi-prod-pg/.s.PGSQL.5432',
    'connect ENOENT /cloudsql/proj:europe-west1:inst/.s.PGSQL.5432',
    'connect ENOENT /tmp/.s.PGSQL.5432',
    'connection to server on socket "/cloudsql/p:r:i/.s.PGSQL.5432" failed: No such file or directory',
    'connection to server at "10.1.0.3", port 5432 failed: Connection refused',
    'Error: connect ECONNREFUSED 10.1.0.3:5432',
  ])
    assert.ok(DB_CONN_ERROR.test(t), t);
  for (const t of ['Listening on /tmp/.s.PGSQL.5432', 'connect ECONNREFUSED 10.1.0.3:6379']) assert.equal(DB_CONN_ERROR.test(t), false, t);
});

test('B8: log lines are grouped by workload, also for pods that are gone', () => {
  const line = (pod, container, ctx = {}) => normalizeEntry(entry('boom', { pod, container }), { namespace: 'flobi', ...ctx });
  assert.equal(line(POD, 'brand').service, 'flobi-brand', 'a container named differently from its workload');
  assert.equal(line(POD, 'brand', { podToService: () => 'flobi-brand-v2' }).service, 'flobi-brand-v2', 'the live model wins');
  assert.equal(line(POD, 'brand', { podToService: () => null }).service, 'flobi-brand', 'pod no longer in the model');
  assert.equal(line('standalone', 'tool').service, 'tool');

  // The same answer as workloadOf() for each shape.
  const pod = (name, owner, hash) => ({ metadata: { name, labels: hash ? { 'pod-template-hash': hash } : {}, ownerReferences: [owner] } });
  const shapes = [
    pod('flobi-brand-7d9f8c6b5-x2x9z', { kind: 'ReplicaSet', name: 'flobi-brand-7d9f8c6b5' }, '7d9f8c6b5'),
    pod('api-6f7d9c-bcdfg', { kind: 'ReplicaSet', name: 'api-6f7d9c' }, '6f7d9c'),
    pod('worker-2-84bdc2d6f7-q7w8x', { kind: 'ReplicaSet', name: 'worker-2-84bdc2d6f7' }, '84bdc2d6f7'),
    pod('bull-cleanup-29230000-x2x9z', { kind: 'Job', name: 'bull-cleanup-29230000' }),
    pod('redis-0', { kind: 'StatefulSet', name: 'redis' }),
    pod('rabbitmq-server-12', { kind: 'StatefulSet', name: 'rabbitmq-server' }),
  ];
  for (const p of shapes) assert.equal(workloadFromPodName(p.metadata.name), workloadOf(p), p.metadata.name);
  assert.equal(workloadFromPodName('standalone'), null);
  assert.equal(workloadFromPodName(''), null);
});

test('B2: a JSON error is not adopted from an old fingerprint that hid its quoted values', () => {
  const known = '{"statusCode":500,"message":"Payment provider rejected the charge for this order"}';
  const other = '{"statusCode":500,"message":"Brand extraction failed because the page never loaded"}';
  const legacyKnown = { [fingerprintV1('flobi-billing', known)]: T0 - 10 * DAY };
  assert.equal(fingerprintV1('flobi-billing', known), fingerprintV1('flobi-billing', other), 'the old scheme saw one error');
  const book = new ErrorBook({ known: { x: 1 }, legacyKnown, now: T0 });
  assert.equal(book.add(errorLine(other, T0, { service: 'flobi-billing' })).isNewGroup, true, 'a different JSON error is new');
  const plain = 'S3 upload failed for file_9wf2gpglg7: ECONNRESET after 3021ms';
  const book2 = new ErrorBook({ known: { x: 1 }, legacyKnown: { [fingerprintV1('flobi-drive', plain)]: T0 - DAY }, now: T0 });
  assert.equal(book2.add(errorLine(plain, T0, { service: 'flobi-drive' })).isNewGroup, false, 'plain text still adopts');
});
