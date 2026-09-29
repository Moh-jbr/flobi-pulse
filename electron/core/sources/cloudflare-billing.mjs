// Cloudflare costs for the Costs page (read-only, free): the plans of the account and of
// the zones set in Settings (Subscriptions), and the account's usage-based charges
// (Workers, R2, D1, Images, Stream…) from the Billable Usage API, per month.
// Uses the Cloudflare token from Settings → Integrations; billing needs one more
// permission on it: Account → Billing → Read.
import { json, redact } from '../net/http.mjs';
import { CloudflareClient } from './cloudflare.mjs';

const API = 'https://api.cloudflare.com/client/v4';
/** Until this day of the month, last month's usage is read again (late charges). */
const LATE_UNTIL_DAY = 10;

export const NEEDS_BILLING_READ = 'The Cloudflare token can’t read billing. In Cloudflare: My Profile → API Tokens → edit the token → add Account → Billing → Read.';

// States that are charged. Trial, Cancelled, Failed and Expired aren't.
const CHARGED = new Set(['paid', 'provisioned', 'awaitingpayment']);
const FREQUENCIES = new Set(['weekly', 'monthly', 'quarterly', 'yearly']);
const PLAN_NAMES = { free: 'Free', lite: 'Lite', pro: 'Pro', pro_plus: 'Pro Plus', business: 'Business', enterprise: 'Enterprise' };

const currencyOf = (...xs) => {
  const c = xs.find((x) => /^[A-Za-z]{3}$/.test(x || ''));
  return c ? c.toUpperCase() : 'USD';
};

/** A subscription (account or zone) as the Costs page shows it. */
export function parseSubscription(s, zone = null) {
  const plan = s?.rate_plan || {};
  const state = String(s?.state || '');
  const price = Number(s?.price);
  const z = zone || s?.zone || null;
  return {
    id: String(s?.id || `${z?.id || 'account'}:${plan.id || plan.public_name || 'plan'}`),
    name: plan.public_name || PLAN_NAMES[plan.id] || (plan.id ? String(plan.id) : 'Subscription'),
    planId: plan.id || null,
    zone: z?.name || null,
    zoneId: z?.id || null,
    price: Number.isFinite(price) ? price : null,
    currency: currencyOf(s?.currency, plan.currency),
    frequency: FREQUENCIES.has(s?.frequency) ? s.frequency : null,
    state: state || null,
    charged: !state || CHARGED.has(state.toLowerCase()),
    periodEnd: Date.parse(s?.current_period_end) || null,
  };
}

const utcMonth = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const firstNumber = (...xs) => {
  for (const x of xs) {
    const n = typeof x === 'string' && x.trim() === '' ? NaN : Number(x);
    if (x != null && Number.isFinite(n)) return n;
  }
  return null;
};

/**
 * Billable-usage rows (FOCUS columns) → one month: currency → { lines: { service: cost }, through }.
 * Each row is one product for one charge period (a day for most), counted in the month it starts.
 */
export function usageMonth(rows, month) {
  const out = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    const start = Date.parse(r?.ChargePeriodStart);
    if (!Number.isFinite(start) || utcMonth(start) !== month) continue;
    const cost = firstNumber(r.ContractedCost, r.EffectiveCost, r.BilledCost, r.ListCost);
    if (cost == null) continue;
    const m = (out[currencyOf(r.BillingCurrency)] ||= { lines: {}, through: 0 });
    const name = String(r.ServiceName || r.ServiceFamilyName || 'Usage').trim();
    m.lines[name] = (m.lines[name] || 0) + cost;
    const end = Date.parse(r.ChargePeriodEnd);
    if (Number.isFinite(end) && end > m.through) m.through = end;
  }
  return out;
}

const monthRange = (month, now) => {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}`, today: new Date(now).toISOString().slice(0, 10) };
};

export class CloudflareBillingReader {
  /**
   * @param {{ token: string, accountId?: string, zones?: string[], request?: Function, allowZones?: (ids: string[]) => void }} o
   * allowZones tells the guard which zone IDs the zone names in Settings stand for.
   */
  constructor({ token, accountId, zones = [], request = json, allowZones = () => {} }) {
    this.token = String(token || '').trim();
    this.accountId = /^[a-f0-9]{32}$/.test(accountId || '') ? accountId : null;
    this.zoneNames = zones;
    this.request = request;
    this.allowZones = allowZones;
    this.client = new CloudflareClient({ token: this.token, accountId: this.accountId, zones, request });
  }

  get key() {
    return `cloudflare:${this.accountId || ''}:${[...this.zoneNames].map((z) => z.toLowerCase()).sort().join(',')}`;
  }

  async _get(path) {
    let res;
    try {
      res = await this.request({ url: `${API}${path}`, headers: { authorization: `Bearer ${this.token}` }, timeoutMs: 30_000 });
    } catch (e) {
      if (e && typeof e.message === 'string') e.message = redact(e.message, this.token);
      throw e;
    }
    if (res && res.success === false) {
      const err = res.errors?.[0] || {};
      throw Object.assign(new Error(redact(err.message || 'Cloudflare API error', this.token)), { status: /authentication|unauthorized|permission/i.test(err.message || '') ? 403 : 400, code: err.code });
    }
    return res?.result;
  }

  /**
   * @param {{ months: string[], now?: number, previous?: object, stopped?: () => boolean }} o
   * @returns plans (subscriptions) and usage per month; `previous` gives back the months read before.
   */
  async read({ months, now = Date.now(), previous = null, stopped = () => false }) {
    const notes = [];
    let forbidden = false;
    const subs = new Map();
    const add = (p) => {
      // The account's list can include the zones' plans too: count each once.
      const dupe = [...subs.values()].some((x) => x.id === p.id || (p.zoneId && x.zoneId === p.zoneId && x.planId === p.planId));
      if (!dupe) subs.set(p.id, p);
    };
    const failed = (what, e) => {
      if (e?.status === 403 || e?.status === 401) forbidden = true;
      else notes.push(`${what}: ${e?.message || e}`);
    };

    if (this.accountId) {
      try {
        const list = await this._get(`/accounts/${this.accountId}/subscriptions`);
        for (const s of Array.isArray(list) ? list : []) add(parseSubscription(s));
      } catch (e) {
        failed('Account plans', e);
      }
    }
    let zones = [];
    try {
      zones = await this.client.zones();
    } catch (e) {
      failed('Zones', e);
    }
    this.allowZones(zones.map((z) => z.id));
    for (const z of zones) {
      if (stopped()) break;
      try {
        const s = await this._get(`/zones/${z.id}/subscription`);
        if (s) add(parseSubscription(s, z));
      } catch (e) {
        failed(z.name, e);
      }
    }
    if (forbidden && !subs.size) {
      const e = new Error(NEEDS_BILLING_READ);
      e.code = 'forbidden';
      throw e;
    }
    const usage = await this.readUsage(months, now, previous?.usage, stopped);
    return {
      status: 'ok',
      message: forbidden ? NEEDS_BILLING_READ : notes.length ? notes.slice(0, 3).join(' · ') : null,
      subscriptions: [...subs.values()],
      zones: zones.map((z) => z.name),
      usage,
    };
  }

  /** Usage-based charges per month: this month always, last month until the 10th, older months once. */
  async readUsage(months, now, prev, stopped) {
    if (!this.accountId) return { status: 'off', message: 'Add the Cloudflare account ID in Settings → Integrations to see usage-based charges (Workers, R2…).', months: {}, read: {} };
    const out = { status: 'ok', message: null, months: {}, read: {} };
    const keep = new Set(months);
    for (const [m, v] of Object.entries(prev?.months || {})) if (keep.has(m)) out.months[m] = v;
    for (const [m, t] of Object.entries(prev?.read || {})) if (keep.has(m)) out.read[m] = t;
    const current = months.at(-1);
    const last = months.at(-2);
    const late = new Date(now).getUTCDate() <= LATE_UNTIL_DAY;
    for (const m of [...months].reverse()) {
      if (stopped()) break;
      if (!(m === current || (m === last && late) || !out.read[m])) continue;
      const { from, to, today } = monthRange(m, now);
      let rows;
      try {
        rows = await this._get(`/accounts/${this.accountId}/billable-usage?from=${from}&to=${to}`);
      } catch (e) {
        // A range ending in the future may be refused: then up to today.
        if (m === current && e?.status === 400 && today < to) {
          try {
            rows = await this._get(`/accounts/${this.accountId}/billable-usage?from=${from}&to=${today}`);
          } catch (e2) {
            e = e2;
          }
        }
        if (!rows) {
          if (e?.status === 401 || e?.status === 403) return { ...out, status: 'forbidden', message: NEEDS_BILLING_READ };
          if (e?.status === 404 || e?.status === 400 || e?.status === 405) return { ...out, status: 'unavailable', message: `Cloudflare didn’t return usage-based charges for this account (${e.message}). Its Billable Usage API covers self-serve accounts.` };
          return { ...out, status: 'error', message: e?.message || String(e) };
        }
      }
      out.months[m] = usageMonth(rows, m);
      out.read[m] = now;
    }
    return out;
  }
}
