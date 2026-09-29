// App updates from the app's own GitHub Releases, the way Discord does it: check
// in the background, show "Update available" in the toolbar, and on a click
// download the new version, verify its checksum, install it and restart.
//
// No update library: the two or three requests go through the read-only guard
// like every other request, and the shipped app keeps zero runtime dependencies.
// It also works without paid code signing (which the usual macOS updater needs).
import { app } from 'electron';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { json, download } from './core/net/http.mjs';
import { configureGuard } from './core/net/guard.mjs';
import { isNewer, pickAsset, parseSums, assetDigest, UPDATE_ASSET, UPDATE_DIR_PREFIX, checkRetryDelay, isRateLimited } from './core/update/release.mjs';
import { cleanStaleUpdates } from './core/update/cleanup.mjs';

const execFileP = promisify(execFile);
const HOUR = 60 * 60_000;
/** While an update downloads or installs, a check must leave the status alone. */
const BUSY = ['downloading', 'installing'];

export class Updater {
  /**
   * @param {{repo: string, onChange: (state: object) => void, quit: () => void}} o
   * `quit` must really quit (not hide to the tray), so the installer can take over.
   */
  constructor({ repo, onChange, quit }) {
    this.repo = repo;
    this.onChange = onChange;
    this.quit = quit;
    this.failures = 0; // failed checks in a row
    this.retryAt = 0; // after a failed check: when the retry runs (background checks wait for it)
    this.state = { status: 'idle', current: app.getVersion(), releasesUrl: repo ? `https://github.com/${repo}/releases/latest` : null };
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.onChange(this.state);
  }

  /** Why this copy can't update itself, or null when it can. */
  unsupported() {
    if (!app.isPackaged) return 'Updates only run in the installed app.';
    if (!this.repo) return 'No release repository is set in package.json.';
    if (!UPDATE_ASSET[process.platform]) return 'Updates aren’t available on this platform.';
    if (process.platform === 'linux' && !process.env.APPIMAGE) return 'Updates only work when the app runs as an AppImage.';
    return null;
  }

  start() {
    const reason = this.unsupported();
    if (reason) return this.set({ status: 'unsupported', error: reason });
    this.stopped = false;
    this.retryAt = 0; // stop() cancelled any pending retry
    configureGuard({ updateRepo: this.repo });
    cleanStaleUpdates().catch(() => {}); // leftovers of earlier updates
    this.first = setTimeout(() => this.check(), 5_000);
    this.timer = setInterval(() => this.check(), HOUR);
  }

  /** Cancels every timer: the first check, the hourly one and a pending retry (main calls this on quit). */
  stop() {
    this.stopped = true;
    clearTimeout(this.first);
    clearInterval(this.timer);
    clearTimeout(this.retry);
  }

  /** Checks again if the last check is older than `maxAgeMs` (window focused, computer woke up). */
  checkIfStale(maxAgeMs = 10 * 60_000) {
    if (this.state.status !== 'unsupported' && Date.now() - (this.lastCheck || 0) > maxAgeMs) this.check();
  }

  /** The latest release (a method of its own so tests can stand in for GitHub). */
  latestRelease() {
    return json({ url: `https://api.github.com/repos/${this.repo}/releases/latest`, headers: { accept: 'application/vnd.github+json' } });
  }

  /** Streams a file to disk (a method of its own so tests can stand in for GitHub). */
  download(opts) {
    return download(opts);
  }

  /** The folder the app runs from, which the Windows installer writes to. */
  installDir() {
    return path.dirname(process.execPath);
  }

  async check({ manual = false } = {}) {
    if (this.stopped || ['downloading', 'installing', 'unsupported'].includes(this.state.status)) return this.state;
    // After a failure the retry timer checks at retryAt; checking sooner in the background
    // (focus, wake-up) would only spend the rate limit the whole office shares.
    if (!manual && Date.now() < this.retryAt) return this.state;
    this.lastCheck = Date.now();
    clearTimeout(this.retry);
    if (manual) this.set({ status: 'checking', error: null });
    try {
      const rel = await this.latestRelease();
      this.failures = 0;
      this.retryAt = 0;
      // An install that started while this check was on its way keeps its status: turning
      // "downloading" back into "available" let a second click start a second install.
      if (this.stopped || BUSY.includes(this.state.status)) return this.state;
      const version = String(rel?.tag_name || '').replace(/^v/, '');
      const asset = pickAsset(rel, process.platform);
      if (!asset || !isNewer(version, this.state.current)) {
        this.set({ status: 'idle', checkedAt: Date.now(), error: null, lastError: null, retryAt: null });
      } else {
        this.release = rel;
        this.asset = asset;
        this.set({ status: 'available', version, notes: String(rel.body || '').slice(0, 1200), size: asset.size || 0, checkedAt: Date.now(), error: null, lastError: null, retryAt: null });
      }
    } catch (e) {
      if (this.stopped) return this.state;
      // Offline or rate-limited: try again later (GitHub's reset time when it gave one), and say so in Settings.
      console.warn('[update] check failed:', e.message);
      const delay = checkRetryDelay(e, this.failures++);
      this.retryAt = Date.now() + delay;
      clearTimeout(this.retry);
      this.retry = setTimeout(() => {
        this.retryAt = 0;
        this.check();
      }, delay);
      if (BUSY.includes(this.state.status)) return this.state;
      const message = isRateLimited(e) ? 'GitHub is limiting update checks from this network for now' : e.message;
      this.set({ status: this.state.status === 'checking' ? 'idle' : this.state.status, lastError: message, retryAt: this.retryAt, error: manual ? `Couldn't check for updates: ${message}` : this.state.error });
    }
    return this.state;
  }

  /** Download → verify → install → restart. Called when the user clicks the button. */
  async install() {
    // Claimed before the first await, so a second click can't start a second download
    // and installer (on macOS, two swap scripts racing).
    if (this.installing || !['available', 'error'].includes(this.state.status) || !this.asset) return this.state;
    this.installing = true;
    const asset = this.asset;
    let dir = null;
    let handedOff = false;
    try {
      this.set({ status: 'downloading', progress: 0, error: null });
      // Installed for all users (Program Files): the installer would need an administrator,
      // and saying no to that prompt would leave the app closed. Say so before downloading.
      if (process.platform === 'win32' && !(await canWrite(this.installDir()))) {
        throw new Error(`Flobi Pulse is installed for all users (in ${this.installDir()}), so it can't update itself. Download the new installer from the releases page and run it.`);
      }
      dir = await fs.mkdtemp(path.join(os.tmpdir(), UPDATE_DIR_PREFIX));
      const file = path.join(dir, asset.name);
      let shown = 0;
      const { sha256 } = await this.download({
        url: asset.browser_download_url,
        file,
        onProgress: (bytes, total) => {
          const p = total ? bytes / total : 0;
          if (p - shown >= 0.01) this.set({ progress: (shown = p) });
        },
      });
      const expected = assetDigest(asset) || (await this.checksumFromList(asset.name, dir));
      if (!expected) throw new Error('This release has no checksum for the download, so it was not installed.');
      if (expected !== sha256) throw new Error('The download was damaged (checksum mismatch). Try again.');
      this.set({ status: 'installing', progress: 1 });
      const { keepDir = false } = (await INSTALL[process.platform](file, dir)) || {};
      handedOff = true;
      if (!keepDir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      this.quit();
    } catch (e) {
      this.set({ status: 'error', error: e.message });
    } finally {
      if (!handedOff) {
        if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        this.installing = false;
      }
    }
    return this.state;
  }

  /** Fallback when GitHub doesn't report a digest: the release's SHA256SUMS.txt. */
  async checksumFromList(name, dir) {
    const list = (this.release?.assets || []).find((a) => a.name === 'SHA256SUMS.txt');
    if (!list) return null;
    const file = path.join(dir, 'SHA256SUMS.txt');
    await this.download({ url: list.browser_download_url, file, maxBytes: 64 * 1024 });
    return parseSums(await fs.readFile(file, 'utf8')).get(name) || null;
  }
}

/**
 * Resolves once the OS has started the child. Rejects (with `why`) when it couldn't,
 * e.g. an antivirus quarantined or locked the file, so the app keeps running.
 */
/**
 * Starts a detached process (`start` calls spawn) and resolves once it runs. Node reports one that
 * can't start in two ways: an 'error' event (a missing file, no permission), or by throwing right
 * away (on Windows, a file that isn't a program or one an antivirus blocked: "spawn UNKNOWN").
 * Either way the caller gets the same plain message: "<why> (<code>)."
 */
export function started(why, start) {
  const fail = (e) => new Error(`${why} (${e?.code || e?.message || e}).`);
  let child;
  try {
    child = start();
  } catch (e) {
    return Promise.reject(fail(e));
  }
  return new Promise((resolve, reject) => {
    child.on('error', () => {}); // an error after it started must not crash the app
    child.once('error', (e) => reject(fail(e)));
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/** Whether this process may write to `dir`. fs.access ignores Windows permissions (ACLs), so it tries. */
async function canWrite(dir) {
  const probe = path.join(dir, `.flobi-pulse-write-test-${process.pid}`);
  try {
    await fs.writeFile(probe, '');
    await fs.rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

const INSTALL = {
  // The NSIS installer reinstalls silently (/S) into the folder the user chose the
  // first time, then starts the app again (--force-run). install() has already
  // checked that this folder is writable.
  async win32(file) {
    // Quit only once Windows has really started the installer: if an antivirus blocked
    // the (unsigned) file, the app would otherwise close without updating.
    await started("Windows didn't start the installer (an antivirus may have blocked it). Download it from the releases page instead", () => spawn(file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true }));
    return { keepDir: true }; // it runs from the download folder; cleaned at a later start
  },

  // Unzip the new .app next to the current one; once this process has exited, a
  // small shell script swaps them (keeping the old one if anything fails) and reopens.
  async darwin(file, dir) {
    const bundle = path.resolve(path.dirname(app.getPath('exe')), '..', '..');
    if (!bundle.endsWith('.app')) throw new Error("Couldn't find the app to replace.");
    if (bundle.startsWith('/Volumes/') || bundle.includes('/AppTranslocation/')) throw new Error('Move Flobi Pulse to your Applications folder first, then update.');
    const parent = path.dirname(bundle);
    await fs.access(parent, FS.W_OK).catch(() => {
      throw new Error(`No permission to replace the app in ${parent}. Download the update from the releases page instead.`);
    });
    const unpacked = path.join(dir, 'unpacked');
    await execFileP('/usr/bin/ditto', ['-x', '-k', file, unpacked]);
    const name = (await fs.readdir(unpacked)).find((n) => n.endsWith('.app'));
    if (!name) throw new Error('The update has no app inside.');
    const staged = `${bundle}.update`;
    await fs.rm(staged, { recursive: true, force: true });
    await execFileP('/usr/bin/ditto', [path.join(unpacked, name), staged]);
    const script = [
      `while /bin/kill -0 ${process.pid} 2>/dev/null; do /bin/sleep 0.3; done`,
      '/bin/rm -rf "$DEST.old"',
      'if /bin/mv "$DEST" "$DEST.old"; then',
      '  if /bin/mv "$STAGED" "$DEST"; then /bin/rm -rf "$DEST.old"; else /bin/mv "$DEST.old" "$DEST"; fi',
      'fi',
      '/usr/bin/xattr -dr com.apple.quarantine "$DEST" 2>/dev/null',
      '/usr/bin/open "$DEST"',
    ].join('\n');
    await started("Couldn't start the update", () => spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore', env: { ...process.env, DEST: bundle, STAGED: staged } }));
  },

  // An AppImage is one file: swap it (the running copy stays readable until exit) and relaunch.
  async linux(file) {
    const target = process.env.APPIMAGE;
    const staged = `${target}.update`;
    await fs.copyFile(file, staged);
    await fs.chmod(staged, 0o755);
    await fs.rename(staged, target);
    app.relaunch({ execPath: target, args: process.argv.slice(1) });
  },
};
