// Flobi Pulse – Electron main process.
// Owns the window, tray, notifications, sign-in and the data connectors.
// All network access happens here, through the read-only guard.
import { app, BrowserWindow, Menu, Tray, Notification, nativeImage, nativeTheme, ipcMain, shell, dialog, safeStorage, clipboard, powerMonitor, screen, session } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JsonStore, SecureStore, DEFAULT_SETTINGS, effectiveConfig } from './core/stores.mjs';
import { ServiceAccountAuth } from './core/auth/service-account.mjs';
import { Pipeline } from './core/engine/pipeline.mjs';
import { Alarm } from './core/engine/alarm.mjs';
import { LiveConnector } from './core/engine/live.mjs';
import { DemoConnector } from './core/engine/demo.mjs';
import { SentryClient, SENTRY_SAAS_HOSTS, cleanSentryToken, sentryTokenProblem, explainSentryError } from './core/sources/sentry.mjs';
import { parseConnectionName } from './core/sources/cloudsql.mjs';
import { CloudflareClient } from './core/sources/cloudflare.mjs';
import { deniedAttempts, resetGuard } from './core/net/guard.mjs';
import { destroyAgents } from './core/net/http.mjs';
import { Updater } from './updater.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
const DEV_URL = process.env.PULSE_DEV_URL || null;
const START_IN_DEMO = process.argv.includes('--demo');
const MIN = 60_000;

// Translucent window material only on macOS. On Windows, a see-through (Mica)
// window makes every repaint of the live lists expensive, which is what made
// scrolling laggy, so it gets a normal solid window.
const nativeMaterial = isMac;

app.setName('Flobi Pulse');
if (isWin) app.setAppUserModelId('ai.flobi.pulse');
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

/** @type {BrowserWindow|null} */
let win = null;
let tray = null;
let quitting = false;
let settingsStore;
let stateStore;
let secrets;
let team = {};
let auth = null;
let pipeline = null;
let connector = null;
let mode = 'signed-out'; // signed-out | live | demo
let heartbeat = null;
let lastHealth = null;
const follows = new Map();
let followSeq = 0;
let updater = null;

// ── Utilities ────────────────────────────────────────────────────────────────
function send(message) {
  if (win && !win.isDestroyed()) win.webContents.send('pulse:event', message);
}

function windowVisible() {
  return !!(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized());
}

// ── Alert sounds ─────────────────────────────────────────────────────────────
// The window plays them (Web Audio); it keeps running while hidden in the tray.
function canPlaySound() {
  return !!(win && !win.isDestroyed() && !win.webContents.isCrashed());
}

function openCritical(id) {
  const a = pipeline && [...pipeline.alerts.active.values()].find((x) => x.id === id);
  return a && a.severity === 'critical' && !a.acked && !pipeline.alerts.isMuted(a) ? a : null;
}

const alarm = new Alarm({
  play: (kind) => send({ t: 'sound', kind, volume: settingsStore?.get().notifications.volume ?? 0.8 }),
  stillRinging: (id) => !!openCritical(id),
  repeat: () => settingsStore?.get().notifications.alarmRepeat !== false,
  onChange: () => {
    sendAlarm();
    updateTray();
  },
});

function alarmState() {
  const st = alarm.state();
  return { ...st, titles: st.ids.map((id) => openCritical(id)?.title).filter(Boolean) };
}

function sendAlarm() {
  send({ t: 'alarm', alarm: alarmState() });
}

/** Stops the siren and marks the alerts it was ringing for as acknowledged. */
function silenceAlarm() {
  const ids = alarm.silence();
  for (const id of ids) pipeline?.alerts.ack(id);
  send({ t: 'sound-stop' });
  return ids.length;
}

/** "owner/repo" of the app's GitHub releases, from package.json → repository. */
async function releaseRepo() {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(app.getAppPath(), 'package.json'), 'utf8'));
    const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || '';
    return /github(?:\.com[/:]|:)([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?$/.exec(url)?.[1] || null;
  } catch {
    return null;
  }
}

async function loadTeamConfig() {
  const candidates = [path.join(app.getAppPath(), 'config', 'team.config.json'), path.join(__dirname, '..', 'config', 'team.config.json')];
  for (const file of candidates) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {}
  }
  return {};
}

function config() {
  return effectiveConfig(team, settingsStore.get(), { sentryToken: secrets.get('sentryToken'), cloudflareToken: secrets.get('cloudflareToken') });
}

/** The optional second key, for a database in another Google Cloud project. */
function databaseAuth() {
  const text = secrets.get('databaseKey');
  if (!text) return null;
  try {
    return new ServiceAccountAuth(text);
  } catch (e) {
    console.warn('[database key] unreadable:', e.message);
    return null;
  }
}

/** Who the database key is, for the UI (never the key itself). */
function databaseKeyInfo() {
  const id = databaseAuth()?.identity;
  return id ? { email: id.email, projectId: id.projectId } : null;
}

function publicInfo() {
  const c = config();
  return {
    platform: process.platform,
    version: app.getVersion(),
    nativeMaterial,
    mode,
    identity: auth?.identity || (mode === 'demo' ? { kind: 'demo', email: 'demo@flobi.ai', name: 'Demo mode' } : null),
    team: {
      projectId: c.projectId,
      namespace: c.namespace,
      clusterName: c.cluster?.name,
      clusterLocation: c.cluster?.location,
    },
    integrations: {
      sentry: { host: c.sentry.host, org: c.sentry.org || '', hasToken: !!c.sentry.token, tokenFromTeam: !secrets.get('sentryToken') && !!team.sentry?.token },
      cloudflare: { accountId: c.cloudflare.accountId || '', zones: c.cloudflare.zones || [], hasToken: !!c.cloudflare.token, tokenFromTeam: !secrets.get('cloudflareToken') && !!team.cloudflare?.token },
      cloudsql: { instances: settingsStore.get().overrides?.cloudsql?.instances || [], fromTeam: team.cloudsql?.instances || [] },
      databaseKey: databaseKeyInfo(),
    },
    uptime: c.uptime,
    update: updater?.state || null,
    settings: settingsStore.get(),
    secretsEncrypted: secrets.encrypted,
  };
}

// ── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors;
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    width: Math.min(1480, width - 80),
    height: Math.min(940, height - 60),
    // Small enough for a half-screen window or a laptop at 125–150 % scaling.
    minWidth: 900,
    minHeight: 580,
    show: false,
    title: 'Flobi Pulse',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    // Same as --bg-content, so the first paint doesn't flash a different shade.
    backgroundColor: nativeMaterial ? '#00000000' : dark ? '#161618' : '#ffffff',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 22, y: 22 }, vibrancy: 'sidebar', visualEffectState: 'followWindow' } : {}),
    ...(isWin ? { titleBarOverlay: { color: '#00000000', symbolColor: dark ? '#f5f5f7' : '#1d1d1f', height: 52 } } : {}),
    ...(isWin && nativeMaterial ? { backgroundMaterial: 'mica' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      // Alert sounds must play without a click first (also while in the tray).
      autoplayPolicy: 'no-user-gesture-required',
      additionalArguments: [`--pulse-platform=${process.platform}`, `--pulse-material=${nativeMaterial ? 1 : 0}`, `--pulse-version=${app.getVersion()}`],
    },
  });

  win.once('ready-to-show', () => win.show());
  win.on('close', (e) => {
    if (!quitting && settingsStore.get().general.keepRunningInTray && mode !== 'signed-out') {
      e.preventDefault();
      win.hide();
      if (isMac) app.dock?.hide();
    }
  });
  win.on('show', () => {
    if (isMac) app.dock?.show();
    if (pipeline) send({ t: 'state', sections: pipeline.fullState() });
  });

  // No navigation away from the app, no new windows. External links open in the browser.
  win.webContents.on('will-navigate', (e, url) => {
    if (DEV_URL && url.startsWith(DEV_URL)) return;
    e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });

  if (DEV_URL) win.loadURL(DEV_URL);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

nativeTheme.on('updated', () => {
  if (isWin && win && !win.isDestroyed()) {
    try {
      win.setTitleBarOverlay({ color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? '#f5f5f7' : '#1d1d1f', height: 52 });
    } catch {}
  }
  updateTray();
});

// Links the UI may open in the browser: exact hostnames only.
function openExternalSafe(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return;
  const h = u.hostname.toLowerCase();
  const c = config();
  const uptimeHosts = new Set((c.uptime || []).map((t) => {
    try {
      return new URL(t.url).hostname;
    } catch {
      return null;
    }
  }));
  const ok =
    h === 'console.cloud.google.com' ||
    h === 'dash.cloudflare.com' ||
    h === 'sentry.io' ||
    /^[a-z0-9-]+\.sentry\.io$/.test(h) ||
    h === String(c.sentry?.host || '').toLowerCase() ||
    h === 'flobi.ai' ||
    /^[a-z0-9-]+\.flobi\.ai$/.test(h) ||
    h === 'handoff.zip' ||
    (h === 'github.com' && !!updater?.repo && u.pathname.toLowerCase().startsWith(`/${updater.repo.toLowerCase()}/`)) ||
    uptimeHosts.has(h);
  if (ok) shell.openExternal(u.toString());
}

// ── Tray ─────────────────────────────────────────────────────────────────────
function trayImage(state) {
  const name = isMac ? (state === 'ok' || state === 'off' ? `tray-${state}Template.png` : `tray-${state}.png`) : `tray-win-${state}.png`;
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', name));
  if (isMac && (state === 'ok' || state === 'off')) img.setTemplateImage(true);
  return img;
}

function createTray() {
  tray = new Tray(trayImage('off'));
  tray.setToolTip('Flobi Pulse');
  // macOS shows the menu on click by itself; on Windows a click opens the window
  // and a right-click shows the menu.
  if (!isMac) tray.on('click', showWindow);
  updateTray();
}

function updateTray() {
  if (!tray) return;
  const h = pipeline?.health();
  const alerts = pipeline?.alerts.summary();
  const state = !h || mode === 'signed-out' ? 'off' : h.overall === 'outage' ? 'crit' : h.overall === 'degraded' ? 'warn' : h.overall === 'operational' ? 'ok' : 'off';
  tray.setImage(trayImage(state));
  tray.setToolTip(`Flobi Pulse — ${h?.headline || 'Not connected'}`);
  const top = (alerts?.active || []).slice(0, 6);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...(alarm.ringing ? [{ label: 'Silence the alarm', click: silenceAlarm }, { type: 'separator' }] : []),
      { label: h?.headline || (mode === 'signed-out' ? 'Signed out' : 'Connecting…'), enabled: false },
      ...(top.length
        ? [
            { type: 'separator' },
            ...top.map((a) => ({ label: `${a.severity === 'critical' ? '●' : '○'}  ${a.title}`.slice(0, 70), click: () => (showWindow(), send({ t: 'nav', to: a.view || { to: 'alerts' } })) })),
          ]
        : []),
      { type: 'separator' },
      { label: 'Open Flobi Pulse', click: showWindow },
      { label: 'While you were away…', enabled: mode !== 'signed-out', click: () => (showWindow(), send({ t: 'nav', to: { to: 'timeline' } })) },
      { type: 'separator' },
      { label: 'Quit Flobi Pulse', accelerator: isMac ? 'Cmd+Q' : undefined, click: () => ((quitting = true), app.quit()) },
    ]),
  );
}

// ── Notifications ────────────────────────────────────────────────────────────
function notify(alert, meta = {}) {
  const s = settingsStore.get().notifications;
  if (meta.muted || alert.acked) return;
  if (alert.severity === 'critical' && !s.critical) return;
  if (alert.severity === 'warning' && !s.warning) return;
  if (alert.severity === 'info' && !s.info) return;
  // Our own sounds: a chime for warnings, the repeating siren for critical.
  const ownSound = s.sound && canPlaySound();
  if (ownSound) {
    if (alert.severity === 'critical') {
      const ids = alert.summary ? [...(pipeline?.alerts.active.values() || [])].filter((a) => openCritical(a.id)).map((a) => a.id) : [alert.id];
      alarm.ring(ids.length ? ids : [alert.id]);
    } else if (alert.severity === 'warning') alarm.chime();
  }
  if (win && win.isFocused() && windowVisible()) {
    send({ t: 'toast', alert });
    return;
  }
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: alert.title,
    body: alert.detail || '',
    // Silent when the app plays its own sound; the system sound is the fallback.
    silent: ownSound || !s.sound,
    icon: isWin ? path.join(__dirname, 'assets', 'icon.png') : undefined,
    urgency: alert.severity === 'critical' ? 'critical' : 'normal',
  });
  n.on('click', () => {
    if (alert.severity === 'critical') silenceAlarm();
    showWindow();
    send({ t: 'nav', to: alert.view || { to: 'alerts' } });
  });
  n.show();
}

// ── Sessions ─────────────────────────────────────────────────────────────────
function newPipeline(kind) {
  pipeline?.destroy();
  pipeline = new Pipeline({
    namespace: config().namespace,
    mode: kind,
    knownErrors: stateStore.get().knownErrors || {},
    graceMs: kind === 'demo' ? 8_000 : 45_000,
    notify,
    emit: (type, payload) => {
      if (type === 'state') {
        send({ t: 'state', sections: payload });
        if (payload.alerts) alarm.check();
        if (payload.health || payload.alerts) {
          const h = payload.health?.overall;
          if (h !== lastHealth || payload.alerts) {
            lastHealth = h ?? lastHealth;
            updateTray();
          }
        }
      } else if (type === 'stream' && windowVisible()) {
        send({ t: 'stream', ...payload });
      }
    },
  });
  return pipeline;
}

/**
 * What gets saved together with lastSeenAt: known error types, plus each pod's
 * restart count so the next recap can tell exactly what restarted in between.
 */
function awayState() {
  if (!pipeline || mode !== 'live') return {};
  const out = { knownErrors: pipeline.knownErrors() };
  const snap = pipeline.restartSnapshot();
  if (snap) out.restartSnapshot = snap;
  return out;
}

async function stopConnector() {
  alarm.silence();
  send({ t: 'sound-stop' });
  for (const stop of follows.values()) stop();
  follows.clear();
  connector?.stop();
  connector = null;
  clearInterval(heartbeat);
  heartbeat = null;
  // lastSeenAt is only moved forward by the heartbeat, on sleep and on quit, so a
  // restart (e.g. after waking up) still knows where the recap should start.
  if (pipeline && mode === 'live') await stateStore.update({ knownErrors: pipeline.knownErrors() });
  pipeline?.destroy();
  pipeline = null;
  resetGuard();
}

async function startLive({ recapSince } = {}) {
  await stopConnector();
  mode = 'live';
  const p = newPipeline('live');
  const st = stateStore.get();
  connector = new LiveConnector({ config: config(), auth, dbAuth: databaseAuth(), pipeline: p, settings: settingsStore.get(), lastSeenAt: recapSince ?? st.lastSeenAt ?? null, knownErrors: st.knownErrors || {}, restartSnapshot: st.restartSnapshot || null });
  await connector.start();
  let lastBeat = Date.now();
  heartbeat = setInterval(() => {
    const now = Date.now();
    // A late tick means the computer was asleep: leave lastSeenAt where it was so
    // the wake-up recap covers the gap.
    if (now - lastBeat < 3 * MIN) stateStore.update({ lastSeenAt: now, ...awayState() });
    lastBeat = now;
  }, MIN);
  send({ t: 'session', info: publicInfo() });
  send({ t: 'state', sections: p.fullState() });
  updateTray();
}

async function startDemo() {
  await stopConnector();
  mode = 'demo';
  const p = newPipeline('demo');
  connector = new DemoConnector({ pipeline: p, lastSeenAt: null });
  connector.start();
  send({ t: 'session', info: publicInfo() });
  send({ t: 'state', sections: p.fullState() });
  updateTray();
}

async function restoreSession() {
  const saved = secrets.get('session');
  if (!saved) return false;
  try {
    if (saved.kind !== 'service-account') return false;
    auth = new ServiceAccountAuth(saved.key);
    await startLive();
    return true;
  } catch (e) {
    console.warn('[session] restore failed:', e.message);
    auth = null;
    return false;
  }
}

async function signOut() {
  await stopConnector();
  try {
    await auth?.signOut();
  } catch {}
  auth = null;
  mode = 'signed-out';
  // Signing out takes every Google key off this computer, the database's too.
  await secrets.clear(['session', 'databaseKey']);
  send({ t: 'session', info: publicInfo() });
  updateTray();
}

/** Accepts "flobi", "https://flobi.sentry.io" or ".../organizations/flobi/". */
function sentryOrgSlug(org) {
  const o = String(org || '').trim();
  const m = o.match(/organizations\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  return o.replace(/^https?:\/\//, '').replace(/\.(de\.|us\.)?sentry\.io.*$/i, '').replace(/\/.*$/, '');
}

function validSentryHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^https:\/\//, '').replace(/\/+$/, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h)) throw new Error('Enter a valid Sentry host name, like sentry.io or sentry.yourcompany.com.');
  return h;
}

// ── Commands from the UI ─────────────────────────────────────────────────────
const commands = {
  'app:hello': async () => {
    const info = publicInfo();
    if (pipeline) setTimeout(() => send({ t: 'state', sections: pipeline.fullState() }), 0);
    return info;
  },

  'auth:serviceAccount': async ({ text } = {}) => {
    let keyText = text;
    if (!keyText) {
      const res = await dialog.showOpenDialog(win, { title: 'Choose the service-account key', properties: ['openFile'], filters: [{ name: 'Service-account key', extensions: ['json'] }] });
      if (res.canceled || !res.filePaths[0]) return { canceled: true };
      keyText = await fs.readFile(res.filePaths[0], 'utf8');
    }
    const candidate = new ServiceAccountAuth(keyText);
    await candidate.getToken('read'); // proves the key works before we keep it
    auth = candidate;
    await secrets.set('session', { kind: 'service-account', key: keyText });
    await startLive();
    return publicInfo();
  },

  'auth:signOut': async () => {
    await signOut();
    return publicInfo();
  },

  'demo:start': async () => {
    await startDemo();
    return publicInfo();
  },

  'demo:stop': async () => {
    await stopConnector();
    mode = 'signed-out';
    if (await restoreSession()) return publicInfo();
    send({ t: 'session', info: publicInfo() });
    updateTray();
    return publicInfo();
  },

  'settings:set': async ({ patch }) => {
    const before = settingsStore.get();
    // Only UI preferences can be changed here. Connections (Sentry, Cloudflare,
    // uptime URLs) have their own validated commands; project/cluster come from the build.
    const clean = {};
    const pick = (group, rules) => {
      if (!patch?.[group] || typeof patch[group] !== 'object') return;
      for (const [k, test] of Object.entries(rules)) if (k in patch[group] && test(patch[group][k])) (clean[group] ||= {})[k] = patch[group][k];
    };
    const bool = (v) => typeof v === 'boolean';
    pick('appearance', { theme: (v) => ['system', 'light', 'dark'].includes(v), glass: (v) => typeof v === 'number' && v >= 0 && v <= 1, density: (v) => ['regular', 'compact'].includes(v) });
    pick('notifications', { critical: bool, warning: bool, info: bool, sound: bool, alarmRepeat: bool, volume: (v) => typeof v === 'number' && v >= 0 && v <= 1 });
    pick('general', { keepRunningInTray: bool, openAtLogin: bool, liveIncludesInfoLogs: bool });
    patch = clean;
    await settingsStore.update(patch);
    const s = settingsStore.get();
    nativeTheme.themeSource = s.appearance.theme;
    if (!!before.general.openAtLogin !== !!s.general.openAtLogin) app.setLoginItemSettings({ openAtLogin: !!s.general.openAtLogin });
    const needsRestart = patch.general && 'liveIncludesInfoLogs' in patch.general;
    if (needsRestart && mode === 'live') await startLive();
    return publicInfo();
  },

  'integrations:set': async ({ sentry, cloudflare }) => {
    const overrides = { ...settingsStore.get().overrides };
    if (sentry) {
      const host = validSentryHost(sentry.host || 'sentry.io');
      if (sentry.org) sentry.org = sentryOrgSlug(sentry.org);
      if (sentry.org && !/^[A-Za-z0-9_-]+$/.test(sentry.org)) throw new Error('The organization slug can only contain letters, numbers, - and _.');
      const oldHost = String(config().sentry.host || 'sentry.io').toLowerCase();
      const hostChanged = host !== oldHost;
      const bothSaas = SENTRY_SAAS_HOSTS.includes(host) && SENTRY_SAAS_HOSTS.includes(oldHost);
      if ('token' in sentry) await secrets.set('sentryToken', cleanSentryToken(sentry.token) || null);
      else if (hostChanged && !bothSaas) await secrets.set('sentryToken', null); // never send the saved token to another company's server
      overrides.sentry = { host, org: sentry.org || '' };
    }
    if (cloudflare) {
      if (cloudflare.accountId && !/^[a-f0-9]{32}$/.test(cloudflare.accountId)) throw new Error('The Cloudflare account ID is 32 characters (0-9, a-f).');
      if ('token' in cloudflare) await secrets.set('cloudflareToken', cloudflare.token || null);
      overrides.cloudflare = { accountId: cloudflare.accountId || '', zones: (cloudflare.zones || []).filter((z) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(z)) };
    }
    await settingsStore.update({ overrides });
    if (mode === 'live') await startLive();
    return publicInfo();
  },

  // The Cloud SQL instance(s) to watch when the database is in another project.
  'cloudsql:set': async ({ instances }) => {
    const list = [...new Set((Array.isArray(instances) ? instances : []).map((x) => parseConnectionName(x)?.id).filter(Boolean))].slice(0, 5);
    if ((instances || []).some((x) => String(x).trim() && !parseConnectionName(x))) throw new Error('A connection name looks like project:region:instance, e.g. flobi-db:europe-west1:flobi-pg.');
    await settingsStore.update({ overrides: { cloudsql: { instances: list } } });
    if (connector && mode === 'live') {
      connector.config.cloudsql = config().cloudsql;
      connector._opsAt = 0;
      await connector.pollCloudSql();
    }
    return publicInfo();
  },

  // A second service-account key for a database that lives in another Google Cloud
  // project. It's used only for Cloud SQL status and Postgres logs outside our project.
  'database:setKey': async ({ text } = {}) => {
    let keyText = text;
    if (!keyText) {
      const res = await dialog.showOpenDialog(win, { title: "Choose the database project's service-account key", properties: ['openFile'], filters: [{ name: 'Service-account key', extensions: ['json'] }] });
      if (res.canceled || !res.filePaths[0]) return { canceled: true };
      keyText = await fs.readFile(res.filePaths[0], 'utf8');
    }
    const candidate = new ServiceAccountAuth(keyText);
    if (auth && candidate.identity.email === auth.identity.email) throw new Error("That's the key you signed in with. Pick the key made for the database's project.");
    await candidate.getToken('platform'); // proves the key works before we keep it
    await secrets.set('databaseKey', keyText);
    if (mode === 'live') await startLive();
    return publicInfo();
  },

  'database:removeKey': async () => {
    await secrets.set('databaseKey', null);
    if (mode === 'live') await startLive();
    return publicInfo();
  },

  'integrations:test': async ({ kind, config: cfg }) => {
    const c = config();
    if (kind === 'sentry') {
      const host = validSentryHost(cfg.host || c.sentry.host);
      const savedHost = String(c.sentry.host || 'sentry.io').toLowerCase();
      const canReuse = host === savedHost || (SENTRY_SAAS_HOSTS.includes(host) && SENTRY_SAAS_HOSTS.includes(savedHost));
      const token = cleanSentryToken(cfg.token || (canReuse ? c.sentry.token : ''));
      const orgSlug = sentryOrgSlug(cfg.org || c.sentry.org);
      if (!token) throw new Error('Enter the API token for this Sentry host.');
      if (!orgSlug) throw new Error('Enter the organization slug (from https://<slug>.sentry.io).');
      const problem = sentryTokenProblem(token);
      if (problem) throw new Error(problem);
      // On sentry.io, also try the other data regions: a token only works in its own.
      const hosts = SENTRY_SAAS_HOSTS.includes(host) ? [host, ...SENTRY_SAAS_HOSTS.filter((h) => h !== host)] : [host];
      let first = null;
      for (const h of hosts) {
        try {
          const client = new SentryClient({ host: h, org: orgSlug, token });
          const org = await client.verify();
          const projects = await client.projects();
          const moved = h !== host ? ` · found it on ${h}, so the region was switched` : '';
          return { ok: true, host: h, message: `Connected to ${org.name || org.slug} · ${projects.length} project${projects.length === 1 ? '' : 's'}${moved}` };
        } catch (e) {
          first ||= e;
          if (e.status !== 401 && e.status !== 404) break;
        }
      }
      throw new Error(explainSentryError(first, orgSlug));
    }
    if (kind === 'cloudflare') {
      const client = new CloudflareClient({ token: cfg.token || c.cloudflare.token, accountId: cfg.accountId || c.cloudflare.accountId, zones: cfg.zones || c.cloudflare.zones });
      await client.verify();
      const zones = await client.zones();
      return { ok: true, message: zones.length ? `Token works · zones: ${zones.map((z) => z.name).join(', ')}` : 'Token works, but it cannot see any of the listed zones' };
    }
    throw new Error('Unknown integration');
  },

  'uptime:set': async ({ targets }) => {
    const clean = (targets || [])
      .filter((t) => /^https:\/\//.test(t.url))
      .map((t, i) => ({ id: t.id || `u${i}-${t.url}`, name: String(t.name || new URL(t.url).host).slice(0, 60), url: t.url, group: t.group === 'frontend' ? 'frontend' : 'backend' }));
    await settingsStore.update({ overrides: { ...settingsStore.get().overrides, uptime: clean } });
    if (mode === 'live') await startLive();
    return publicInfo();
  },

  'logs:follow': async ({ pod, container, service }) => {
    if (!connector) throw new Error('Not connected');
    const id = `f${++followSeq}`;
    const stop = connector.followLogs(
      { pod, container, service },
      (lines) => send({ t: 'follow', id, lines }),
      (status, message) => send({ t: 'follow', id, status, message: message || null }),
    );
    follows.set(id, stop);
    return { id };
  },
  'logs:unfollow': async ({ id }) => {
    follows.get(id)?.();
    follows.delete(id);
    return true;
  },
  'logs:previous': async (args) => connector?.previousLogs(args) ?? [],
  'logs:query': async (args) => connector?.queryLogs(args) ?? [],
  'recap:get': async ({ since, until }) => connector?.recap({ since, until: until || Date.now() }),
  'usage:get': async (args) => connector?.usage(args),
  'alerts:ack': async ({ id }) => {
    pipeline?.alerts.ack(id);
    alarm.check();
    return true;
  },
  'alerts:mute': async ({ service, minutes }) => {
    pipeline?.alerts.mute(service, minutes);
    alarm.check();
    return true;
  },
  'alarm:state': async () => alarmState(),
  'alarm:silence': async () => silenceAlarm(),
  'live:retry': async () => {
    connector?.retryLive();
    return true;
  },
  'open:external': async ({ url }) => {
    openExternalSafe(url);
    return true;
  },
  'clipboard:write': async ({ text }) => {
    clipboard.writeText(String(text ?? ''));
    return true;
  },
  // The app's own right-click menu: edit commands on the focused text field.
  'edit:do': async ({ action }) => {
    if (!['cut', 'copy', 'paste', 'selectAll'].includes(action) || !win || win.isDestroyed()) return false;
    win.webContents[action]();
    return true;
  },
  'notify:test': async () => {
    const s = settingsStore.get().notifications;
    const ownSound = s.sound && canPlaySound();
    if (ownSound) send({ t: 'sound', kind: 'warning', volume: s.volume ?? 0.8 });
    const n = new Notification({ title: 'Flobi Pulse notifications work', body: "You'll get alerts like this one when something breaks.", silent: ownSound || !s.sound });
    n.show();
    return true;
  },
  'guard:denied': async () => deniedAttempts(),

  // App updates (see updater.mjs). Installing runs in the background; the UI
  // follows along through 'update' events.
  'update:check': async () => updater?.check({ manual: true }) ?? null,
  'update:install': async () => {
    updater?.install();
    return updater?.state ?? null;
  },
};

ipcMain.handle('pulse:invoke', async (event, { cmd, args }) => {
  const from = event.senderFrame?.url || '';
  if (!from || !(from.startsWith('file://') || (DEV_URL && from.startsWith(DEV_URL)))) throw new Error('Untrusted sender');
  const fn = commands[cmd];
  if (!fn) throw new Error(`Unknown command ${cmd}`);
  try {
    return await fn(args || {});
  } catch (e) {
    // Only the message crosses the bridge (never stack traces or tokens).
    throw new Error(String(e?.message || e).slice(0, 600));
  }
});

// ── App menu (macOS) ─────────────────────────────────────────────────────────
function buildMenu() {
  if (!isMac) {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Flobi Pulse',
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { label: 'Settings…', accelerator: 'Cmd+,', click: () => (showWindow(), send({ t: 'nav', to: { to: 'settings' } })) },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { label: 'Quit Flobi Pulse', accelerator: 'Cmd+Q', click: () => ((quitting = true), app.quit()) },
        ],
      },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          ...(DEV_URL ? [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }] : []),
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      { role: 'windowMenu' },
    ]),
  );
}

// ── Lifecycle ────────────────────────────────────────────────────────────────
app.on('second-instance', () => showWindow());

app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  settingsStore = new JsonStore(path.join(userData, 'settings.json'), DEFAULT_SETTINGS);
  stateStore = new JsonStore(path.join(userData, 'state.json'), { lastSeenAt: null, knownErrors: {} });
  secrets = new SecureStore({ dir: userData, safeStorage });
  await Promise.all([settingsStore.load(), stateStore.load(), secrets.load()]);
  team = await loadTeamConfig();
  nativeTheme.themeSource = settingsStore.get().appearance.theme;

  // The UI needs no browser permissions (camera, mic, notifications-from-page…).
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (ev) => ev.preventDefault());
  });

  buildMenu();
  createWindow();
  createTray();

  updater = new Updater({ repo: await releaseRepo(), onChange: (update) => send({ t: 'update', update }), quit: () => ((quitting = true), app.quit()) });
  updater.start();

  if (START_IN_DEMO) await startDemo();
  else await restoreSession();

  powerMonitor.on('resume', async () => {
    // Streams may have died while the laptop slept; reconnect and recap the gap.
    if (mode === 'live') await startLive({ recapSince: stateStore.get().lastSeenAt });
  });
  powerMonitor.on('suspend', () => {
    if (mode === 'live') stateStore.update({ lastSeenAt: Date.now(), ...awayState() });
  });
});

app.on('activate', () => showWindow());

app.on('before-quit', () => {
  quitting = true;
});

app.on('will-quit', async (e) => {
  if (mode === 'live' && pipeline) {
    e.preventDefault();
    const away = awayState();
    await stopConnector();
    await stateStore.update({ lastSeenAt: Date.now(), ...away });
    mode = 'signed-out';
    destroyAgents();
    app.exit(0);
  }
});

app.on('window-all-closed', () => {
  if (mode === 'signed-out' || !settingsStore.get().general.keepRunningInTray) {
    quitting = true;
    app.quit();
  }
});
