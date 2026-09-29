// The Costs page: what the platform costs, per vendor and in total, this month, last month
// and the months before. Pure functions (the model the page shows, the money math, the
// settings check) plus a small poller; the readers (BigQuery, Cloudflare, GitHub, OpenRouter,
// fal) are passed in. No Node APIs here: the browser preview runs this too.
//
// Google AI Studio has no reader of its own: Google bills the Gemini API through Cloud Billing,
// so its lines come out of the Google Cloud billing export (and out of Google Cloud's total).
//
// Numbers are only ever what a vendor reported or what someone typed in Settings. What isn't
// known is null ("—" on the page), never a guess: a plan Flobi Pulse started tracking this
// month has no amount for last month.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** How often the readers run. Billing data changes a few times a day at most. */
export const POLL_MS = 6 * HOUR;
/** While a low-credits alert is on, the balance is checked this often between the full reads. */
export const BALANCE_MS = 30 * 60_000;
/** A manual Refresh can't run again sooner than this. */
export const COOLDOWN_MS = 60_000;
/** A read this computer couldn't make because it was offline is made again this soon. */
export const OFFLINE_RETRY_MS = 60_000;
/** Months shown (this one and the five before it). */
export const MONTHS = 6;
/** How long before a projection: fewer days of usage than this is too little to go on. */
const MIN_PROJECTION_DAYS = 2;

export const CYCLES = ['monthly', 'yearly', 'quarterly', 'weekly', 'one-time'];

// ── Months (the calendar of this computer) ───────────────────────────────────
const two = (n) => String(n).padStart(2, '0');

/** "2026-09" for a time. */
export function monthKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}`;
}

/** "2026-09" + 2 → "2026-11". */
export function addMonths(key, n) {
  const total = Number(key.slice(0, 4)) * 12 + Number(key.slice(5, 7)) - 1 + n;
  return `${Math.floor(total / 12)}-${two((total % 12) + 1)}`;
}

/** The last `n` months up to the current one, oldest first. */
export function lastMonths(now, n = MONTHS) {
  const cur = monthKey(now);
  return Array.from({ length: n }, (_, i) => addMonths(cur, i - n + 1));
}

/** How much of the month has passed at `t` (0…1), in this computer's calendar. */
export function monthFraction(t, now = t) {
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  return Math.max(0, Math.min(1, (Math.min(t, now) - start) / (end - start)));
}

const daysInMonth = (now) => {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
};

// ── Money ────────────────────────────────────────────────────────────────────
/**
 * What a charge that comes every `cycle` costs in one month: a yearly one is a twelfth,
 * a quarterly one a third, a weekly one 52 weeks' worth spread over 12 months.
 * One-time charges have no monthly share (they count in their own month only).
 */
export function monthlyShare(amount, cycle) {
  const a = Number(amount);
  if (amount == null || amount === '' || !Number.isFinite(a)) return null;
  if (cycle === 'monthly') return a;
  if (cycle === 'yearly') return a / 12;
  if (cycle === 'quarterly') return a / 3;
  if (cycle === 'weekly') return (a * 52) / 12;
  return null;
}

/**
 * An item from Settings, month by month: a one-time item in the month of its date (0 in the
 * others); a recurring one its monthly share, from the month it was added (before: not known).
 */
export function itemMonths(item, months) {
  const out = {};
  const since = item.addedAt ? monthKey(item.addedAt) : null;
  const when = /^\d{4}-\d{2}-\d{2}$/.test(item.date || '') ? item.date.slice(0, 7) : since;
  for (const m of months) {
    if (item.cycle === 'one-time') out[m] = when === m ? Number(item.amount) || 0 : 0;
    else out[m] = since && m < since ? null : monthlyShare(item.amount, item.cycle);
  }
  return out;
}

/** A 3-letter currency code, upper case, or null. */
export function currencyCode(v) {
  return /^[A-Za-z]{3}$/.test(String(v ?? '').trim()) ? String(v).trim().toUpperCase() : null;
}

// ── Settings → Costs ─────────────────────────────────────────────────────────
export const DEFAULT_COSTS = {
  bigQueryTable: '', // "project.dataset.table" of the Cloud Billing export
  github: { owner: '', kind: 'org', seatPrice: null, seatCurrency: 'USD' },
  items: [], // what's typed in: { id, vendor, item, amount, currency, cycle, date, note, addedAt }
  rates: {}, // 1 unit of the key currency = n units of the page's currency (only when currencies mix)
  currency: '', // the page's currency; '' = USD when anything is in USD
  // An alert when a prepaid balance drops below an amount (in the balance's currency).
  creditAlerts: { openrouter: { on: false, below: null }, fal: { on: false, below: null } },
};

/** The prepaid vendors a low-credits alert can be set for. */
export const CREDIT_VENDORS = { openrouter: 'OpenRouter', fal: 'fal' };

/** "project.dataset.table" (also "project:dataset.table", with or without backticks) → its parts, or null. */
export function parseTableRef(text) {
  const s = String(text || '')
    .trim()
    .replace(/^`(.*)`$/, '$1')
    .replace(/^([a-z][a-z0-9-]{4,28}[a-z0-9]):/, '$1.');
  const m = /^([a-z][a-z0-9-]{4,28}[a-z0-9])\.([A-Za-z0-9_]{1,1024})\.([A-Za-z0-9_-]{1,1024})$/.exec(s);
  return m ? { project: m[1], dataset: m[2], table: m[3], id: `${m[1]}.${m[2]}.${m[3]}` } : null;
}

// ── BigQuery storage ─────────────────────────────────────────────────────────
// The billing export lives in BigQuery, whose storage is free up to 10 GiB a month for the whole
// billing account (other BigQuery data there shares it). The Costs page shows how much of that the
// export uses and, before it gets close, the command that keeps only recent days. Flobi Pulse never
// runs it: it's read-only, the command is for the person to run in BigQuery once.

/** BigQuery's free storage: 10 GiB a month, per billing account. */
export const BQ_FREE_BYTES = 10 * 1024 ** 3;
/** From this share of the free storage it's "getting close" (and an alert says so); from the next, it's about full. */
export const BQ_NEAR = 0.8;
export const BQ_FULL = 0.95;
/** Days the export must keep for the Costs page's six months (and the days before the oldest one). */
export const BQ_MIN_KEEP_DAYS = 200;
export const BQ_MAX_KEEP_DAYS = 400;

/**
 * How much of BigQuery's free storage the billing export table uses, and what to do about it.
 * `s` is what the reader found ({ bytes, bytesPerDay, expirationDays }); `ref` the table.
 * keepDays: the days to keep so the table settles around half the free storage (never fewer
 * than the page needs, never more than 400); command: the one-time statement that does it.
 */
export function bigQueryStorage(s, ref) {
  if (!s || !Number.isFinite(s.bytes) || !ref?.id) return null;
  const share = s.bytes / BQ_FREE_BYTES;
  const level = share >= BQ_FULL ? 'full' : share >= BQ_NEAR ? 'near' : 'ok';
  const perDay = Number.isFinite(s.bytesPerDay) && s.bytesPerDay > 0 ? s.bytesPerDay : null;
  const expirationDays = Number.isFinite(s.expirationDays) && s.expirationDays > 0 ? s.expirationDays : null;
  const keepDays = perDay ? Math.max(BQ_MIN_KEEP_DAYS, Math.min(BQ_MAX_KEEP_DAYS, Math.floor(BQ_FREE_BYTES / 2 / perDay))) : BQ_MAX_KEEP_DAYS;
  return {
    bytes: s.bytes,
    freeBytes: BQ_FREE_BYTES,
    share,
    level,
    bytesPerDay: perDay,
    expirationDays,
    keepDays,
    // Where the table ends up once BigQuery deletes the older days: with keepDays, or with the expiration already set.
    settlesAt: perDay ? perDay * keepDays : null,
    cappedAt: perDay && expirationDays ? perDay * expirationDays : null,
    // With nothing set, when it would pass the free storage at this pace.
    daysToFree: perDay && !expirationDays && s.bytes < BQ_FREE_BYTES ? Math.floor((BQ_FREE_BYTES - s.bytes) / perDay) : null,
    command: `ALTER TABLE \`${ref.id}\`\nSET OPTIONS (partition_expiration_days = ${keepDays});`,
  };
}

/**
 * An API key as pasted (OpenRouter, fal): trimmed, without "Bearer " or "Key " in front. Empty
 * means remove it (null). Throws when it can't be a key (spaces, line breaks), since it's sent
 * as a header.
 */
export function cleanApiKey(v, name) {
  const s = String(v ?? '')
    .trim()
    .replace(/^(bearer|key)\s+/i, '');
  if (!s) return null;
  if (!/^[\x21-\x7e]{8,512}$/.test(s)) throw new Error(`That doesn’t look like ${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name} key. Paste it as copied, in one piece.`);
  return s;
}

const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const newId = () => Math.random().toString(36).slice(2, 10);

function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || '')) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Settings → Costs, checked. `patch` holds only what changed; the rest stays as in `current`.
 * Throws an Error with a message for the person when something can't be used.
 */
export function cleanCostsSettings(patch = {}, current = {}, now = Date.now()) {
  const cur = { ...structuredClone(DEFAULT_COSTS), ...(current || {}) };
  cur.github = { ...DEFAULT_COSTS.github, ...(current?.github || {}) };
  cur.creditAlerts = Object.fromEntries(Object.keys(CREDIT_VENDORS).map((id) => [id, { ...DEFAULT_COSTS.creditAlerts[id], ...(current?.creditAlerts?.[id] || {}) }]));
  const out = { ...cur };
  if ('bigQueryTable' in patch) {
    const t = String(patch.bigQueryTable ?? '').trim();
    if (!t) out.bigQueryTable = '';
    else {
      const ref = parseTableRef(t);
      if (!ref) throw new Error('The table looks like project.dataset.table, e.g. flobi-billing.billing_export.gcp_billing_export_v1_0123AB_4567CD_89EF01.');
      out.bigQueryTable = ref.id;
    }
  }
  if (patch.github && typeof patch.github === 'object') {
    const g = { ...cur.github };
    if ('owner' in patch.github) {
      const o = String(patch.github.owner ?? '')
        .trim()
        .replace(/^https?:\/\/github\.com\//i, '')
        .replace(/^@/, '')
        .replace(/\/.*$/, '');
      if (o && !/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(o)) throw new Error('A GitHub organization or user name has only letters, numbers and single hyphens.');
      g.owner = o;
    }
    if ('kind' in patch.github) g.kind = patch.github.kind === 'user' ? 'user' : 'org';
    if ('seatPrice' in patch.github) {
      const v = patch.github.seatPrice;
      if (v === '' || v == null) g.seatPrice = null;
      else {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 100_000) throw new Error('The price per seat is a number, like 4 or 21.');
        g.seatPrice = n;
      }
    }
    if ('seatCurrency' in patch.github) g.seatCurrency = currencyCode(patch.github.seatCurrency) || 'USD';
    out.github = g;
  }
  if ('items' in patch) {
    const list = Array.isArray(patch.items) ? patch.items : [];
    if (list.length > 100) throw new Error('Up to 100 items.');
    const before = new Map((cur.items || []).map((it) => [it.id, it]));
    out.items = list.map((it) => {
      const vendor = text(it?.vendor, 60);
      const amount = Number(it?.amount);
      if (!vendor) throw new Error('Each item needs a vendor (like Sentry).');
      if (it?.amount === '' || it?.amount == null || !Number.isFinite(amount) || Math.abs(amount) > 10_000_000) throw new Error(`${vendor}: the amount is a number, like 26 or 26.50.`);
      const id = /^[A-Za-z0-9_-]{1,40}$/.test(it?.id || '') ? it.id : newId();
      const old = before.get(id);
      const date = String(it?.date ?? '').trim();
      if (date && !validDate(date)) throw new Error(`${vendor}: the date looks like 2026-09-28.`);
      return {
        id,
        vendor,
        item: text(it?.item, 80),
        amount,
        currency: currencyCode(it?.currency) || 'USD',
        cycle: CYCLES.includes(it?.cycle) ? it.cycle : 'monthly',
        date,
        note: text(it?.note, 200),
        // When it was first added: a recurring item counts from that month on.
        addedAt: old?.addedAt || (Number.isFinite(it?.addedAt) && it.addedAt <= now ? it.addedAt : now),
      };
    });
  }
  if ('rates' in patch) {
    const rates = {};
    for (const [k, v] of Object.entries(patch.rates || {})) {
      const code = currencyCode(k);
      if (!code || v === '' || v == null) continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) throw new Error(`The ${code} rate is a number above 0, like 1.08.`);
      rates[code] = n;
    }
    out.rates = rates;
  }
  if ('currency' in patch) out.currency = currencyCode(patch.currency) || '';
  if (patch.creditAlerts && typeof patch.creditAlerts === 'object') {
    const next = { ...cur.creditAlerts };
    for (const [id, name] of Object.entries(CREDIT_VENDORS)) {
      const p = patch.creditAlerts[id];
      if (!p || typeof p !== 'object') continue;
      const a = { ...cur.creditAlerts[id] };
      if ('below' in p) {
        const v = String(p.below ?? '')
          .trim()
          .replace(/^\$\s*/, '');
        if (!v) a.below = null;
        else {
          const n = Number(v);
          if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) throw new Error(`${name}: the amount to alert below is a number above 0, like 20.`);
          a.below = n;
        }
      }
      if ('on' in p) a.on = p.on === true;
      if (a.on && a.below == null) throw new Error(`${name}: type the amount to alert below, like 20.`);
      next[id] = a;
    }
    out.creditAlerts = next;
  }
  return out;
}

// ── The page ─────────────────────────────────────────────────────────────────
const VENDOR_OF = [
  [/^(google cloud|gcp|google cloud platform)$/i, 'gcp'],
  [/^cloudflare$/i, 'cloudflare'],
  [/^github$/i, 'github'],
  [/^sentry$/i, 'sentry'],
  [/^clerk$/i, 'clerk'],
  [/^((google )?ai studio|gemini( api)?)$/i, 'aistudio'],
  [/^open ?router$/i, 'openrouter'],
  [/^fal(\.ai)?$/i, 'fal'],
  [/^replicate$/i, 'replicate'],
];
const vendorOf = (name) => VENDOR_OF.find(([re]) => re.test(String(name || '').trim()))?.[1] || 'other';

function manualLine(item, months) {
  return {
    id: `manual:${item.id}`,
    name: item.item || item.vendor,
    vendor: item.vendor,
    note: item.note || null,
    manual: true,
    kind: item.cycle === 'one-time' ? 'one-time' : 'fixed',
    cycle: item.cycle,
    price: Number(item.amount),
    currency: currencyCode(item.currency) || 'USD',
    date: item.date || null,
    addedAt: item.addedAt || null,
    months: itemMonths(item, months),
  };
}

const vendor = (id, name, source) => ({ id, name, source, status: 'ok', reason: null, message: null, lines: [], okAt: null, checkedAt: null, refreshing: false, progress: null, through: null });

/** Status of a vendor that has a reader: its last read, or loading before the first one. */
function readStatus(v, raw) {
  if (!raw) {
    v.status = 'loading';
    return;
  }
  Object.assign(v, { status: raw.status || 'ok', message: raw.message || null, okAt: raw.okAt || null, checkedAt: raw.checkedAt || null, refreshing: !!raw.refreshing, progress: raw.progress || null });
  if (!raw.okAt && raw.refreshing && !raw.status) v.status = 'loading';
}

/** The export's newest usage this far behind its last read: Google is still filling it in (or it stopped). */
export const EXPORT_LAG_MS = 3 * DAY;
/** Still that far behind this long after the export made its table: it isn't filling in, it stopped. */
const EXPORT_BACKFILL_MS = 7 * DAY;

const utcMonthStart = (key) => Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1);

/**
 * The first month the billing export has whole ("YYYY-MM"), from when it made its table (UTC):
 * into a multi-region dataset (US, EU) Google also copies the month before it was turned on;
 * into a regional one only what comes after, so its first whole month is the next one (unless
 * it began on the 1st). Location not known: taken as multi-region. Null when there's no date.
 */
export function exportFirstMonth(created, location) {
  const t = Number(created);
  if (!Number.isFinite(t) || t <= 0) return null;
  const d = new Date(t);
  const m = `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}`;
  const regional = !!location && !/^(us|eu)$/i.test(String(location).trim());
  if (!regional) return addMonths(m, -1);
  return d.getUTCDate() === 1 ? m : addMonths(m, 1);
}

function gcpVendor(raw, setup, months) {
  const v = vendor('gcp', 'Google Cloud', 'Cloud Billing export in BigQuery');
  const ref = parseTableRef(setup?.table);
  Object.assign(v, { table: ref?.id || null, dataset: ref?.dataset || null, project: ref?.project || null, email: setup?.email || null });
  if (!ref) {
    Object.assign(v, { status: 'off', reason: 'no-table' });
    return v;
  }
  readStatus(v, raw);
  v.rows = raw?.rows ?? null;
  v.storage = bigQueryStorage(raw?.storage, ref);
  if (!raw?.months) return v;
  const complete = new Set(raw.complete || []);
  // What Google has put in the export so far. Months before its first whole one are never whole
  // (a few hours spill over, by invoice month). While its newest usage is days behind (the first
  // days after it's turned on, Google copies the month before and then catches up to now), only
  // the months it's already past count: this month and the one it's in are unknown, not partial.
  const newest = Number(raw.through) > 0 ? Number(raw.through) : null;
  // (A result without `through` at all is from before the page looked at this: counted as before.)
  const behind = !!raw.okAt && raw.through !== undefined && (!newest || raw.okAt - newest > EXPORT_LAG_MS);
  // Not known when the export began (a result saved before the page asked): while it's behind,
  // nothing before the month it has got to counts.
  const first = exportFirstMonth(raw.created, raw.location) ?? (behind && newest ? new Date(newest).toISOString().slice(0, 7) : null);
  const exported = (m) => (!first || m >= first) && (!behind || (!!newest && newest >= utcMonthStart(addMonths(m, 1))));
  Object.assign(v, { exportFrom: first, created: Number(raw.created) > 0 ? Number(raw.created) : null });
  if (behind) v.catchingUp = { through: newest, stuck: Number(raw.created) > 0 && raw.okAt - Number(raw.created) > EXPORT_BACKFILL_MS };
  const names = new Map();
  for (const m of months) for (const [cur, d] of Object.entries(raw.months[m] || {})) for (const name of Object.keys(d?.lines || {})) names.set(`${cur}:${name}`, { name, cur });
  for (const { name, cur } of names.values()) {
    const line = { id: `gcp:${cur}:${name}`, name, kind: 'usage', cycle: 'usage', currency: cur, months: {}, credits: {} };
    for (const m of months) {
      const d = raw.months[m]?.[cur];
      if (!complete.has(m) || !exported(m) || !d) {
        line.months[m] = null;
        continue;
      }
      const [cost, credits] = d.lines?.[name] || [0, 0];
      line.months[m] = cost + credits;
      line.credits[m] = credits;
    }
    v.lines.push(line);
  }
  const current = months.at(-1);
  v.through = exported(current) ? Math.max(0, ...Object.values(raw.months[current] || {}).map((d) => d?.through || 0)) || null : null;
  // Before the first complete month is in (the first read of a new table), it's still loading.
  if (!complete.has(current) && raw.refreshing && v.status === 'ok' && !raw.okAt) v.status = 'loading';
  return v;
}

/** A Cloudflare plan's share of one month: nothing while in a trial or once cancelled. */
function planShare(sub) {
  if (!sub?.charged) return 0;
  return monthlyShare(sub.price ?? 0, sub.frequency) ?? 0;
}

function cloudflareVendor(raw, setup, history, months) {
  const v = vendor('cloudflare', 'Cloudflare', 'Subscriptions and Billable Usage API');
  Object.assign(v, { accountId: setup?.accountId || null, zones: setup?.zones || [] });
  if (!setup?.hasToken) {
    Object.assign(v, { status: 'off', reason: 'no-token' });
    return v;
  }
  readStatus(v, raw);
  if (!raw) return v;
  const current = months.at(-1);
  // Plans: this month from the last read, earlier months from what was seen then.
  const plans = new Map();
  const note = (m, sub) => {
    let p = plans.get(sub.id);
    if (!p) plans.set(sub.id, (p = { sub, months: Object.fromEntries(months.map((x) => [x, null])) }));
    if (m === current) p.sub = sub;
    p.months[m] = planShare(sub);
  };
  if (raw.subscriptions) for (const s of raw.subscriptions) note(current, s);
  for (const m of months.slice(0, -1)) for (const s of history?.[m]?.[raw.key]?.subs || []) note(m, s);
  for (const { sub, months: byMonth } of plans.values()) {
    // A plan seen before but not in this month's list is gone: nothing this month.
    if (byMonth[current] == null && Array.isArray(raw.subscriptions)) byMonth[current] = 0;
    v.lines.push({
      id: `cf:plan:${sub.id}`,
      name: sub.zone ? `${sub.zone} · ${sub.name}` : sub.name,
      kind: 'fixed',
      cycle: sub.frequency || 'none',
      price: sub.price,
      currency: sub.currency || 'USD',
      state: sub.charged ? null : sub.state,
      renews: sub.charged ? sub.periodEnd || null : null,
      months: byMonth,
    });
  }
  // Usage-based charges.
  const u = raw.usage || {};
  Object.assign(v, { usageStatus: u.status || null, usageMessage: u.message || null });
  const names = new Map();
  for (const m of months) for (const [cur, d] of Object.entries(u.months?.[m] || {})) for (const name of Object.keys(d?.lines || {})) names.set(`${cur}:${name}`, { name, cur });
  for (const { name, cur } of names.values()) {
    v.lines.push({ id: `cf:usage:${cur}:${name}`, name, kind: 'usage', cycle: 'usage', currency: cur, months: Object.fromEntries(months.map((m) => [m, u.read?.[m] ? u.months?.[m]?.[cur]?.lines?.[name] || 0 : null])) });
  }
  v.through = Math.max(0, ...Object.values(u.months?.[current] || {}).map((d) => d?.through || 0)) || (u.read?.[current] ? raw.checkedAt : null);
  return v;
}

function githubVendor(raw, setup, history, months, gh = {}) {
  const v = vendor('github', 'GitHub', 'Billing usage summary');
  Object.assign(v, { owner: setup?.owner || null, kind: setup?.kind || 'org' });
  if (!setup?.hasToken) {
    Object.assign(v, { status: 'off', reason: 'no-token' });
    return v;
  }
  if (!setup?.owner) {
    Object.assign(v, { status: 'off', reason: 'no-owner' });
    return v;
  }
  readStatus(v, raw);
  if (!raw) return v;
  const current = months.at(-1);
  const names = new Set();
  for (const m of months) for (const name of Object.keys(raw.months?.[m]?.USD?.lines || {})) names.add(name);
  for (const name of names) {
    v.lines.push({ id: `gh:usage:${name}`, name, kind: 'usage', cycle: 'usage', currency: 'USD', months: Object.fromEntries(months.map((m) => [m, raw.read?.[m] ? raw.months?.[m]?.USD?.lines?.[name] || 0 : null])) });
  }
  Object.assign(v, { seats: raw.seats || null, seatsNote: raw.seatsNote || null });
  // Seats: the plan's seat count (only owners see it) × the price per seat set in Settings.
  const price = Number(gh?.seatPrice);
  if (v.kind === 'org' && gh?.seatPrice != null && Number.isFinite(price)) {
    const count = (s) => (!s ? null : String(s.plan || '').toLowerCase() === 'free' ? 0 : s.seats || s.filled || 0);
    const byMonth = {};
    for (const m of months) {
      const s = m === current ? raw.seats : history?.[m]?.[raw.key]?.seats;
      const n = count(s);
      byMonth[m] = n == null ? null : n * price;
    }
    const plan = raw.seats?.plan;
    // Only once a seat count was ever seen (GitHub shows it to owners only).
    if (Object.values(byMonth).some((x) => x != null)) v.lines.push({ id: 'gh:seats', name: plan ? `Seats (${plan.charAt(0).toUpperCase()}${plan.slice(1)} plan)` : 'Seats', kind: 'fixed', cycle: 'monthly', price, perSeat: true, seats: count(raw.seats), filled: raw.seats?.filled ?? null, currency: currencyCode(gh.seatCurrency) || 'USD', months: byMonth });
  }
  v.through = raw.read?.[current] ? raw.checkedAt : null;
  return v;
}

/** The Gemini API as Cloud Billing names it (it was the Generative Language API before). */
const GEMINI = /^(gemini api|generative language api)$/i;

/**
 * Google AI Studio: Google bills the Gemini API through Cloud Billing, so when AI Studio's project
 * is on the billing account whose export is set, its usage is in there. Those lines move from
 * Google Cloud to here (so they're counted once), with the export's status.
 */
function aiStudioVendor(gcp) {
  const v = vendor('aistudio', 'Google AI Studio', 'Gemini API, from the Cloud Billing export');
  if (gcp.status === 'off') {
    Object.assign(v, { status: 'off', reason: 'via-gcp' });
    return v;
  }
  Object.assign(v, { status: gcp.status, message: gcp.message, okAt: gcp.okAt, checkedAt: gcp.checkedAt, refreshing: gcp.refreshing, through: gcp.through, table: gcp.table, exportFrom: gcp.exportFrom || null, created: gcp.created || null, catchingUp: gcp.catchingUp || null });
  v.lines = gcp.lines.filter((l) => GEMINI.test(l.name)).map((l) => ({ ...l, id: `aistudio:${l.id}` }));
  gcp.lines = gcp.lines.filter((l) => !GEMINI.test(l.name));
  // The whole export was read and has no Gemini API: nothing billed on that billing account.
  // (While Google is still filling it in, there may be some yet.)
  if (v.status === 'ok' && !v.lines.length && gcp.okAt && !gcp.catchingUp) Object.assign(v, { status: 'off', reason: 'none' });
  return v;
}

const lastDayOf = (m) => `${m}-${two(new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate())}`;
const nextDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + DAY).toISOString().slice(0, 10);

/**
 * OpenRouter: usage per model from the days read (whole UTC days, up to yesterday). This month is
 * known up to the last day read when every day before it is there; an earlier month only when
 * every one of its days is. One that began before the first read (OpenRouter keeps 30 days), or
 * with days missing, is unknown: never a part of it passed off as the whole.
 */
function openRouterVendor(raw, setup, months) {
  const v = vendor('openrouter', 'OpenRouter', 'Activity and Credits API');
  if (!setup?.hasKey) {
    Object.assign(v, { status: 'off', reason: 'no-key' });
    return v;
  }
  readStatus(v, raw);
  if (!raw?.days) return v;
  const [prev, current] = months.slice(-2);
  const days = raw.days;
  const last = /^\d{4}-\d{2}-\d{2}$/.test(raw.lastDay || '') ? raw.lastDay : null;
  const known = {};
  for (const m of months) {
    const end = lastDayOf(m);
    const upto = m === current && last < end ? last : end;
    let ok = !!last && (m === current ? nextDay(last) >= `${m}-01` : last >= end);
    for (let day = `${m}-01`; ok && day <= upto; day = nextDay(day)) if (!days[day]) ok = false;
    known[m] = ok;
  }
  const lines = new Map();
  const line = (name, id = `or:${name}`) => {
    if (!lines.has(name)) lines.set(name, { id, name, kind: 'usage', cycle: 'usage', currency: 'USD', months: Object.fromEntries(months.map((m) => [m, known[m] ? 0 : null])) });
    return lines.get(name);
  };
  for (const [day, byModel] of Object.entries(days)) {
    const m = day.slice(0, 7);
    if (known[m]) for (const [name, usd] of Object.entries(byModel || {})) if (Number.isFinite(usd)) line(name).months[m] += usd;
  }
  // Nothing spent in the months known: one line, so the months read show $0 rather than "—".
  if (!lines.size && months.some((m) => known[m])) line('Usage', 'or:usage');
  v.lines = [...lines.values()];
  v.lastDay = last; // 'YYYY-MM-DD' (UTC): the last whole day read
  v.through = last && known[current] ? Date.parse(`${last}T00:00:00Z`) + DAY : null;
  const byok = (m) => (known[m] ? Object.entries(raw.byok || {}).reduce((sum, [day, x]) => (day.slice(0, 7) === m && Number.isFinite(x) ? sum + x : sum), 0) : null);
  v.byok = { thisMonth: byok(current), lastMonth: byok(prev), currency: 'USD' };
  v.balance = raw.credits && Number.isFinite(raw.credits.total) && Number.isFinite(raw.credits.used) ? { amount: raw.credits.total - raw.credits.used, currency: 'USD' } : null;
  v.balanceNote = raw.creditsNote || null;
  return v;
}

/** fal: usage per endpoint for the months read, and the credit balance. */
function falVendor(raw, setup, months) {
  const v = vendor('fal', 'fal', 'Usage and Billing API');
  if (!setup?.hasKey) {
    Object.assign(v, { status: 'off', reason: 'no-key' });
    return v;
  }
  readStatus(v, raw);
  if (!raw) return v;
  const current = months.at(-1);
  const names = new Map();
  // Endpoints that cost nothing in every month shown (free ones) aren't listed.
  for (const m of months) for (const [cur, d] of Object.entries(raw.months?.[m] || {})) for (const [name, cost] of Object.entries(d?.lines || {})) if (cost) names.set(`${cur}:${name}`, { name, cur });
  for (const { name, cur } of names.values()) {
    v.lines.push({ id: `fal:${cur}:${name}`, name, kind: 'usage', cycle: 'usage', currency: cur, months: Object.fromEntries(months.map((m) => [m, raw.read?.[m] ? raw.months?.[m]?.[cur]?.lines?.[name] || 0 : null])) });
  }
  if (!v.lines.length && months.some((m) => raw.read?.[m])) v.lines.push({ id: 'fal:usage', name: 'Usage', kind: 'usage', cycle: 'usage', currency: raw.balance?.currency || 'USD', months: Object.fromEntries(months.map((m) => [m, raw.read?.[m] ? 0 : null])) });
  v.through = raw.read?.[current] ? raw.checkedAt || null : null;
  v.balance = raw.balance && Number.isFinite(raw.balance.amount) ? { amount: raw.balance.amount, currency: raw.balance.currency || 'USD' } : null;
  v.balanceNote = raw.balanceNote || null;
  v.account = raw.account || null;
  return v;
}

/** Below this many days of credits left (at the current pace), the Costs page says so. */
export const LOW_BALANCE_DAYS = 7;

/**
 * How long a prepaid balance (OpenRouter's, fal's) lasts: at this month's pace, or last month's
 * in the first days of a month. Adds perDay, daysLeft and low to v.balance.
 */
function runway(v, months, now) {
  const b = v.balance;
  const [prev, current] = months.slice(-2);
  const usage = (m) => v.lines.reduce((sum, l) => (l.kind === 'usage' && l.currency === b.currency && l.months[m] != null ? sum + l.months[m] : sum), 0);
  const read = (m) => v.lines.some((l) => l.kind === 'usage' && l.months[m] != null);
  const days = monthFraction(v.through ?? now, now) * daysInMonth(now);
  const lastMonthDays = new Date(Number(prev.slice(0, 4)), Number(prev.slice(5, 7)), 0).getDate();
  let perDay = null;
  if (read(current) && days >= MIN_PROJECTION_DAYS && usage(current) > 0) perDay = usage(current) / days;
  else if (read(prev) && usage(prev) > 0) perDay = usage(prev) / lastMonthDays;
  b.perDay = perDay;
  b.daysLeft = perDay ? Math.max(0, Math.floor(b.amount / perDay)) : null;
  b.low = b.amount <= 0 ? perDay != null : b.daysLeft != null && b.daysLeft < LOW_BALANCE_DAYS;
}

/** Vendors that are always on the page, typed in because they have no billing API. */
const NO_API = {
  sentry: 'Your plan, from Settings → Costs (Sentry has no billing API)',
  clerk: 'Your plan, from Settings → Costs (Clerk has no billing API)',
  replicate: 'Typed in Settings → Costs (Replicate has no billing API)',
};

function manualVendor(id, name, lines) {
  const v = vendor(id, name, NO_API[id] || 'Added in Settings → Costs');
  v.lines = lines;
  if (!lines.length) Object.assign(v, { status: 'off', reason: 'manual' });
  return v;
}

/**
 * Totals, projection and trend of a vendor, in the page's currency. `rate(cur)` converts
 * (null when there's no rate: that amount is left out and named in missingRates).
 */
function finishVendor(v, months, rate, missing, now) {
  const [prev, current] = months.slice(-2);
  const conv = (l, m) => {
    const a = l.months[m];
    if (a == null) return null;
    const r = rate(l.currency);
    if (r == null) {
      if (a && (m === current || m === prev)) missing.add(l.currency);
      return null;
    }
    return a * r;
  };
  v.byMonth = {};
  v.partial = {};
  for (const m of months) {
    let sum = null;
    let unknown = false;
    for (const l of v.lines) {
      const a = conv(l, m);
      if (a == null) unknown = unknown || l.months[m] == null || !!l.months[m];
      else sum = (sum ?? 0) + a;
    }
    v.byMonth[m] = sum;
    v.partial[m] = sum != null && unknown;
  }
  v.totals = { thisMonth: v.byMonth[current], lastMonth: v.byMonth[prev] };
  // Projection: fixed charges as they are, usage at this month's pace so far.
  let usage = null;
  let fixed = null;
  for (const l of v.lines) {
    const a = conv(l, current);
    if (a == null) continue;
    if (l.kind === 'usage') usage = (usage ?? 0) + a;
    else fixed = (fixed ?? 0) + a;
  }
  const frac = usage != null ? monthFraction(v.through ?? now, now) : 0;
  const enough = frac * daysInMonth(now) >= MIN_PROJECTION_DAYS;
  const amount = usage == null && fixed == null ? null : (fixed ?? 0) + (usage == null ? 0 : enough ? usage / frac : usage);
  v.projection = { amount, estimated: usage != null && enough, early: usage != null && !enough };
  v.trend = months.map((m) => ({ month: m, amount: v.byMonth[m] }));
  v.showTrend = v.lines.some((l) => l.kind === 'usage') && v.trend.filter((t) => t.amount != null).length >= 2;
  v.stale = !!(v.okAt && (now - v.okAt > 2 * POLL_MS || (v.status !== 'ok' && v.status !== 'loading')));
  // Lines people see: one-time items only around their own month (and upcoming ones).
  for (const l of v.lines) l.hidden = l.kind === 'one-time' && !(l.months[current] || l.months[prev]) && !(l.date && l.date.slice(0, 7) > current);
  // Biggest first; what's typed in last.
  v.lines.sort((a, b) => Number(!!a.manual) - Number(!!b.manual) || (conv(b, current) ?? -1) - (conv(a, current) ?? -1) || (conv(b, prev) ?? -1) - (conv(a, prev) ?? -1) || a.name.localeCompare(b.name));
  for (const l of v.lines) Object.assign(l, { thisMonth: l.months[current], lastMonth: l.months[prev] });
}

/**
 * Everything the Costs page shows.
 * @param {{ vendors?: object, history?: object }} data what the readers found (see CostsWatcher)
 * @param {object} settings Settings → Costs (see DEFAULT_COSTS)
 * @param {{ now?: number, setup?: object, running?: boolean, cooldownUntil?: number, nextPollAt?: number, mode?: string }} ctx
 *   setup: what's configured: { email, gcp: { table }, cloudflare: { hasToken, accountId, zones }, github: { hasToken, owner, kind },
 *   openrouter: { hasKey }, fal: { hasKey } }
 */
export function buildCosts({ vendors = {}, history = {} } = {}, settings = {}, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const s = { ...DEFAULT_COSTS, ...(settings || {}) };
  const setup = ctx.setup || {};
  const months = lastMonths(now, MONTHS);
  const [prev, current] = months.slice(-2);

  const manual = { gcp: [], cloudflare: [], github: [], aistudio: [], openrouter: [], fal: [], replicate: [], sentry: [], clerk: [], other: [] };
  for (const it of s.items || []) manual[vendorOf(it.vendor)].push(manualLine(it, months));

  const gcp = gcpVendor(vendors.gcp, { ...setup.gcp, email: setup.email }, months);
  // Before anything typed in is added to Google Cloud: only the export's Gemini API lines move.
  const aistudio = aiStudioVendor(gcp);
  const cloudflare = cloudflareVendor(vendors.cloudflare, setup.cloudflare, history, months);
  const github = githubVendor(vendors.github, setup.github, history, months, s.github);
  const openrouter = openRouterVendor(vendors.openrouter, setup.openrouter, months);
  const fal = falVendor(vendors.fal, setup.fal, months);
  const list = [gcp, cloudflare, github, aistudio, openrouter, fal];
  for (const v of list) if (manual[v.id].length) v.lines.push(...manual[v.id]);
  list.push(manualVendor('replicate', 'Replicate', manual.replicate));
  list.push(manualVendor('sentry', 'Sentry', manual.sentry));
  list.push(manualVendor('clerk', 'Clerk', manual.clerk));
  if (manual.other.length) list.push(manualVendor('other', 'Other', manual.other));

  // One currency for the totals: USD when anything is in USD (Cloudflare and GitHub always
  // are), unless Settings picks another. Other currencies need a rate from Settings.
  const used = new Set(list.flatMap((v) => v.lines.filter((l) => l.months[current] != null || l.months[prev] != null).map((l) => l.currency)));
  const currency = currencyCode(s.currency) || (used.has('USD') || !used.size ? 'USD' : [...used].sort()[0]);
  const rates = s.rates || {};
  const rate = (cur) => (cur === currency ? 1 : Number(rates[cur]) > 0 ? Number(rates[cur]) : null);
  const missing = new Set();
  for (const v of list) finishVendor(v, months, rate, missing, now);
  for (const v of list) if (v.balance) runway(v, months, now);
  // Settings → Costs: an alert when the credits drop below an amount.
  for (const v of list) {
    const a = s.creditAlerts?.[v.id];
    if (!(v.id in CREDIT_VENDORS) || !a?.on || !(Number(a.below) > 0)) continue;
    v.creditAlert = { below: Number(a.below) };
    if (v.balance && v.status !== 'off') Object.assign(v.balance, { alertBelow: Number(a.below), alerting: v.balance.amount < Number(a.below) });
  }

  const sum = (pick) => {
    let total = null;
    for (const v of list) {
      const a = pick(v);
      if (a != null) total = (total ?? 0) + a;
    }
    return total;
  };
  const counted = list.filter((v) => v.status !== 'off');
  const total = {
    thisMonth: sum((v) => v.totals.thisMonth),
    lastMonth: sum((v) => v.totals.lastMonth),
    projected: sum((v) => v.projection.amount),
    projectionEstimated: list.some((v) => v.projection.estimated),
    projectionEarly: list.some((v) => v.projection.early),
    // Last month leaves something out: an item or plan tracked only since, or a source not read.
    lastMonthPartial: counted.some((v) => v.partial[prev] || (v.totals.lastMonth == null && v.lines.length > 0)),
    thisMonthPartial: counted.some((v) => v.partial[current]),
    byMonth: Object.fromEntries(months.map((m) => [m, sum((v) => v.byMonth[m])])),
  };
  const gaps = [];
  for (const v of list) for (const l of v.lines) if (!l.hidden && l.lastMonth == null && l.thisMonth != null && (l.manual || l.kind === 'fixed')) gaps.push(l.name);

  return {
    now,
    mode: ctx.mode || 'live',
    month: current,
    lastMonth: prev,
    months,
    currency,
    rates: Object.fromEntries(Object.entries(rates).filter(([k]) => k !== currency)),
    // Currencies seen that need a rate (only asked for when currencies mix).
    currencies: [...used].filter((c) => c !== currency).sort(),
    missingRates: [...missing].sort(),
    vendors: list,
    total,
    lastMonthGaps: gaps,
    // 'none': Google AI Studio when the export has no Gemini API (nothing to set up).
    notSetUp: list.filter((v) => v.status === 'off' && v.reason !== 'manual' && v.reason !== 'none').map((v) => v.name),
    checkedAt: Math.max(0, ...list.map((v) => v.checkedAt || 0)) || null,
    refreshing: !!ctx.running,
    cooldownUntil: ctx.cooldownUntil || null,
    nextPollAt: ctx.nextPollAt || null,
  };
}

/**
 * The prepaid balances that are below the amount set to alert at (Settings → Costs), for the
 * alert (engine/alerts.mjs): [{ id, name, amount, currency, below, perDay, daysLeft }].
 */
export function lowCredits(model) {
  return (model?.vendors || []).filter((v) => v.balance?.alerting).map((v) => ({ id: v.id, name: v.name, amount: v.balance.amount, currency: v.balance.currency, below: v.balance.alertBelow, perDay: v.balance.perDay ?? null, daysLeft: v.balance.daysLeft ?? null }));
}

// ── The poller ───────────────────────────────────────────────────────────────
const HISTORY_MONTHS = 13;
// What a failed read says about itself (anything else, like a network error code, is 'error').
const READ_CODES = new Set(['invalid', 'setup', 'forbidden', 'api-off', 'not-found']);

/**
 * Runs the readers every 6 hours (and on Refresh, at most once a minute), keeps what they
 * found (restored from `saved` after a restart, when it's for the same account) and what
 * plans were seen each month (a plan's past months come only from there).
 */
export class CostsWatcher {
  /**
   * @param {{ readers?: Record<string, {key: string, read: Function}>, saved?: object,
   *   onChange?: () => void, onSave?: (saved: object) => void, now?: () => number,
   *   pollMs?: number, cooldownMs?: number, startDelayMs?: number,
   *   isOffline?: (o: {since: number}) => Promise<boolean>, offlineRetryMs?: number }} o
   * isOffline (net/connectivity.mjs): a read that got no answer at all while this computer is
   * offline keeps what was read before, and everything is read again in `offlineRetryMs`.
   */
  constructor({ readers = {}, saved = null, onChange = () => {}, onSave = () => {}, now = () => Date.now(), pollMs = POLL_MS, cooldownMs = COOLDOWN_MS, startDelayMs = 15_000, balanceMs = BALANCE_MS, isOffline = null, offlineRetryMs = OFFLINE_RETRY_MS } = {}) {
    Object.assign(this, { readers, onChange, onSave, now, pollMs, cooldownMs, startDelayMs, balanceMs, isOffline, offlineRetryMs });
    this.missed = false; // a read in the current round was skipped: this computer was offline
    this.balanceIds = []; // readers whose balance is checked between reads (setBalanceChecks)
    this.balanceTimer = null;
    this.vendors = {};
    for (const [id, r] of Object.entries(readers)) {
      const v = saved?.vendors?.[id];
      if (v && v.key === r.key) this.vendors[id] = { ...v, refreshing: false, progress: null };
    }
    this.history = {};
    const keep = new Set(lastMonths(this.now(), HISTORY_MONTHS));
    for (const [m, h] of Object.entries(saved?.history || {})) if (keep.has(m)) this.history[m] = h;
    this.running = false;
    this.stopped = false;
    this.timer = null;
    this.cooldownUntil = null;
    this.nextPollAt = null;
  }

  get data() {
    return { vendors: this.vendors, history: this.history, running: this.running, cooldownUntil: this.cooldownUntil, nextPollAt: this.nextPollAt };
  }

  /** First read soon, unless what was saved is recent: then when it's due. */
  start() {
    const ids = Object.keys(this.readers);
    const now = this.now();
    const fresh = ids.length > 0 && ids.every((id) => this.vendors[id]?.okAt && now - this.vendors[id].okAt < this.pollMs);
    const due = fresh ? Math.min(...ids.map((id) => this.vendors[id].okAt)) + this.pollMs - now : 0;
    if (ids.length) this.schedule(Math.max(this.startDelayMs, due));
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.emitTimer);
    clearTimeout(this.balanceTimer);
    this.timer = null;
    this.balanceTimer = null;
  }

  /**
   * The readers (with a balance() read) whose balance is checked every `balanceMs` between the
   * full reads: the ones with a low-credits alert on. One just added is checked within seconds.
   */
  setBalanceChecks(ids = []) {
    const next = [...new Set(ids)].filter((id) => typeof this.readers[id]?.balance === 'function').sort();
    const added = next.some((id) => !this.balanceIds.includes(id));
    const same = next.join() === this.balanceIds.join();
    this.balanceIds = next;
    if (same || this.stopped) return;
    clearTimeout(this.balanceTimer);
    this.balanceTimer = next.length ? setTimeout(() => this.checkBalances(), added ? 2000 : this.balanceMs) : null;
  }

  /** Reads just the balances (a failed one keeps the last; the next full read says what's wrong). */
  async checkBalances() {
    this.balanceTimer = null;
    if (this.stopped) return;
    if (!this.running) {
      let changed = false;
      for (const id of this.balanceIds) {
        if (!this.vendors[id]?.okAt) continue; // never read: the full read brings it
        try {
          const b = await this.readers[id].balance();
          if (this.stopped) return;
          if (this.running || !this.vendors[id]) continue;
          this.vendors[id] = { ...this.vendors[id], ...b, balanceAt: this.now() };
          changed = true;
        } catch {
          // Keep the last balance.
        }
      }
      if (changed) {
        this.save();
        this.emit();
      }
    }
    if (!this.stopped && this.balanceIds.length) this.balanceTimer = setTimeout(() => this.checkBalances(), this.balanceMs);
  }

  schedule(ms) {
    clearTimeout(this.timer);
    if (this.stopped) return;
    // A new month is a new column: read again a few minutes after it begins.
    const d = new Date(this.now());
    const turn = new Date(d.getFullYear(), d.getMonth() + 1, 1, 0, 5).getTime() - this.now();
    const wait = turn > 0 ? Math.min(ms, turn) : ms;
    this.nextPollAt = this.now() + wait;
    this.timer = setTimeout(() => this.poll(), wait);
  }

  /** Refresh now. Refused while a read runs or within a minute of the last one. */
  refresh({ force = false } = {}) {
    const now = this.now();
    if (this.stopped || !Object.keys(this.readers).length) return { started: false, reason: 'off' };
    if (this.running) return { started: false, reason: 'running' };
    if (!force && this.cooldownUntil && now < this.cooldownUntil) return { started: false, reason: 'cooldown', retryInMs: this.cooldownUntil - now };
    this.poll();
    return { started: true };
  }

  emit() {
    clearTimeout(this.emitTimer);
    this.emitTimer = null;
    if (!this.stopped) this.onChange();
  }

  /** Progress arrives often: pass it on a few times a second at most. */
  emitSoon() {
    if (this.emitTimer || this.stopped) return;
    this.emitTimer = setTimeout(() => this.emit(), 400);
  }

  save() {
    const vendors = {};
    for (const [id, v] of Object.entries(this.vendors)) {
      const { refreshing, progress, ...rest } = v;
      vendors[id] = rest;
    }
    this.onSave({ v: 1, vendors, history: this.history });
  }

  async poll() {
    if (this.running || this.stopped) return;
    this.running = true;
    const started = this.now();
    this.cooldownUntil = started + this.cooldownMs;
    clearTimeout(this.timer);
    this.nextPollAt = null;
    this.emit();
    const months = lastMonths(started, MONTHS);
    this.missed = false;
    await Promise.all(Object.entries(this.readers).map(([id, r]) => this.readOne(id, r, months)));
    this.running = false;
    if (this.stopped) return;
    this.save();
    // Offline for some of them: again in a minute (and every minute until the connection is back).
    this.schedule(this.missed ? this.offlineRetryMs : this.pollMs);
    this.emit();
  }

  /** A read failed with `e`: was it only that this computer is offline? */
  async offline(e) {
    if (!this.isOffline || e?.status != null || READ_CODES.has(e?.code)) return false;
    try {
      return !!(await this.isOffline({ since: Date.now() }));
    } catch {
      return false;
    }
  }

  async readOne(id, reader, months) {
    const prev = this.vendors[id]?.key === reader.key ? this.vendors[id] : null;
    this.vendors[id] = { ...(prev || {}), key: reader.key, refreshing: true, progress: null };
    this.emit();
    try {
      const res = await reader.read({
        months,
        now: this.now(),
        previous: prev,
        stopped: () => this.stopped,
        onProgress: (progress) => {
          this.vendors[id] = { ...this.vendors[id], progress };
          this.emitSoon();
        },
        // A long first read shows the months that are ready as it goes.
        onPartial: prev?.okAt
          ? undefined
          : (partial) => {
              this.vendors[id] = { ...this.vendors[id], ...partial, status: 'loading' };
              this.emitSoon();
            },
      });
      if (this.stopped) return;
      const at = this.now();
      this.vendors[id] = { ...res, key: reader.key, checkedAt: at, okAt: at, refreshing: false, progress: null };
      this.remember(id, reader.key, res, at);
    } catch (e) {
      if (this.stopped) return;
      const offline = await this.offline(e);
      if (this.stopped) return;
      const { refreshing, progress, ...kept } = prev || {};
      if (offline) {
        // Nothing answered because this computer is offline: nothing wrong with this vendor.
        // What was read before stays as it was (it's read again once the connection is back).
        this.missed = true;
        if (prev) this.vendors[id] = { ...kept, refreshing: false, progress: null };
        else delete this.vendors[id];
      } else this.vendors[id] = { ...kept, key: reader.key, status: READ_CODES.has(e?.code) ? e.code : 'error', message: String(e?.message || e).slice(0, 600), checkedAt: this.now(), okAt: prev?.okAt || null, refreshing: false, progress: null };
    }
    this.save();
    this.emit();
  }

  /** What plans and seats look like this month (their past months come only from here). */
  remember(id, key, res, at) {
    let snap = null;
    if (id === 'cloudflare' && Array.isArray(res.subscriptions)) snap = { subs: res.subscriptions.map(({ id: sid, name, zone, zoneId, planId, price, currency, frequency, state, charged }) => ({ id: sid, name, zone, zoneId, planId, price, currency, frequency, state, charged })) };
    if (id === 'github' && res.seats) snap = { seats: res.seats };
    if (!snap) return;
    const m = monthKey(at);
    this.history = { ...this.history, [m]: { ...(this.history[m] || {}), [key]: snap } };
  }
}
