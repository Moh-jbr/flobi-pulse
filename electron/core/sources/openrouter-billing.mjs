// OpenRouter costs for the Costs page (read-only, free): what was spent each day, per model
// (the Activity API, which covers the last 30 completed UTC days), and the credits left (bought
// minus used, the Credits API). Both need a management key (OpenRouter → Settings → Management
// keys): an ordinary API key can't read them. A management key can also create and delete keys,
// so the read-only guard lets it reach these two endpoints and nothing else.
//
// OpenRouter keeps only those 30 days, so the days read are kept with the Costs page's other
// results, and each read replaces the days it covers. Months before the first read stay unknown.
import { request as send, redact, errorMessage } from '../net/http.mjs';

const API = 'https://openrouter.ai/api/v1';
const DAY = 86_400_000;
/** The Activity API covers the last 30 completed UTC days. */
export const ACTIVITY_DAYS = 30;

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round6 = (n) => Math.round(n * 1e6) / 1e6;

/**
 * Activity rows → { days: { 'YYYY-MM-DD': { model: USD } }, byok: { day: USD } }. Every day of
 * the window is there, an empty one as {}: a day that's there is a day that's known.
 * `usage` is what OpenRouter charged in credits; byok_usage_inference is what the providers
 * billed on the team's own keys (BYOK), which OpenRouter doesn't charge, so it's kept apart.
 */
export function activityDays(rows, now) {
  const today = isoDay(now);
  const midnight = Date.parse(`${today}T00:00:00Z`);
  const days = {};
  const byok = {};
  for (let i = ACTIVITY_DAYS; i >= 1; i--) days[isoDay(midnight - i * DAY)] = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    const day = /^\d{4}-\d{2}-\d{2}/.exec(String(r?.date ?? ''))?.[0];
    // Today isn't over yet: it's counted once it is.
    if (!day || day >= today || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) continue;
    const d = (days[day] ||= {});
    const model = String(r.model || r.model_permaslug || '').trim() || 'Other';
    const usage = num(r.usage);
    if (usage) d[model] = round6((d[model] || 0) + usage);
    const b = num(r.byok_usage_inference);
    if (b) byok[day] = round6((byok[day] || 0) + b);
  }
  return { days, byok };
}

/**
 * The days kept after a read: the new read's days replace the old ones, except that a finished
 * day that had usage never turns empty (in case a read covers a day less than expected); days
 * before `firstMonth` are dropped.
 */
export function mergeDays(previous = {}, fresh = {}, firstMonth = '') {
  const out = {};
  for (const [day, v] of Object.entries(previous || {})) if (day.slice(0, 7) >= firstMonth) out[day] = v;
  for (const [day, v] of Object.entries(fresh || {})) {
    if (day.slice(0, 7) < firstMonth) continue;
    const before = out[day];
    out[day] = Object.keys(v).length || !before || !Object.keys(before).length ? v : before;
  }
  return out;
}

export class OpenRouterBillingReader {
  /** @param {{ key: string, request?: Function }} o `request` is only replaced by tests. */
  constructor({ key, request = send }) {
    this.apiKey = String(key || '').trim();
    this.send = request;
  }

  /** One OpenRouter account per app: the days read stay when the key is replaced. */
  get key() {
    return 'openrouter';
  }

  async _get(path) {
    let res;
    try {
      res = await this.send({ url: `${API}${path}`, headers: { authorization: `Bearer ${this.apiKey}` }, timeoutMs: 30_000 });
    } catch (e) {
      if (e && typeof e.message === 'string') e.message = redact(e.message, this.apiKey);
      throw e;
    }
    const text = res.body.toString('utf8');
    if (res.status >= 300) throw Object.assign(new Error(this.explain(res.status, text)), { status: res.status, code: res.status === 401 || res.status === 403 ? 'forbidden' : 'error' });
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      throw Object.assign(new Error('OpenRouter sent an answer that isn’t JSON. Try again later.'), { status: res.status, code: 'error' });
    }
  }

  explain(status, text) {
    if (status === 401) return 'OpenRouter rejected the key (deleted or disabled). Create a management key in OpenRouter → Settings → Management keys and paste it in Settings → Costs.';
    if (status === 403) return 'This OpenRouter key can’t read usage: it takes a management key (OpenRouter → Settings → Management keys). An ordinary API key can’t.';
    if (status === 429) return 'OpenRouter is limiting requests right now; the next check tries again.';
    return redact(errorMessage(status, text), this.apiKey);
  }

  /**
   * @param {{ months: string[], now?: number, previous?: object, stopped?: () => boolean }} o
   * @returns {{ status, message, days, byok, lastDay, credits, creditsNote }}
   */
  async read({ months, now = Date.now(), previous = null, stopped = () => false }) {
    const res = await this._get('/activity');
    const fresh = activityDays(res?.data, now);
    const first = months[0] || '';
    const out = {
      status: 'ok',
      message: null,
      days: mergeDays(previous?.days, fresh.days, first),
      byok: {},
      lastDay: isoDay(Date.parse(`${isoDay(now)}T00:00:00Z`) - DAY),
      credits: null,
      creditsNote: null,
    };
    // BYOK the same way: the days read replace what was there, unless the day itself was kept.
    for (const [day, v] of Object.entries(previous?.byok || {})) if (day.slice(0, 7) >= first && (!(day in fresh.days) || out.days[day] === previous.days?.[day])) out.byok[day] = v;
    for (const [day, v] of Object.entries(fresh.byok)) if (day.slice(0, 7) >= first) out.byok[day] = v;
    if (stopped()) return out;
    try {
      Object.assign(out, await this.balance());
    } catch (e) {
      out.creditsNote = e.message;
    }
    return out;
  }

  /** Just the credits (bought, used): between the reads, while a low-credits alert is on. */
  async balance() {
    const c = (await this._get('/credits'))?.data;
    const total = Number(c?.total_credits);
    const used = Number(c?.total_usage);
    if (!Number.isFinite(total) || !Number.isFinite(used)) throw Object.assign(new Error('OpenRouter didn’t say how many credits are left. Try again later.'), { code: 'error' });
    return { credits: { total, used }, creditsNote: null };
  }
}
