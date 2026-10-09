import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setOpenAtLogin, syncOpenAtLogin, openedAtLogin, autostartEntry, autostartFile, HIDDEN_ARG } from '../electron/core/login-item.mjs';

const fakeApp = (isPackaged, wasOpenedAtLogin = false, current = {}) => {
  const calls = [];
  return { isPackaged, calls, setLoginItemSettings: (o) => calls.push(o), getLoginItemSettings: () => ({ wasOpenedAtLogin, ...current }) };
};

test('run from source, nothing is registered to start with the computer', async () => {
  const app = fakeApp(false);
  assert.equal(await setOpenAtLogin(app, true, { platform: 'win32' }), false);
  assert.deepEqual(app.calls, []);
});

test('Windows starts the app hidden, macOS as hidden too', async () => {
  const win = fakeApp(true);
  await setOpenAtLogin(win, true, { platform: 'win32' });
  assert.deepEqual(win.calls, [{ openAtLogin: true, args: [HIDDEN_ARG] }]);
  const mac = fakeApp(true);
  await setOpenAtLogin(mac, false, { platform: 'darwin' });
  assert.deepEqual(mac.calls, [{ openAtLogin: false, openAsHidden: true }]);
});

test('Linux gets an autostart entry, and loses it when turned off', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pulse-autostart-'));
  const env = { XDG_CONFIG_HOME: dir, APPIMAGE: '/home/me/Apps/Flobi Pulse.AppImage' };
  const file = autostartFile(env);
  assert.equal(file, path.join(dir, 'autostart', 'flobi-pulse.desktop'));
  await setOpenAtLogin(fakeApp(true), true, { platform: 'linux', env });
  assert.match(await fs.readFile(file, 'utf8'), /^Exec="\/home\/me\/Apps\/Flobi Pulse\.AppImage" --hidden$/m);
  await setOpenAtLogin(fakeApp(true), false, { platform: 'linux', env });
  await assert.rejects(fs.stat(file));
  await fs.rm(dir, { recursive: true, force: true });
});

test('an odd path is quoted the way autostart entries need', () => {
  assert.match(autostartEntry('/opt/a "b" $c'), /^Exec="\/opt\/a \\"b\\" \\\$c" --hidden$/m);
});

test('the app knows when the computer started it', () => {
  assert.equal(openedAtLogin(fakeApp(true), { platform: 'win32', argv: ['pulse.exe', HIDDEN_ARG] }), true);
  assert.equal(openedAtLogin(fakeApp(true), { platform: 'win32', argv: ['pulse.exe'] }), false);
  assert.equal(openedAtLogin(fakeApp(true, true), { platform: 'darwin', argv: [] }), true);
  assert.equal(openedAtLogin(fakeApp(true, true), { platform: 'linux', argv: [] }), false);
});

test('Windows: turned off in Startup apps stays off, and the setting follows', async () => {
  const off = fakeApp(true, false, { openAtLogin: true, executableWillLaunchAtLogin: false });
  assert.equal(await syncOpenAtLogin(off, true, { platform: 'win32' }), false);
  assert.deepEqual(off.calls, []);
});

test('Windows: registered and enabled is left alone; missing (moved, updated) is registered again', async () => {
  const fine = fakeApp(true, false, { openAtLogin: true, executableWillLaunchAtLogin: true });
  assert.equal(await syncOpenAtLogin(fine, true, { platform: 'win32' }), true);
  assert.deepEqual(fine.calls, []);
  const missing = fakeApp(true, false, { openAtLogin: false, executableWillLaunchAtLogin: false });
  assert.equal(await syncOpenAtLogin(missing, true, { platform: 'win32' }), true);
  assert.deepEqual(missing.calls, [{ openAtLogin: true, args: [HIDDEN_ARG] }]);
});

test('Linux: an entry removed in Startup Applications is not put back; one still there is refreshed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pulse-autostart-'));
  const env = { XDG_CONFIG_HOME: dir, APPIMAGE: '/new/Flobi Pulse.AppImage' };
  assert.equal(await syncOpenAtLogin(fakeApp(true), true, { platform: 'linux', env }), false);
  await assert.rejects(fs.stat(autostartFile(env)));
  await fs.mkdir(path.dirname(autostartFile(env)), { recursive: true });
  await fs.writeFile(autostartFile(env), autostartEntry('/old/Flobi Pulse.AppImage'));
  assert.equal(await syncOpenAtLogin(fakeApp(true), true, { platform: 'linux', env }), true);
  assert.match(await fs.readFile(autostartFile(env), 'utf8'), /Exec="\/new\/Flobi Pulse\.AppImage"/);
  await fs.rm(dir, { recursive: true, force: true });
});

test('run from source, the setting is only read back', async () => {
  const app = fakeApp(false, false, { openAtLogin: false });
  assert.equal(await syncOpenAtLogin(app, true, { platform: 'win32' }), true);
  assert.deepEqual(app.calls, []);
});

test('macOS: switched off in Login Items stays off', async () => {
  const app = fakeApp(true, false, { openAtLogin: false, status: 'requires-approval' });
  assert.equal(await syncOpenAtLogin(app, true, { platform: 'darwin' }), false);
  assert.deepEqual(app.calls, []);
});

test('Linux: an entry the desktop switched off in place stays off', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pulse-autostart-'));
  const env = { XDG_CONFIG_HOME: dir, APPIMAGE: '/a/Flobi Pulse.AppImage' };
  await fs.mkdir(path.dirname(autostartFile(env)), { recursive: true });
  for (const off of ['Hidden=true', 'X-GNOME-Autostart-enabled=false']) {
    const text = autostartEntry('/a/Flobi Pulse.AppImage').replace('X-GNOME-Autostart-enabled=true', off);
    await fs.writeFile(autostartFile(env), text);
    assert.equal(await syncOpenAtLogin(fakeApp(true), true, { platform: 'linux', env }), false);
    assert.equal(await fs.readFile(autostartFile(env), 'utf8'), text);
  }
  await fs.rm(dir, { recursive: true, force: true });
});
