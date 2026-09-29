// ─────────────────────────────────────────────────────────────────────────────
//  Read-only guard
//
//  Every outgoing request in Flobi Pulse passes through checkRequest() before a
//  single byte leaves the machine. Anything that is not on this allowlist throws
//  ReadOnlyViolation. The list only contains read endpoints (plus Google's token
//  endpoint, which turns the service-account key into a short-lived access
//  token), so even a bug elsewhere in the app cannot create, change or delete
//  anything in the cluster, GCP, Sentry, Cloudflare, GitHub, OpenRouter or fal.
//  Paid APIs (Cloud Monitoring, BigQuery jobs and queries) are left off on
//  purpose, so the app can't add to the bill.
//
//  The Costs page reads billing through the same guard, GET only: BigQuery's
//  free table preview (tables.get and tabledata.list) of the ONE billing-export
//  table set in Settings, never a job or a query; the billing reads of the set
//  Cloudflare account and its zones; the billing usage and plan of the set GitHub
//  organization (or user); OpenRouter's usage and credits, and fal's usage and
//  balance, only once their keys are set (those keys can do more, the guard lets
//  them read those two things and nothing else).
//
//  Rules are allowlists (exact paths / exact queries / exact headers), never
//  blocklists, so encoding tricks (%2F, %73ecrets, ../) have nothing to slip past.
//
//  This is layer 2 of 3. Layer 1 is IAM (the identity only has *viewer* roles).
//  Layer 3 is that nothing is ever deployed into the cluster.
// ─────────────────────────────────────────────────────────────────────────────

export class ReadOnlyViolation extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'ReadOnlyViolation';
    this.code = 'READ_ONLY_VIOLATION';
    this.detail = detail;
  }
}

const DEFAULT_SENTRY_HOSTS = ['sentry.io', 'us.sentry.io', 'de.sentry.io'];

/**
 * The connectivity check (net/connectivity.mjs): two always-up addresses of two different
 * companies. Any answer means this computer is online. GET only, exactly these, nothing sent.
 */
export const CONNECTIVITY_PROBES = Object.freeze(['https://www.gstatic.com/generate_204', 'https://cloudflare.com/cdn-cgi/trace']);
const PROBE_URLS = new Set(CONNECTIVITY_PROBES);

const state = {
  projectId: null,
  kubernetesHosts: new Set(),
  sentryHosts: new Set(DEFAULT_SENTRY_HOSTS),
  uptimeUrls: new Set(),
  graphQLQueries: new Set(),
  // Other projects whose Cloud SQL instances (and only those, and their Postgres
  // logs) may be read, for a database that lives outside the app's project.
  sqlProjects: new Set(),
  // "owner/repo" of the app's own GitHub releases (app updates). Set once at
  // startup from package.json and kept across connector restarts.
  updateRepo: null,
  // The Versions page: the org whose repos' releases may be read, and the one
  // manifest file listing them. Also set once at startup.
  github: null, // { owner, manifest: '/repos/<owner>/<repo>/contents/<path>' }
  // The Costs page: what it may read, set from Settings → Costs. Kept across connector
  // restarts (the Costs page has its own timer); configureGuard({ billing: null }) clears it.
  billing: emptyBilling(),
  denied: [], // last few denied attempts, surfaced in Settings → Data sources
};

function emptyBilling() {
  return {
    bigQuery: null, // { project, dataset, table }: the ONE billing-export table
    cloudflareAccount: null, // 32-hex account ID
    cloudflareZones: new Set(), // zone IDs of the zones set in Settings (learned from the zone list)
    github: null, // { kind: 'org' | 'user', owner } (lowercase)
    openrouter: false, // a management key is set: its usage (activity) and credits may be read
    fal: false, // an admin key is set: its usage and credit balance may be read
  };
}

// A BigQuery table reference, as Google spells its parts: project ID, dataset, table.
const BQ_PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const BQ_NAME = /^[A-Za-z0-9_]{1,1024}$/;
const BQ_TABLE = /^[A-Za-z0-9_-]{1,1024}$/;
// tabledata.list: the fields, the page size and the next page. Nothing else (no startIndex, no views).
const BQ_DATA_KEYS = new Set(['selectedFields', 'maxResults', 'pageToken', 'formatOptions.useInt64Timestamp']);

function configureBilling(b) {
  if (b === null) {
    state.billing = emptyBilling();
    return;
  }
  const bq = b.bigQuery;
  if ('bigQuery' in b) state.billing.bigQuery = bq && BQ_PROJECT.test(bq.project || '') && BQ_NAME.test(bq.dataset || '') && BQ_TABLE.test(bq.table || '') ? { project: bq.project, dataset: bq.dataset, table: bq.table } : null;
  if ('cloudflareAccount' in b) state.billing.cloudflareAccount = /^[a-f0-9]{32}$/.test(b.cloudflareAccount || '') ? b.cloudflareAccount : null;
  if ('cloudflareZones' in b) state.billing.cloudflareZones = new Set((b.cloudflareZones || []).filter((z) => /^[a-f0-9]{32}$/.test(z)));
  const g = b.github;
  if ('github' in b) state.billing.github = g && ['org', 'user'].includes(g.kind) && /^[A-Za-z0-9-]{1,39}$/.test(g.owner || '') ? { kind: g.kind, owner: g.owner.toLowerCase() } : null;
  if ('openrouter' in b) state.billing.openrouter = b.openrouter === true;
  if ('fal' in b) state.billing.fal = b.fal === true;
}

/** Every query key of the URL is one of these (a URL with no query passes). */
const onlyKeys = (u, allowed) => [...u.searchParams.keys()].every((k) => allowed.includes(k));

/** The path exactly as written in the URL, before parsing resolves "%2e%2e" or "..". */
function rawPath(url) {
  return String(url).replace(/^https:\/\/[^/]+/i, '').split(/[?#]/)[0];
}

/** No percent-encoding, no "." or ".." segments, no empty segments. */
function cleanRaw(raw) {
  return !/%|\/\.{1,2}(\/|$)|\/\//.test(raw);
}

/** "$20260928": a day partition of a day-partitioned table, a real calendar date. */
function dayDecorator(s) {
  const m = /^\$(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

export function configureGuard({ projectId, kubernetesHost, sentryHost, uptimeUrls, graphQLQueries, sqlProjects, updateRepo, github, billing } = {}) {
  if (billing !== undefined) configureBilling(billing);
  if (projectId !== undefined) state.projectId = projectId;
  if (github?.owner && /^[A-Za-z0-9-]+$/.test(github.owner) && /^[A-Za-z0-9._-]+$/.test(github.manifestRepo || '') && /^[A-Za-z0-9._/-]+$/.test(github.manifestPath || '') && !github.manifestPath.includes('..')) {
    state.github = { owner: github.owner.toLowerCase(), manifest: `/repos/${github.owner}/${github.manifestRepo}/contents/${github.manifestPath}`.toLowerCase() };
  }
  if (updateRepo && /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(updateRepo)) state.updateRepo = updateRepo.toLowerCase();
  if (sqlProjects) for (const p of sqlProjects) if (new RegExp(`^${PROJECT}$`).test(p)) state.sqlProjects.add(p);
  if (kubernetesHost) state.kubernetesHosts.add(hostOnly(kubernetesHost));
  if (sentryHost) state.sentryHosts.add(hostOnly(sentryHost));
  if (uptimeUrls) state.uptimeUrls = new Set(uptimeUrls.map(normalizeUrl).filter(Boolean));
  if (graphQLQueries) for (const q of graphQLQueries) state.graphQLQueries.add(q);
}

export function resetGuard() {
  state.projectId = null;
  state.kubernetesHosts.clear();
  state.sentryHosts = new Set(DEFAULT_SENTRY_HOSTS);
  state.uptimeUrls.clear();
  state.sqlProjects.clear();
  state.denied = [];
}

export function deniedAttempts() {
  return [...state.denied];
}

function hostOnly(host) {
  return String(host).replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '').toLowerCase();
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Kubernetes object names (DNS-1123). */
export const K8S_NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;
const N = '[a-z0-9](?:[-a-z0-9.]{0,251}[a-z0-9])?';

// Every Kubernetes path Flobi Pulse reads. Nothing else is reachable.
const K8S_PATHS = [
  /^\/version$/,
  new RegExp(`^/api/v1/namespaces/${N}/(pods|services|events)$`),
  new RegExp(`^/api/v1/namespaces/${N}/pods/${N}/log$`),
  /^\/api\/v1\/(nodes|events)$/,
  new RegExp(`^/apis/apps/v1/namespaces/${N}/(deployments|statefulsets)$`),
  new RegExp(`^/apis/autoscaling/v2/namespaces/${N}/horizontalpodautoscalers$`),
  new RegExp(`^/apis/keda\\.sh/v1alpha1/namespaces/${N}/scaledobjects$`),
  new RegExp(`^/apis/batch/v1/namespaces/${N}/(jobs|cronjobs)$`),
  new RegExp(`^/apis/networking\\.k8s\\.io/v1/namespaces/${N}/ingresses$`),
  new RegExp(`^/apis/networking\\.gke\\.io/v1/namespaces/${N}/managedcertificates$`),
  new RegExp(`^/apis/policy/v1/namespaces/${N}/poddisruptionbudgets$`),
  new RegExp(`^/apis/metrics\\.k8s\\.io/v1beta1/namespaces/${N}/pods$`),
  /^\/apis\/metrics\.k8s\.io\/v1beta1\/nodes$/,
];
const K8S_QUERY_KEYS = new Set(['watch', 'allowWatchBookmarks', 'timeoutSeconds', 'resourceVersion', 'fieldSelector', 'container', 'follow', 'previous', 'tailLines', 'timestamps', 'sinceTime', 'limit', 'continue']);

// Headers the app is allowed to send. Anything else (method overrides etc.) is refused.
const HEADER_ALLOW = new Set(['authorization', 'content-type', 'accept', 'user-agent', 'content-length', 'cache-control', 'te', 'grpc-accept-encoding', 'x-goog-request-params', 'if-none-match']);

const PROJECT = '([a-z][a-z0-9-]{4,28}[a-z0-9])';

function sqlProjectOk(p) {
  return projectOk(p) || state.sqlProjects.has(p);
}

function projectOk(projectFromPath) {
  return !state.projectId || projectFromPath === state.projectId;
}

/**
 * The URL as messages and Settings show it: no credentials and no query values,
 * which could hold a secret (an uptime URL with ?key=…). Query names stay, since
 * they're often why a request was refused.
 */
export function displayUrl(url) {
  const s = String(url).replace(/#[\s\S]*$/, '');
  const q = s.indexOf('?');
  const base = (q < 0 ? s : s.slice(0, q)).replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1');
  if (q < 0) return base;
  const keys = [...new Set(s.slice(q + 1).split('&').map((p) => p.split('=')[0]).filter(Boolean))];
  return `${base}?${keys.map((k) => `${k}=…`).join('&')}`;
}

function deny(reason, method, url) {
  const shown = displayUrl(url);
  state.denied.push({ at: Date.now(), method, url: shown.slice(0, 300), reason });
  if (state.denied.length > 20) state.denied.shift();
  throw new ReadOnlyViolation(`Blocked by the read-only guard: ${reason} (${method} ${shown.slice(0, 160)})`, {
    method,
    url: shown,
    reason,
  });
}

/**
 * Throws ReadOnlyViolation unless the request is a known read.
 * @param {{method?: string, url: string, headers?: Record<string,string>, body?: string|Buffer|null}} req
 * @returns {true}
 */
export function checkRequest({ method = 'GET', url, headers = {}, body = null }) {
  method = String(method).toUpperCase();
  let u;
  try {
    u = new URL(url);
  } catch {
    return deny('invalid URL', method, url);
  }
  if (u.protocol !== 'https:') return deny('only HTTPS is allowed', method, url);
  if (u.username || u.password) return deny('credentials in URL are not allowed', method, url);
  if (u.hash) return deny('URL fragments are not allowed', method, url);

  for (const k of Object.keys(headers || {})) {
    if (!HEADER_ALLOW.has(k.toLowerCase())) return deny(`header "${k}" is not allowed`, method, url);
  }

  const host = u.hostname.toLowerCase();
  const path = u.pathname;

  // ── Service-account key → short-lived access token ─────────────────────────
  if (host === 'oauth2.googleapis.com') {
    if (method === 'POST' && path === '/token' && !u.search) return true;
    return deny('only token exchange is allowed on oauth2.googleapis.com', method, url);
  }

  // ── GKE control plane API (cluster discovery only) ─────────────────────────
  if (host === 'container.googleapis.com') {
    const m = path.match(new RegExp(`^/v1/projects/${PROJECT}/locations/[a-z0-9-]+/clusters/[a-z0-9-]+$`));
    if (method === 'GET' && m && projectOk(m[1]) && !u.search) return true;
    return deny('only reading cluster details is allowed on container.googleapis.com', method, url);
  }

  // ── Cloud Logging (read + live tail) ───────────────────────────────────────
  if (host === 'logging.googleapis.com') {
    if (method === 'POST' && path === '/v2/entries:list' && !u.search) return checkLoggingBody(body, method, url);
    // The tail's request is protobuf: the guard reads the project names out of its bytes.
    if (method === 'POST' && path === '/google.logging.v2.LoggingServiceV2/TailLogEntries' && !u.search) return checkTailBody(body, method, url);
    return deny('only listing and tailing log entries is allowed on logging.googleapis.com', method, url);
  }

  // ── Cloud Monitoring: never. Its API is billed per read, so it stays off the
  //    allowlist and every request to it is refused like any unknown host. ───

  // ── BigQuery: the Costs page's billing-export table, and nothing else ───────
  //    Two free reads of that ONE table: its metadata (tables.get) and its rows
  //    through BigQuery's free table preview (tabledata.list), optionally one
  //    day's partition ($YYYYMMDD). Never jobs or queries (billed per byte), never
  //    another table or dataset, never a write.
  if (host === 'bigquery.googleapis.com') {
    const t = state.billing.bigQuery;
    if (method !== 'GET') return deny('BigQuery is read-only here (GET of the billing table only, never a query or a job)', method, url);
    if (!t) return deny('no billing table is set in Settings → Costs', method, url);
    if (!cleanRaw(rawPath(url))) return deny('encoded or relative BigQuery paths are not allowed', method, url);
    const base = `/bigquery/v2/projects/${t.project}/datasets/${t.dataset}/tables/${t.table}`;
    if (path === base && !u.search) return true; // tables.get
    const rest = path.startsWith(base) ? path.slice(base.length) : null;
    const data = rest === '/data' || (rest !== null && rest.endsWith('/data') && dayDecorator(rest.slice(0, -'/data'.length)));
    if (data && [...u.searchParams.keys()].every((k) => BQ_DATA_KEYS.has(k))) return true; // tabledata.list
    return deny('only reading the billing table set in Settings → Costs is allowed on bigquery.googleapis.com (no queries or jobs)', method, url);
  }

  // ── Cloud SQL Admin (instance status + recent operations, free) ────────────
  if (host === 'sqladmin.googleapis.com') {
    if (method !== 'GET') return deny('Cloud SQL is read-only (GET only)', method, url);
    const inst = path.match(new RegExp(`^/v1/projects/${PROJECT}/instances$`));
    if (inst && sqlProjectOk(inst[1]) && !u.search) return true;
    const one = path.match(new RegExp(`^/v1/projects/${PROJECT}/instances/[a-z][a-z0-9-]{0,97}$`));
    if (one && sqlProjectOk(one[1]) && !u.search) return true;
    const ops = path.match(new RegExp(`^/v1/projects/${PROJECT}/operations$`));
    if (ops && sqlProjectOk(ops[1]) && [...u.searchParams.keys()].every((k) => k === 'instance' || k === 'maxResults')) return true;
    return deny('only reading Cloud SQL instances and operations is allowed on sqladmin.googleapis.com', method, url);
  }

  // ── Cloud Run (read service status) ────────────────────────────────────────
  if (host === 'run.googleapis.com') {
    const m = path.match(new RegExp(`^/v2/projects/${PROJECT}/locations/[a-z0-9-]+/services$`));
    // Paging through the list is the only query allowed.
    if (method === 'GET' && m && projectOk(m[1]) && [...u.searchParams.keys()].every((k) => k === 'pageToken' || k === 'pageSize')) return true;
    return deny('only reading services is allowed on run.googleapis.com', method, url);
  }

  // ── Kubernetes API server of the configured cluster ────────────────────────
  if (state.kubernetesHosts.has(host)) {
    if (method !== 'GET') return deny('the Kubernetes API is read-only (GET only)', method, url);
    if (/%|\/\.{1,2}(\/|$)|\/\//.test(u.href.slice(u.origin.length).split('?')[0])) return deny('encoded or relative Kubernetes paths are not allowed', method, url);
    if (!K8S_PATHS.some((re) => re.test(path))) return deny('this Kubernetes path is not on the read allowlist', method, url);
    for (const key of u.searchParams.keys()) if (!K8S_QUERY_KEYS.has(key)) return deny(`query parameter "${key}" is not allowed`, method, url);
    return true;
  }

  // ── Cloudflare (analytics + Pages status, and billing for the Costs page) ──
  if (host === 'api.cloudflare.com') {
    if (method === 'GET') {
      if (
        path === '/client/v4/user/tokens/verify' ||
        path === '/client/v4/zones' ||
        /^\/client\/v4\/accounts\/[a-f0-9]{32}\/pages\/projects$/.test(path)
      ) {
        return true;
      }
      // Costs: the plans of the set account and zones, and the account's usage-based charges.
      const b = state.billing;
      const acct = b.cloudflareAccount && `/client/v4/accounts/${b.cloudflareAccount}`;
      if (acct && path === `${acct}/subscriptions` && !u.search) return true;
      if (acct && path === `${acct}/billable-usage` && [...u.searchParams.keys()].every((k) => k === 'from' || k === 'to')) return true;
      const zone = path.match(/^\/client\/v4\/zones\/([a-f0-9]{32})\/subscription$/);
      if (zone && b.cloudflareZones.has(zone[1]) && !u.search) return true;
      return deny('unknown Cloudflare read endpoint', method, url);
    }
    if (method === 'POST' && path === '/client/v4/graphql' && !u.search) return checkGraphQLBody(body, method, url);
    return deny('only analytics reads are allowed on api.cloudflare.com', method, url);
  }

  // ── Sentry (issues + projects) ─────────────────────────────────────────────
  if (state.sentryHosts.has(host) || /^[a-z0-9-]+\.sentry\.io$/.test(host)) {
    if (method === 'GET' && /^\/api\/0\/organizations\/[A-Za-z0-9_-]+\/(issues|projects)?\/?$/.test(path)) return true;
    return deny('Sentry is read-only (organization, projects and issues only)', method, url);
  }

  // ── Uptime checks (exact configured URLs only) ─────────────────────────────
  if (state.uptimeUrls.has(u.toString())) {
    if ((method === 'GET' || method === 'HEAD') && !body) return true;
    return deny('uptime checks may only GET or HEAD', method, url);
  }

  // ── App updates: this app's own GitHub releases, read and download only ────
  if (host === 'api.github.com') {
    const p = path.toLowerCase();
    const raw = String(url).replace(/^https:\/\/[^/]+/i, '').split(/[?#]/)[0];
    const clean = !/%|\/\.{1,2}(\/|$)|\/\//.test(raw);
    if (method === 'GET' && clean && state.updateRepo && p === `/repos/${state.updateRepo}/releases/latest` && !u.search) return true;
    // Versions page: the release manifest, and the releases of the org's repos.
    if (method === 'GET' && clean && state.github) {
      if (p === state.github.manifest && !u.search) return true;
      const m = p.match(/^\/repos\/([a-z0-9-]+)\/([a-z0-9._-]+)\/releases$/);
      if (m && m[1] === state.github.owner && [...u.searchParams.keys()].every((k) => k === 'per_page' || k === 'page')) return true;
    }
    // Costs page: the billing usage summary of the set organization (or user) for a month,
    // and the organization itself (its plan: how many seats).
    const g = state.billing.github;
    if (method === 'GET' && clean && g) {
      const month = [...u.searchParams.keys()].every((k) => k === 'year' || k === 'month');
      const summary = g.kind === 'org' ? `/organizations/${g.owner}/settings/billing/usage/summary` : `/users/${g.owner}/settings/billing/usage/summary`;
      if (p === summary && month) return true;
      if (g.kind === 'org' && p === `/orgs/${g.owner}` && !u.search) return true;
    }
    return deny("only reading the app's own releases, the team's release notes and the billing summary set in Settings → Costs is allowed on api.github.com", method, url);
  }
  if (host === 'github.com') {
    // Checked on the path as written, before URL parsing resolves "%2e%2e" or "..".
    const raw = String(url).replace(/^https:\/\/[^/]+/i, '').split(/[?#]/)[0];
    const file = path.toLowerCase().startsWith(`/${state.updateRepo}/releases/download/`) && !/%|\/\.{1,2}(\/|$)|\/\//.test(raw);
    if (method === 'GET' && state.updateRepo && file && !u.search) return true;
    return deny("only downloading the app's own release files is allowed on github.com", method, url);
  }
  // GitHub answers a release download with a redirect to a signed link on its file storage.
  if (host === 'release-assets.githubusercontent.com' || host === 'objects.githubusercontent.com') {
    if (method === 'GET' && state.updateRepo && !body) return true;
    return deny('only downloading release files is allowed on GitHub file storage', method, url);
  }

  // ── OpenRouter (Costs page): the usage per day and the credits, GET only ──
  //    The management key can create and delete keys; here it only reads these two.
  if (host === 'openrouter.ai') {
    if (method !== 'GET' || !state.billing.openrouter) return deny('only reading usage and credits (with a key set in Settings → Costs) is allowed on openrouter.ai', method, url);
    if (!cleanRaw(rawPath(url))) return deny('encoded or relative OpenRouter paths are not allowed', method, url);
    if (path === '/api/v1/activity' && onlyKeys(u, ['date'])) return true;
    if (path === '/api/v1/credits' && !u.search) return true;
    return deny('only reading usage (activity) and credits is allowed on openrouter.ai', method, url);
  }

  // ── fal (Costs page): the usage per month and the credit balance, GET only ──
  //    The admin key can do more; here it only reads these two.
  if (host === 'api.fal.ai') {
    if (method !== 'GET' || !state.billing.fal) return deny('only reading usage and the balance (with a key set in Settings → Costs) is allowed on api.fal.ai', method, url);
    if (!cleanRaw(rawPath(url))) return deny('encoded or relative fal paths are not allowed', method, url);
    if (path === '/v1/models/usage' && onlyKeys(u, ['start', 'end', 'timeframe', 'expand', 'limit', 'cursor'])) return true;
    if (path === '/v1/account/billing' && onlyKeys(u, ['expand'])) return true;
    return deny('only reading usage and the credit balance is allowed on api.fal.ai', method, url);
  }

  // ── Is this computer online? (net/connectivity.mjs) ────────────────────────
  if (PROBE_URLS.has(u.toString())) {
    if (method === 'GET' && !body) return true;
    return deny('the connectivity check may only GET', method, url);
  }

  return deny('host is not on the allowlist', method, url);
}

function bodyText(body) {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  return JSON.stringify(body);
}

/** A filter that can only match Cloud SQL logs: starts with the type, ANDs only. */
function sqlOnlyFilter(f) {
  f = String(f || '');
  return f.startsWith('resource.type="cloudsql_database" AND ') && !/\bOR\b|\bNOT\b|[()]/.test(f.slice(38));
}

function checkLoggingBody(body, method, url) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText(body));
  } catch {
    return deny('entries:list body must be JSON', method, url);
  }
  const names = parsed.resourceNames || [];
  if (!names.length) return deny('entries:list must name the project', method, url);
  for (const n of names) {
    const m = String(n).match(/^projects\/([^/]+)$/);
    if (m && projectOk(m[1])) continue;
    // The database's own project: only its Postgres logs.
    if (m && state.sqlProjects.has(m[1]) && names.length === 1 && sqlOnlyFilter(parsed.filter)) continue;
    return deny('entries:list may only read the configured project', method, url);
  }
  return true;
}

/** A live tail may only read the configured project (never the database's, never another). */
/**
 * The resource names a TailLogEntriesRequest reads (field 1, repeated string), from the
 * protobuf bytes exactly as they'll be sent. Throws on anything that isn't well-formed.
 */
export function tailResourceNames(bytes) {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const names = [];
  let i = 0;
  const varint = () => {
    let x = 0;
    for (let shift = 0; ; shift += 7) {
      if (i >= b.length || shift > 49) throw new Error('bad varint');
      const byte = b[i++];
      x += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) return x;
    }
  };
  while (i < b.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (field === 0) throw new Error('bad field');
    if (wire === 0) varint();
    else if (wire === 1 || wire === 5) i += wire === 1 ? 8 : 4;
    else if (wire === 2) {
      const len = varint();
      if (i + len > b.length) throw new Error('truncated');
      if (field === 1) names.push(b.toString('utf8', i, i + len));
      i += len;
    } else throw new Error('bad wire type');
    if (i > b.length) throw new Error('truncated');
  }
  return names;
}

// The request's own bytes, not a description of them: what's checked is what's sent.
function checkTailBody(body, method, url) {
  if (!(body instanceof Uint8Array)) return deny('a live tail must be checked on the request it sends', method, url);
  let names;
  try {
    names = tailResourceNames(body);
  } catch {
    return deny('a live tail request must be a valid TailLogEntriesRequest', method, url);
  }
  if (!names.length) return deny('a live tail must name the project', method, url);
  for (const n of names) {
    const m = String(n).match(/^projects\/([^/]+)$/);
    if (!m || !state.projectId || m[1] !== state.projectId) return deny('a live tail may only read the configured project', method, url);
  }
  return true;
}

function checkGraphQLBody(body, method, url) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText(body));
  } catch {
    return deny('GraphQL body must be JSON', method, url);
  }
  // Only the exact analytics queries shipped with the app may be sent.
  if (!state.graphQLQueries.has(String(parsed.query || ''))) return deny('only the built-in analytics queries are allowed', method, url);
  if (parsed.operationName !== undefined && typeof parsed.operationName !== 'string') return deny('invalid GraphQL operation name', method, url);
  return true;
}
