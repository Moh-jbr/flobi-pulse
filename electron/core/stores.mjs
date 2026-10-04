// Local persistence: settings (plain JSON), app state (plain JSON) and secrets
// (encrypted with the OS keychain through Electron's safeStorage).
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_COSTS } from './engine/costs.mjs';

async function readJson(file, fallback) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return fallback; // not saved yet
  }
  try {
    const data = JSON.parse(text);
    // Anything but a JSON object (a file cut short, edited by hand) counts as missing.
    if (isPlainObject(data)) return data;
  } catch {}
  console.warn(`[store] ${path.basename(file)} is unreadable, using the defaults`);
  return fallback;
}

let tmpSeq = 0;

/** Writes to a temp file next to `file`, then renames it over `file`, so a crash mid-write never leaves half a file. */
export async function writeJsonAtomic(file, data, mode) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  // One temp file per write: two writes in flight never share (or clean up) the same one.
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
  try {
    await fs.writeFile(tmp, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2), mode ? { mode } : undefined);
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

/** Top-level keys of `patch` replace those of `base`; a key set to undefined is removed. */
export function shallowMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}

export const DEFAULT_SETTINGS = {
  appearance: {
    theme: 'system', // system | light | dark
    glass: 0.5, // 0 = clear, 1 = tinted (OS 27 transparency control)
    density: 'regular', // regular | compact
  },
  notifications: {
    critical: true,
    warning: true,
    info: false,
    releases: true, // a new version of one of the team's repos (the Versions page)
    sound: true, // chime for warnings, siren for critical alerts
    volume: 0.8, // 0–1
    alarmRepeat: true, // critical siren repeats until acknowledged
  },
  general: {
    keepRunningInTray: true,
    openAtLogin: false,
    liveIncludesInfoLogs: true,
  },
  // Per-machine overrides of config/team.config.json (null = use team value)
  overrides: {
    sentry: null,
    cloudflare: null,
    uptime: null,
    cloudsql: null,
  },
  // Settings → Costs: the billing-export table, GitHub billing account, items, rates.
  costs: structuredClone(DEFAULT_COSTS),
};

export class JsonStore {
  /**
   * @param {string} file
   * @param {object} [defaults]
   * @param {{shallow?: boolean}} [o] `shallow`: update() replaces whole top-level keys
   *   (undefined removes one) instead of deep-merging into them. For state that is
   *   always saved whole (known errors, restart counts): merged, it could only grow.
   */
  constructor(file, defaults = {}, { shallow = false } = {}) {
    this.file = file;
    this.defaults = defaults;
    this.shallow = shallow;
    this.data = structuredClone(defaults);
    this._writing = Promise.resolve();
  }
  async load() {
    const saved = await readJson(this.file, {});
    this.data = this.shallow ? { ...structuredClone(this.defaults), ...saved } : deepMerge(structuredClone(this.defaults), saved);
    return this.data;
  }
  get() {
    return this.data;
  }
  async update(patch) {
    this.data = this.shallow ? shallowMerge(this.data, patch) : deepMerge(this.data, patch);
    await this.flush();
    return this.data;
  }
  async replace(key, value) {
    this.data[key] = value;
    await this.flush();
  }
  flush() {
    const snapshot = JSON.stringify(this.data, null, 2);
    this._writing = this._writing.then(() => writeJsonAtomic(this.file, snapshot)).catch((e) => console.warn('[store] write failed', e.message));
    return this._writing;
  }
}

/**
 * Secrets: service-account keys, Sentry/Cloudflare/GitHub tokens.
 * Encrypted with the OS keychain (Keychain on macOS, DPAPI on Windows).
 */
export class SecureStore {
  constructor({ dir, safeStorage }) {
    this.file = path.join(dir, 'secrets.bin');
    this.safe = safeStorage;
    this.data = {};
    this._writing = Promise.resolve();
  }
  get encrypted() {
    return !!this.safe?.isEncryptionAvailable?.();
  }
  async load() {
    try {
      const buf = await fs.readFile(this.file);
      if (buf.subarray(0, 6).toString() === 'PLAIN:') {
        this.data = JSON.parse(Buffer.from(buf.subarray(6).toString(), 'base64').toString('utf8'));
      } else {
        this.data = JSON.parse(this.safe.decryptString(buf));
      }
    } catch {
      this.data = {};
    }
    return this.data;
  }
  get(key) {
    return this.data[key];
  }
  async set(key, value) {
    if (value === undefined || value === null || value === '') delete this.data[key];
    else this.data[key] = value;
    await this.flush();
  }
  async clear(keys) {
    for (const k of keys) delete this.data[k];
    await this.flush();
  }
  async flush() {
    const text = JSON.stringify(this.data);
    const payload = this.encrypted ? this.safe.encryptString(text) : Buffer.from(`PLAIN:${Buffer.from(text).toString('base64')}`);
    // One write at a time, in order, so an older snapshot never lands last. A failed
    // write still fails for its caller, but doesn't block the next one.
    const write = this._writing.catch(() => {}).then(() => writeJsonAtomic(this.file, payload, 0o600));
    this._writing = write;
    return write;
  }
}

/** Team config merged with this machine's overrides and secrets. */
export function effectiveConfig(team, settings, secrets) {
  const o = settings?.overrides || {};
  const t = team || {};
  // Project and cluster come only from the team config baked into the build, so a
  // setting can never redirect credentials to another server.
  return {
    projectId: t.projectId,
    namespace: t.namespace || 'flobi',
    cluster: { ...(t.cluster || {}) },
    sentry: {
      host: 'sentry.io',
      ...(t.sentry || {}),
      ...(o.sentry || {}),
      token: secrets?.sentryToken || t.sentry?.token || '',
    },
    cloudflare: {
      zones: [],
      ...(t.cloudflare || {}),
      ...(o.cloudflare || {}),
      token: secrets?.cloudflareToken || t.cloudflare?.token || '',
    },
    uptime: (o.uptime || t.uptime || []).map((u, i) => ({ id: u.id || `u${i}-${u.url}`, group: 'backend', ...u })),
    // Pages projects someone chose not to check (pages-uptime.mjs adds one for each the list leaves out).
    uptimeHiddenPages: Array.isArray(o.uptimeHiddenPages) ? o.uptimeHiddenPages.filter((x) => typeof x === 'string') : [],
    // Cloud SQL instances to watch, as "project:region:instance" (only needed when
    // the database is in another project and no pod names it in its settings).
    cloudsql: { instances: [...new Set([...(t.cloudsql?.instances || []), ...(o.cloudsql?.instances || [])])] },
    versions: versionsConfig(t.versions?.manifest, secrets?.githubToken),
  };
}

/** The Versions page: the release manifest ("owner/repo/path.json") plus this person's own GitHub token. */
function versionsConfig(manifest, token) {
  const m = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._/-]+)$/.exec(manifest || '');
  return m ? { owner: m[1], manifestRepo: m[2], manifestPath: m[3], token: token || '' } : null;
}
