import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bump, buildVersions, VersionsWatcher } from '../electron/core/engine/versions.mjs';
import { DemoConnector } from '../electron/core/engine/demo.mjs';
import { normalizeEntry } from '../electron/core/engine/normalize.mjs';
import { ErrorBook } from '../electron/core/engine/errors.mjs';

const T0 = Date.UTC(2026, 8, 25, 10, 0, 0);
const rel = (tag, publishedAt, body = '') => ({ tag, publishedAt, body });

test('B15: release notes that start with a blank line still mark the versioning baseline', () => {
  const v = buildVersions({ repos: { a: {} } }, { a: [rel('v1.1.0', 3), rel('v1.0.0', 2, '\n\nVersioning starts here.'), rel('nightly', 1)] });
  const byTag = Object.fromEntries(v.repos[0].releases.map((r) => [r.tag, r]));
  assert.equal(byTag['v1.0.0'].baseline, true);
  assert.equal(byTag['v1.1.0'].baseline, false);
});

test('B15: steps are measured from the latest stable version, skipping release candidates and other tags', () => {
  const steps = (list, n = list.length) => Object.fromEntries(buildVersions({ repos: { a: {} } }, { a: list.slice(0, n) }).repos[0].releases.map((r) => [r.tag, r.bump]));
  assert.deepEqual(steps([rel('v1.3.0', 4), rel('v1.3.0-rc.2', 3), rel('v1.3.0-rc.1', 2), rel('v1.2.5', 1)]), { 'v1.3.0': 'minor', 'v1.3.0-rc.2': 'other', 'v1.3.0-rc.1': 'other', 'v1.2.5': 'first' });
  assert.equal(steps([rel('v2.0.0', 3), rel('nightly', 2), rel('v1.9.0', 1)])['v2.0.0'], 'major');
  assert.equal(steps([rel('v1.0.0', 2), rel('v1.0.0-rc.1', 1)])['v1.0.0'], 'first', 'the first stable release after its candidates');
  // Only release candidates in what was read (a full page): the previous version is unknown.
  const page = [rel('v2.0.0', 20), ...Array.from({ length: 14 }, (_, i) => rel(`v2.0.0-rc.${14 - i}`, 19 - i))];
  assert.equal(steps(page)['v2.0.0'], 'other');
  assert.equal(bump('v1.2.0-rc.1', 'v1.2.0'), 'other');
  assert.equal(bump(undefined, 'v1.0.0'), 'first');
});

test('B15: a watcher stopped during a poll announces, shows and saves nothing', async () => {
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((a, b) => ((resolve = a), (reject = b)));
    return { promise, resolve, reject };
  };
  const seen = [];
  const make = (client, saved = { since: 1 }) => new VersionsWatcher({ client, manifestRepo: 'm', manifestPath: 'repos.json', onChange: () => seen.push('change'), onNew: () => seen.push('new'), onSave: () => seen.push('save'), saved, now: () => 5000 });

  // stopped while the releases are being read
  const releases = deferred();
  const w = make({ manifest: async () => ({ repos: { a: {} } }), releases: () => releases.promise });
  const polling = w.poll();
  await new Promise((r) => setImmediate(r));
  w.stop();
  releases.resolve([rel('v1.1.0', 4000)]);
  await polling;
  assert.deepEqual(seen, []);
  assert.equal(w.running, false);

  // stopped while the manifest is being read, which then fails
  const manifest = deferred();
  const w2 = make({ manifest: () => manifest.promise, releases: async () => [] });
  const polling2 = w2.poll();
  w2.stop();
  manifest.reject(new Error('offline'));
  await polling2;
  assert.deepEqual(seen, []);
  assert.equal(w2.state.status, 'loading');

  // not stopped: it announces the new release as before
  const w3 = make({ manifest: async () => ({ repos: { a: {} } }), releases: async () => [rel('v1.1.0', 4000)] });
  await w3.poll();
  assert.deepEqual(seen, ['change', 'new', 'save']);
});

test('B16: the demo recap lists incidents in time order, like the real one', async () => {
  const d = new DemoConnector({ pipeline: null, lastSeenAt: null });
  d.clock = () => T0;
  const r = await d.recap({ since: T0 - 10 * 3600_000, until: T0 });
  const starts = r.incidents.map((i) => i.start);
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  assert.equal(r.summary.critical, r.incidents.filter((i) => i.severity === 'critical').length);
  assert.equal(r.summary.warning, r.incidents.filter((i) => i.severity === 'warning').length);
});

test('B16: demo exceptions are one error each, with their stack; demo ids group', () => {
  const d = new DemoConnector({ pipeline: null, lastSeenAt: null });
  d.buildCluster(T0);
  const book = new ErrorBook({ known: { other: 1 } });
  const lines = [...d.exceptionEntries('flobi-gateway', T0), ...d.exceptionEntries('flobi-gateway', T0 + 10_000)].map((e) => normalizeEntry(e, { namespace: 'flobi' }));
  assert.ok(lines.length > 4 && lines.every((l) => l.level === 'ERROR'));
  lines.forEach((l) => book.add(l));
  const [g, ...rest] = book.summary(T0 + 20_000);
  assert.equal(rest.length, 0);
  assert.equal(g.service, 'flobi-gateway');
  assert.equal(g.count, 2);
  assert.equal(g.stack.length, lines.length / 2 - 1);
  assert.match(g.stack[0], /^TypeError: /);

  // The demo's own error lines (random ids included) make one group per kind of error.
  const drive = d.pods.find((p) => p.metadata.labels.app === 'flobi-drive');
  const drives = new ErrorBook({ known: { other: 1 } });
  for (let i = 0; i < 4000; i++) drives.add(normalizeEntry(d.logEntry(drive, 'flobi-drive', T0 + i * 100), { namespace: 'flobi' }));
  const titles = drives.summary(T0 + 500_000).map((x) => x.title);
  assert.equal(titles.filter((t) => t.startsWith('Folder fd_')).length, 1, titles.join('\n'));
  assert.equal(titles.filter((t) => t.startsWith('S3 upload failed')).length, 1, titles.join('\n'));
});
