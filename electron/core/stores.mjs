// Local persistence: settings (plain JSON), app state (plain JSON) and secrets
// (encrypted with the OS keychain through Electron's safeStorage).
import fs from 'node:fs/promises';
import path from 'node:path';

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, data, mode) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2), mode ? { mode } : undefined);
  await fs.rename(tmp, file);
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
};

export class JsonStore {
  constructor(file, defaults = {}) {
    this.file = file;
    this.defaults = defaults;
    this.data = structuredClone(defaults);
    this._writing = Promise.resolve();
  }
  async load() {
    this.data = deepMerge(structuredClone(this.defaults), await readJson(this.file, {}));
    return this.data;
  }
  get() {
    return this.data;
  }
  async update(patch) {
    this.data = deepMerge(this.data, patch);
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
 * Secrets: service-account key, Sentry/Cloudflare tokens.
 * Encrypted with the OS keychain (Keychain on macOS, DPAPI on Windows).
 */
export class SecureStore {
  constructor({ dir, safeStorage }) {
    this.file = path.join(dir, 'secrets.bin');
    this.safe = safeStorage;
    this.data = {};
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
    await writeJsonAtomic(this.file, payload, 0o600);
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
    // Cloud SQL instances to watch, as "project:region:instance" (only needed when
    // the database is in another project and no pod names it in its settings).
    cloudsql: { instances: [...new Set([...(t.cloudsql?.instances || []), ...(o.cloudsql?.instances || [])])] },
  };
}
