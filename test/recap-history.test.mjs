import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecap, unionMs, eventOccurrences } from '../electron/core/engine/recap.mjs';
import { fingerprintV1 } from '../electron/core/engine/errors.mjs';
import { bucketPeriod } from '../electron/core/engine/series.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms) => new Date(ms).toISOString();
const at = (h, m, s = 0) => Date.UTC(2026, 8, 25, h, m, s);

/** Cloud Logging stand-in: answers each recap query from `data`, newest first like the real API. */
function fakeLogging(data) {
  const calls = [];
  return {
    calls,
    listAll: async ({ filter }) => {
      calls.push(filter);
      const pick = filter.includes('logs/events') ? data.events : filter.includes('http_load_balancer') ? data.lb : filter.includes('k8s_container') ? data.errors : [];
      return [...(pick || [])].reverse();
    },
  };
}

const lb5xx = (t, service = 'flobi-gateway') => ({
  timestamp: iso(t),
  resource: { type: 'http_load_balancer', labels: { backend_service_name: `k8s1-8f2c1a9b-flobi-${service}-80-q7w8e9r0` } },
  httpRequest: { requestMethod: 'GET', requestUrl: 'https://api.flobi.ai/x', status: 502, latency: '0.01s' },
  jsonPayload: { statusDetails: 'failed_to_connect_to_backend' },
});

// Lines of one stack trace share the millisecond; the nanoseconds keep them in order.
const errEntry = (t, text, { pod = 'flobi-brand-7d9f8c6b5-x2x9z', container = 'brand', ns = 0 } = {}) => ({
  timestamp: iso(t).replace('Z', `${String(ns).padStart(6, '0')}Z`),
  severity: 'ERROR',
  resource: { type: 'k8s_container', labels: { namespace_name: 'flobi', pod_name: pod, container_name: container } },
  textPayload: text,
});

const nest = (message, context = 'FilesService') => `[Nest] 1  - 09/25/2026, 3:00:00 AM   ERROR [${context}] ${message}`;

function nestException(t, n, pod) {
  const lines = [
    `[Nest] 1  - 09/25/2026, 3:00:00 AM   ERROR [ExceptionsHandler] Cannot read properties of undefined (reading 'brandId')`,
    "TypeError: Cannot read properties of undefined (reading 'brandId')",
    ...Array.from({ length: 8 }, (_, i) => `    at Frame${i}.run (/app/dist/brand/frame${i}.js:${10 + i}:5)`),
  ];
  return lines.map((text, i) => errEntry(t, text, { pod: pod || `flobi-brand-7d9f8c6b5-${'bcdfg'.slice(0, 4)}${'hjklm'[n % 5]}`, ns: i * 1000 }));
}

test('B9: a short burst in a long recap is short, whatever the bucket size', async () => {
  const since = Date.UTC(2026, 8, 25, 18, 0); // a weekend: Friday evening to Monday morning
  const until = since + 62 * HOUR;
  assert.equal(bucketPeriod(until - since), 900);
  const burst = since + 20 * HOUR;
  const logging = fakeLogging({ lb: Array.from({ length: 10 }, (_, i) => lb5xx(burst + i * 1000)) });
  const r = await buildRecap({ since, until, namespace: 'flobi', projectId: 'p', logging, knownErrors: { a: 1 } });
  const http = r.incidents.filter((i) => i.kind === 'http');
  assert.equal(http.length, 1);
  assert.equal(http[0].severity, 'warning', '10 failures in 10 s is not an outage');
  assert.equal(http[0].start, burst);
  assert.equal(http[0].end, burst + 9000);
  assert.doesNotMatch(http[0].detail, /15 min/);
  assert.match(http[0].detail, /within a minute/);
  assert.equal(r.summary.outageMinutes, 0);
});

test('B9: outage minutes count overlapping incidents once', async () => {
  const since = at(0, 0);
  const until = at(9, 0);
  // Gateway and brand fail together for 30 minutes, and the apps can't reach the database meanwhile.
  const lb = [];
  for (let i = 0; i < 150; i++) lb.push(lb5xx(at(3, 0) + i * 12_000, 'flobi-gateway'), lb5xx(at(3, 0) + i * 12_000 + 500, 'flobi-brand'));
  const errors = Array.from({ length: 30 }, (_, i) => errEntry(at(3, 5) + i * 30_000, 'Error: connect ECONNREFUSED /cloudsql/p:europe-west1:db/.s.PGSQL.5432', { pod: `flobi-brand-7d9f8c6b5-bcd${'fghjk'[i % 5]}${'lmnpq'[i % 5]}` }));
  const logging = fakeLogging({ lb, errors });
  const r = await buildRecap({ since, until, namespace: 'flobi', projectId: 'p', logging, knownErrors: { a: 1 } });
  const critical = r.incidents.filter((i) => i.severity === 'critical');
  assert.equal(critical.length, 3, r.incidents.map((i) => `${i.severity} ${i.title}`).join(' | '));
  assert.equal(r.summary.outageMinutes, 30, 'about 30 minutes, not the ~75 of the three added up');
  assert.equal(unionMs([[0, 10], [5, 20], [30, 40], [40, 41]]), 31);
  assert.equal(unionMs([]), 0);
});

test('B10: a stack trace is one error, not one per line', async () => {
  const since = at(0, 0);
  const until = at(10, 0);
  const errors = Array.from({ length: 40 }, (_, n) => nestException(at(3, 0) + n * 5000, n)).flat();
  const logging = fakeLogging({ errors });
  const r = await buildRecap({ since, until, namespace: 'flobi', projectId: 'p', logging, knownErrors: { a: 1 } });
  assert.equal(r.summary.errors, 40);
  assert.ok(!r.incidents.some((i) => i.id.startsWith('errspike:')), 'no spike from counting frames');
  assert.equal(r.summary.newErrorTypes, 1);
  const errorQuery = logging.calls.find((f) => f.includes('k8s_container'));
  assert.match(errorQuery, /NOT textPayload=~"\^ \+at "/, 'frames are left out of the capped query');
});

test('B10: error spikes count errors, and last as long as the errors did', async () => {
  const since = at(0, 0);
  const until = at(10, 0);
  const errors = [];
  // an error every hour, then 300 in two minutes
  for (let h = 0; h < 10; h++) errors.push(errEntry(at(h, 10), nest('Folder fd_k2m4p7x9zq not found'), { container: 'flobi-drive', pod: 'flobi-drive-7d9f8c6b5-x2x9z' }));
  for (let i = 0; i < 300; i++) errors.push(errEntry(at(4, 1) + i * 400, nest(`Folder fd_${'bcdfghjklm'[i % 10]}2m4p7x9zq not found`), { pod: `flobi-drive-7d9f8c6b5-bcd${'fghjk'[i % 5]}${'lmnpq'[i % 5]}`, container: 'flobi-drive' }));
  // Plain stderr lines without any level are warnings here as on the Errors page, not errors.
  for (let i = 0; i < 50; i++) errors.push(errEntry(at(6, 0) + i * 100, 'Invalid `prisma.file.create()` invocation:'));
  const r = await buildRecap({ since, until, namespace: 'flobi', projectId: 'p', logging: fakeLogging({ errors }), knownErrors: { a: 1 } });
  assert.equal(r.summary.errors, 310);
  const spikes = r.incidents.filter((i) => i.id.startsWith('errspike:'));
  assert.equal(spikes.length, 1);
  assert.equal(spikes[0].service, 'flobi-drive');
  assert.equal(spikes[0].start, at(4, 1));
  assert.equal(spikes[0].end, at(4, 1) + 299 * 400);
  assert.match(spikes[0].detail, /^300 errors in 2 min/);
});

test('B11: a re-exported Kubernetes event counts its occurrences, not the sum of its counts', async () => {
  const since = at(0, 0);
  const until = at(9, 0);
  const pod = 'flobi-face-detection-7d9f8c6b5-x2x9z';
  const ev = (uid, count, t) => ({ logName: 'projects/p/logs/events', timestamp: iso(t), jsonPayload: { metadata: { uid, name: `${pod}.${uid}` }, type: 'Warning', reason: 'Unhealthy', message: 'Readiness probe failed: context deadline exceeded', involvedObject: { kind: 'Pod', name: pod, namespace: 'flobi' }, count, lastTimestamp: iso(t) } });
  const events = [];
  for (let c = 1; c <= 20; c++) events.push(ev('ev-1', c, at(4, 0) + c * 30_000));
  for (let c = 5; c <= 7; c++) events.push(ev('ev-2', c, at(4, 5) + c * 30_000)); // began before the recap: 3 more in it
  const r = await buildRecap({ since, until, namespace: 'flobi', projectId: 'p', logging: fakeLogging({ events }), knownErrors: { a: 1 } });
  const inc = r.incidents.find((i) => i.kind === 'event');
  assert.equal(inc.title, 'face-detection: Health checks failing (23×)');
  assert.equal(eventOccurrences([{ uid: 'a', count: 4, t: 1 }, { uid: 'a', count: 9, t: 2 }]), 6);
  assert.equal(eventOccurrences([{ objectKind: 'Pod', objectName: 'x', reason: 'Evicted', message: 'm', t: 1 }]), 1);
});

test('B12 + B8: new error types use both known maps and the workload name', async () => {
  const since = at(0, 0);
  const until = at(9, 0);
  const known = nest('S3 upload failed for file_9wf2gpglg7: ECONNRESET after 3021ms');
  const errors = [
    // The container is "brand", the workload "flobi-brand"; the pod is gone by now.
    errEntry(at(2, 0), nest('S3 upload failed for file_zz81kd02aa: ECONNRESET after 17ms')),
    errEntry(at(3, 0), nest('Stripe webhook signature verification failed', 'StripeWebhook')),
  ];
  const legacyKnownErrors = { [fingerprintV1('flobi-brand', known)]: since - 10 * 24 * HOUR };
  const run = (o) => buildRecap({ since, until, namespace: 'flobi', projectId: 'p', logging: fakeLogging({ errors }), ...o });

  const r = await run({ knownErrors: { other: 1 }, legacyKnownErrors });
  assert.equal(r.summary.newErrorTypes, 1, 'the upload error was known before the fingerprints changed');
  const inc = r.incidents.find((i) => i.id.startsWith('newerrors:'));
  assert.deepEqual(inc.items.map((i) => [i.service, i.title]), [['flobi-brand', 'Stripe webhook signature verification failed']]);

  const first = await run({ knownErrors: {}, legacyKnownErrors: null });
  assert.equal(first.summary.newErrorTypes, null, 'first run: nothing to compare with');
  assert.ok(!first.incidents.some((i) => i.id.startsWith('newerrors:')));
  const updated = await run({ knownErrors: {}, legacyKnownErrors });
  assert.equal(updated.summary.newErrorTypes, null, 'first run after the update: a baseline too');

  const viaModel = await run({ knownErrors: { a: 1 }, podToService: () => 'flobi-brand-api' });
  assert.ok(viaModel.incidents.find((i) => i.id.startsWith('newerrors:')).items.every((i) => i.service === 'flobi-brand-api'));
});

test('B17: bucket sizes stay within what series.mjs promises', () => {
  const points = (ms) => ms / (bucketPeriod(ms) * 1000);
  assert.ok(points(6 * HOUR) <= 360);
  assert.ok(points(24 * HOUR) <= 288);
  assert.ok(points(7 * 24 * HOUR) <= 672);
  assert.ok(points(30 * 24 * HOUR) <= 720);
  assert.equal(bucketPeriod(10 * HOUR), 300, 'the recap thresholds are tuned to these sizes');
});
