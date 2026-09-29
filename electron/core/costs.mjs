// The Costs page, main-process side: builds the readers from Settings → Costs and the keys
// the app already has, runs them (engine/costs.mjs: every 6 hours, Refresh at most once a
// minute), keeps what they found in the state store so the page shows it right away after a
// restart, and keeps BigQuery's per-day sums in a file under userData.
//
// Everything here is a free read through the read-only guard: BigQuery's table preview
// (never a query), Cloudflare's and GitHub's billing endpoints, OpenRouter's usage and credits,
// fal's usage and balance. It runs on its own timer, independent of the live connector's restarts.
import path from 'node:path';
import fs from 'node:fs/promises';
import { writeJsonAtomic } from './stores.mjs';
import { configureGuard } from './net/guard.mjs';
import { CostsWatcher, buildCosts, parseTableRef, DEFAULT_COSTS, CREDIT_VENDORS } from './engine/costs.mjs';
import { demoCosts } from './engine/demo.mjs';
import { BigQueryBillingReader } from './sources/bigquery-billing.mjs';
import { CloudflareBillingReader } from './sources/cloudflare-billing.mjs';
import { GitHubBillingReader } from './sources/github-billing.mjs';
import { OpenRouterBillingReader } from './sources/openrouter-billing.mjs';
import { FalBillingReader } from './sources/fal-billing.mjs';

/** BigQuery's per-day sums, one JSON file under userData (a few hundred KB at most). */
export function fileCache(file) {
  return {
    load: async () => {
      try {
        return JSON.parse(await fs.readFile(file, 'utf8'));
      } catch {
        return null; // not there yet, or unreadable: read the days again
      }
    },
    save: (data) => writeJsonAtomic(file, JSON.stringify(data)),
  };
}

/** The readers for what's set up (only what's set up gets one). */
export function makeReaders({ table, auth, cf, token, owner, kind, cacheFile, openrouterKey, falKey }) {
  const readers = {};
  if (table) readers.gcp = new BigQueryBillingReader({ table: table.id, getToken: () => auth.getToken('billing'), invalidateToken: (t) => auth.invalidate?.(t), cache: fileCache(cacheFile) });
  if (cf.token) readers.cloudflare = new CloudflareBillingReader({ token: cf.token, accountId: cf.accountId, zones: cf.zones || [], allowZones: (ids) => configureGuard({ billing: { cloudflareZones: ids } }) });
  if (token && owner) readers.github = new GitHubBillingReader({ token, owner, kind });
  if (openrouterKey) readers.openrouter = new OpenRouterBillingReader({ key: openrouterKey });
  if (falKey) readers.fal = new FalBillingReader({ key: falKey });
  return readers;
}

export class CostsService {
  /**
   * @param {{ dir: string, stateStore: {get: Function, update: Function}, onChange: (costs: object|null) => void, readers?: Function, isOffline?: Function }} o
   * `stateStore.get().costs` holds what the readers found last; `onChange` gets the page's model.
   * `readers` builds the readers (tests pass fakes). `isOffline` (net/connectivity.mjs): a read
   * that got no answer while this computer is offline isn't shown as a problem (CostsWatcher).
   */
  constructor({ dir, stateStore, onChange, readers = makeReaders, isOffline = null }) {
    this.isOffline = isOffline;
    this.cacheFile = path.join(dir, 'costs-bigquery.json');
    this.stateStore = stateStore;
    this.onChange = onChange;
    this.makeReaders = readers;
    this.watcher = null;
    this.signature = null;
    this.mode = 'signed-out';
    this.settings = DEFAULT_COSTS;
    this.setup = {};
  }

  /**
   * Called whenever the session, a key or Settings → Costs may have changed. The readers only
   * start again when what they read changed; items, rates and currency just rebuild the page.
   * @param {{ mode: string, auth?: object, config?: object, settings?: object, githubToken?: string, openrouterKey?: string, falKey?: string }} o
   */
  update({ mode, auth = null, config = {}, settings, githubToken = '', openrouterKey = '', falKey = '' }) {
    this.mode = mode;
    this.settings = { ...DEFAULT_COSTS, ...(settings || {}) };
    if (mode !== 'live' || !auth) {
      this.stopWatcher();
      configureGuard({ billing: null });
      this.emit();
      return;
    }
    const table = parseTableRef(this.settings.bigQueryTable);
    const cf = config.cloudflare || {};
    const gh = this.settings.github || {};
    const owner = String(gh.owner || config.versions?.owner || '').trim();
    const kind = gh.kind === 'user' ? 'user' : 'org';
    const token = String(githubToken || '').trim();
    const orKey = String(openrouterKey || '').trim();
    const fKey = String(falKey || '').trim();
    this.setup = {
      email: auth.identity?.email || null,
      gcp: { table: table?.id || '' },
      cloudflare: { hasToken: !!cf.token, accountId: cf.accountId || '', zones: cf.zones || [] },
      github: { hasToken: !!token, owner, kind },
      openrouter: { hasKey: !!orKey },
      fal: { hasKey: !!fKey },
    };
    const signature = JSON.stringify([auth.identity?.email, table?.id, cf.token, cf.accountId, cf.zones, token, owner, kind, orKey, fKey]);
    const same = signature === this.signature && this.watcher;
    configureGuard({ billing: { bigQuery: table, cloudflareAccount: cf.accountId || null, github: token && owner ? { kind, owner } : null, openrouter: !!orKey, fal: !!fKey, ...(same ? {} : { cloudflareZones: [] }) } });
    // A low-credits alert on: that balance is checked every 30 minutes between the reads.
    const alertIds = Object.keys(CREDIT_VENDORS).filter((id) => this.settings.creditAlerts?.[id]?.on);
    if (same) {
      this.watcher.setBalanceChecks(alertIds);
      this.emit();
      return;
    }
    const restarted = this.signature !== null;
    this.stopWatcher();
    this.signature = signature;
    const readers = this.makeReaders({ table, auth, cf, token, owner, kind, cacheFile: this.cacheFile, openrouterKey: orKey, falKey: fKey });
    this.watcher = new CostsWatcher({
      readers,
      isOffline: this.isOffline,
      saved: this.stateStore.get().costs || null,
      onChange: () => this.emit(),
      onSave: (saved) => this.stateStore.update({ costs: saved }),
    });
    this.watcher.start();
    // Something the readers depend on changed (a new table, token or organization): read now.
    if (restarted) this.watcher.refresh({ force: true });
    this.watcher.setBalanceChecks(alertIds);
    this.emit();
  }

  stopWatcher() {
    this.watcher?.stop();
    this.watcher = null;
    this.signature = null;
  }

  /** The page's model (null when signed out). */
  state(now = Date.now()) {
    if (this.mode === 'demo') {
      const demo = demoCosts(now);
      return buildCosts(demo.data, demo.settings, { now, setup: demo.setup, mode: 'demo' });
    }
    if (this.mode !== 'live') return null;
    const d = this.watcher?.data || { vendors: {}, history: {} };
    return buildCosts(d, this.settings, { now, setup: this.setup, running: d.running, cooldownUntil: d.cooldownUntil, nextPollAt: d.nextPollAt, mode: 'live' });
  }

  emit() {
    try {
      this.onChange(this.state());
    } catch (e) {
      console.warn('[costs] building the page failed:', e.message);
    }
  }

  /** Refresh now (at most once a minute): { started, reason?, retryInMs?, costs }. */
  refresh() {
    const r = this.mode === 'live' && this.watcher ? this.watcher.refresh() : { started: false, reason: this.mode === 'demo' ? 'demo' : 'off' };
    return { ...r, costs: this.state() };
  }

  stop() {
    this.stopWatcher();
  }
}
