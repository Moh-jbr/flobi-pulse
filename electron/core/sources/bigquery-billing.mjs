// Google Cloud costs for the Costs page, from the Cloud Billing export in BigQuery.
//
// Google has no API that returns what you spend. The documented way is the billing
// export: Cloud Billing writes every charge into a BigQuery table
// (gcp_billing_export_v1_<billing account>) a few times a day. A query on that table
// would be billed (and the free tier may already be used up), so this reader never
// runs a query or a job. It reads the table the way BigQuery's own "Preview" does:
// tabledata.list, which Google documents as free and outside the quotas, plus
// tables.get (metadata, also free). The read-only guard lets nothing else through.
//
// The table has one partition per day. Each day is read once, added up here
// (invoice month × service, net of credits) and only the sums are cached on disk.
// Later checks only look again at the last 10 days (and at last month's days until
// the 10th, while late charges still land), at days whose row count changed, and at
// nothing at all when the table hasn't changed since the last check.
import { json, redact, errorMessage } from '../net/http.mjs';
import { parseTableRef } from '../engine/costs.mjs';

export { parseTableRef };

const API = 'https://bigquery.googleapis.com/bigquery/v2';
const DAY = 86_400_000;
/** Days re-checked on every read (late charges land in recent days). */
export const RECENT_DAYS = 10;
/** Until this day of the month, last month's days are re-checked too. */
export const LATE_UNTIL_DAY = 10;
/**
 * For this many days after the export made its table, every day is re-checked: Google is still
 * filling it in (it copies the month before, which takes up to five days), and those rows can
 * land in any day.
 */
export const BACKFILL_DAYS = 10;

// What's read of each row. The standard usage cost export has all of them; the detailed
// (resource-level) export too. Only the first three are required.
export const FIELDS = ['service.description', 'cost', 'currency', 'usage_end_time', 'invoice.month', 'cost_type', 'credits.amount'];
const REQUIRED = ['cost', 'currency', 'invoice.month'];

export class BillingReadError extends Error {
  /** @param {'invalid'|'setup'|'forbidden'|'api-off'|'not-found'|'error'} code */
  constructor(code, message) {
    super(message);
    this.name = 'BillingReadError';
    this.code = code;
  }
}

// ── Days and months (UTC, like the table's partitions) ─────────────────────────
const two = (n) => String(n).padStart(2, '0');
/** "20260928" for a time. */
export function dayId(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}`;
}
const dayMs = (id) => Date.UTC(+id.slice(0, 4), +id.slice(4, 6) - 1, +id.slice(6, 8));
/** Every day from `from` to `to` (both "YYYYMMDD", included), oldest first. */
export function dayRange(from, to) {
  const out = [];
  for (let t = dayMs(from); t <= dayMs(to); t += DAY) out.push(dayId(t));
  return out;
}
const monthStart = (key) => Date.UTC(+key.slice(0, 4), +key.slice(5, 7) - 1, 1);

/** "202609" (invoice.month) → "2026-09". */
export function invoiceMonth(v) {
  const m = /^(\d{4})(\d{2})$/.exec(String(v ?? ''));
  return m && +m[2] >= 1 && +m[2] <= 12 ? `${m[1]}-${m[2]}` : null;
}

/** A TIMESTAMP cell as ms: microseconds (useInt64Timestamp) or seconds ("1.7275176E9"). */
export function timestampMs(v) {
  if (v == null || v === '') return null;
  const s = String(v);
  if (/^-?\d{13,}$/.test(s)) return Math.round(Number(s) / 1000);
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 1000) : null;
}

// ── Rows ─────────────────────────────────────────────────────────────────────
const isRecord = (f) => f?.type === 'RECORD' || f?.type === 'STRUCT';

/**
 * The fields of `wanted` the table has: `selected` is sent as selectedFields (in table order,
 * the order the preview returns them in) and `schema` decodes the rows. `top`: whole top-level
 * fields instead of sub-fields (a fallback, should BigQuery refuse a sub-field).
 */
export function selectFields(schemaFields, { wanted = FIELDS, top = false } = {}) {
  const want = wanted.map((w) => w.toLowerCase());
  const leaves = [];
  const walk = (fields, prefix) => {
    const out = [];
    for (const f of fields || []) {
      const p = prefix ? `${prefix}.${f.name}` : f.name;
      const pl = p.toLowerCase();
      if (!isRecord(f) && want.includes(pl)) {
        out.push(f);
        leaves.push(p);
      } else if (isRecord(f) && want.some((w) => w.startsWith(`${pl}.`))) {
        const sub = walk(f.fields, p);
        if (sub.length) out.push({ ...f, fields: sub });
      }
    }
    return out;
  };
  const pruned = walk(schemaFields || [], '');
  const found = new Set(leaves.map((l) => l.toLowerCase()));
  const missing = REQUIRED.filter((r) => !found.has(r));
  if (!top) return { schema: pruned, fields: schemaFields || [], selected: leaves, missing };
  const names = new Set(pruned.map((f) => f.name));
  const whole = (schemaFields || []).filter((f) => names.has(f.name));
  return { schema: whole, fields: schemaFields || [], selected: whole.map((f) => f.name), missing };
}

/**
 * One row of tabledata.list ({ f: [{ v }] }) as an object. The preview returns the selected
 * fields in table order; if it sends a whole record instead, the full schema reads it.
 */
export function decodeRow(row, schema, full) {
  return decodeCells(row?.f, schema, full);
}

function decodeCells(cells, schema, full) {
  const list = Array.isArray(cells) ? cells : [];
  const fields = full && list.length === full.length && list.length !== schema.length ? full : schema;
  const out = {};
  fields.forEach((f, i) => {
    out[f.name.toLowerCase()] = decodeValue(list[i]?.v, f, full?.find((x) => x.name === f.name));
  });
  return out;
}

function decodeValue(v, f, fullF) {
  const one = (x) => (isRecord(f) ? (x && Array.isArray(x.f) ? decodeCells(x.f, f.fields || [], fullF?.fields || f.fields) : null) : x);
  if (f.mode === 'REPEATED') return Array.isArray(v) ? v.map((x) => one(x?.v)) : [];
  return one(v);
}

const COST_TYPES = { tax: 'Tax', adjustment: 'Adjustments', rounding_error: 'Rounding' };

/** What a row is shown as on the Costs page: its service, or Tax / Adjustments / Rounding. */
export function lineName(r) {
  return COST_TYPES[String(r?.cost_type || '').toLowerCase()] || String(r?.service?.description || '').trim() || 'Other';
}

const toNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Adds decoded rows to `agg`: months → currency → { lines: { name: [cost, credits] }, through }.
 * Credits are negative, so what's paid is cost + credits. Months are invoice months, which is
 * how Google's invoice adds up (late usage can be billed in the month after).
 */
export function addRows(agg, rows) {
  for (const r of rows) {
    agg.rows = (agg.rows || 0) + 1;
    const month = invoiceMonth(r.invoice?.month);
    if (!month) continue;
    const cur = /^[A-Za-z]{3}$/.test(r.currency || '') ? r.currency.toUpperCase() : 'USD';
    const m = (((agg.months ||= {})[month] ||= {})[cur] ||= { lines: {}, through: 0 });
    const line = (m.lines[lineName(r)] ||= [0, 0]);
    line[0] += toNumber(r.cost);
    for (const c of r.credits || []) line[1] += toNumber(c?.amount);
    const end = timestampMs(r.usage_end_time);
    if (end && end > m.through) m.through = end;
  }
  return agg;
}

/** Adds one partition's sums into `target` (only the months in `pick`). */
export function mergeMonths(target, months, pick) {
  for (const [month, byCur] of Object.entries(months || {})) {
    if (pick && !pick.has(month)) continue;
    for (const [cur, m] of Object.entries(byCur)) {
      const t = ((target[month] ||= {})[cur] ||= { lines: {}, through: 0 });
      for (const [name, [cost, credits]] of Object.entries(m.lines || {})) {
        const l = (t.lines[name] ||= [0, 0]);
        l[0] += cost;
        l[1] += credits;
      }
      if (m.through > t.through) t.through = m.through;
    }
  }
  return target;
}

/** A cache kept in memory only (tests, or when there's nowhere to save). */
export function memoryCache() {
  let data = null;
  return { load: async () => data && structuredClone(data), save: async (d) => void (data = structuredClone(d)) };
}

export class BigQueryBillingReader {
  /**
   * @param {{ table: string, getToken: () => Promise<string>, invalidateToken?: (t:string)=>void,
   *   request?: Function, cache?: {load: Function, save: Function}, pageRows?: number, pauseMs?: number,
   *   sleep?: (ms:number)=>Promise<void> }} o `request` is only replaced by tests.
   */
  constructor({ table, getToken, invalidateToken, request = json, cache = memoryCache(), pageRows = 10_000, pauseMs = 100, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    this.ref = parseTableRef(table);
    if (!this.ref) throw new BillingReadError('invalid', 'The billing table looks like project.dataset.table, e.g. flobi-billing.billing_export.gcp_billing_export_v1_0123AB_4567CD_89EF01.');
    Object.assign(this, { getToken, invalidateToken, request, cache, pageRows, pauseMs, sleep });
    this.top = false; // select whole top-level fields (if BigQuery ever refuses sub-fields)
  }

  get key() {
    return `bigquery:${this.ref.id}`;
  }

  get path() {
    return `/projects/${this.ref.project}/datasets/${this.ref.dataset}/tables/${this.ref.table}`;
  }

  async _get(path, query) {
    const url = `${API}${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
    for (let attempt = 0; ; attempt++) {
      const token = await this.getToken();
      try {
        return await this.request({ url, headers: { authorization: `Bearer ${token}` }, timeoutMs: 60_000 });
      } catch (e) {
        if (e?.status === 401 && attempt === 0 && this.invalidateToken) {
          this.invalidateToken(token);
          continue;
        }
        throw this.explain(e, token);
      }
    }
  }

  explain(e, token) {
    const { id, dataset } = this.ref;
    const text = redact(`${e?.message || e} ${e?.body || ''}`, token);
    if (e?.status === 403 && /SERVICE_DISABLED|accessNotConfigured|has not been used in project|is disabled/i.test(text)) {
      return new BillingReadError('api-off', 'The BigQuery API is turned off in the service account’s project. Turning it on is free (APIs & Services → BigQuery API → Enable), but it’s a project setting, so it’s your call.');
    }
    if (e?.status === 403) return new BillingReadError('forbidden', `The service account can’t read ${id}. It needs the BigQuery Data Viewer role on the ${dataset} dataset.`);
    if (e?.status === 404) return new BillingReadError('not-found', `Google can’t find ${id}. Check the name: Billing → Billing export shows the project and dataset, and the table appears a few hours after the export is turned on.`);
    if (e?.status === 401) return new BillingReadError('error', 'Google turned the service account away (HTTP 401). Sign in again with the key.');
    if (e?.status) return new BillingReadError('error', redact(e.message || errorMessage(e.status, e.body || ''), token));
    return new BillingReadError('error', redact(e?.message || String(e), token));
  }

  /** The table's metadata (tables.get, free). */
  async meta() {
    const t = await this._get(this.path);
    return {
      rows: Number(t?.numRows) || 0,
      // Logical bytes: what BigQuery's storage pricing (and its free 10 GiB) counts by default.
      bytes: Number(t?.numBytes) || 0,
      longTermBytes: Number(t?.numLongTermBytes) || 0,
      modified: Number(t?.lastModifiedTime) || 0,
      // When the export made the table, and where: a multi-region dataset (US, EU) also gets the
      // month before; a regional one only what comes after (the page says which months are whole).
      created: Number(t?.creationTime) || 0,
      location: typeof t?.location === 'string' ? t.location : null,
      partitioning: t?.timePartitioning?.type || null,
      expirationMs: Number(t?.timePartitioning?.expirationMs) || 0,
      fields: t?.schema?.fields || [],
    };
  }

  /** How many rows one day's partition holds (one row read, to learn totalRows). */
  async partitionRows(day, sel) {
    try {
      const res = await this._get(`${this.path}$${day}/data`, { selectedFields: sel.selected[0], maxResults: '1' });
      return Number(res?.totalRows) || 0;
    } catch (e) {
      if (e.code === 'not-found') return 0; // no such partition: nothing was billed that day
      throw e;
    }
  }

  /** One day's partition, added up. Null when stopped halfway (nothing to keep). */
  async readPartition(day, sel, stopped) {
    const agg = { rows: 0, months: {} };
    let total = 0;
    let pageToken = null;
    for (let page = 0; page < 5000; page++) {
      let res;
      try {
        res = await this._get(`${this.path}$${day}/data`, { selectedFields: sel.selected.join(','), maxResults: String(this.pageRows), 'formatOptions.useInt64Timestamp': 'true', ...(pageToken ? { pageToken } : {}) });
      } catch (e) {
        if (e.code === 'not-found' && page === 0) return { rows: 0, months: {} };
        throw e;
      }
      if (page === 0) total = Number(res?.totalRows) || 0;
      addRows(agg, (res?.rows || []).map((r) => decodeRow(r, sel.schema, sel.fields)));
      pageToken = res?.pageToken || null;
      if (!pageToken) break;
      if (stopped?.()) return null;
      await this.sleep(this.pauseMs);
    }
    return { rows: total || agg.rows, months: agg.months };
  }

  /**
   * Google Cloud costs per invoice month, for `months` ("YYYY-MM", oldest first).
   * onProgress({ done, total }) while days are read; onPartial(result) now and then during a
   * long first read, with the months that are already complete.
   */
  async read({ months, now = Date.now(), stopped = () => false, onProgress, onPartial } = {}) {
    const meta = await this.meta();
    let latest = meta; // the size is re-read after a full check (the export may have grown meanwhile)
    const { id } = this.ref;
    if (meta.partitioning !== 'DAY') throw new BillingReadError('setup', `${id} isn’t split into daily partitions, so reading it would mean downloading all of it every time. Use the standard usage cost export table (gcp_billing_export_v1_…).`);
    let sel = selectFields(meta.fields, { top: this.top });
    if (sel.missing.length) throw new BillingReadError('setup', `${id} doesn’t look like a Cloud Billing export: it has no ${sel.missing.join(', ')}. Use the standard usage cost export table (gcp_billing_export_v1_…).`);

    const fieldsKey = sel.selected.join(',');
    let cache = await this.cache.load().catch(() => null);
    if (!cache || cache.v !== 1 || cache.table !== id || cache.fields !== fieldsKey) cache = { v: 1, table: id, fields: fieldsKey, modified: 0, outside: null, complete: false, syncedDay: null, partitions: {} };

    // From 3 days before the oldest month (a month's first hours in UTC are the month before in
    // Pacific time, the invoice's clock) to today; never before the export could have data
    // (it fills in from the start of the month before it was turned on) or partitions expire.
    const today = dayId(now);
    let floor = dayId(monthStart(months[0]) - 3 * DAY);
    if (meta.created) floor = [floor, dayId(meta.created - 70 * DAY)].sort().at(-1);
    if (meta.expirationMs) floor = [floor, dayId(now - meta.expirationMs)].sort().at(-1);
    const days = floor <= today ? dayRange(floor, today).reverse() : [];
    // Days that left the window count as outside it from now on (for the change check below).
    for (const d of Object.keys(cache.partitions)) {
      if (d >= floor && d <= today) continue;
      if (cache.outside != null) cache.outside += cache.partitions[d].rows;
      delete cache.partitions[d];
    }

    const lastMonthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() - 1, 1);
    const recentFrom = new Date(now).getUTCDate() <= LATE_UNTIL_DAY ? [dayId(lastMonthStart), dayId(now - RECENT_DAYS * DAY)].sort()[0] : dayId(now - RECENT_DAYS * DAY);
    // A young table: every day is counted again (one row each, free), not only the recent ones.
    const young = meta.created > 0 && now - meta.created < BACKFILL_DAYS * DAY;
    const inWindow = () => days.reduce((a, d) => a + (cache.partitions[d]?.rows || 0), 0);
    const save = () => this.cache.save(cache).catch((e) => console.warn('[costs] saving the BigQuery cache failed:', e.message));

    // Nothing changed since the last full read: no day to look at.
    const unchanged = cache.complete && meta.modified && cache.modified === meta.modified && days.every((d) => d > cache.syncedDay || cache.partitions[d]);
    let oldestDone = unchanged ? floor : null;
    if (!unchanged) {
      let done = 0;
      let finished = true;
      const readDay = async (d) => {
        let part;
        try {
          part = await this.readPartition(d, sel, stopped);
        } catch (e) {
          // Asking for sub-fields refused: ask for whole fields from now on.
          if (e.code !== 'error' || !/selected ?fields|field selection|invalid field/i.test(e.message) || this.top) throw e;
          this.top = true;
          sel = selectFields(meta.fields, { top: true });
          cache = { ...cache, fields: sel.selected.join(',') };
          part = await this.readPartition(d, sel, stopped);
        }
        if (part) cache.partitions[d] = part;
        return !!part;
      };
      for (const d of days) {
        if (stopped()) {
          finished = false;
          break;
        }
        const cached = cache.partitions[d];
        if (!cached) {
          if (!(await readDay(d))) {
            finished = false;
            break;
          }
        } else if (d >= recentFrom || young) {
          const rows = await this.partitionRows(d, sel);
          if (rows !== cached.rows && !(await readDay(d))) {
            finished = false;
            break;
          }
        }
        oldestDone = d;
        onProgress?.({ done: ++done, total: days.length });
        if (done % 10 === 0) {
          await save();
          onPartial?.(this.result(cache, months, oldestDone, floor, meta, now));
        }
      }
      if (finished && !stopped()) {
        oldestDone = floor;
        // A day we don't re-check changed (rows added to an old day): the table's row count
        // says so. Then each old day is counted again, and the ones that changed are re-read.
        const after = await this.meta();
        if (after.modified === meta.modified) {
          if (cache.outside != null && after.rows - inWindow() !== cache.outside) {
            for (const d of days) {
              if (d >= recentFrom || !cache.partitions[d] || stopped()) continue;
              if ((await this.partitionRows(d, sel)) !== cache.partitions[d].rows) await readDay(d);
            }
          }
          if (!stopped()) cache.outside = after.rows - inWindow();
        }
        cache.modified = meta.modified;
        cache.complete = !stopped();
        cache.syncedDay = today;
        latest = after;
      }
      await save();
    }
    return this.result(cache, months, oldestDone, floor, latest, now);
  }

  /**
   * How big the table is, for the Costs page's storage meter: its size (tables.get), how much it
   * grows a day (the last 30 days' rows, at the table's average bytes per row) and how long
   * BigQuery keeps each day (partition expiration, when set).
   */
  storage(cache, meta, now) {
    const from = dayId(now - 30 * DAY);
    const today = dayId(now);
    const recent = Object.entries(cache.partitions).filter(([d]) => d >= from && d < today);
    const perRow = meta.rows > 0 ? meta.bytes / meta.rows : 0;
    const perDay = recent.length && perRow ? (recent.reduce((a, [, p]) => a + (p.rows || 0), 0) / recent.length) * perRow : null;
    return { bytes: meta.bytes, longTermBytes: meta.longTermBytes, bytesPerDay: perDay == null ? null : Math.round(perDay), expirationDays: meta.expirationMs ? Math.round(meta.expirationMs / DAY) : null };
  }

  /** The sums per invoice month, and which months are complete (every day they need was read). */
  result(cache, months, oldestDone, floor, meta, now = Date.now()) {
    const want = new Set(months);
    const out = {};
    for (const p of Object.values(cache.partitions)) mergeMonths(out, p.months, want);
    const complete = months.filter((m) => oldestDone && (oldestDone <= floor || oldestDone <= dayId(monthStart(m) - 3 * DAY)));
    let through = 0;
    for (const byCur of Object.values(out)) for (const m of Object.values(byCur)) through = Math.max(through, m.through || 0);
    // through: the newest usage in the export. Far behind now, Google is still filling it in.
    return { status: 'ok', table: this.ref.id, months: out, complete, through: through || null, created: meta?.created || null, location: meta?.location ?? null, rows: meta?.rows ?? null, days: Object.keys(cache.partitions).length, storage: meta ? this.storage(cache, meta, now) : null };
  }
}
