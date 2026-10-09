// Nobody stays on an old version: an offered update installs itself at the next start, or a day
// after it was first offered, with a warning ten minutes before; a failed try is tried again.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { noteSeen, isPending, deadlineOf, GRACE_MS, WARN_MS } from '../electron/core/update/deadline.mjs';
import { whenText, countdown, deadlineSentence, retrySentence } from '../src/lib/update-deadline.js';

globalThis.__pulseTestElectron = { app: { getVersion: () => '1.0.0', isPackaged: true, getPath: () => os.tmpdir(), relaunch: () => {} } };
register(
  `data:text/javascript,${encodeURIComponent(`export async function resolve(specifier, context, next) {
  if (specifier === 'electron') return { url: 'data:text/javascript,export const app = globalThis.__pulseTestElectron.app;', shortCircuit: true };
  return next(specifier, context);
}`)}`,
);
const { Updater } = await import('../electron/updater.mjs');

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 9, 9, 9, 0);
const REPO = 'Moh-jbr/flobi-pulse';
const content = Buffer.from('the new version');
const sha = createHash('sha256').update(content).digest('hex');
/** Waits for an install the updater started by itself. */
const settled = (u) => u.autoInstall;

function release(v = '1.0.1') {
  return { tag_name: `v${v}`, body: 'notes', assets: [{ name: `Flobi-Pulse-${v}.AppImage`, size: content.length, digest: `sha256:${sha}`, browser_download_url: `https://github.com/${REPO}/releases/download/v${v}/x` }] };
}

/** An updater on Linux (an AppImage swap runs anywhere) with GitHub, the state file and notices faked. */
async function updater({ seen = null, fail = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pulse-forced-test-'));
  process.env.APPIMAGE = path.join(dir, 'Flobi-Pulse.AppImage');
  await fs.writeFile(process.env.APPIMAGE, 'the old version');
  const saved = [];
  const notices = [];
  // saveSeen writes the way main's state file does: later, not at once.
  let written = null;
  const saveSeen = (s) => (saved.push(s), new Promise((r) => setImmediate(() => r((written = s)))));
  const u = new Updater({ repo: REPO, onChange: () => {}, quit: () => (u.quits++, (u.quitSaw = written)), seen, saveSeen, onNotice: (n) => notices.push(n) });
  Object.assign(u, { quits: 0, downloads: 0, saved, notices, fail });
  u.latestRelease = async () => release(u.version || '1.0.1');
  u.download = async ({ file }) => {
    u.downloads++;
    if (u.fail) throw new Error('offline');
    await fs.writeFile(file, content);
    return { sha256: sha };
  };
  u.cleanup = () => (u.stop(), fs.rm(dir, { recursive: true, force: true }));
  return u;
}

async function onLinux(fn) {
  const saved = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', saved);
  }
}

test('noteSeen keeps the first date while an update waits, and starts over once it is installed', () => {
  assert.deepEqual(noteSeen(null, '1.0.1', '1.0.0', T0), { version: '1.0.1', at: T0 });
  const seen = { version: '1.0.1', at: T0 };
  assert.deepEqual(noteSeen(seen, '1.0.1', '1.0.0', T0 + HOUR), seen, 'the same release: the same day');
  assert.deepEqual(noteSeen(seen, '1.0.2', '1.0.0', T0 + HOUR), { version: '1.0.2', at: T0 }, 'publishing again buys no time');
  assert.deepEqual(noteSeen(seen, '1.0.2', '1.0.1', T0 + DAY), { version: '1.0.2', at: T0 + DAY }, 'installed: the next one gets its own day');
  assert.deepEqual(noteSeen({ version: '1.0.1', at: T0 + DAY }, '1.0.1', '1.0.0', T0), { version: '1.0.1', at: T0 }, 'a date in the future (a clock put back) is not trusted');
  assert.equal(isPending(seen, '1.0.0'), true);
  assert.equal(isPending(seen, '1.0.1'), false);
  assert.equal(isPending(null, '1.0.0'), false);
  assert.equal(isPending({ version: '1.0.1' }, '1.0.0'), false);
  assert.equal(deadlineOf(seen), T0 + GRACE_MS);
  assert.equal(GRACE_MS, DAY);
  assert.equal(WARN_MS, 10 * MIN);
});

test('how the deadline is said', () => {
  const now = new Date(2026, 9, 9, 9, 0).getTime();
  assert.match(whenText(new Date(2026, 9, 9, 17, 30).getTime(), now), /^today at /);
  assert.match(whenText(new Date(2026, 9, 10, 9, 0).getTime(), now), /^tomorrow at /);
  assert.match(whenText(new Date(2026, 9, 12, 9, 0).getTime(), now), /^on [A-Z][a-z]+ at /);
  assert.equal(countdown(now + 9 * MIN + 5_000, now), '9:05');
  assert.equal(countdown(now - 1, now), '0:00');
  assert.match(deadlineSentence(now + DAY, now), /^It installs itself the next time Flobi Pulse starts, or tomorrow at .+ at the latest\.$/);
  assert.equal(deadlineSentence(null), '');
  assert.match(retrySentence(now + HOUR, now), /^Flobi Pulse tries again by itself today at .+\.$/);
  assert.equal(retrySentence(null), '');
});

test('a first offer is remembered, said once, and given a deadline a day away', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  try {
    await onLinux(async () => {
      const u = await updater();
      await u.check();
      assert.equal(u.state.status, 'available');
      assert.deepEqual(u.saved, [{ version: '1.0.1', at: T0 }]);
      assert.equal(u.state.deadline, T0 + DAY);
      assert.deepEqual(u.notices, [{ kind: 'available', version: '1.0.1', at: T0 + DAY }]);
      mock.timers.tick(HOUR);
      await u.check();
      assert.equal(u.notices.length, 1, 'said once');
      assert.equal(u.saved.length, 1, 'the first date is kept');
      assert.equal(u.downloads, 0, 'nothing installs before the deadline');
      await u.cleanup();
    });
  } finally {
    mock.timers.reset();
  }
});

test('the last ten minutes are warned about, then it installs by itself at the deadline', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 });
  try {
    await onLinux(async () => {
      const u = await updater();
      await u.check();
      mock.timers.tick(DAY - WARN_MS);
      assert.equal(u.state.forcingAt, T0 + DAY);
      assert.deepEqual(u.notices.at(-1), { kind: 'soon', version: '1.0.1', at: T0 + DAY });
      assert.equal(u.downloads, 0);
      mock.timers.tick(WARN_MS);
      await settled(u);
      assert.equal(u.downloads, 1);
      assert.equal(u.quits, 1, 'installed and restarted');
      assert.equal(await fs.readFile(process.env.APPIMAGE, 'utf8'), 'the new version');
      await u.cleanup();
    });
  } finally {
    mock.timers.reset();
  }
});

test('an update offered before the app was closed installs at the first check of the next start', async () => {
  await onLinux(async () => {
    const u = await updater({ seen: { version: '1.0.1', at: Date.now() - HOUR } });
    assert.equal(u.dueOnStart, true);
    await u.check();
    await settled(u);
    assert.equal(u.downloads, 1);
    assert.equal(u.quits, 1);
    assert.deepEqual(u.notices, [], 'no "it is ready" for an update that is installing');
    await u.cleanup();
  });
});

test('past its deadline a check installs it; a failed try is tried again hourly, not at every check', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 + 2 * DAY });
  try {
    await onLinux(async () => {
      // Seen two days ago in a session that never reached its deadline (the computer slept).
      const u = await updater({ seen: { version: '1.0.1', at: T0 }, fail: true });
      u.dueOnStart = false;
      await u.check();
      await settled(u);
      assert.equal(u.downloads, 1);
      assert.equal(u.state.status, 'error');
      assert.equal(u.state.auto, true);
      mock.timers.tick(10 * MIN);
      await u.check(); // the window came to the front
      await settled(u);
      assert.equal(u.downloads, 1, 'not again within the hour');
      assert.equal(u.state.status, 'error', 'still says why it failed');
      u.fail = false;
      mock.timers.tick(HOUR);
      await u.check(); // the hourly check
      await settled(u);
      assert.equal(u.downloads, 2);
      assert.equal(u.quits, 1);
      await u.cleanup();
    });
  } finally {
    mock.timers.reset();
  }
});

test('an install that was handed off but did not take is not started again at every start', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 + HOUR });
  try {
    await onLinux(async () => {
      const first = await updater({ seen: { version: '1.0.1', at: T0 } });
      await first.check();
      await settled(first);
      assert.equal(first.quits, 1, 'handed to the installer, the app quits');
      const seen = first.saved.at(-1);
      assert.deepEqual(seen.handedOff, { version: '1.0.1', at: T0 + HOUR });
      assert.deepEqual(first.quitSaw, seen, 'saved before the app quit');
      await first.cleanup();

      // It started again, still on 1.0.0: the install didn't finish (macOS put the old app back).
      const again = await updater({ seen });
      assert.equal(again.dueOnStart, false);
      await again.check();
      assert.equal(again.downloads, 0, 'no download, and the app stays open');
      assert.equal(again.quits, 0);
      assert.equal(again.state.status, 'error');
      assert.match(again.state.error, /^The update to 1\.0\.1 didn't finish installing\. Download it from the releases page, or click to try again\.$/);
      assert.equal(again.state.nextTry, T0 + 7 * HOUR, 'tried again later, not at once');
      mock.timers.tick(HOUR);
      await again.check(); // the hourly check
      assert.equal(again.downloads, 0);
      assert.equal(again.state.status, 'error', 'still says why');
      mock.timers.tick(5 * HOUR);
      await settled(again);
      assert.equal(again.downloads, 1, 'six hours on, it tries again');
      await again.cleanup();
    });
  } finally {
    mock.timers.reset();
  }
});

test('a declined install at the start is tried again every hour before the deadline, with the same download', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 + HOUR });
  try {
    await onLinux(async () => {
      const u = await updater({ seen: { version: '1.0.1', at: T0 } });
      const appImage = process.env.APPIMAGE;
      process.env.APPIMAGE = path.join(appImage, 'no-such-folder', 'x.AppImage'); // the swap fails, like a declined prompt
      await u.check();
      await settled(u);
      assert.equal(u.downloads, 1);
      assert.equal(u.state.status, 'error');
      assert.equal(u.state.auto, true);
      assert.equal(u.state.nextTry, T0 + 2 * HOUR);
      mock.timers.tick(HOUR);
      await settled(u);
      assert.equal(u.state.status, 'error', 'the second try failed too');
      assert.equal(u.downloads, 1, 'it used the download it already had');
      assert.equal(u.quits, 0);
      process.env.APPIMAGE = appImage;
      mock.timers.tick(HOUR);
      await settled(u);
      assert.equal(u.quits, 1, 'the third try installed it, hours before the deadline');
      assert.equal(u.downloads, 1);
      await u.cleanup();
    });
  } finally {
    mock.timers.reset();
  }
});

test('once this version is current the remembered offer is cleared', async () => {
  await onLinux(async () => {
    const u = await updater({ seen: { version: '1.0.1', at: Date.now() } });
    u.dueOnStart = false;
    u.version = '1.0.0'; // GitHub's latest is this version
    await u.check();
    assert.equal(u.state.status, 'idle');
    assert.deepEqual(u.saved, [null]);
    assert.equal(u.state.deadline, null);
    await u.cleanup();
  });
});

test('a declined install does not stop a manual check or install from working', async () => {
  await onLinux(async () => {
    const u = await updater({ fail: true });
    await u.check();
    await u.install();
    assert.equal(u.state.status, 'error');
    assert.equal(u.state.auto, false);
    await u.check();
    assert.equal(u.state.status, 'available', 'a failed click is not kept as an automatic failure');
    await u.cleanup();
  });
});
