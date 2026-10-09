// Starting with the computer. Windows and macOS have Electron's login items; Linux has none, so
// there it is an XDG autostart entry (~/.config/autostart), which GNOME, KDE and the rest read.
// Started this way the app opens in the tray, not on top of whatever the person sat down to do.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** What the app is started with when the computer starts it. */
export const HIDDEN_ARG = '--hidden';

/** Where Linux keeps what starts with the session. */
export function autostartFile(env = process.env, home = os.homedir()) {
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'autostart', 'flobi-pulse.desktop');
}

/** The autostart entry for a Linux install: `exec` is the AppImage, or the installed binary. */
export function autostartEntry(exec) {
  // Exec quoting: the path goes in double quotes, with ", `, $ and \ escaped (Desktop Entry spec).
  const quoted = `"${String(exec).replace(/(["`$\\])/g, '\\$1')}"`;
  return ['[Desktop Entry]', 'Type=Application', 'Name=Flobi Pulse', 'Comment=Watches the Flobi platform', `Exec=${quoted} ${HIDDEN_ARG}`, 'Icon=flobi-pulse', 'Terminal=false', 'X-GNOME-Autostart-enabled=true', ''].join('\n');
}

/**
 * Turns starting with the computer on or off. Only an installed app does this: run from source,
 * it would start Electron itself at every login.
 */
export async function setOpenAtLogin(app, on, { platform = process.platform, env = process.env } = {}) {
  if (!app.isPackaged) return false;
  if (platform === 'win32') app.setLoginItemSettings({ openAtLogin: on, args: [HIDDEN_ARG] });
  else if (platform === 'darwin') app.setLoginItemSettings({ openAtLogin: on, openAsHidden: true });
  else {
    const file = autostartFile(env);
    if (on) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, autostartEntry(env.APPIMAGE || process.execPath));
    } else await fs.rm(file, { force: true });
  }
  return true;
}

/**
 * At each start: brings the computer's entry in line with the setting without overruling the
 * person. Returns what the setting should now say. Turned off outside the app (Windows' Startup
 * apps, a Linux desktop's Startup Applications) it stays off, and the setting follows (false);
 * missing or pointing at another copy of the app (moved, updated, installed for everyone) it is
 * registered again. Only an installed app does any of this.
 */
export async function syncOpenAtLogin(app, wanted, { platform = process.platform, env = process.env } = {}) {
  if (!app.isPackaged) return wanted;
  if (platform === 'win32') {
    const cur = app.getLoginItemSettings({ args: [HIDDEN_ARG] });
    if (wanted && cur.openAtLogin && cur.executableWillLaunchAtLogin === false) return false;
    if (wanted !== !!cur.openAtLogin) app.setLoginItemSettings({ openAtLogin: wanted, args: [HIDDEN_ARG] });
    return wanted;
  }
  if (platform === 'darwin') {
    const cur = app.getLoginItemSettings();
    // macOS 13+: switched off in System Settings → Login Items (asking again would only nag).
    if (wanted && cur.status === 'requires-approval') return false;
    if (wanted !== !!cur.openAtLogin) app.setLoginItemSettings({ openAtLogin: wanted, openAsHidden: true });
    return wanted;
  }
  const file = autostartFile(env);
  const there = await fs
    .stat(file)
    .then(() => true)
    .catch(() => false);
  if (!wanted) {
    if (there) await fs.rm(file, { force: true });
    return false;
  }
  if (!there) return false; // removed in the desktop's Startup Applications
  // Some desktops switch an entry off by editing it rather than deleting it.
  const entry = await fs.readFile(file, 'utf8').catch(() => '');
  if (/^(Hidden=true|X-GNOME-Autostart-enabled=false)\s*$/im.test(entry)) return false;
  await fs.writeFile(file, autostartEntry(env.APPIMAGE || process.execPath)); // the Exec of this copy
  return true;
}

/** Whether this start was the computer starting the app (it then waits in the tray). */
export function openedAtLogin(app, { platform = process.platform, argv = process.argv } = {}) {
  if (argv.includes(HIDDEN_ARG)) return true;
  if (platform === 'darwin') {
    try {
      return !!app.getLoginItemSettings().wasOpenedAtLogin;
    } catch {
      return false;
    }
  }
  return false;
}
