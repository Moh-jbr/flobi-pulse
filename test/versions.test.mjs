import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bump, notesSummary, buildVersions, newReleases, VersionsWatcher } from '../electron/core/engine/versions.mjs';
import { resetGuard, configureGuard, checkRequest, ReadOnlyViolation } from '../electron/core/net/guard.mjs';

test('version steps', () => {
  assert.equal(bump('v1.4.2', 'v2.0.0'), 'major');
  assert.equal(bump('v1.4.2', 'v1.5.0'), 'minor');
  assert.equal(bump('v1.4.2', 'v1.4.3'), 'patch');
  assert.equal(bump(undefined, 'v1.0.0'), 'first');
  assert.equal(bump('v1.0.0', 'nightly'), 'other');
});

test('release notes at a glance (flobi-release format)', () => {
  const body = '1 change since v1.1.0 · [compare](https://github.com/o/r/compare/v1.1.0...v2.0.0)\n\n### Breaking changes\n\n- **release-test:** major-level test change ([855145c](https://github.com/o/r/commit/855145c), dana)';
  const s = notesSummary(body);
  assert.equal(s.first, '1 change since v1.1.0');
  assert.deepEqual(s.sections, ['Breaking changes']);
  assert.equal(s.changes, 1);
  assert.equal(s.breaking, true);
  assert.equal(notesSummary('Versioning starts here.').breaking, false);
});

test('repos grouped by product, feed newest first, steps worked out per repo', () => {
  const v = buildVersions(
    { owner: 'o', repos: { a: { product: 'Drive', audience: 'user' }, b: { product: 'Drive' }, c: { product: 'Admin', audience: 'internal' } } },
    { a: [{ tag: 'v1.0.0', publishedAt: 1, body: '' }, { tag: 'v1.1.0', publishedAt: 3, body: '' }], b: [{ tag: 'v1.0.0', publishedAt: 2, body: '' }] },
    { c: 'no access' },
  );
  assert.deepEqual(v.feed.map((r) => `${r.repo}@${r.tag}`), ['a@v1.1.0', 'b@v1.0.0', 'a@v1.0.0']);
  assert.equal(v.repos.find((r) => r.name === 'a').latest.bump, 'minor');
  assert.equal(v.repos.find((r) => r.name === 'c').error, 'no access');
  assert.equal(v.repos.find((r) => r.name === 'c').latest, null);
});

test('only releases after watching began are announced, each once', async () => {
  let t = 1000;
  const releases = { a: [{ tag: 'v1.0.0', publishedAt: 500, body: '' }] };
  const announced = [];
  const w = new VersionsWatcher({
    client: { manifest: async () => ({ owner: 'o', repos: { a: { product: 'A' }, skipped: { product: 'S', skip: 'not yet' } } }), releases: async (name) => { if (name === 'skipped') throw new Error('should not be read'); return releases[name]; } },
    manifestRepo: 'm',
    manifestPath: 'repos.json',
    onChange: () => {},
    onNew: (list) => announced.push(...list.map((r) => r.tag)),
    now: () => t,
  });
  await w.poll(); // baseline: v1.0.0 existed before, no notification
  assert.deepEqual(announced, []);
  t = 2000;
  releases.a = [{ tag: 'v1.1.0', publishedAt: 1500, body: '' }, ...releases.a];
  await w.poll();
  await w.poll();
  assert.deepEqual(announced, ['v1.1.0']);
  assert.equal(w.state.status, 'ok');
  assert.equal(newReleases(w.state.feed, 0, new Set()).length, 0, 'no baseline, nothing is new');
});

test('guard: the Versions page reads only the manifest and release lists of the team org', () => {
  resetGuard();
  const blocked = (url, method = 'GET') => assert.throws(() => checkRequest({ method, url }), ReadOnlyViolation);
  blocked('https://api.github.com/repos/4ow4-Developers/flobi-release/contents/repos.json');
  configureGuard({ github: { owner: '4ow4-Developers', manifestRepo: 'flobi-release', manifestPath: 'repos.json' } });
  assert.equal(checkRequest({ url: 'https://api.github.com/repos/4ow4-Developers/flobi-release/contents/repos.json', headers: { authorization: 'Bearer x', 'if-none-match': '"abc"' } }), true);
  assert.equal(checkRequest({ url: 'https://api.github.com/repos/4ow4-Developers/flobi_drive/releases?per_page=15' }), true);
  blocked('https://api.github.com/repos/4ow4-Developers/flobi_drive/contents/src/secrets.ts');
  blocked('https://api.github.com/repos/4ow4-Developers/flobi-release/contents/.env');
  blocked('https://api.github.com/repos/other-org/app/releases');
  blocked('https://api.github.com/repos/4ow4-Developers/flobi_drive/releases', 'POST');
  blocked('https://api.github.com/repos/4ow4-Developers/flobi_drive/releases/1', 'DELETE');
  blocked('https://api.github.com/repos/4ow4-Developers/flobi_drive/releases?per_page=5&sort=x');
  blocked('https://api.github.com/repos/4ow4-Developers/flobi_drive/%2e%2e/releases');
  blocked('https://api.github.com/user/repos');
});
