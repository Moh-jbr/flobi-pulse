// fal costs for the Costs page (read-only, free): what was spent each month, per endpoint (the
// Usage API), and the credit balance (the Billing API). Both need an Admin key (fal → Settings →
// API keys, scope Admin); an ordinary key can't read them. An Admin key can do more, so the
// read-only guard lets it reach these two endpoints and nothing else.
import { request as send, redact, errorMessage } from '../net/http.mjs';

const API = 'https://api.fal.ai/v1';
/** Pages of usage read at most (one or two is usual for six months). */
const MAX_PAGES = 20;

const num = (v) => {
  const n = typeof v === 'string' && v.trim() === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
};
const currencyOf = (c) => (/^[A-Za-z]{3}$/.test(String(c || '')) ? String(c).toUpperCase() : 'USD');

/**
 * Usage buckets (one per month) → { 'YYYY-MM': { USD: { lines: { endpoint: cost } } } } for the
 * months in `keep`. The cost is after discounts (cost_total).
 */
export function usageMonths(series, keep) {
  const out = {};
  for (const b of Array.isArray(series) ? series : []) {
    const m = /^(\d{4}-\d{2})/.exec(String(b?.bucket ?? ''))?.[1];
    if (!m || !keep.has(m)) continue;
    for (const r of Array.isArray(b.results) ? b.results : []) {
      const cost = num(r?.cost_total) ?? num(r?.cost);
      if (cost == null) continue;
      const cur = ((out[m] ||= {})[currencyOf(r.currency)] ||= { lines: {} });
      const name = String(r.endpoint_id || '').trim() || 'Other';
      cur.lines[name] = (cur.lines[name] || 0) + cost;
    }
  }
  return out;
}

export class FalBillingReader {
  /** @param {{ key: string, request?: Function }} o `request` is only replaced by tests. */
  constructor({ key, request = send }) {
    this.apiKey = String(key || '').trim();
    this.send = request;
  }

  /** One fal account per app. */
  get key() {
    return 'fal';
  }

  async _get(path) {
    let res;
    try {
      res = await this.send({ url: `${API}${path}`, headers: { authorization: `Key ${this.apiKey}` }, timeoutMs: 30_000 });
    } catch (e) {
      if (e && typeof e.message === 'string') e.message = redact(e.message, this.apiKey);
      throw e;
    }
    const text = res.body.toString('utf8');
    if (res.status >= 300) throw Object.assign(new Error(this.explain(res.status, text)), { status: res.status, code: res.status === 401 || res.status === 403 ? 'forbidden' : 'error' });
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      throw Object.assign(new Error('fal sent an answer that isn’t JSON. Try again later.'), { status: res.status, code: 'error' });
    }
  }

  explain(status, text) {
    if (status === 401) return 'fal rejected the key (deleted, or not a whole key). Create an Admin key in fal → Settings → API keys and paste it in Settings → Costs.';
    if (status === 403) return 'This fal key can’t read usage: it takes an Admin key (fal → Settings → API keys, scope Admin).';
    if (status === 429) return 'fal is limiting requests right now; the next check tries again.';
    return redact(errorMessage(status, text), this.apiKey);
  }

  /** The monthly usage buckets from `start` (YYYY-MM-DD) to now, every page. */
  async usage(start, stopped) {
    const series = [];
    const seen = new Set();
    let cursor = null;
    for (let page = 0; page < MAX_PAGES && !stopped(); page++) {
      const q = new URLSearchParams({ start, timeframe: 'month', expand: 'time_series' });
      if (cursor) q.set('cursor', cursor);
      const res = await this._get(`/models/usage?${q}`);
      if (Array.isArray(res?.time_series)) series.push(...res.time_series);
      const next = res?.has_more ? res.next_cursor : null;
      if (!next || seen.has(next)) break;
      seen.add(next);
      cursor = next;
    }
    return series;
  }

  /**
   * @param {{ months: string[], now?: number, stopped?: () => boolean }} o
   * Every month shown, read again each time (fal keeps its usage), and the balance.
   * @returns {{ status, message, months, read, balance, balanceNote, account }}
   */
  async read({ months, now = Date.now(), stopped = () => false }) {
    const keep = new Set(months);
    const out = { status: 'ok', message: null, months: {}, read: {}, balance: null, balanceNote: null, account: null };
    let from = months[0];
    let series;
    try {
      series = await this.usage(`${from}-01`, stopped);
    } catch (e) {
      // A start further back than fal keeps may be refused: then this month on its own.
      if (e?.status !== 400 || months.length < 2) throw e;
      from = months.at(-1);
      series = await this.usage(`${from}-01`, stopped);
      out.message = `fal only returned usage for ${from}: older months are left out.`;
    }
    out.months = usageMonths(series, keep);
    for (const m of months) if (m >= from) out.read[m] = now;
    if (stopped()) return out;
    try {
      Object.assign(out, await this.balance());
    } catch (e) {
      out.balanceNote = e.message;
    }
    return out;
  }

  /** Just the credit balance (and the account's name): between the reads, while a low-credits alert is on. */
  async balance() {
    const b = await this._get('/account/billing?expand=credits');
    const amount = num(b?.credits?.current_balance);
    if (amount == null) throw Object.assign(new Error('fal didn’t say what the balance is. Try again later.'), { code: 'error' });
    const out = { balance: { amount, currency: currencyOf(b.credits.currency) }, balanceNote: null };
    if (typeof b?.username === 'string' && b.username.trim()) out.account = b.username.trim().slice(0, 80);
    return out;
  }
}
