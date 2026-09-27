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
import { isNewer, pickAsset, parseSums, assetDigest, UPDATE_ASSET } from './core/update/release.mjs';

const execFileP = promisify(execFile);
const HOUR = 60 * 60_000;

export class Updater {
  /**
   * @param {{repo: string, onChange: (state: object) => void, quit: () => void}} o
   * `quit` must really quit (not hide to the tray), so the installer can take over.
   */
  constructor({ repo, onChange, quit }) {
    this.repo = repo;
    this.onChange = onChange;
    this.quit = quit;
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
    configureGuard({ updateRepo: this.repo });
    setTimeout(() => this.check(), 15_000);
    this.timer = setInterval(() => this.check(), 2 * HOUR);
  }

  stop() {
    clearInterval(this.timer);
  }

  async check({ manual = false } = {}) {
    if (['downloading', 'installing', 'unsupported'].includes(this.state.status)) return this.state;
    if (manual) this.set({ status: 'checking', error: null });
    try {
      const rel = await json({ url: `https://api.github.com/repos/${this.repo}/releases/latest`, headers: { accept: 'application/vnd.github+json' } });
      const version = String(rel?.tag_name || '').replace(/^v/, '');
      const asset = pickAsset(rel, process.platform);
      if (!asset || !isNewer(version, this.state.current)) {
        this.set({ status: 'idle', checkedAt: Date.now(), error: null });
      } else {
        this.release = rel;
        this.asset = asset;
        this.set({ status: 'available', version, notes: String(rel.body || '').slice(0, 1200), size: asset.size || 0, checkedAt: Date.now(), error: null });
      }
    } catch (e) {
      // Offline or rate-limited: stay quiet and try again at the next check.
      console.warn('[update] check failed:', e.message);
      if (manual || this.state.status === 'checking') this.set({ status: 'idle', error: `Couldn't check for updates: ${e.message}` });
    }
    return this.state;
  }

  /** Download → verify → install → restart. Called when the user clicks the button. */
  async install() {
    if (!['available', 'error'].includes(this.state.status) || !this.asset) return this.state;
    const asset = this.asset;
    try {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flobi-pulse-update-'));
      const file = path.join(dir, asset.name);
      this.set({ status: 'downloading', progress: 0, error: null });
      let shown = 0;
      const { sha256 } = await download({
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
      await INSTALL[process.platform](file, dir);
      this.quit();
    } catch (e) {
      this.set({ status: 'error', error: e.message });
    }
    return this.state;
  }

  /** Fallback when GitHub doesn't report a digest: the release's SHA256SUMS.txt. */
  async checksumFromList(name, dir) {
    const list = (this.release?.assets || []).find((a) => a.name === 'SHA256SUMS.txt');
    if (!list) return null;
    const file = path.join(dir, 'SHA256SUMS.txt');
    await download({ url: list.browser_download_url, file, maxBytes: 64 * 1024 });
    return parseSums(await fs.readFile(file, 'utf8')).get(name) || null;
  }
}

const INSTALL = {
  // The NSIS installer reinstalls silently (/S) into the folder the user chose the
  // first time, then starts the app again (--force-run).
  async win32(file) {
    spawn(file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
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
    spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore', env: { ...process.env, DEST: bundle, STAGED: staged } }).unref();
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
