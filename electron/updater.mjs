// App updates from the app's own GitHub Releases, the way Discord does it: check
// in the background, show "Update available" in the toolbar, and on a click
// download the new version, verify its checksum, install it and restart.
//
// No update library: the two or three requests go through the read-only guard
// like every other request, and the shipped app keeps zero runtime dependencies.
// It also works without paid code signing (which the usual macOS updater needs).
//
// Nobody stays on an old version (core/update/deadline.mjs): an update that was offered and not
// installed installs itself the next time the app starts, or a day after it was first offered while
// the app runs, with a notification ten minutes before.
import { app } from 'electron';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { constants as FS, createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { json, download } from './core/net/http.mjs';
import { configureGuard } from './core/net/guard.mjs';
import { isNewer, pickAsset, parseSums, assetDigest, UPDATE_ASSET, UPDATE_DIR_PREFIX, checkRetryDelay, isRateLimited } from './core/update/release.mjs';
import { cleanStaleUpdates } from './core/update/cleanup.mjs';
import { noteSeen, isPending, deadlineOf, unfinishedHandOff, WARN_MS } from './core/update/deadline.mjs';

const execFileP = promisify(execFile);
const HOUR = 60 * 60_000;
/** How often an install that failed by itself is tried again; after a hand-off that didn't finish, less often (each try closes the app). */
const RETRY_EVERY = HOUR;
const RETRY_AFTER_HANDOFF = 6 * HOUR;
/** While an update downloads or installs, a check must leave the status alone. */
const BUSY = ['downloading', 'installing'];

export class Updater {
  /**
   * @param {{repo: string, onChange: (state: object) => void, quit: () => void, seen?: {version: string, at: number} | null, saveSeen?: (seen: object | null) => void, onNotice?: (n: {kind: 'available' | 'soon', version: string, at: number}) => void}} o
   * `quit` must really quit (not hide to the tray), so the installer can take over. `seen` is when
   * an update was first offered (kept by main across restarts, given back through `saveSeen`);
   * `onNotice` tells the person about one: offered ('available'), installing itself soon ('soon').
   */
  constructor({ repo, onChange, quit, seen = null, saveSeen = () => {}, onNotice = () => {} }) {
    this.repo = repo;
    this.onChange = onChange;
    this.quit = quit;
    this.saveSeen = saveSeen;
    this.onNotice = onNotice;
    this.seen = seen;
    // Offered before and still not installed: it installs as this start's first check finds it,
    // unless the last start already handed it to the installer and it didn't take.
    this.unfinished = unfinishedHandOff(seen, app.getVersion()) ? seen.handedOff.version : null;
    this.dueOnStart = !this.unfinished && isPending(seen, app.getVersion());
    this.autoTriedAt = this.unfinished ? Date.now() : 0; // the last time it tried to install by itself
    this.retryEvery = this.unfinished ? RETRY_AFTER_HANDOFF : RETRY_EVERY;
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
    this.first = setTimeout(() => this.check(), this.dueOnStart ? 0 : 5_000);
    this.timer = setInterval(() => this.check(), HOUR);
  }

  /** Cancels every timer: the first check, the hourly one and a pending retry (main calls this on quit). */
  stop() {
    this.stopped = true;
    clearTimeout(this.first);
    clearInterval(this.timer);
    clearTimeout(this.retry);
    clearTimeout(this.warnTimer);
    clearTimeout(this.forceTimer);
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

  /**
   * Starts `file` through Windows' administrator prompt (a method of its own so tests can stand in
   * for it). Resolves once the elevated installer is running; rejects when the prompt was declined
   * or blocked, so the app stays open. Start-Process returns as soon as the process has started.
   */
  async elevate(file, args) {
    try {
      await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', "$ErrorActionPreference = 'Stop'; Start-Process -FilePath $env:PULSE_INSTALLER -ArgumentList ($env:PULSE_ARGS -split ' ') -Verb RunAs"], {
        env: { ...process.env, PULSE_INSTALLER: file, PULSE_ARGS: args.join(' ') },
        windowsHide: true,
      });
    } catch {
      throw new Error('Flobi Pulse is installed for all users, so Windows has to allow the update. The permission prompt was declined or blocked, and nothing was changed. Click to try again.');
    }
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
        this.dueOnStart = false;
        this.clearDeadline();
        if (this.seen) this.saveSeen((this.seen = null));
        this.set({ status: 'idle', checkedAt: Date.now(), error: null, lastError: null, retryAt: null, deadline: null, forcingAt: null });
      } else {
        this.release = rel;
        this.asset = asset;
        const offered = this.seen?.version !== version; // a version this computer hasn't been told about
        const seen = noteSeen(this.seen, version, this.state.current, Date.now());
        if (seen.version !== this.seen?.version || seen.at !== this.seen?.at) this.saveSeen((this.seen = seen));
        // A failed try at installing by itself keeps saying why until the next try.
        const unfinished = this.unfinished === version && this.state.status !== 'error';
        if (this.unfinished !== version) this.unfinished = null;
        const failed = unfinished || (this.state.status === 'error' && this.state.auto);
        this.set({
          status: failed ? 'error' : 'available',
          version,
          notes: String(rel.body || '').slice(0, 1200),
          size: asset.size || 0,
          checkedAt: Date.now(),
          ...(!failed && { error: null }),
          ...(unfinished && { auto: true, nextTry: this.autoTriedAt + this.retryEvery, error: `The update to ${version} didn't finish installing. Download it from the releases page, or click to try again.` }),
          lastError: null,
          retryAt: null,
          deadline: deadlineOf(seen),
        });
        if (offered && !this.dueOnStart && Date.now() < deadlineOf(seen) - WARN_MS) this.onNotice({ kind: 'available', version, at: deadlineOf(seen) });
        this.enforce();
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

  /**
   * Installs an offered update by itself when it is due: at the first check after the app starts,
   * or at its deadline. Before the deadline it sets a timer for the warning and one for the install.
   * A try that failed (the administrator prompt declined, offline) is tried again at the next
   * start, and hourly while the app runs, deadline or not: the hourly check calls this again.
   */
  enforce() {
    this.clearDeadline();
    if (!this.seen || !isPending(this.seen, this.state.current)) return;
    const deadline = deadlineOf(this.seen);
    const now = Date.now();
    const retrying = this.state.status === 'error' && this.state.auto;
    if (this.dueOnStart || now >= deadline || retrying) {
      const onStart = this.dueOnStart;
      this.dueOnStart = false;
      // Checks also run when the window is focused: one try an hour is enough.
      if (!onStart && now - this.autoTriedAt < this.retryEvery) {
        // The next try: when the wait is over, or at the deadline if that comes first.
        const next = this.autoTriedAt + this.retryEvery;
        this.forceTimer = setTimeout(() => this.enforce(), (now < deadline ? Math.min(deadline, next) : next) - now);
        this.forceTimer.unref?.();
        return;
      }
      if (!this.canInstall()) return; // already installing, or a check is under way (it calls this again)
      this.autoTriedAt = now;
      this.autoInstall = this.install({ auto: true }); // kept so tests can wait for it
      return;
    }
    if (now >= deadline - WARN_MS) this.warn(deadline);
    else this.warnTimer = setTimeout(() => this.warn(deadline), deadline - WARN_MS - now);
    this.forceTimer = setTimeout(() => this.enforce(), deadline - now);
    this.warnTimer?.unref?.();
    this.forceTimer.unref?.();
  }

  /** Ten minutes before it installs by itself: a countdown in the toolbar and a notification. */
  warn(deadline) {
    if (this.state.forcingAt === deadline) return;
    this.set({ forcingAt: deadline });
    this.onNotice({ kind: 'soon', version: this.state.version, at: deadline });
  }

  clearDeadline() {
    clearTimeout(this.warnTimer);
    clearTimeout(this.forceTimer);
    this.warnTimer = this.forceTimer = null;
  }

  canInstall() {
    return !this.installing && ['available', 'error'].includes(this.state.status) && !!this.asset;
  }

  /** Download → verify → install → restart. Called when the user clicks the button, or by `enforce` (`auto`). */
  async install({ auto = false } = {}) {
    // Claimed before the first await, so a second click can't start a second download
    // and installer (on macOS, two swap scripts racing).
    if (!this.canInstall()) return this.state;
    this.installing = true;
    const asset = this.asset;
    const version = this.state.version;
    let dir = null;
    let file = null;
    let verified = null; // the checksum, once the file on disk is known good
    let handedOff = false;
    try {
      this.set({ status: 'downloading', progress: 0, error: null, auto });
      // Installed for all users (Program Files): only an administrator can write there, so the
      // installer is started through Windows' administrator prompt once the download is verified.
      const allUsers = process.platform === 'win32' && !(await canWrite(this.installDir()));
      // A try that failed after the download (a declined prompt) left it on disk: the next try
      // uses it again if it is still whole, rather than downloading the same 100 MB every hour.
      const kept = this.kept;
      this.kept = null;
      if (kept && kept.name === asset.name && (await sha256Of(kept.file).catch(() => null)) === kept.sha) ({ dir, file, sha: verified } = kept);
      else {
        if (kept) await fs.rm(kept.dir, { recursive: true, force: true }).catch(() => {});
        dir = await fs.mkdtemp(path.join(os.tmpdir(), UPDATE_DIR_PREFIX));
        file = path.join(dir, asset.name);
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
        verified = sha256;
      }
      this.set({ status: 'installing', progress: 1 });
      const { keepDir = false } = (await INSTALL[process.platform](file, dir, { allUsers, elevate: (f, args) => this.elevate(f, args) })) || {};
      handedOff = true;
      if (!keepDir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      // Remembered, so a start that still runs the old version knows this install didn't take.
      // Written before quitting: the app may exit without waiting for a save still on its way.
      this.seen = { ...(this.seen || { version, at: Date.now() }), handedOff: { version, at: Date.now() } };
      await Promise.resolve(this.saveSeen(this.seen)).catch(() => {});
      this.quit();
    } catch (e) {
      this.set({ status: 'error', error: e.message, nextTry: auto ? this.autoTriedAt + this.retryEvery : null });
    } finally {
      if (!handedOff) {
        if (verified) this.kept = { dir, file, sha: verified, name: asset.name };
        else if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
        this.installing = false;
      }
    }
    if (auto && !handedOff && !this.stopped) this.enforce(); // sets the timer for the next try
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

/** The sha256 of a file on disk, in hex. */
function sha256Of(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('error', reject)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')));
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
  // first time, then starts the app again (--force-run). An install for all users
  // (Program Files) goes through the administrator prompt and stays per-machine (/allusers).
  async win32(file, dir, { allUsers = false, elevate } = {}) {
    const args = ['/S', '--updated', '--force-run'];
    // Quit only once Windows has really started the installer: if an antivirus blocked
    // the (unsigned) file, or the prompt was declined, the app would otherwise close without updating.
    if (allUsers) await elevate(file, ['/S', '/allusers', '--updated', '--force-run']);
    else await started("Windows didn't start the installer (an antivirus may have blocked it). Download it from the releases page instead", () => spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true }));
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
