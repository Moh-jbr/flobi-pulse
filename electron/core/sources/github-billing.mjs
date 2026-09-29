// GitHub costs for the Costs page (read-only, free): the billing usage summary of the
// organization (or personal account) set in Settings → Costs, per month (Actions,
// Packages, Copilot, Git LFS…, after the free allowances), and the organization's plan
// (how many seats, priced with the seat price set in Settings, since the plan's price
// isn't in the API). Uses the GitHub token from Settings → Integrations. For billing it
// also needs Administration: Read-only (organization permissions), or Plan: Read-only
// for a personal account, and GitHub only shows billing to owners and billing managers.
import { request as send, redact, errorMessage } from '../net/http.mjs';

const API = 'https://api.github.com';
/** Until this day of the month, last month's usage is read again (it's still being finalized). */
const LATE_UNTIL_DAY = 10;

const PRODUCTS = { actions: 'Actions', packages: 'Packages', copilot: 'Copilot', codespaces: 'Codespaces', git_lfs: 'Git LFS', gitlfs: 'Git LFS', lfs: 'Git LFS', shared_storage: 'Shared storage', advanced_security: 'Advanced Security', ghas: 'Advanced Security', models: 'GitHub Models', spark: 'Spark' };

/** "git_lfs" → "Git LFS", "actions" → "Actions". */
export function productName(p) {
  const key = String(p || '').trim().toLowerCase();
  if (!key) return 'Other';
  return PRODUCTS[key] || key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** A month's usageItems → { USD: { lines: { product: net } } }. Net = after discounts (included minutes etc.). */
export function summarizeUsage(items) {
  const lines = {};
  for (const it of Array.isArray(items) ? items : []) {
    const name = productName(it?.product);
    const net = it?.netAmount != null ? num(it.netAmount) : num(it?.grossAmount) - num(it?.discountAmount);
    lines[name] = (lines[name] || 0) + net;
  }
  return { USD: { lines } };
}

export class GitHubBillingReader {
  /** @param {{ token: string, owner: string, kind?: 'org'|'user', request?: Function }} o `request` is only replaced by tests. */
  constructor({ token, owner, kind = 'org', request = send }) {
    this.token = String(token || '').trim();
    this.owner = String(owner || '').trim();
    this.kind = kind === 'user' ? 'user' : 'org';
    this.send = request;
    this.cache = new Map(); // url → { etag, data }: unchanged answers are free of the rate limit
  }

  get key() {
    return `github:${this.kind}:${this.owner.toLowerCase()}`;
  }

  async _get(path) {
    const url = `${API}${path}`;
    const hit = this.cache.get(url);
    let res;
    try {
      res = await this.send({ url, headers: { authorization: `Bearer ${this.token}`, accept: 'application/vnd.github+json', ...(hit?.etag ? { 'if-none-match': hit.etag } : {}) }, timeoutMs: 20_000 });
    } catch (e) {
      if (e && typeof e.message === 'string') e.message = redact(e.message, this.token);
      throw e;
    }
    if (res.status === 304 && hit) return hit.data;
    const text = res.body.toString('utf8');
    if (res.status >= 300) throw Object.assign(new Error(this.explain(res.status, text, res.headers)), { status: res.status, code: res.status === 403 ? 'forbidden' : res.status === 404 ? 'not-found' : 'error' });
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw Object.assign(new Error('GitHub sent an answer that isn’t JSON. Try again later.'), { status: res.status, code: 'error' });
    }
    if (res.headers?.etag) this.cache.set(url, { etag: res.headers.etag, data });
    return data;
  }

  explain(status, text, headers) {
    const who = this.kind === 'org' ? `the ${this.owner} organization` : `${this.owner}’s account`;
    if (status === 401) return 'GitHub rejected the token (expired or revoked). Create a new one in Settings → Integrations → GitHub.';
    if (status === 403 && headers?.['x-ratelimit-remaining'] === '0') return 'GitHub’s hourly limit for this token is used up; it resets within the hour.';
    if (status === 403 || status === 404) {
      return this.kind === 'org'
        ? `The GitHub token can’t read the billing of ${who}. Give it Administration: Read-only (organization permissions); only owners and billing managers can see billing.`
        : `The GitHub token can’t read the billing of ${who}. It needs Plan: Read-only (account permissions), and its resource owner must be ${this.owner}.`;
    }
    return redact(errorMessage(status, text), this.token);
  }

  summaryPath(month) {
    const [y, m] = month.split('-').map(Number);
    const who = this.kind === 'org' ? `/organizations/${this.owner}` : `/users/${this.owner}`;
    return `${who}/settings/billing/usage/summary?year=${y}&month=${m}`;
  }

  /**
   * @param {{ months: string[], now?: number, previous?: object, stopped?: () => boolean }} o
   * Usage per month (this month always, last month until the 10th, older months once) and the seats.
   */
  async read({ months, now = Date.now(), previous = null, stopped = () => false }) {
    const keep = new Set(months);
    const out = { status: 'ok', message: null, owner: this.owner, kind: this.kind, months: {}, read: {}, seats: null, seatsNote: null };
    for (const [m, v] of Object.entries(previous?.months || {})) if (keep.has(m)) out.months[m] = v;
    for (const [m, t] of Object.entries(previous?.read || {})) if (keep.has(m)) out.read[m] = t;
    const current = months.at(-1);
    const last = months.at(-2);
    const late = new Date(now).getUTCDate() <= LATE_UNTIL_DAY;
    for (const m of [...months].reverse()) {
      if (stopped()) break;
      if (!(m === current || (m === last && late) || !out.read[m])) continue;
      try {
        const res = await this._get(this.summaryPath(m));
        out.months[m] = summarizeUsage(res?.usageItems);
        out.read[m] = now;
      } catch (e) {
        // This month failing is the answer; an older month failing (beyond the 24 months GitHub
        // keeps, say) just leaves that month empty.
        if (m === current) throw e;
        break;
      }
    }
    if (this.kind === 'org') {
      try {
        const org = await this._get(`/orgs/${this.owner}`);
        const p = org?.plan;
        if (p && (p.seats != null || p.filled_seats != null)) out.seats = { plan: p.name || null, seats: Number(p.seats) || 0, filled: Number(p.filled_seats) || 0 };
        else out.seatsNote = 'GitHub only shows the plan (seats) to owners of the organization.';
      } catch (e) {
        out.seatsNote = e.message;
      }
    }
    return out;
  }
}
