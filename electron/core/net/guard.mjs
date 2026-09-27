// ─────────────────────────────────────────────────────────────────────────────
//  Read-only guard
//
//  Every outgoing request in Flobi Pulse passes through checkRequest() before a
//  single byte leaves the machine. Anything that is not on this allowlist throws
//  ReadOnlyViolation. The list only contains read endpoints (plus Google's token
//  endpoint, which turns the service-account key into a short-lived access
//  token), so even a bug elsewhere in the app cannot create, change or delete
//  anything in the cluster, GCP, Sentry or Cloudflare. Paid APIs (Cloud
//  Monitoring) are left off on purpose, so the app can't add to the bill.
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
  denied: [], // last few denied attempts, surfaced in Settings → Data sources
};

export function configureGuard({ projectId, kubernetesHost, sentryHost, uptimeUrls, graphQLQueries, sqlProjects, updateRepo, github } = {}) {
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

function deny(reason, method, url) {
  state.denied.push({ at: Date.now(), method, url: String(url).slice(0, 300), reason });
  if (state.denied.length > 20) state.denied.shift();
  throw new ReadOnlyViolation(`Blocked by the read-only guard: ${reason} (${method} ${String(url).slice(0, 160)})`, {
    method,
    url,
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
    if (method === 'POST' && path === '/google.logging.v2.LoggingServiceV2/TailLogEntries' && !u.search) return true;
    return deny('only listing and tailing log entries is allowed on logging.googleapis.com', method, url);
  }

  // ── Cloud Monitoring: never. Its API is billed per read, so it stays off the
  //    allowlist and every request to it is refused like any unknown host. ───

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
    if (method === 'GET' && m && projectOk(m[1]) && !u.search) return true;
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

  // ── Cloudflare (analytics + Pages status) ──────────────────────────────────
  if (host === 'api.cloudflare.com') {
    if (method === 'GET') {
      if (
        path === '/client/v4/user/tokens/verify' ||
        path === '/client/v4/zones' ||
        /^\/client\/v4\/accounts\/[a-f0-9]{32}\/pages\/projects$/.test(path)
      ) {
        return true;
      }
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
    return deny("only reading the app's own releases and the team's release notes is allowed on api.github.com", method, url);
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
