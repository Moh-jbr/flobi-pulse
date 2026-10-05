// The app updater (C14): a check never undoes an install in progress, one click =
// one install, Windows installer failures keep the app running, temp folders are
// cleaned up, rate limits are honoured, and stop() cancels every timer.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { HttpError } from '../electron/core/net/http.mjs';
import { checkRetryDelay, isRateLimited } from '../electron/core/update/release.mjs';
import { cleanStaleUpdates } from '../electron/core/update/cleanup.mjs';

// updater.mjs imports Electron's `app`, which plain Node doesn't have: point that import at a stub.
const relaunches = [];
globalThis.__pulseTestElectron = { app: { getVersion: () => '1.0.0', isPackaged: true, getPath: () => os.tmpdir(), relaunch: (o) => relaunches.push(o) } };
register(
  `data:text/javascript,${encodeURIComponent(`export async function resolve(specifier, context, next) {
  if (specifier === 'electron') return { url: 'data:text/javascript,export const app = globalThis.__pulseTestElectron.app;', shortCircuit: true };
  return next(specifier, context);
}`)}`,
);
const { Updater, started } = await import('../electron/updater.mjs');

const MIN = 60_000;
const HOUR = 60 * MIN;
const REPO = 'Moh-jbr/flobi-pulse';
const content = Buffer.from('the new version');
const sha = createHash('sha256').update(content).digest('hex');
const flush = () => new Promise((r) => setImmediate(r));

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

function release(v = '1.0.1') {
  const asset = (name) => ({ name, size: content.length, digest: `sha256:${sha}`, browser_download_url: `https://github.com/${REPO}/releases/download/v${v}/${name}` });
  return { tag_name: `v${v}`, body: 'notes', assets: [asset(`Flobi-Pulse-Setup-${v}.exe`), asset(`Flobi-Pulse-${v}-mac.zip`), asset(`Flobi-Pulse-${v}.AppImage`)] };
}

async function scratch() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pulse-updater-test-'));
}

/** An updater whose GitHub is faked; downloads write `content` and remember their folder. */
function updater() {
  const u = new Updater({ repo: REPO, onChange: () => {}, quit: () => u.quits++ });
  u.quits = 0;
  u.dirs = [];
  u.latestRelease = async () => release();
  u.download = async ({ file }) => {
    u.dirs.push(path.dirname(file));
    await fs.writeFile(file, content);
    return { sha256: sha, bytes: content.length };
  };
  return u;
}

async function asPlatform(platform, fn) {
  const saved = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', saved);
  }
}

const gone = (p) => fs.access(p).then(() => false, () => true);

test('a check that lands during a download leaves it alone, and more clicks start nothing', async () => {
  const dir = await scratch();
  process.env.APPIMAGE = path.join(dir, 'Flobi-Pulse.AppImage');
  await fs.writeFile(process.env.APPIMAGE, 'the old version');
  // The AppImage install (a file swap) runs on any OS, so this runs the same everywhere.
  await asPlatform('linux', async () => {
    const u = updater();
    await u.check();
    assert.equal(u.state.status, 'available');

    const slow = deferred();
    u.latestRelease = () => slow.promise;
    const checking = u.check(); // a background check (window focused) is on its way…

    const gate = deferred();
    const write = u.download;
    let downloads = 0;
    u.download = async (o) => (downloads++, await gate.promise, write(o));
    const first = u.install(); // …when the "Update available" button is clicked
    assert.equal(u.state.status, 'downloading', 'claimed at once');
    const second = u.install(); // and clicked again
    slow.resolve(release());
    await checking;
    assert.equal(u.state.status, 'downloading', 'the check did not turn it back into "available"');
    const third = u.install();
    gate.resolve();
    await Promise.all([first, second, third]);

    assert.equal(downloads, 1, 'one download, one installer');
    assert.equal(u.quits, 1);
    assert.equal(await fs.readFile(process.env.APPIMAGE, 'utf8'), 'the new version');
    assert.equal(relaunches.length, 1);
    assert.ok(await gone(u.dirs[0]), 'the download folder is removed once the update is in place');
  });
  await fs.rm(dir, { recursive: true, force: true });
});

test('Windows: an installer that can’t start (antivirus) leaves the app running with a plain error', async () => {
  const dir = await scratch();
  await asPlatform('win32', async () => {
    const u = updater();
    u.installDir = () => dir; // writable: a per-user install
    await u.check();
    assert.equal(u.asset.name, 'Flobi-Pulse-Setup-1.0.1.exe');
    await u.install(); // the downloaded file can't be run here, just like a quarantined one
    assert.equal(u.state.status, 'error');
    assert.match(u.state.error, /^Windows didn't start the installer \(an antivirus may have blocked it\)\. Download it from the releases page instead \([A-Z]+\)\.$/);
    assert.equal(u.quits, 0, 'the app stays open');
    assert.ok(await gone(u.dirs[0]), 'the failed download is removed');
    await u.install(); // and it can be tried again
    assert.equal(u.dirs.length, 2);
    assert.equal(u.quits, 0);
  });
  await fs.rm(dir, { recursive: true, force: true });
});

test('a program that can’t start gives the same plain error, whether Node throws (Windows) or reports it', async () => {
  const why = "Windows didn't start the installer";
  // Windows, a file that isn't a program (or one an antivirus blocked): spawn throws right away.
  await assert.rejects(
    started(why, () => {
      throw Object.assign(new Error('spawn UNKNOWN'), { code: 'UNKNOWN' });
    }),
    { message: `${why} (UNKNOWN).` },
  );
  // Elsewhere it's an 'error' event; one that did start is let go (unref) and resolves.
  const { EventEmitter } = await import('node:events');
  const blocked = Object.assign(new EventEmitter(), { unref() {} });
  const failing = started(why, () => blocked);
  blocked.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }));
  await assert.rejects(failing, { message: `${why} (EACCES).` });
  const running = Object.assign(new EventEmitter(), { unref: () => (running.unrefed = true) });
  const ok = started(why, () => running);
  running.emit('spawn');
  await ok;
  assert.equal(running.unrefed, true);
  running.emit('error', new Error('exited badly')); // later errors are ignored, not thrown
});

test('Windows: installed for all users, it downloads, verifies, then runs the installer through the administrator prompt', async () => {
  await asPlatform('win32', async () => {
    const u = updater();
    u.installDir = () => path.join(os.tmpdir(), 'pulse-no-such-folder', 'Flobi Pulse'); // not writable for us
    const asked = [];
    u.elevate = async (file, args) => asked.push({ file, args });
    await u.check();
    await u.install();
    assert.equal(u.state.error, null);
    assert.equal(u.state.status, 'installing');
    assert.equal(asked.length, 1, 'one administrator prompt');
    assert.equal(path.basename(asked[0].file), 'Flobi-Pulse-Setup-1.0.1.exe');
    assert.equal(path.dirname(asked[0].file), u.dirs[0], 'the verified download is what runs');
    assert.deepEqual(asked[0].args, ['/S', '/allusers', '--updated', '--force-run'], 'silent, stays installed for all users, starts again');
    assert.equal(u.quits, 1, 'the app quits so the installer can replace it');
  });
});

test('Windows: a declined administrator prompt leaves the app running with a plain error, and it can be tried again', async () => {
  await asPlatform('win32', async () => {
    const u = updater();
    u.installDir = () => path.join(os.tmpdir(), 'pulse-no-such-folder', 'Flobi Pulse');
    let prompts = 0;
    u.elevate = async () => {
      prompts++;
      throw new Error('Flobi Pulse is installed for all users, so Windows has to allow the update. The permission prompt was declined or blocked, and nothing was changed. Click to try again.');
    };
    await u.check();
    await u.install();
    assert.equal(u.state.status, 'error');
    assert.match(u.state.error, /permission prompt was declined or blocked, and nothing was changed/);
    assert.equal(u.quits, 0, 'the app stays open');
    assert.ok(await gone(u.dirs[0]), 'the download is removed');
    await u.install();
    assert.equal(prompts, 2, 'a second click asks again');
    assert.equal(u.quits, 0);
  });
});

test('update temp folders older than a day are cleaned up; nothing else is touched', async () => {
  const root = await scratch();
  const old = path.join(root, 'flobi-pulse-update-a1b2c3');
  const fresh = path.join(root, 'flobi-pulse-update-d4e5f6');
  const other = path.join(root, 'someone-elses-folder');
  const file = path.join(root, 'flobi-pulse-update-not-a-folder');
  for (const d of [old, fresh, other]) await fs.mkdir(d);
  await fs.writeFile(path.join(old, 'Flobi-Pulse-Setup-1.0.1.exe'), 'x');
  await fs.writeFile(file, 'x');
  const twoDaysAgo = new Date(Date.now() - 48 * HOUR);
  for (const p of [old, other, file]) await fs.utimes(p, twoDaysAgo, twoDaysAgo);
  await cleanStaleUpdates(root);
  assert.ok(await gone(old));
  for (const p of [fresh, other, file]) assert.equal(await gone(p), false, p);
  await cleanStaleUpdates(path.join(root, 'missing')); // never throws
  await fs.rm(root, { recursive: true, force: true });
});

test('retry delay: GitHub’s reset when rate-limited (2 min…1 h), else 2 → 60 min', () => {
  const now = 1_790_000_000_000;
  const e = (status, headers) => new HttpError(status, `HTTP ${status}`, '', headers);
  assert.equal(checkRetryDelay(e(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 600) }), 0, now), 10 * MIN);
  assert.equal(checkRetryDelay(e(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 5 * 3600) }), 0, now), HOUR);
  assert.equal(checkRetryDelay(e(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 - 10) }), 0, now), 2 * MIN);
  assert.equal(checkRetryDelay(e(403, { 'retry-after': '30' }), 0, now), 2 * MIN);
  assert.equal(checkRetryDelay(e(429, { 'retry-after': '300' }), 0, now), 5 * MIN);
  assert.equal(checkRetryDelay(e(429, { 'retry-after': new Date(now + 15 * MIN).toUTCString() }), 0, now), 15 * MIN);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map((n) => checkRetryDelay(e(503, {}), n, now) / MIN), [2, 4, 8, 16, 32, 60, 60]);
  assert.equal(checkRetryDelay(new Error('getaddrinfo ENOTFOUND api.github.com'), 1, now), 4 * MIN);
  assert.equal(checkRetryDelay(e(403, {}), 0, now), 2 * MIN, 'a 403 without limit headers backs off normally');
  assert.equal(isRateLimited(e(403, { 'x-ratelimit-remaining': '0' })), true);
  assert.equal(isRateLimited(e(429, {})), true);
  assert.equal(isRateLimited(e(403, { 'x-ratelimit-remaining': '12' })), false);
});

test('a rate-limited check waits for the reset: background checks are skipped, "Check now" still asks', async () => {
  const u = updater();
  let calls = 0;
  u.latestRelease = async () => {
    calls++;
    throw new HttpError(403, 'HTTP 403 – API rate limit exceeded for 203.0.113.9.', '', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1200) });
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    await u.check();
    assert.ok(u.retryAt - Date.now() > 19 * MIN && u.retryAt - Date.now() <= 20 * MIN, 'retries at GitHub’s reset');
    assert.equal(u.state.retryAt, u.retryAt, 'Settings can show when');
    assert.equal(u.state.lastError, 'GitHub is limiting update checks from this network for now');
    await u.check(); // window focused, computer woke up…
    u.checkIfStale(0);
    assert.equal(calls, 1, '…no extra requests before the reset');
    await u.check({ manual: true });
    assert.equal(calls, 2);
    assert.equal(u.state.error, "Couldn't check for updates: GitHub is limiting update checks from this network for now");
  } finally {
    console.warn = warn;
    u.stop();
  }
});

test('stop() cancels every timer: the first check, the hourly one and a pending retry', async () => {
  process.env.APPIMAGE ||= path.join(os.tmpdir(), 'Flobi-Pulse.AppImage');
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const warn = console.warn;
  console.warn = () => {};
  const saved = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux' }); // an AppImage: supported on any test machine
  try {
    let calls = 0;
    const offline = async () => {
      calls++;
      throw new Error('getaddrinfo ENOTFOUND api.github.com');
    };
    const u = updater();
    u.latestRelease = offline;
    u.start();
    u.stop(); // quit within the first 5 seconds
    mock.timers.tick(3 * HOUR);
    await flush();
    assert.equal(calls, 0);

    const v = updater();
    v.latestRelease = offline;
    v.start();
    mock.timers.tick(5_000); // the first check runs, fails, and schedules a retry
    await flush();
    assert.equal(calls, 1);
    v.stop();
    mock.timers.tick(3 * HOUR);
    await flush();
    assert.equal(calls, 1, 'no retry and no hourly check after stop()');
  } finally {
    Object.defineProperty(process, 'platform', saved);
    console.warn = warn;
    mock.timers.reset();
  }
});
