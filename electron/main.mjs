// Flobi Pulse – Electron main process.
// Owns the window, tray, notifications, sign-in and the data connectors.
// All network access happens here, through the read-only guard.
import { app, BrowserWindow, Menu, Tray, Notification, nativeImage, nativeTheme, ipcMain, shell, dialog, safeStorage, clipboard, powerMonitor, screen, session, net } from 'electron';
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
import { deniedAttempts, resetGuard, configureGuard } from './core/net/guard.mjs';
import { destroyAgents } from './core/net/http.mjs';
import { Connectivity } from './core/net/connectivity.mjs';
import { Updater } from './updater.mjs';
import { GitHubClient } from './core/sources/github.mjs';
import { VersionsWatcher } from './core/engine/versions.mjs';
import { CostsService } from './core/costs.mjs';
import { cleanCostsSettings, cleanApiKey, lowCredits } from './core/engine/costs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
const DEV_URL = process.env.PULSE_DEV_URL || null;
const START_IN_DEMO = process.argv.includes('--demo');
const MIN = 60_000;
// The old known-error map is still read for this long after the first save of the new one.
const LEGACY_KNOWN_ERRORS_MS = 30 * 24 * 60 * MIN;
// After Silence, nothing new rings for this long (what was silenced stays quiet until it's fixed).
const SILENCE_QUIET_MS = 5 * MIN;

// A stray error in a background task shouldn't bring up Electron's crash dialog
// or stop the monitoring: log it and carry on.
process.on('uncaughtException', (e) => console.error('[main] uncaught exception:', e));
process.on('unhandledRejection', (e) => console.error('[main] unhandled rejection:', e));

// Every platform gets a normal solid window. A see-through one (macOS vibrancy,
// Windows Mica) let the desktop show around and through the sidebar and panels,
// so they no longer matched the content; on Windows it also made scrolling laggy.

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
let versions = null; // VersionsWatcher, when a GitHub token is set
let costs = null; // CostsService: the Costs page (its own 6-hour timer)
// What the past-week load read (core/engine/backfill.mjs), kept across restarts (waking up,
// a settings change) so a restart only reads the gap. Memory only; emptied on sign-out.
let pastWeekCache = {};
// What Silence and Mute set up in demo mode (AlertBook.stateToSave), for the next demo
// session. Memory only: demo mode never saves anything.
let demoAlertState = null;
// The Costs page's billing export vs BigQuery's free storage (engine/costs.mjs), kept for the next pipeline.
let billingStorage = null;
// Prepaid balances (OpenRouter, fal) below the amount set to alert at, kept for the next pipeline.
let billingCredits = [];
// Is this computer online (core/net/connectivity.mjs)? Asked before anything is called down.
let connectivity = null;
/** Something failed at `since`: resolves true when it's because this computer is offline. */
const isOffline = (o) => (connectivity ? connectivity.offline(o) : Promise.resolve(false));

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

/** A critical alert that's still open, unacknowledged and unmuted (it may be recovering). */
function liveCritical(id) {
  const a = pipeline && [...pipeline.alerts.active.values()].find((x) => x.id === id);
  return a && a.severity === 'critical' && !a.acked && !pipeline.alerts.isMuted(a) ? a : null;
}

/** …and its problem is there right now. One whose problem went away stays open a little
 *  longer ("Recovering"): the siren keeps it but stays quiet unless the problem returns.
 *  Offline, nothing can be seen: the siren pauses the same way until the connection is back. */
function openCritical(id) {
  if (mode === 'live' && connectivity?.online === false) return null;
  const a = liveCritical(id);
  return a && !a.clearingSince ? a : null;
}

/**
 * The alerts a critical notification rings for: the startup summary covers every
 * open alert, any other notification its own alert plus the related ones grouped
 * into it. Only those still critical, unacknowledged, unmuted and not recovering.
 */
function sirenIds(alert, meta) {
  const list = alert.summary ? [...(pipeline?.alerts.active.values() || [])] : [alert, ...(Array.isArray(meta.related) ? meta.related : [])];
  return [...new Set(list.map((a) => a?.id))].filter((id) => id && openCritical(id));
}

const alarm = new Alarm({
  play: (kind) => send({ t: 'sound', kind, volume: settingsStore?.get().notifications.volume ?? 0.8 }),
  stillRinging: (id) => !!liveCritical(id),
  sounding: (id) => !!openCritical(id),
  repeat: () => settingsStore?.get().notifications.alarmRepeat !== false,
  onChange: () => {
    sendAlarm();
    updateTray();
  },
});

/** What the red banner shows: nothing while every alert it rings for is recovering. */
function alarmState() {
  const st = alarm.state();
  return { ...st, ringing: st.ringing && st.audible, titles: st.ids.map((id) => openCritical(id)?.title).filter(Boolean) };
}

let lastAlarmSent = '';
function sendAlarm() {
  const a = alarmState();
  // Called on every alerts update too (an alert starting or stopping to recover changes
  // the banner without changing the siren's list), so only send real changes.
  const key = JSON.stringify([a.ringing, a.ids, a.titles]);
  if (key === lastAlarmSent) return;
  lastAlarmSent = key;
  send({ t: 'alarm', alarm: a });
}

/**
 * Silence (the red banner, the tray menu, clicking a critical notification): stops the siren,
 * and what it was ringing for, plus `also` (a clicked notification's own alerts), stays quiet
 * until it's fixed (AlertBook.silence). For 5 minutes nothing new rings either (Alarm.silence).
 */
function silenceAlarm(also = []) {
  const ids = [...new Set([...alarm.state().ids, ...also])];
  const n = pipeline?.alerts.silence(ids) ?? 0;
  alarm.silence({ quietMs: n ? SILENCE_QUIET_MS : 0 });
  send({ t: 'sound-stop' });
  if (n) send({ t: 'silenced', count: n, quietMs: SILENCE_QUIET_MS });
  return n;
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
  return effectiveConfig(team, settingsStore.get(), { sentryToken: secrets.get('sentryToken'), cloudflareToken: secrets.get('cloudflareToken'), githubToken: secrets.get('githubToken') });
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

// ── Versions page: the team's GitHub releases ────────────────────────────────
function versionsState() {
  const v = config().versions;
  const base = versions?.state || (!v ? { status: 'off' } : !v.token ? { status: 'needs-token' } : { status: 'loading' });
  return { ...base, owner: v?.owner || null, viewedAt: stateStore.get().versionsViewedAt || 0 };
}

function startVersions() {
  versions?.stop();
  versions = null;
  const v = config().versions;
  if (v?.token) {
    configureGuard({ github: v });
    versions = new VersionsWatcher({
      client: new GitHubClient({ token: v.token, owner: v.owner }),
      manifestRepo: v.manifestRepo,
      manifestPath: v.manifestPath,
      saved: stateStore.get().versionsSaved || {},
      onSave: (saved) => stateStore.update({ versionsSaved: saved }),
      onChange: () => send({ t: 'versions', versions: versionsState() }),
      onNew: notifyReleases,
      isOffline,
    });
    versions.start();
  }
  send({ t: 'versions', versions: versionsState() });
}

/** "Drive: flobi_drive v2.1.0 is out", as a toast (window in front) or a system notification. */
function notifyReleases(all) {
  // A repo starting to version (its first, baseline release) isn't news.
  const list = all.filter((r) => !r.baseline);
  if (!list.length || settingsStore.get().notifications.releases === false) return;
  const one = list.length === 1 ? list[0] : null;
  const alert = {
    id: `release:${Date.now()}`,
    severity: 'info',
    title: one ? `${one.product}: ${one.repo} ${one.tag} is out` : `${list.length} new versions are out`,
    detail: one ? [one.notes.breaking ? 'Breaking changes' : null, one.notes.first].filter(Boolean).join(' · ') : list.slice(0, 4).map((r) => `${r.repo} ${r.tag}`).join(' · '),
    view: { to: 'versions' },
  };
  if (win && win.isFocused() && windowVisible()) return send({ t: 'toast', alert });
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: alert.title, body: alert.detail, silent: true, icon: isWin ? path.join(__dirname, 'assets', 'icon.png') : undefined });
  n.on('click', () => {
    showWindow();
    send({ t: 'nav', to: alert.view });
  });
  n.show();
}

// ── Costs page: billing from BigQuery's export, Cloudflare, GitHub, OpenRouter, fal and Settings ──
/** Hands the session, keys and Settings → Costs to the Costs page; cheap when nothing changed. */
function syncCosts() {
  costs?.update({ mode, auth, config: config(), settings: settingsStore.get().costs, githubToken: secrets.get('githubToken'), openrouterKey: secrets.get('openrouterKey'), falKey: secrets.get('falKey') });
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
      github: { hasToken: !!secrets.get('githubToken'), owner: c.versions?.owner || null },
      // The Costs page's keys (never the keys themselves).
      openrouter: { hasKey: !!secrets.get('openrouterKey') },
      fal: { hasKey: !!secrets.get('falKey') },
    },
    uptime: c.uptime,
    update: updater?.state || null,
    versions: versionsState(),
    costs: costs?.state() ?? null,
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
    backgroundColor: dark ? '#161618' : '#ffffff',
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    ...(isMac ? { trafficLightPosition: { x: 22, y: 22 } } : {}),
    ...(isWin ? { titleBarOverlay: { color: '#00000000', symbolColor: dark ? '#f5f5f7' : '#1d1d1f', height: 52 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      // Alert sounds must play without a click first (also while in the tray).
      autoplayPolicy: 'no-user-gesture-required',
      additionalArguments: [`--pulse-platform=${process.platform}`, `--pulse-version=${app.getVersion()}`],
    },
  });
  // Run from source (npm run dev), the process is electron.exe, so Windows calls the taskbar
  // button "Electron" with Electron's icon (right-click menu, pinning). The installed app gets
  // its name and icon from its Start menu shortcut; this gives the dev window the same.
  if (isWin && !app.isPackaged) {
    win.setAppDetails({
      appId: 'ai.flobi.pulse',
      appIconPath: path.join(__dirname, 'assets', 'icon.ico'),
      relaunchCommand: `"${process.execPath}" "${app.getAppPath()}"`,
      relaunchDisplayName: 'Flobi Pulse',
    });
  }
  // Like Discord: look for a new version when the window comes back to the front.
  win.on('focus', () => updater?.checkIfStale());

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
    (h === 'github.com' && !!c.versions?.owner && u.pathname.toLowerCase().startsWith(`/${c.versions.owner.toLowerCase()}/`)) ||
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
  const top = (alerts?.active || []).filter((a) => !a.clearingSince).slice(0, 6);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...(alarm.audible ? [{ label: 'Silence the alarm', click: () => silenceAlarm() }, { type: 'separator' }] : []),
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
  // Muted, or part of a problem someone silenced: it shows in the app, that's all.
  if (meta.muted || meta.silenced || alert.acked) return;
  if (alert.severity === 'critical' && !s.critical) return;
  if (alert.severity === 'warning' && !s.warning) return;
  if (alert.severity === 'info' && !s.info) return;
  // Our own sounds: a chime for warnings, the repeating siren for critical.
  const ownSound = s.sound && canPlaySound();
  if (ownSound) {
    if (alert.severity === 'critical') alarm.ring(sirenIds(alert, meta));
    else if (alert.severity === 'warning') alarm.chime();
  }
  if (win && win.isFocused() && windowVisible()) {
    send({ t: 'toast', alert });
    return;
  }
  if (!Notification.isSupported()) return;
  const n = new Notification({
    title: alert.title,
    // The evidence, then what to do about it.
    body: [alert.detail, alert.action].filter(Boolean).join('\n'),
    // Silent when the app plays its own sound; the system sound is the fallback.
    silent: ownSound || !s.sound,
    icon: isWin ? path.join(__dirname, 'assets', 'icon.png') : undefined,
    urgency: alert.severity === 'critical' ? 'critical' : 'normal',
  });
  n.on('click', () => {
    // Clicking a critical notification is Silence, for what it rang for too (also when the siren is off).
    if (alert.severity === 'critical') silenceAlarm([alert, ...(Array.isArray(meta.related) ? meta.related : [])].map((a) => a?.id).filter((id) => id && liveCritical(id)));
    showWindow();
    send({ t: 'nav', to: alert.view || { to: 'alerts' } });
  });
  n.show();
}

// ── Sessions ─────────────────────────────────────────────────────────────────
// Demo mode gets empty known-error maps (its made-up errors must neither mix with
// this machine's real ones nor all look new against them) and never saves anything.
function newPipeline(kind, { knownErrors = {}, legacyKnownErrors } = {}) {
  pipeline?.destroy();
  pipeline = new Pipeline({
    namespace: config().namespace,
    mode: kind,
    knownErrors,
    legacyKnownErrors,
    graceMs: kind === 'demo' ? 8_000 : 45_000,
    notify,
    // A data source just failed: is it this computer that went offline? (Demo data can't fail.)
    onTrouble: () => kind === 'live' && connectivity?.check({ since: Date.now() }).catch(() => {}),
    emit: (type, payload) => {
      if (type === 'state') {
        send({ t: 'state', sections: payload });
        if (payload.alerts) {
          alarm.check();
          sendAlarm(); // an alert that started or stopped recovering shows or hides the banner
          if (kind === 'live') saveAlertHistorySoon();
        }
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
  // The Recent page: alerts from earlier runs (last 7 days). What was silenced or muted carries
  // over, so a reconnect or waking up doesn't ring again for it (demo mode: in memory only).
  if (kind === 'live') {
    pipeline.alerts.loadHistory(stateStore.get().alertHistory || []);
    pipeline.alerts.loadState(stateStore.get().alertSilence);
  } else pipeline.alerts.loadState(demoAlertState);
  pipeline.setBillingStorage(billingStorage);
  pipeline.setBillingCredits(billingCredits);
  if (kind === 'live' && connectivity) pipeline.setConnectivity(connectivity.state);
  return pipeline;
}

let historyTimer = null;
/** Alert history, and what's silenced or muted (`alertSilence`), a moment after the alerts change. */
function saveAlertHistorySoon() {
  clearTimeout(historyTimer);
  historyTimer = setTimeout(() => {
    if (pipeline && mode === 'live') stateStore.update({ alertHistory: pipeline.historyToSave(), alertSilence: pipeline.alerts.stateToSave() });
  }, 5_000);
}

/**
 * Error types this machine has seen are saved as `knownErrorsV2`: their fingerprints
 * changed, so the map saved by older versions (`knownErrors`) is left untouched
 * (a downgraded app still finds it) and only read, for 30 days after the first save
 * of the new map, so errors known before the switch don't all look new. Then it's
 * dropped. The state store replaces whole keys, so the saved map can also shrink.
 */
function knownErrorsToSave(p) {
  const st = stateStore.get();
  const now = Date.now();
  const since = st.knownErrorsV2Since || now;
  const map = p.knownErrors();
  const out = map && typeof map === 'object' ? { knownErrorsV2: { ...map }, knownErrorsV2Since: since } : {};
  if ('knownErrors' in st && now - since > LEGACY_KNOWN_ERRORS_MS) out.knownErrors = undefined; // removes it
  return out;
}

/** The old known-error map while it's still read (see knownErrorsToSave): a copy, so the saved one stays as it is. */
function legacyKnownErrorsInUse() {
  const { knownErrors: old, knownErrorsV2Since: since } = stateStore.get();
  if (!old || typeof old !== 'object' || !Object.keys(old).length) return undefined;
  if (since && Date.now() - since > LEGACY_KNOWN_ERRORS_MS) return undefined;
  return { ...old };
}

/**
 * What gets saved together with lastSeenAt: known error types, each pod's
 * restart count so the next recap can tell exactly what restarted in between,
 * and what's silenced or muted. Live only: nothing from demo mode is saved.
 */
function awayState() {
  if (!pipeline || mode !== 'live') return {};
  const out = knownErrorsToSave(pipeline);
  const snap = pipeline.restartSnapshot();
  if (snap) out.restartSnapshot = snap;
  out.alertSilence = pipeline.alerts.stateToSave();
  return out;
}

/**
 * lastSeenAt: until when the live data was seen, where the next recap starts. Offline nothing is
 * seen, so it stays where it was and the recap after reconnecting (or the next start) covers it.
 */
function seenNow(now = Date.now()) {
  return connectivity?.online === false ? {} : { lastSeenAt: now };
}

async function stopConnectorNow() {
  // The session's siren stops with it; the quiet window after a Silence carries on into the next one.
  alarm.reset();
  send({ t: 'sound-stop' });
  for (const stop of follows.values()) stop();
  follows.clear();
  connector?.stop();
  connector = null;
  clearInterval(heartbeat);
  heartbeat = null;
  // lastSeenAt is only moved forward by the heartbeat, on sleep and on quit, so a
  // restart (e.g. after waking up) still knows where the recap should start.
  if (pipeline && mode === 'live') {
    clearTimeout(historyTimer);
    await stateStore.update({ ...knownErrorsToSave(pipeline), alertHistory: pipeline.historyToSave(), alertSilence: pipeline.alerts.stateToSave() });
  } else if (pipeline && mode === 'demo') demoAlertState = pipeline.alerts.stateToSave();
  pipeline?.destroy();
  pipeline = null;
  resetGuard();
}

async function startLiveNow({ recapSince } = {}) {
  // A restart queued behind a sign-out has nothing to sign in with.
  if (!auth) return;
  await stopConnectorNow();
  mode = 'live';
  const st = stateStore.get();
  const legacy = legacyKnownErrorsInUse();
  // Separate copies: the pipeline adds to its map as errors come in, while the
  // recap compares against what was known before.
  const p = newPipeline('live', { knownErrors: { ...st.knownErrorsV2 }, legacyKnownErrors: legacy });
  connector = new LiveConnector({ config: config(), auth, dbAuth: databaseAuth(), pipeline: p, settings: settingsStore.get(), lastSeenAt: recapSince ?? st.lastSeenAt ?? null, knownErrors: { ...st.knownErrorsV2 }, legacyKnownErrors: legacy, restartSnapshot: st.restartSnapshot || null, pastWeekCache, connectivity });
  await connector.start();
  let lastBeat = Date.now();
  heartbeat = setInterval(() => {
    const now = Date.now();
    // A late tick means the computer was asleep: leave lastSeenAt where it was so
    // the wake-up recap covers the gap. Offline, nothing is seen either (seenNow).
    if (now - lastBeat < 3 * MIN) stateStore.update({ ...seenNow(now), ...awayState() });
    lastBeat = now;
  }, MIN);
  syncCosts();
  send({ t: 'session', info: publicInfo() });
  send({ t: 'state', sections: p.fullState() });
  updateTray();
}

async function startDemoNow() {
  await stopConnectorNow();
  mode = 'demo';
  const p = newPipeline('demo');
  connector = new DemoConnector({ pipeline: p, lastSeenAt: null });
  connector.start();
  syncCosts();
  send({ t: 'session', info: publicInfo() });
  send({ t: 'state', sections: p.fullState() });
  updateTray();
}

async function restoreSessionNow() {
  const saved = secrets.get('session');
  if (!saved) return false;
  try {
    if (saved.kind !== 'service-account') return false;
    auth = new ServiceAccountAuth(saved.key);
    await startLiveNow();
    return true;
  } catch (e) {
    console.warn('[session] restore failed:', e.message);
    auth = null;
    return false;
  }
}

async function signOutNow() {
  await stopConnectorNow();
  try {
    await auth?.signOut();
  } catch {}
  auth = null;
  mode = 'signed-out';
  pastWeekCache = {};
  // Signing out takes every Google key off this computer, the database's too.
  await secrets.clear(['session', 'databaseKey']);
  syncCosts();
  send({ t: 'session', info: publicInfo() });
  updateTray();
}

// Session changes (sign-in, a restart after a settings change or waking up, demo,
// sign-out) run one at a time. Two overlapping restarts used to leave the first new
// connector running unseen: its streams, and one of the project's 10 live-tail slots,
// kept going with nobody listening.
let sessionQueue = Promise.resolve();
function serialized(fn) {
  const run = sessionQueue.then(() => fn(), () => fn());
  sessionQueue = run.catch(() => {});
  return run;
}
const stopConnector = () => serialized(stopConnectorNow);
// "Reconnect if we're live" decides when it runs, not when it's asked for: a demo or a
// sign-out queued in between wins (a wake-up during "Try demo" used to switch back to live).
const restartLive = (o) => serialized(() => (mode === 'live' ? startLiveNow(o) : undefined));
const startDemo = () => serialized(startDemoNow);
const restoreSession = () => serialized(restoreSessionNow);
const signOut = () => serialized(signOutNow);

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
    // One step with the switch itself, so a sign-out still under way can't undo it halfway.
    await serialized(async () => {
      auth = candidate;
      await secrets.set('session', { kind: 'service-account', key: keyText });
      await startLiveNow();
    });
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

  'demo:stop': async () =>
    serialized(async () => {
      await stopConnectorNow();
      mode = 'signed-out';
      if (await restoreSessionNow()) return publicInfo();
      syncCosts();
      send({ t: 'session', info: publicInfo() });
      updateTray();
      return publicInfo();
    }),

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
    pick('notifications', { critical: bool, warning: bool, info: bool, releases: bool, sound: bool, alarmRepeat: bool, volume: (v) => typeof v === 'number' && v >= 0 && v <= 1 });
    pick('general', { keepRunningInTray: bool, openAtLogin: bool, liveIncludesInfoLogs: bool });
    patch = clean;
    await settingsStore.update(patch);
    const s = settingsStore.get();
    nativeTheme.themeSource = s.appearance.theme;
    if (!!before.general.openAtLogin !== !!s.general.openAtLogin) app.setLoginItemSettings({ openAtLogin: !!s.general.openAtLogin });
    const needsRestart = patch.general && 'liveIncludesInfoLogs' in patch.general;
    if (needsRestart) await restartLive();
    return publicInfo();
  },

  'integrations:set': async ({ sentry, cloudflare, github }) => {
    if (github) {
      if ('token' in github) await secrets.set('githubToken', String(github.token || '').trim() || null);
      startVersions();
      syncCosts(); // the Costs page reads GitHub billing with the same token
      if (!sentry && !cloudflare) return publicInfo();
    }
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
    await restartLive();
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
    await serialized(async () => {
      // Signed out meanwhile: that took every Google key off this computer, this one included.
      if (mode === 'signed-out') return;
      await secrets.set('databaseKey', keyText);
      if (mode === 'live') await startLiveNow();
    });
    return publicInfo();
  },

  'database:removeKey': async () => {
    await secrets.set('databaseKey', null);
    await restartLive();
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
    if (kind === 'github') {
      const v = c.versions;
      if (!v) throw new Error('No release manifest is set in the team config (versions.manifest).');
      const token = String(cfg.token || v.token || '').trim();
      if (!token) throw new Error('Paste a GitHub token first.');
      configureGuard({ github: v });
      const manifest = await new GitHubClient({ token, owner: v.owner }).manifest(v.manifestRepo, v.manifestPath);
      const all = Object.values(manifest?.repos || {});
      return { ok: true, message: `Connected · ${all.length} repositories in the release manifest, ${all.filter((r) => !r.skip).length} versioned` };
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
    await restartLive();
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
  // `restarts` + `at` (from the crash inspector) pick one crash; without them, the latest.
  'logs:previous': async ({ pod, container, service, restarts, at }) => connector?.previousLogs({ pod, container, service, restarts, at }) ?? [],
  'logs:query': async (args) => {
    const items = (await connector?.queryLogs(args)) ?? [];
    // withMeta: also say whether Google's search stopped early (a flag on the array doesn't survive IPC).
    return args.withMeta ? { items, truncated: !!items.truncated } : items;
  },
  'request:logs': async (args) => connector?.requestLogs?.(args) ?? { match: 'none', lines: [] },
  'recap:get': async ({ since, until }) => connector?.recap({ since, until: until || Date.now() }),
  'usage:get': async (args) => connector?.usage(args),
  // Acknowledge: this alert is silenced like the Silence button does it (no quiet window).
  'alerts:ack': async ({ id }) => {
    pipeline?.alerts.silence([id]);
    alarm.check();
    return true;
  },
  // `target`: a service name, or "key:<alert key>" for one alert. Older UIs send `service`.
  'alerts:mute': async ({ target, service, minutes }) => {
    const what = target || service;
    if (!what || typeof what !== 'string') throw new Error('Nothing to mute.');
    pipeline?.alerts.mute(what, minutes);
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
  // Table exports (see src/lib/export.js): the user picks where the file goes.
  'export:save': async ({ name, data }) => {
    const file = path.basename(String(name || 'export.xlsx'));
    const ext = path.extname(file).toLowerCase();
    if (!['.xlsx', '.csv', '.md'].includes(ext)) throw new Error('Only .xlsx, .csv and .md files can be exported.');
    if (!(data instanceof Uint8Array) || data.length > 256 * 1024 * 1024) throw new Error('The export is empty or too large.');
    const label = { '.xlsx': 'Excel workbook', '.csv': 'CSV', '.md': 'Markdown' }[ext];
    const res = await dialog.showSaveDialog(win, { title: 'Export', defaultPath: path.join(app.getPath('downloads'), file), filters: [{ name: label, extensions: [ext.slice(1)] }] });
    if (res.canceled || !res.filePath) return { canceled: true };
    await fs.writeFile(res.filePath, data);
    return { saved: res.filePath };
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
  // Versions page (see core/engine/versions.mjs).
  'versions:refresh': async () => {
    await versions?.poll();
    return versionsState();
  },
  'versions:seen': async () => {
    await stateStore.update({ versionsViewedAt: Date.now() });
    send({ t: 'versions', versions: versionsState() });
    return versionsState();
  },
  // Costs page (see core/costs.mjs). Refresh runs at most once a minute.
  'costs:refresh': async () => costs?.refresh() ?? null,
  // Settings → Costs: the billing table, GitHub billing account, items typed in, rates, and the
  // OpenRouter and fal keys (those go to the encrypted secrets, never to settings.json; '' removes one).
  'costs:set': async (patch = {}) => {
    const { openrouterKey, falKey, ...rest } = patch || {};
    const keys = {};
    if (openrouterKey !== undefined) keys.openrouterKey = cleanApiKey(openrouterKey, 'OpenRouter');
    if (falKey !== undefined) keys.falKey = cleanApiKey(falKey, 'fal');
    const next = cleanCostsSettings(rest, settingsStore.get().costs);
    for (const [k, v] of Object.entries(keys)) await secrets.set(k, v);
    await settingsStore.replace('costs', next);
    syncCosts();
    return publicInfo();
  },
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
  // Every state update replaces whole keys (see JsonStore), so saved maps can shrink.
  stateStore = new JsonStore(path.join(userData, 'state.json'), { lastSeenAt: null }, { shallow: true });
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

  // Offline, nothing is called down and no alert opens: the page says it's offline and shows what
  // it last saw. Back after more than half a minute (or before the cluster was ever reached, say
  // the app started before the Wi-Fi), everything reconnects at once instead of waiting out each
  // stream's retry, and the recap covers the gap (lastSeenAt stays put while offline).
  let offlineSince = null;
  connectivity = new Connectivity({
    onChange: (state) => {
      if (mode === 'live') {
        pipeline?.setConnectivity(state);
        if (!state.online) send({ t: 'sound-stop' }); // a siren already sounding stops too
        sendAlarm();
      }
      updateTray();
      const was = offlineSince;
      offlineSince = state.online ? null : state.since;
      const neverConnected = mode === 'live' && pipeline && !pipeline.synced.has('pods');
      if (state.online && was && (Date.now() - was > 30_000 || neverConnected)) restartLive().catch((e) => console.error('[online] reconnecting failed:', e));
    },
  });
  // The operating system says when the network comes or goes (Wi-Fi off, cable out): check then.
  let osOnline = net.isOnline();
  setInterval(() => {
    const now = net.isOnline();
    if (now !== osOnline) {
      osOnline = now;
      connectivity.check({ force: true }).catch(() => {});
    }
  }, 3000);

  updater = new Updater({ repo: await releaseRepo(), onChange: (update) => send({ t: 'update', update }), quit: () => ((quitting = true), app.quit()) });
  updater.start();
  startVersions();
  costs = new CostsService({
    dir: userData,
    stateStore,
    isOffline,
    onChange: (c) => {
      send({ t: 'costs', costs: c });
      // The billing export's share of BigQuery's free storage, for the alert when it gets close;
      // the credits below the amount set to alert at (Settings → Costs), for theirs.
      billingStorage = c?.vendors?.find((v) => v.id === 'gcp')?.storage || null;
      pipeline?.setBillingStorage(billingStorage);
      billingCredits = lowCredits(c);
      pipeline?.setBillingCredits(billingCredits);
    },
  });

  if (START_IN_DEMO) await startDemo();
  else await restoreSession();

  powerMonitor.on('resume', async () => {
    try {
      connectivity.check({ force: true }).catch(() => {});
      updater?.checkIfStale(0);
      // Streams may have died while the laptop slept; reconnect and recap the gap.
      await restartLive({ recapSince: stateStore.get().lastSeenAt });
    } catch (e) {
      console.error('[resume] reconnecting failed:', e);
    }
  });
  powerMonitor.on('suspend', () => {
    if (mode === 'live') stateStore.update({ ...seenNow(), ...awayState() });
  });
});

app.on('activate', () => showWindow());

app.on('before-quit', () => {
  quitting = true;
});

let savingOnQuit = false;
app.on('will-quit', async (e) => {
  updater?.stop();
  versions?.stop();
  costs?.stop();
  // Quit again while the state is being saved (Cmd+Q twice, the updater): the save
  // already under way exits when it's done.
  if (savingOnQuit) return e.preventDefault();
  if (mode !== 'live' || !pipeline) return;
  e.preventDefault();
  savingOnQuit = true;
  // However the save goes (it throws, it hangs), the app still exits.
  setTimeout(() => app.exit(0), 5_000);
  try {
    const away = { ...seenNow(), ...awayState() };
    await stopConnector();
    await stateStore.update(away);
  } catch (err) {
    console.error('[quit] saving the state failed:', err);
  } finally {
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
