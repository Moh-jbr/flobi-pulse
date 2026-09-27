// Used only when the UI runs in a plain browser (design preview, screenshots).
// Runs the demo engine in the page and mimics the Electron bridge.
import { Pipeline } from '../../electron/core/engine/pipeline.mjs';
import { DemoConnector } from '../../electron/core/engine/demo.mjs';
import { Alarm } from '../../electron/core/engine/alarm.mjs';
import { buildVersions } from '../../electron/core/engine/versions.mjs';

// Demo releases for the Versions page, shaped like flobi-release's notes.
function demoVersions(viewedAt) {
  const H = 3600_000;
  const now = Date.now();
  const cmp = (repo, a, b) => `[compare](https://github.com/4ow4-Developers/${repo}/compare/${a}...${b})`;
  const rel = (repo, tag, hoursAgo, body, author = 'github-actions (bot)') => ({ id: `${repo}@${tag}`, tag, name: tag, body, url: `https://github.com/4ow4-Developers/${repo}/releases/tag/${tag}`, prerelease: false, publishedAt: now - hoursAgo * H, author });
  const manifest = {
    owner: '4ow4-Developers',
    repos: {
      flobi_drive: { live: 'production', product: 'Drive', audience: 'user' },
      'flobi-drive-back': { live: 'testing', product: 'Drive', audience: 'user' },
      'flobi-gateway': { live: 'testing', product: 'Gateway', audience: 'internal' },
      'flobi-artwork': { live: 'testing', product: 'Artwork', audience: 'user' },
      'flobi-billing-back': { live: 'testing', product: 'Billing', audience: 'user' },
    },
  };
  const releases = {
    flobi_drive: [
      rel('flobi_drive', 'v2.1.0', 0.3, `3 changes since v2.0.0 · ${cmp('flobi_drive', 'v2.0.0', 'v2.1.0')}

### New

- **upload:** resume large uploads after a dropped connection ([a1b2c3d](https://github.com/4ow4-Developers/flobi_drive/commit/a1b2c3d), dana)
- **share:** copy a folder link with view-only access ([b2c3d4e](https://github.com/4ow4-Developers/flobi_drive/commit/b2c3d4e), sam)

### Fixes

- **preview:** PDFs with rotated pages show the right way up ([c3d4e5f](https://github.com/4ow4-Developers/flobi_drive/commit/c3d4e5f), dana)`),
      rel('flobi_drive', 'v2.0.0', 26, `1 change since v1.1.0 · ${cmp('flobi_drive', 'v1.1.0', 'v2.0.0')}

### Breaking changes

- **api:** folder routes moved from \`/v1/folders\` to \`/v2/folders\` ([855145c](https://github.com/4ow4-Developers/flobi_drive/commit/855145c), dana)`),
      rel('flobi_drive', 'v1.1.0', 30, `1 change since v1.0.2 · ${cmp('flobi_drive', 'v1.0.2', 'v1.1.0')}

### New

- **search:** find files by their contents ([d4e5f6a](https://github.com/4ow4-Developers/flobi_drive/commit/d4e5f6a), dana)`),
      rel('flobi_drive', 'v1.0.0', 31, 'Versioning starts here. Every push to `production` from now on gets its own version and notes, worked out from the commit messages.', 'dana'),
    ],
    'flobi-drive-back': [
      rel('flobi-drive-back', 'v1.0.1', 3, `1 change since v1.0.0 · ${cmp('flobi-drive-back', 'v1.0.0', 'v1.0.1')}

### Fixes

- **storage:** stats no longer count deleted files ([e5f6a7b](https://github.com/4ow4-Developers/flobi-drive-back/commit/e5f6a7b), dana)`),
      rel('flobi-drive-back', 'v1.0.0', 31, 'Versioning starts here. Every push to `testing` from now on gets its own version and notes, worked out from the commit messages.', 'dana'),
    ],
    'flobi-gateway': [rel('flobi-gateway', 'v1.0.0', 5, 'Versioning starts here.', 'dana')],
  };
  return { status: 'ok', ...buildVersions(manifest, releases), checkedAt: now, error: null, owner: '4ow4-Developers', viewedAt };
}

export function createBrowserBridge() {
  const listeners = new Set();
  const send = (m) => {
    if (window.__pulseLog && ['toast', 'sound', 'alarm', 'sound-stop'].includes(m.t)) window.__pulseLog.push({ t: m.t, at: Date.now(), kind: m.kind, sev: m.alert?.severity, title: m.alert?.title, ringing: m.alarm?.ringing });
    listeners.forEach((l) => l(m));
  };
  let pipeline = null;
  let connector = null;
  let settings = {
    appearance: { theme: 'system', glass: 0.5, density: 'regular' },
    notifications: { critical: true, warning: true, info: false, sound: true, volume: 0.8, alarmRepeat: true },
    general: { keepRunningInTray: true, openAtLogin: false, liveIncludesInfoLogs: true },
    overrides: {},
  };
  const params = new URLSearchParams(location.search);
  let mode = params.get('signedout') ? 'signed-out' : 'demo';
  const platform = params.get('platform') || (navigator.userAgent.includes('Windows') ? 'win32' : 'darwin');
  const follows = new Map();
  let seq = 0;
  let cloudsqlInstances = [];
  let databaseKey = null;
  let versionsViewedAt = Date.now() - 2 * 3600_000; // so the newest demo releases show as "New"
  // ?update=1 previews the "Update available" button with a simulated download.
  let update = params.get('update')
    ? { status: 'available', current: '1.0.0', version: '1.0.1', size: 98_300_000, releasesUrl: 'https://github.com/Moh-jbr/flobi-pulse/releases/latest' }
    : { status: 'unsupported', current: '1.0.0', error: 'Updates only run in the installed app.' };
  const setUpdate = (patch) => send({ t: 'update', update: (update = { ...update, ...patch }) });

  const openCritical = (id) => {
    const a = pipeline && [...pipeline.alerts.active.values()].find((x) => x.id === id);
    return a && a.severity === 'critical' && !a.acked && !pipeline.alerts.isMuted(a) ? a : null;
  };
  const alarmState = () => {
    const st = alarm.state();
    return { ...st, titles: st.ids.map((id) => openCritical(id)?.title).filter(Boolean) };
  };
  const alarm = new Alarm({
    play: (kind) => send({ t: 'sound', kind, volume: settings.notifications.volume ?? 0.8 }),
    stillRinging: (id) => !!openCritical(id),
    repeat: () => settings.notifications.alarmRepeat !== false,
    onChange: () => send({ t: 'alarm', alarm: alarmState() }),
  });
  const notify = (alert, meta = {}) => {
    const n = settings.notifications;
    if (meta.muted || alert.acked || n[alert.severity] === false) return;
    if (n.sound) {
      if (alert.severity === 'critical') alarm.ring(alert.summary ? [...pipeline.alerts.active.values()].filter((a) => openCritical(a.id)).map((a) => a.id) : [alert.id]);
      else if (alert.severity === 'warning') alarm.chime();
    }
    send({ t: 'toast', alert });
  };

  const info = () => ({
    platform,
    version: '1.0.0',
    mode,
    identity: mode === 'demo' ? { kind: 'demo', email: 'demo@flobi.ai', name: 'Demo mode' } : null,
    team: { projectId: 'flobi-prod-2026', namespace: 'flobi', clusterName: 'flobi-cluster', clusterLocation: 'europe-west1', clusterEndpointInConfig: false },
    integrations: { sentry: { host: 'sentry.io', org: 'flobi', hasToken: true }, cloudflare: { accountId: '', zones: ['flobi.ai'], hasToken: true }, cloudsql: { instances: cloudsqlInstances, fromTeam: [] }, databaseKey, github: { hasToken: true, owner: '4ow4-Developers' } },
    uptime: [],
    update,
    versions: demoVersions(versionsViewedAt),
    settings,
    secretsEncrypted: true,
  });

  const start = () => {
    pipeline = new Pipeline({
      namespace: 'flobi',
      mode: 'demo',
      graceMs: 8000,
      emit: (type, payload) => {
        if (type === 'state') {
          if (payload.alerts) alarm.check();
          send({ t: 'state', sections: payload });
        } else send({ t: 'stream', ...payload });
      },
      notify,
    });
    connector = new DemoConnector({ pipeline });
    connector.start();
  };
  if (mode === 'demo') start();

  const commands = {
    'app:hello': async () => {
      if (pipeline) setTimeout(() => send({ t: 'state', sections: pipeline.fullState() }), 0);
      return info();
    },
    'demo:start': async () => {
      mode = 'demo';
      start();
      send({ t: 'session', info: info() });
      setTimeout(() => send({ t: 'state', sections: pipeline.fullState() }), 0);
      return info();
    },
    'demo:stop': async () => {
      connector?.stop();
      pipeline?.destroy();
      pipeline = connector = null;
      mode = 'signed-out';
      send({ t: 'session', info: info() });
      return info();
    },
    'auth:signOut': async () => commands['demo:stop'](),
    'auth:serviceAccount': async () => {
      throw new Error('Service-account sign-in only works in the desktop app.');
    },
    'settings:set': async ({ patch }) => {
      settings = { ...settings, ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, { ...(settings[k] || {}), ...v }])) };
      return info();
    },
    'integrations:set': async () => info(),
    'cloudsql:set': async ({ instances }) => {
      cloudsqlInstances = instances || [];
      return info();
    },
    'database:setKey': async () => {
      databaseKey = { email: 'pulse-db-viewer@flobi-db-prod.iam.gserviceaccount.com', projectId: 'flobi-db-prod' };
      return info();
    },
    'database:removeKey': async () => {
      databaseKey = null;
      return info();
    },
    'integrations:test': async ({ kind }) => ({ ok: true, message: kind === 'sentry' ? 'Connected to Flobi · 6 projects' : 'Token works · zones: flobi.ai' }),
    'uptime:set': async () => info(),
    'logs:follow': async (args) => {
      const id = `f${++seq}`;
      // ?logs=silent|hang|fail previews the bad cases: connected but quiet, never answers, fails.
      const mode = params.get('logs');
      if (mode === 'silent') setTimeout(() => send({ t: 'follow', id, status: 'streaming' }), 300);
      else if (mode === 'hang') setTimeout(() => send({ t: 'follow', id, status: 'opening' }), 300);
      else if (mode === 'fail') setTimeout(() => send({ t: 'follow', id, status: 'unreachable', message: "Kubernetes didn't start sending this pod's logs within 15 s." }), 1000);
      else follows.set(id, connector.followLogs(args, (lines) => send({ t: 'follow', id, lines }), (status, message) => send({ t: 'follow', id, status, message })));
      return { id };
    },
    'logs:unfollow': async ({ id }) => {
      follows.get(id)?.();
      follows.delete(id);
      return true;
    },
    'logs:previous': async (a) => connector.previousLogs(a),
    'logs:query': async (a) => (params.get('logs') === 'silent' ? (await new Promise((r) => setTimeout(r, 400)), []) : connector.queryLogs(a)),
    'request:logs': async (a) => connector.requestLogs(a),
    'recap:get': async (a) => connector.recap({ since: a.since, until: a.until || Date.now() }),
    'usage:get': async (a) => connector.usage(a),
    'alerts:ack': async ({ id }) => (pipeline.alerts.ack(id), alarm.check()),
    'alerts:mute': async ({ service, minutes }) => (pipeline.alerts.mute(service, minutes), alarm.check()),
    'alarm:state': async () => alarmState(),
    'alarm:silence': async () => {
      const ids = alarm.silence();
      for (const id of ids) pipeline?.alerts.ack(id);
      send({ t: 'sound-stop' });
      return ids.length;
    },
    // Preview only: put the Database page in a given state.
    'debug:db': async ({ patch }) => pipeline?.setDatabase(patch),
    // Preview only: fire a made-up alert to try the sounds and banners.
    'debug:alert': async ({ severity = 'critical' }) =>
      pipeline?.alerts.happen({ key: `debug:${Date.now()}`, kind: 'crash', service: 'director', severity, title: severity === 'critical' ? 'director is down' : 'director restarted', detail: 'Test alert from the preview', view: { to: 'crashes' } }),
    'live:retry': async () => true,
    'open:external': async ({ url }) => window.open(url, '_blank', 'noopener'),
    'clipboard:write': async ({ text }) => navigator.clipboard?.writeText(text),
    'export:save': async ({ name, data }) => {
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([data])), download: name });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      return { saved: name };
    },
    'edit:do': async ({ action }) => document.execCommand(action),
    'notify:test': async () => {
      if (settings.notifications.sound) send({ t: 'sound', kind: 'warning', volume: settings.notifications.volume ?? 0.8 });
      send({ t: 'toast', alert: { id: 'test', severity: 'info', title: 'Notifications work', detail: 'This is what an alert looks like.' } });
    },
    'guard:denied': async () => [],
    'update:check': async () => update,
    'versions:refresh': async () => demoVersions(versionsViewedAt),
    'versions:seen': async () => {
      versionsViewedAt = Date.now();
      send({ t: 'versions', versions: demoVersions(versionsViewedAt) });
      return demoVersions(versionsViewedAt);
    },
    'update:install': async () => {
      if (update.status !== 'available' && update.status !== 'error') return update;
      setUpdate({ status: 'downloading', progress: 0 });
      const t = setInterval(() => {
        if (update.progress >= 1) return clearInterval(t), setUpdate({ status: 'installing' });
        setUpdate({ progress: Math.min(1, update.progress + 0.07) });
      }, 250);
      return update;
    },
  };

  // Preview only: lets screenshot/test scripts drive the fake backend.
  window.__pulsePreview = { invoke: (cmd, args) => commands[cmd]?.(args || {}) };

  return {
    platform,
    version: '1.0.0',
    preview: true,
    invoke: async (cmd, args) => {
      const fn = commands[cmd];
      if (!fn) throw new Error(`Unknown command ${cmd}`);
      return fn(args || {});
    },
    on: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}
