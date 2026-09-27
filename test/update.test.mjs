import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNewer, parseVersion, pickAsset, parseSums, assetDigest } from '../electron/core/update/release.mjs';
import { resetGuard, configureGuard, checkRequest, ReadOnlyViolation } from '../electron/core/net/guard.mjs';

test('versions: only a higher plain version counts as an update', () => {
  assert.deepEqual(parseVersion('v1.2.3'), [1, 2, 3]);
  assert.equal(parseVersion('1.2.3-beta.1'), null);
  assert.equal(isNewer('v1.0.1', '1.0.0'), true);
  assert.equal(isNewer('1.10.0', '1.9.9'), true);
  assert.equal(isNewer('2.0.0', '10.0.0'), false);
  assert.equal(isNewer('1.0.0', '1.0.0'), false);
  assert.equal(isNewer('v0.9.0', '1.0.0'), false);
  assert.equal(isNewer('nightly', '1.0.0'), false);
});

test('each platform picks its own update file from the release', () => {
  const release = {
    assets: ['Flobi-Pulse-Windows.zip', 'Flobi-Pulse-Setup-1.0.1.exe', 'Flobi-Pulse-1.0.1-mac.zip', 'Flobi-Pulse-1.0.1.dmg', 'Flobi-Pulse-macOS.zip', 'Flobi-Pulse-1.0.1.AppImage', 'SHA256SUMS.txt'].map((name) => ({ name })),
  };
  assert.equal(pickAsset(release, 'win32').name, 'Flobi-Pulse-Setup-1.0.1.exe');
  assert.equal(pickAsset(release, 'darwin').name, 'Flobi-Pulse-1.0.1-mac.zip');
  assert.equal(pickAsset(release, 'linux').name, 'Flobi-Pulse-1.0.1.AppImage');
  assert.equal(pickAsset(release, 'freebsd'), null);
  assert.equal(pickAsset({ assets: [{ name: 'Flobi-Pulse-Windows.zip' }] }, 'win32'), null);
});

test('checksums: from GitHub digests or a sha256sum list', () => {
  const hex = 'a'.repeat(64);
  assert.equal(assetDigest({ digest: `sha256:${hex.toUpperCase()}` }), hex);
  assert.equal(assetDigest({ digest: 'md5:abc' }), null);
  assert.equal(assetDigest({}), null);
  const sums = parseSums(`${hex}  Flobi-Pulse-Setup-1.0.1.exe\r\n${'b'.repeat(64)} *Flobi-Pulse-1.0.1.AppImage\nnot a line\n`);
  assert.equal(sums.get('Flobi-Pulse-Setup-1.0.1.exe'), hex);
  assert.equal(sums.get('Flobi-Pulse-1.0.1.AppImage'), 'b'.repeat(64));
  assert.equal(sums.size, 2);
});

test('guard: updates may only read and download the app’s own releases', () => {
  resetGuard();
  const blocked = (req) => assert.throws(() => checkRequest(req), ReadOnlyViolation);
  const latest = 'https://api.github.com/repos/Moh-jbr/flobi-pulse/releases/latest';
  // Nothing on GitHub is reachable until the app names its release repo.
  blocked({ url: latest });
  configureGuard({ updateRepo: 'Moh-jbr/flobi-pulse' });
  assert.equal(checkRequest({ url: latest, headers: { accept: 'application/vnd.github+json' } }), true);
  assert.equal(checkRequest({ url: 'https://github.com/Moh-jbr/flobi-pulse/releases/download/v1.0.1/Flobi-Pulse-Setup-1.0.1.exe' }), true);
  assert.equal(checkRequest({ url: 'https://release-assets.githubusercontent.com/github-production-release-asset/1/2?sp=r&sig=x' }), true);
  // Other repos, other endpoints, writes and tricks are refused.
  blocked({ url: 'https://api.github.com/repos/someone/else/releases/latest' });
  blocked({ url: 'https://api.github.com/repos/Moh-jbr/flobi-pulse/releases' });
  blocked({ url: 'https://api.github.com/user' });
  blocked({ method: 'POST', url: latest });
  blocked({ method: 'DELETE', url: 'https://api.github.com/repos/Moh-jbr/flobi-pulse/releases/1' });
  blocked({ url: 'https://github.com/someone/else/releases/download/v1/x.exe' });
  blocked({ url: 'https://github.com/Moh-jbr/flobi-pulse/releases/download/v1/../../../x' });
  blocked({ url: 'https://github.com/Moh-jbr/flobi-pulse/releases/download/v1/%2e%2e/x' });
  blocked({ url: 'https://github.com/Moh-jbr/flobi-pulse/settings' });
  blocked({ method: 'PUT', url: 'https://release-assets.githubusercontent.com/x', body: 'x' });
  // The repo survives a connector restart (resetGuard), like the app does between sign-ins.
  resetGuard();
  assert.equal(checkRequest({ url: latest }), true);
});
