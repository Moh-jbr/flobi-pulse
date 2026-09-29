// Used only when the UI runs in a plain browser (design preview, screenshots).
// Runs the demo engine in the page and mimics the Electron bridge.
import { Pipeline } from '../../electron/core/engine/pipeline.mjs';
import { DemoConnector, demoCosts } from '../../electron/core/engine/demo.mjs';
import { Alarm } from '../../electron/core/engine/alarm.mjs';
import { buildVersions } from '../../electron/core/engine/versions.mjs';
import { buildCosts, cleanCostsSettings, cleanApiKey, lowCredits, DEFAULT_COSTS } from '../../electron/core/engine/costs.mjs';
import { k8sLogLine } from '../../electron/core/engine/normalize.mjs';

/**
 * The Costs page's demo data, or (preview only, ?costs=…) one of its other states:
 * off (nothing set up), errors (missing permissions), loading (the first BigQuery read),
 * storage (the billing export close to BigQuery's free storage), credits (OpenRouter's credits
 * about to run out and some BYOK usage, fal's used up, no Gemini API in the export), first
 * (OpenRouter's first read: only the 30 days it keeps), backfill (the billing export turned on
 * a few hours ago: Google has copied only the first hours of last month so far).
 */
function previewCosts(d, kind, now) {
  const { gcp, cloudflare, github, openrouter, fal } = d.data.vendors;
  if (kind === 'off') return { data: { vendors: {}, history: {} }, setup: { email: d.setup.email, gcp: { table: '' }, cloudflare: { hasToken: false }, github: { hasToken: false }, openrouter: { hasKey: false }, fal: { hasKey: false } } };
  if (kind === 'errors')
    return {
      ...d,
      data: {
        ...d.data,
        vendors: {
          gcp: { ...gcp, status: 'forbidden', message: `The service account can’t read ${gcp.table}. It needs the BigQuery Data Viewer role on the billing_export dataset.`, okAt: now - 20 * 3600_000, checkedAt: now - 60_000 },
          cloudflare: { key: cloudflare.key, status: 'forbidden', message: 'The Cloudflare token can’t read billing. In Cloudflare: My Profile → API Tokens → edit the token → add Account → Billing → Read.', checkedAt: now - 60_000, okAt: null },
          github: { key: github.key, status: 'forbidden', message: 'The GitHub token can’t read the billing of the 4ow4-Developers organization. Give it Administration: Read-only (organization permissions); only owners and billing managers can see billing.', checkedAt: now - 60_000, okAt: null },
          openrouter: { key: openrouter.key, status: 'forbidden', message: 'This OpenRouter key can’t read usage: it takes a management key (OpenRouter → Settings → Management keys). An ordinary API key can’t.', checkedAt: now - 60_000, okAt: null },
          fal: { ...fal, status: 'error', message: 'fal is limiting requests right now; the next check tries again.', okAt: now - 20 * 3600_000, checkedAt: now - 60_000 },
        },
      },
    };
  if (kind === 'loading') return { ...d, data: { ...d.data, vendors: { ...d.data.vendors, gcp: { key: gcp.key, refreshing: true, progress: { done: 34, total: 110 } } } } };
  // The billing export close to BigQuery's free 10 GiB, growing ~30 MB a day.
  if (kind === 'storage') return { ...d, data: { ...d.data, vendors: { ...d.data.vendors, gcp: { ...gcp, storage: { bytes: 8.7 * 1024 ** 3, longTermBytes: 5.1 * 1024 ** 3, bytesPerDay: 30_000_000, expirationDays: null } } } } };
  if (kind === 'backfill') {
    const [before, last] = d.data.vendors.gcp.complete.slice(-3, -1);
    const lastStart = Date.UTC(+last.slice(0, 4), +last.slice(5, 7) - 1, 1);
    const through = lastStart + 10 * 3600_000;
    const months = {
      [before]: { USD: { lines: { 'Compute Engine': [40.12, 0], 'Cloud SQL': [4.6, 0] }, through: lastStart + 7 * 3600_000 } },
      [last]: { USD: { lines: { 'Compute Engine': [23.18, 0], 'Cloud SQL': [2.67, 0], 'Kubernetes Engine': [2.6, 0], Networking: [1.3, 0], 'Gemini API': [0.4, 0] }, through } },
    };
    return { ...d, data: { ...d.data, vendors: { ...d.data.vendors, gcp: { ...gcp, months, through, created: now - 5 * 3600_000, location: 'US', rows: 3312, storage: { bytes: 4.9 * 1024 ** 2, longTermBytes: 0, bytesPerDay: null, expirationDays: null } } } } };
  }
  if (kind === 'first') {
    const days = Object.fromEntries(Object.entries(openrouter.days).slice(-30));
    return { ...d, data: { ...d.data, vendors: { ...d.data.vendors, openrouter: { ...openrouter, days } } } };
  }
  if (kind === 'credits') {
    const byok = Object.fromEntries(Object.keys(openrouter.days).slice(-40).map((day, i) => [day, 0.35 + (i % 5) * 0.1]));
    const months = {};
    for (const [m, byCur] of Object.entries(gcp.months)) months[m] = Object.fromEntries(Object.entries(byCur).map(([cur, x]) => [cur, { ...x, lines: Object.fromEntries(Object.entries(x.lines).filter(([name]) => name !== 'Gemini API')) }]));
    return {
      ...d,
      data: {
        ...d.data,
        vendors: {
          ...d.data.vendors,
          gcp: { ...gcp, months },
          openrouter: { ...openrouter, byok, credits: { total: openrouter.credits.total, used: openrouter.credits.total - 11.4 } },
          fal: { ...fal, balance: { amount: 0, currency: 'USD' } },
        },
      },
    };
  }
  return d;
}

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
    if (window.__pulseLog && ['toast', 'sound', 'alarm', 'sound-stop', 'silenced'].includes(m.t)) window.__pulseLog.push({ t: m.t, at: Date.now(), kind: m.kind, sev: m.alert?.severity, title: m.alert?.title, ringing: m.alarm?.ringing, count: m.count });
    listeners.forEach((l) => l(m));
  };
  let pipeline = null;
  let connector = null;
  // Like main.mjs: what Silence and Mute set up carries over to the next demo session (in memory).
  let alertState = null;
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
  let floodTimer = null;
  let cloudsqlInstances = [];
  let databaseKey = null;
  let versionsViewedAt = Date.now() - 2 * 3600_000; // so the newest demo releases show as "New"
  // Costs page: demo billing; Settings → Costs edits change it; Refresh pretends to read.
  let costsSettings = params.get('costs') === 'off' ? structuredClone(DEFAULT_COSTS) : demoCosts().settings;
  // ?costs=credits: the low-credits alerts on (OpenRouter below $20 goes off; fal is used up).
  if (params.get('costs') === 'credits') costsSettings = { ...costsSettings, creditAlerts: { openrouter: { on: true, below: 20 }, fal: { on: true, below: 25 } } };
  // Settings → Costs keys: only whether one is "saved" (removing one shows its Not set up state).
  const costsKeys = { openrouter: params.get('costs') !== 'off', fal: params.get('costs') !== 'off' };
  const costsRun = { refreshing: false, cooldownUntil: null, checkedAt: null };
  const costsModel = () => {
    if (mode !== 'demo') return null;
    const now = Date.now();
    const d = previewCosts(demoCosts(now), params.get('costs'), now);
    if (costsRun.checkedAt) for (const v of Object.values(d.data.vendors)) if (v.okAt) Object.assign(v, { okAt: costsRun.checkedAt, checkedAt: costsRun.checkedAt });
    const setup = { ...d.setup, openrouter: { hasKey: costsKeys.openrouter }, fal: { hasKey: costsKeys.fal } };
    return buildCosts(d.data, costsSettings, { now, setup, mode: 'demo', running: costsRun.refreshing, cooldownUntil: costsRun.cooldownUntil });
  };
  // ?update=1 previews the "Update available" button with a simulated download.
  let update = params.get('update')
    ? { status: 'available', current: '1.0.0', version: '1.0.1', size: 98_300_000, releasesUrl: 'https://github.com/Moh-jbr/flobi-pulse/releases/latest' }
    : { status: 'unsupported', current: '1.0.0', error: 'Updates only run in the installed app.' };
  const setUpdate = (patch) => send({ t: 'update', update: (update = { ...update, ...patch }) });

  // Like main.mjs: a live critical alert may be recovering (its problem went away); the
  // siren keeps it but only sounds for the ones whose problem is there right now.
  const liveCritical = (id) => {
    const a = pipeline && [...pipeline.alerts.active.values()].find((x) => x.id === id);
    return a && a.severity === 'critical' && !a.acked && !pipeline.alerts.isMuted(a) ? a : null;
  };
  const openCritical = (id) => {
    const a = liveCritical(id);
    return a && !a.clearingSince ? a : null;
  };
  // Like main.mjs sirenIds(): the startup summary rings for every open alert, any other
  // notification for its own alert plus the related ones grouped into it.
  const sirenIds = (alert, meta) => {
    const list = alert.summary ? [...pipeline.alerts.active.values()] : [alert, ...(Array.isArray(meta.related) ? meta.related : [])];
    return [...new Set(list.map((a) => a?.id))].filter((id) => id && openCritical(id));
  };
  const alarmState = () => {
    const st = alarm.state();
    return { ...st, ringing: st.ringing && st.audible, titles: st.ids.map((id) => openCritical(id)?.title).filter(Boolean) };
  };
  let lastAlarmSent = '';
  const sendAlarm = () => {
    const a = alarmState();
    const key = JSON.stringify([a.ringing, a.ids, a.titles]);
    if (key === lastAlarmSent) return;
    lastAlarmSent = key;
    send({ t: 'alarm', alarm: a });
  };
  const alarm = new Alarm({
    play: (kind) => send({ t: 'sound', kind, volume: settings.notifications.volume ?? 0.8 }),
    stillRinging: (id) => !!liveCritical(id),
    sounding: (id) => !!openCritical(id),
    repeat: () => settings.notifications.alarmRepeat !== false,
    onChange: () => sendAlarm(),
  });
  // Like main.mjs silenceAlarm(): what the siren rings for stays quiet until it's fixed, and for 5 minutes nothing new rings.
  const QUIET_MS = 5 * 60_000;
  const silenceAlarm = (also = []) => {
    const ids = [...new Set([...alarm.state().ids, ...also])];
    const n = pipeline?.alerts.silence(ids) ?? 0;
    alarm.silence({ quietMs: n ? QUIET_MS : 0 });
    send({ t: 'sound-stop' });
    if (n) send({ t: 'silenced', count: n, quietMs: QUIET_MS });
    return n;
  };
  const notify = (alert, meta = {}) => {
    const n = settings.notifications;
    if (meta.muted || meta.silenced || alert.acked || n[alert.severity] === false) return;
    if (n.sound) {
      if (alert.severity === 'critical') alarm.ring(sirenIds(alert, meta));
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
    integrations: { sentry: { host: 'sentry.io', org: 'flobi', hasToken: true }, cloudflare: { accountId: '', zones: ['flobi.ai'], hasToken: true }, cloudsql: { instances: cloudsqlInstances, fromTeam: [] }, databaseKey, github: { hasToken: true, owner: '4ow4-Developers' }, openrouter: { hasKey: costsKeys.openrouter }, fal: { hasKey: costsKeys.fal } },
    uptime: [],
    update,
    versions: demoVersions(versionsViewedAt),
    costs: costsModel(),
    settings: { ...settings, costs: costsSettings },
    secretsEncrypted: true,
  });

  const start = () => {
    pipeline = new Pipeline({
      namespace: 'flobi',
      mode: 'demo',
      graceMs: 8000,
      emit: (type, payload) => {
        if (type === 'state') {
          if (payload.alerts) {
            alarm.check();
            sendAlarm();
          }
          send({ t: 'state', sections: payload });
        } else send({ t: 'stream', ...payload });
      },
      notify,
    });
    pipeline.alerts.loadState(alertState);
    pipeline.setBillingStorage(costsModel()?.vendors?.find((v) => v.id === 'gcp')?.storage || null);
    pipeline.setBillingCredits(lowCredits(costsModel()));
    // ?offline=1: this computer offline (the sidebar, toolbar and pages say so; alerts wait).
    if (params.get('offline')) pipeline.setConnectivity({ online: false, since: Date.now() - 4 * 60_000 });
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
      send({ t: 'costs', costs: costsModel() });
      setTimeout(() => send({ t: 'state', sections: pipeline.fullState() }), 0);
      return info();
    },
    'demo:stop': async () => {
      clearInterval(floodTimer);
      alarm.reset();
      send({ t: 'sound-stop' });
      if (pipeline) alertState = pipeline.alerts.stateToSave();
      connector?.stop();
      pipeline?.destroy();
      pipeline = connector = null;
      mode = 'signed-out';
      send({ t: 'session', info: info() });
      send({ t: 'costs', costs: null });
      return info();
    },
    'auth:signOut': async () => commands['demo:stop'](),
    'auth:serviceAccount': async () => {
      throw new Error('Service-account sign-in only works in the desktop app.');
    },
    'settings:set': async ({ patch }) => {
      window.__pulseLog?.push({ t: 'settings', patch, at: Date.now() });
      settings ={ ...settings, ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, { ...(settings[k] || {}), ...v }])) };
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
      window.__pulseLog?.push({ t: 'follow', id, pod: args.pod, at: Date.now() });
      // ?logs=silent|hang|fail previews the bad cases: connected but quiet, never answers, fails.
      const mode = params.get('logs');
      if (mode === 'silent') setTimeout(() => send({ t: 'follow', id, status: 'streaming' }), 300);
      else if (mode === 'hang') setTimeout(() => send({ t: 'follow', id, status: 'opening' }), 300);
      else if (mode === 'fail') setTimeout(() => send({ t: 'follow', id, status: 'unreachable', message: "Kubernetes didn't start sending this pod's logs within 15 s." }), 1000);
      else follows.set(id, connector.followLogs(args, (lines) => send({ t: 'follow', id, lines }), (status, message) => send({ t: 'follow', id, status, message })));
      return { id };
    },
    'logs:unfollow': async ({ id }) => {
      window.__pulseLog?.push({ t: 'unfollow', id, at: Date.now() });
      follows.get(id)?.();
      follows.delete(id);
      return true;
    },
    'logs:previous': async (a) => connector.previousLogs(a),
    'logs:query': async (a) => {
      const items = params.get('logs') === 'silent' ? (await new Promise((r) => setTimeout(r, 400)), []) : await connector.queryLogs(a);
      return a.withMeta ? { items, truncated: params.get('logs') === 'truncated' } : items;
    },
    'request:logs': async (a) => connector.requestLogs(a),
    // ?recap=fail previews a recap that can't be read (the automatic one at start still shows).
    'recap:get': async (a) => {
      window.__pulseLog?.push({ t: 'recap:get', at: Date.now() });
      if (params.get('recap') === 'fail') {
        await new Promise((r) => setTimeout(r, 500));
        throw new Error("Error invoking remote method 'recap:get': Error: Cloud Logging didn't answer within 60 s.");
      }
      return connector.recap({ since: a.since, until: a.until || Date.now() });
    },
    'usage:get': async (a) => connector.usage(a),
    'alerts:ack': async ({ id }) => (pipeline.alerts.silence([id]), alarm.check()),
    // `target` is what an alert says to mute (its service, or `key:<alert key>`); `service` is the older form.
    'alerts:mute': async ({ target, service, minutes }) => (pipeline.alerts.mute(target ?? service, minutes), alarm.check()),
    'alarm:state': async () => alarmState(),
    'alarm:silence': async () => silenceAlarm(),
    // Preview only: put the Database page in a given state.
    'debug:db': async ({ patch }) => pipeline?.setDatabase(patch),
    // Preview only: fire a made-up alert to try the sounds and banners.
    'debug:alert': async ({ severity = 'critical' }) =>
      pipeline?.alerts.happen({ key: `debug:${Date.now()}`, kind: 'crash', service: 'director', severity, title: severity === 'critical' ? 'director is down' : 'director restarted', detail: 'Test alert from the preview', view: { to: 'crashes' } }),
    // Preview only: mark an active alert as recovering (its problem went away; it closes after a hold).
    'debug:clearing': async ({ title = '' }) => {
      const a = pipeline && [...pipeline.alerts.active.values()].find((x) => x.title.includes(title));
      if (!a) return false;
      Object.assign(a, { clearing: true, clearingSince: Date.now() });
      pipeline.alerts.version++;
      return true;
    },
    // Preview only: one request on the live stream, a status 0 unless told otherwise (the client left before the answer).
    'debug:request': async (r) =>
      send({
        t: 'stream',
        traffic: [{ kind: 'request', id: `preview-${Date.now()}`, ts: Date.now(), method: 'GET', host: 'api.flobi.ai', path: '/drive/stream-zip?id=preview', status: 0, latencyMs: 31_200, reqSize: 612, respSize: 0, ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/139.0', ip: '172.70.12.34', referer: 'https://drive.flobi.ai/', protocol: 'HTTP/1.1', source: 'lb', service: 'flobi-downloads', statusDetails: 'client_disconnected_before_any_response', cache: null, trace: null, ...r }],
      }),
    // Preview only: what clicking a notification does (main sends the page or item to open).
    'debug:nav': async ({ to }) => send({ t: 'nav', to }),
    // Preview only: roll out a new version of a service. A Pending pod shows up (not started yet),
    // then after `ms` new pods replace the old ones and the rollout finishes.
    'debug:rollout': async ({ service = 'flobi-notes', ms = 8000 }) => {
      const d = connector?.deployments.find((x) => x.metadata.name === service);
      if (!d) return false;
      const old = connector.pods.filter((x) => x.metadata.labels.app === service);
      d.metadata.generation += 1;
      d._rs = Math.random().toString(36).slice(2, 11);
      const first = connector.makePod(d, Date.now());
      const cs = first.status.containerStatuses[0];
      first.status = { ...first.status, phase: 'Pending', startTime: undefined, conditions: [{ type: 'PodScheduled', status: 'True' }], containerStatuses: [{ ...cs, ready: false, state: { waiting: { reason: 'ContainerCreating' } } }] };
      connector.pods.push(first);
      connector.pushK8s();
      setTimeout(() => {
        if (!connector || connector.stopped) return;
        const now = Date.now();
        first.status = { ...first.status, phase: 'Running', startTime: new Date(now).toISOString(), conditions: [{ type: 'Ready', status: 'True' }, { type: 'PodScheduled', status: 'True' }], containerStatuses: [{ ...cs, ready: true, state: { running: { startedAt: new Date(now).toISOString() } } }] };
        connector.pods = connector.pods.filter((x) => !old.includes(x)).concat(old.slice(1).map(() => connector.makePod(d, now)));
        d.status = { ...d.status, observedGeneration: d.metadata.generation };
        connector.pushK8s();
      }, ms);
      return true;
    },
    // Preview only (performance checks): put `count` log lines on the live stream at once,
    // then keep sending `rate` lines a second until called again with rate 0.
    'debug:logs': async ({ count = 0, rate = 0 }) => {
      clearInterval(floodTimer);
      if (!connector) return false;
      const running = connector.pods;
      const make = (n, spreadMs) => {
        const now = Date.now();
        return Array.from({ length: n }, (_, i) => {
          const pod = running[(Math.random() * running.length) | 0];
          const service = pod.metadata.labels.app;
          const ts = now - Math.round(((n - i) / n) * spreadMs);
          return { ...k8sLogLine({ text: connector.textFor(service, ts), ts, pod: pod.metadata.name, container: service, service }), source: 'cloud' };
        });
      };
      for (let left = count; left > 0; left -= 2000) send({ t: 'stream', logs: make(Math.min(2000, left), 60_000) });
      if (rate > 0) floodTimer = setInterval(() => send({ t: 'stream', logs: make(Math.max(1, Math.round(rate / 4)), 250) }), 250);
      return true;
    },
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
    'costs:refresh': async () => {
      const now = Date.now();
      if (costsRun.refreshing || (costsRun.cooldownUntil && now < costsRun.cooldownUntil)) return { started: false, reason: costsRun.refreshing ? 'running' : 'cooldown', retryInMs: Math.max(0, (costsRun.cooldownUntil || now) - now), costs: costsModel() };
      Object.assign(costsRun, { refreshing: true, cooldownUntil: now + 60_000 });
      setTimeout(() => {
        Object.assign(costsRun, { refreshing: false, checkedAt: Date.now() });
        send({ t: 'costs', costs: costsModel() });
      }, 1200);
      return { started: true, costs: costsModel() };
    },
    'costs:set': async (patch = {}) => {
      const { openrouterKey, falKey, ...rest } = patch;
      const orKey = openrouterKey === undefined ? undefined : cleanApiKey(openrouterKey, 'OpenRouter');
      const fKey = falKey === undefined ? undefined : cleanApiKey(falKey, 'fal');
      costsSettings = cleanCostsSettings(rest, costsSettings);
      if (orKey !== undefined) costsKeys.openrouter = !!orKey;
      if (fKey !== undefined) costsKeys.fal = !!fKey;
      pipeline?.setBillingCredits(lowCredits(costsModel()));
      send({ t: 'costs', costs: costsModel() });
      return info();
    },
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
