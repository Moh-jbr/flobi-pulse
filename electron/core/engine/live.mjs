// Wires the real data sources (GKE, Cloud Logging, Cloud SQL Admin, Sentry,
// Cloudflare, uptime checks, Cloud Run) into the pipeline, and answers the UI's
// on-demand requests (pod log follow, history search, recap, charts).
// Everything used here is free to read. Cloud Monitoring (billed per read) is
// not used at all.
import { configureGuard } from '../net/guard.mjs';
import { resolveCluster, KubeClient, Informer, MetricsPoller, resourcePaths } from '../sources/kubernetes.mjs';
import { LoggingClient } from '../sources/logging.mjs';
import { CloudSqlClient, parseConnectionName } from '../sources/cloudsql.mjs';
import { SentryClient, explainSentryError } from '../sources/sentry.mjs';
import { CloudflareClient, summarizeEdge, isNoAccess } from '../sources/cloudflare.mjs';
import { UptimeMonitor } from '../sources/uptime.mjs';
import { listCloudRunServices } from '../sources/cloudrun.mjs';
import { lookupDomain } from '../sources/dns.mjs';
import { normalizeEntry, k8sLogLine } from './normalize.mjs';
import { slim } from './model.mjs';
import { buildRecap } from './recap.mjs';

const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();

/**
 * Cloud Logging filter for one workload's container logs: its pods by name (so pods
 * that have since been replaced still match) or a container named like it. Pods of a
 * Deployment are "<name>-<hash>-<hash>", of a StatefulSet "<name>-<n>".
 */
export function serviceFilter(name) {
  const n = String(name).replace(/[^a-z0-9.-]/gi, '');
  const re = n.replace(/\./g, '\\\\.');
  return `(resource.labels.container_name="${n}" OR resource.labels.pod_name=~"^${re}-([a-z0-9]{5,10}-[a-z0-9]{5}|[a-z0-9]{5}|[0-9]+)$")`;
}

function friendlyK8sError(e, endpoint) {
  if (e.status === 401) return 'The cluster turned the service account away (HTTP 401), although Google accepted the key. Check that it has the “Kubernetes Engine Viewer” role (SETUP.md, step 1).';
  if (e.status === 403) return "The service account can't read the cluster. It needs the “Kubernetes Engine Viewer” role (SETUP.md, step 1).";
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|timed out/i.test(e.message)) return `Can't reach the cluster at ${endpoint} (${e.message}). Check your internet connection.`;
  if (/certificate|self.signed|unable to verify/i.test(e.message)) return `The cluster's certificate didn't match the one in the team config. Ask your admin to refresh cluster.caCertificate (${e.message}).`;
  return e.message;
}

export class LiveConnector {
  constructor({ config, auth, dbAuth, pipeline, settings, lastSeenAt, knownErrors, restartSnapshot }) {
    this.config = config;
    this.auth = auth;
    // Optional second service account for a database in another Google Cloud project.
    this.dbAuth = dbAuth || null;
    this.pipeline = pipeline;
    this.settings = settings;
    this.lastSeenAt = lastSeenAt;
    this.knownErrors = knownErrors || {};
    this.restartSnapshot = restartSnapshot || null;
    this.ns = config.namespace;
    this.timers = [];
    this.stoppers = [];
    this.stopped = false;
    this.getToken = () => auth.getToken('read');
    this.getKubeToken = () => auth.getToken('platform');
  }

  every(ms, fn, { immediate = true } = {}) {
    const handle = { t: null };
    this.timers.push(handle);
    const run = async () => {
      if (this.stopped) return;
      try {
        await fn();
      } catch (e) {
        console.warn('[live] task failed:', e.message);
      }
      if (!this.stopped) handle.t = setTimeout(run, ms);
    };
    if (immediate) run();
    else handle.t = setTimeout(run, ms);
  }

  later(ms, fn) {
    const handle = { t: setTimeout(fn, ms) };
    this.timers.push(handle);
  }

  async start() {
    const { projectId } = this.config;
    configureGuard({ projectId });
    this.pipeline.setSession({ mode: 'live', identity: this.auth.identity, projectId, namespace: this.ns, cluster: { name: this.config.cluster.name, location: this.config.cluster.location } });
    this.logging = new LoggingClient({ projectId, getToken: this.getToken, invalidateToken: () => this.auth.invalidate?.() });
    this.cloudsql = new CloudSqlClient({ projectId, getToken: (project) => this.sqlAuth(project).getToken('platform') });
    if (this.dbAuth) {
      const db = this.dbAuth;
      this.dbLogging = new LoggingClient({ projectId: db.identity.projectId, getToken: () => db.getToken('read'), invalidateToken: () => db.invalidate?.() });
    }
    try {
      this.sentry = new SentryClient(this.config.sentry);
    } catch (e) {
      this.sentry = { configured: false, error: e.message };
    }
    this.cloudflare = new CloudflareClient(this.config.cloudflare);

    this.startKubernetes();
    this.startTail();
    this.every(2 * MIN, () => this.pollCloudSql());
    this.every(MIN, () => this.pollSqlLogs(), { immediate: false });
    this.startUptime();
    this.every(5 * MIN, () => this.pollCloudRun());
    // Until the first DNS answers are in, failed certificates wait instead of alerting.
    this.pipeline.setDnsInfo(new Map());
    this.later(15_000, () => this.checkCertificateDomains().catch(() => {}));
    this.later(35_000, () => this.checkCertificateDomains().catch(() => {}));
    this.every(60_000, () => this.checkCertificateDomains(), { immediate: false });
    if (this.sentry.configured) this.every(60_000, () => this.pollSentry());
    else this.pipeline.setSource('sentry', this.sentry.error ? 'error' : 'off', this.sentry.error || 'Add a Sentry token in Settings → Integrations');
    if (this.cloudflare.configured) this.every(60_000, () => this.pollCloudflare());
    else this.pipeline.setSource('cloudflare', 'off', 'Add a Cloudflare token in Settings → Integrations');

    if (this.lastSeenAt && Date.now() - this.lastSeenAt > 10 * MIN) {
      const until = Date.now();
      // Wait (briefly) for the pod list: comparing restart counts with the ones
      // saved on quit is how the recap knows what restarted while you were away.
      this.waitForPods(20_000)
        .then(() => (this.stopped ? null : this.recap({ since: this.lastSeenAt, until })))
        .then((r) => r && this.pipeline.setRecap({ ...r, auto: true }))
        .catch((e) => console.warn('[recap]', e.message));
    }
  }

  waitForPods(maxMs) {
    const t0 = Date.now();
    return new Promise((resolve) => {
      const check = () => {
        if (this.stopped || this.pipeline.synced.has('pods') || Date.now() - t0 > maxMs) resolve();
        else setTimeout(check, 500);
      };
      check();
    });
  }

  stop() {
    this.stopped = true;
    for (const h of this.timers) clearTimeout(h.t);
    for (const s of this.stoppers) {
      try {
        s();
      } catch {}
    }
    this.informers?.forEach((i) => i.stop());
    this.metrics?.stop();
    this.uptime?.stop();
    this.tail?.stop();
    this.fallbackStop?.();
  }

  // ── Kubernetes ────────────────────────────────────────────────────────────
  async startKubernetes() {
    const p = this.pipeline;
    p.setSource('kubernetes', 'connecting');
    let cluster;
    try {
      cluster = await resolveCluster({ config: this.config, auth: this.auth });
      if (this.stopped) return;
    } catch (e) {
      if (this.stopped) return;
      p.setSource('kubernetes', 'error', e.message);
      if (!this.stopped) this.later(60_000, () => this.startKubernetes());
      return;
    }
    p.setSession({ cluster: { name: cluster.name, location: cluster.location, endpoint: cluster.endpoint, version: cluster.version, source: cluster.source, caB64: cluster.source === 'gke-api' ? cluster.caB64 : undefined } });
    this.kube = new KubeClient({ endpoint: cluster.endpoint, caB64: cluster.caB64, getToken: this.getKubeToken });
    try {
      let v;
      try {
        v = await this.kube.version();
      } catch (e) {
        if (e.status !== 401) throw e;
        this.auth.invalidate?.(); // one retry with a fresh token
        v = await this.kube.version();
      }
      if (this.stopped) return;
      p.setSession({ cluster: { ...p.session.cluster, version: cluster.version || v?.gitVersion } });
    } catch (e) {
      if (this.stopped) return;
      p.setSource('kubernetes', 'error', friendlyK8sError(e, cluster.endpoint));
      if (!this.stopped) this.later(60_000, () => this.startKubernetes());
      return;
    }
    p.setSource('kubernetes', 'ok');
    const statuses = {};
    const onStatus = (key, st, msg) => {
      statuses[key] = { st, msg };
      const bad = Object.entries(statuses).filter(([, v]) => v.st === 'error' || v.st === 'forbidden');
      if (bad.length) p.setSource('kubernetes', 'degraded', `${bad.map(([k]) => k).join(', ')}: ${bad[0][1].msg}`);
      else p.setSource('kubernetes', 'ok');
    };
    this.informers = Object.entries(resourcePaths(this.ns)).map(([key, path]) =>
      new Informer(this.kube, key, path, { onChange: (k, items) => p.setK8s(k, items), onStatus, slim: (o) => slim(key, o) }).start(),
    );
    this.metrics = new MetricsPoller(this.kube, this.ns, {
      onMetrics: (m) => p.setMetrics(m),
      onStatus: (st, msg) => p.setSource('metrics', st, msg),
    }).start();
  }

  // ── Live tail (requests + logs) ───────────────────────────────────────────
  tailFilter() {
    const c = this.config.cluster.name;
    const info = this.settings?.general?.liveIncludesInfoLogs !== false;
    return [
      `(resource.type="k8s_container" AND resource.labels.namespace_name="${this.ns}" AND resource.labels.cluster_name="${c}"${info ? '' : ' AND severity>=WARNING'})`,
      'resource.type="http_load_balancer"',
      '(resource.type="cloudsql_database" AND (severity>=WARNING OR textPayload:"duration:"))',
      'resource.type="cloud_run_revision"',
    ].join(' OR ');
  }

  normalizeCtx() {
    const p = this.pipeline;
    return {
      namespace: this.ns,
      routeToService: (h, path) => p.router(h, path),
      podToService: (pod) => p.model.pods.find((x) => x.name === pod)?.service || null,
    };
  }

  startTail() {
    const p = this.pipeline;
    this.tail = this.logging.tail({
      filter: this.tailFilter(),
      onEntries: (entries) => {
        const ctx = this.normalizeCtx();
        p.ingest(entries.map((e) => normalizeEntry(e, ctx)));
      },
      onSuppressed: (s) => {
        const n = s.reduce((a, x) => a + x.count, 0);
        p.setSource('live', 'streaming', `Google skipped ${n.toLocaleString()} entries to stay under its rate limit`);
      },
      onState: (state, message) => {
        p.setSource('live', state, message || null);
        if (state === 'unavailable' || state === 'error') this.startFallback();
        if (state === 'streaming') this.stopFallback();
      },
    });
  }

  retryLive() {
    this.tail?.retryNow();
  }

  /** While the live tail is unavailable, still catch errors every 30 s. */
  startFallback() {
    if (this.fallbackStop) return;
    let last = Date.now() - 2 * MIN;
    let stopped = false;
    const run = async () => {
      if (stopped || this.stopped) return;
      try {
        const res = await this.logging.list({
          filter: `resource.type="k8s_container" AND resource.labels.namespace_name="${this.ns}" AND severity>=ERROR AND timestamp>"${iso(last)}"`,
          orderBy: 'timestamp asc',
          pageSize: 500,
        });
        const ctx = this.normalizeCtx();
        const items = (res?.entries || []).map((e) => normalizeEntry(e, ctx));
        if (items.length) last = Math.max(...items.map((i) => i.ts));
        this.pipeline.ingest(items);
      } catch (e) {
        console.warn('[fallback]', e.message);
      }
      if (!stopped) t = setTimeout(run, 30_000);
    };
    let t = setTimeout(run, 1000);
    this.fallbackStop = () => {
      stopped = true;
      clearTimeout(t);
      this.fallbackStop = null;
    };
  }

  stopFallback() {
    this.fallbackStop?.();
  }

  // ── Cloud SQL (status + recent operations; errors come from the live logs) ─
  /** Instances to check: the ones named in the team config / Settings, the ones
   *  the pods connect to (their Cloud SQL proxy settings) and the ones whose
   *  Postgres logs show up. */
  sqlTargets() {
    const ids = new Set([...(this.config.cloudsql?.instances || []), ...this.pipeline.sqlInstancesInUse().keys(), ...(this.pipeline.sqlSeenInLogs || [])]);
    return [...ids].map(parseConnectionName).filter(Boolean);
  }

  /** The account that reads Cloud SQL in `project`: the database key for any project but ours, when there is one. */
  sqlAuth(project) {
    return this.dbAuth && project !== this.config.projectId ? this.dbAuth : this.auth;
  }

  /** Who to name in a "can't read" message about `project`. */
  sqlWho(project) {
    return this.sqlAuth(project) === this.dbAuth ? `the database key (${this.dbAuth.identity.email})` : 'the service account';
  }

  /** The database key's project, when it's a different one from ours. */
  get dbProject() {
    const p = this.dbAuth?.identity?.projectId;
    return p && p !== this.config.projectId ? p : null;
  }

  async pollCloudSql() {
    const p = this.pipeline;
    const primary = this.config.projectId;
    // The first time, give the pod list a moment: it tells which instance the apps use.
    if (!this._sqlStarted) {
      this._sqlStarted = true;
      await this.waitForPods(20_000);
      if (this.stopped) return;
    }
    const now = Date.now();
    const targets = this.sqlTargets();
    const dbProject = this.dbProject;
    const others = [...new Set([...targets.map((t) => t.project), dbProject].filter((x) => x && x !== primary))];
    if (others.length) configureGuard({ sqlProjects: others });

    let instances = [];
    let listError = null;
    try {
      instances = await this.cloudsql.instances(primary);
    } catch (e) {
      listError = e;
    }
    // With a database key, its project is searched too, so no connection name is needed.
    let dbListError = null;
    if (dbProject) {
      try {
        instances.push(...(await this.cloudsql.instances(dbProject)));
      } catch (e) {
        dbListError = e;
      }
    }
    const have = new Set(instances.map((i) => i.id));
    const problems = [];
    for (const t of targets) {
      if (have.has(t.id)) continue;
      try {
        const inst = await this.cloudsql.instance(t.project, t.name);
        instances.push(inst);
        have.add(inst.id);
      } catch (e) {
        problems.push({ id: t.id, project: t.project, kind: e.status === 403 ? 'forbidden' : e.status === 404 ? 'missing' : 'error', message: e.message });
      }
    }

    const isDisabled = (e) => e && /SERVICE_DISABLED|has not been used in project|is disabled/i.test(`${e.message} ${e.body || ''}`);
    const disabled = isDisabled(listError);
    const dbProblem = !dbListError
      ? null
      : isDisabled(dbListError)
        ? { status: 'error', message: `The Cloud SQL Admin API is turned off in project ${dbProject}, the database key's project (turning it on is free, see SETUP.md).` }
        : dbListError.status === 403
          ? { status: 'forbidden', message: `The database key (${this.dbAuth.identity.email}) can't read Cloud SQL in its project ${dbProject}: it needs the "Cloud SQL Viewer" role there, and "Logs Viewer" for the Postgres errors.` }
          : { status: 'error', message: `Couldn't read Cloud SQL in project ${dbProject}: ${dbListError.message}` };
    let status;
    let message = null;
    if (instances.length) {
      status = 'ok';
      const bad = problems.find((x) => x.kind === 'forbidden');
      if (bad) message = `Also found ${bad.id}, but ${this.sqlWho(bad.project)} can't read it (it needs the "Cloud SQL Viewer" role in project ${bad.project}).`;
      else if (dbProblem) message = dbProblem.message;
    } else if (dbProblem) {
      ({ status, message } = dbProblem);
    } else if (disabled) {
      status = 'error';
      message = 'The Cloud SQL Admin API is turned off in this project (turning it on is free, see SETUP.md). Database errors from the logs still show.';
    } else if (problems.some((x) => x.kind === 'forbidden' && x.project !== primary)) {
      const bad = problems.find((x) => x.kind === 'forbidden' && x.project !== primary);
      status = 'forbidden';
      message = this.dbAuth
        ? `Your database is ${bad.id}, in the Google Cloud project "${bad.project}". The database key (${this.dbAuth.identity.email}) can't read it: it needs the "Cloud SQL Viewer" role in ${bad.project}, and "Logs Viewer" for the Postgres errors.`
        : `Your database is ${bad.id}, in the Google Cloud project "${bad.project}" (not ${primary}). The service account can't read that project yet: it needs the "Cloud SQL Viewer" role there, and "Logs Viewer" for the Postgres errors. Or add a key from that project in Settings → Database. SETUP.md → "Database in another project".`;
    } else if ((listError && listError.status === 403) || problems.some((x) => x.kind === 'forbidden')) {
      status = 'forbidden';
      message = 'The service account needs the "Cloud SQL Viewer" role (SETUP.md, step 1). Database errors from the logs still show.';
    } else if (listError) {
      status = 'error';
      message = listError.message;
    } else if (problems.some((x) => x.kind === 'missing')) {
      const miss = problems.find((x) => x.kind === 'missing');
      status = 'none';
      message = `The apps are set up to use ${miss.id}, but Google says there is no such instance. Check the connection name in Settings → Database.`;
    } else if (dbProject) {
      status = 'none';
      message = `Google Cloud says neither ${primary} nor ${dbProject} (the database key's project) has a Cloud SQL instance, and no pod names one in its settings. If the database is in a third project, add its connection name (Cloud SQL → your instance → "Connection name") below.`;
    } else {
      status = 'none';
      message = `Google Cloud says project ${primary} has no Cloud SQL instances, and no pod names one in its settings. If your database is in another project, add its connection name (Cloud SQL → your instance → "Connection name") below, or a key from that project.`;
    }

    const patch = { instances, status, message, project: dbProject ? `${primary} or ${dbProject}` : primary, problems, at: now };
    if (instances.length && (!this._opsAt || now - this._opsAt > 5 * MIN)) {
      const lists = await Promise.all(
        instances
          .filter((i) => !i.replicaOf)
          .slice(0, 4)
          .map((i) => this.cloudsql.operations(i.name, 25, i.id.split(':')[0]).catch(() => [])),
      );
      patch.operations = lists.flat().sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)).slice(0, 40);
      this._opsAt = now;
    }
    p.setDatabase(patch);
    p.setSource('cloudsql', status === 'ok' || status === 'none' ? 'ok' : status, status === 'ok' || status === 'none' ? null : message);
  }

  /** Postgres logs of a database in another project (the live tail only covers ours). */
  async pollSqlLogs() {
    const primary = this.config.projectId;
    const projects = [...new Set((this.pipeline.database.instances || []).map((i) => String(i.id).split(':')[0]).filter((x) => x && x !== primary))];
    for (const project of projects) {
      this._sqlLogSince ||= {};
      const since = this._sqlLogSince[project] || Date.now() - 10 * MIN;
      const after = `timestamp>"${new Date(since).toISOString()}"`;
      const logging = this.sqlAuth(project) === this.dbAuth ? this.dbLogging : this.logging;
      try {
        const warn = await logging.listAll({ project, filter: `resource.type="cloudsql_database" AND severity>=WARNING AND ${after}`, orderBy: 'timestamp asc', max: 500, pageSize: 500 });
        const slow = await logging.listAll({ project, filter: `resource.type="cloudsql_database" AND textPayload:"duration:" AND ${after}`, orderBy: 'timestamp asc', max: 200, pageSize: 200 });
        const entries = [...warn, ...slow];
        this._sqlLogSince[project] = Math.max(since, ...entries.map((e) => Date.parse(e.timestamp) || 0));
        if (entries.length) {
          const ctx = this.normalizeCtx();
          this.pipeline.ingest(entries.map((e) => normalizeEntry(e, ctx)).filter(Boolean));
        }
        if (this.pipeline.database.logsNote) this.pipeline.setDatabase({ logsNote: null });
      } catch (e) {
        this.pipeline.setDatabase({ logsNote: e.status === 403 ? `The Postgres errors are in project ${project}: ${this.sqlWho(project)} needs the "Logs Viewer" role there to show them.` : `Couldn't read the Postgres logs in ${project}: ${e.message}` });
      }
    }
  }

  async pollCloudRun() {
    try {
      const list = await listCloudRunServices({ projectId: this.config.projectId, location: this.config.cluster.location || 'europe-west1', getToken: this.getToken });
      this.pipeline.setCloudRun(list);
      this.pipeline.setSource('cloudrun', 'ok');
    } catch (e) {
      this.pipeline.setSource('cloudrun', e.status === 403 ? 'forbidden' : 'error', e.message);
    }
  }

  // ── DNS for certificates Google couldn't issue ─────────────────────────────
  async checkCertificateDomains() {
    if (this.stopped) return;
    const failed = new Set();
    for (const c of this.pipeline.model.certificates || []) {
      if (c.status === 'Active') continue;
      for (const d of c.domains || []) if (d.status !== 'Active') failed.add(String(d.domain).toLowerCase());
    }
    if (!failed.size) return;
    this.dnsCache ||= new Map(); // domain → { info, at }
    const now = Date.now();
    let changed = false;
    for (const d of failed) {
      const hit = this.dnsCache.get(d);
      if (hit && now - hit.at < 30 * MIN) continue;
      // null = the resolver had trouble: fall back to the uptime checks, ask again in 5 min.
      const info = (await lookupDomain(d)) || { none: false, cloudflare: false, unknown: true };
      this.dnsCache.set(d, { info, at: info.unknown ? now - 25 * MIN : now });
      changed = true;
    }
    if (changed) this.pipeline.setDnsInfo(new Map([...this.dnsCache].map(([d, v]) => [d, v.info])));
  }

  // ── Sentry ───────────────────────────────────────────────────────────────
  async pollSentry() {
    const p = this.pipeline;
    try {
      if (!this._sentryProjectsAt || Date.now() - this._sentryProjectsAt > 10 * MIN) {
        const [org, projects] = await Promise.all([this.sentry.verify(), this.sentry.projects()]);
        this._sentryProjectsAt = Date.now();
        p.setSentry({ projects, org });
      }
      const issues = await this.sentry.issues();
      p.setSentry({ issues, status: 'ok', message: null });
      p.setSource('sentry', 'ok');
    } catch (e) {
      const msg = explainSentryError(e, this.config.sentry?.org);
      p.setSentry({ status: 'error', message: msg });
      p.setSource('sentry', 'error', msg);
    }
  }

  // ── Cloudflare ───────────────────────────────────────────────────────────
  async pollCloudflare() {
    const p = this.pipeline;
    const now = Date.now();
    try {
      if (!this.cfZones || now - this._cfZonesAt > 30 * MIN) {
        this.cfZones = await this.cloudflare.zones();
        this._cfZonesAt = now;
      }
      const ids = this.cfZones.map((z) => z.id);
      const patch = { status: 'ok', message: null, at: now };
      const notes = [];
      if (ids.length) {
        let traffic = null;
        try {
          traffic = await this.cloudflare.traffic(ids, now);
        } catch (e) {
          notes.push(isNoAccess(e) ? `Cloudflare won’t share analytics for ${this.cfZones.map((z) => z.name).join(', ')} with this token. Check it has Zone → Analytics → Read and that the zone is included under Zone Resources.` : e.message);
        }
        patch.zones = this.cfZones.map((z) => ({ ...z, ...summarizeEdge(traffic?.zones.get(z.id), z.name) }));
        const hosts = !traffic
          ? []
          : await this.cloudflare
              .errorsByHost(this.cfZones, now - 15 * MIN, now, traffic)
              .then((r) => ((patch.perHost = r.perHost), r.zones))
              .catch((e) => (notes.push(e.message), []));
        const hostMap = new Map();
        for (const z of hosts) {
          for (const g of z.httpRequestsAdaptiveGroups || []) {
            const h = g.dimensions.clientRequestHTTPHost;
            const row = hostMap.get(h) || { host: h, s5xx: 0, s52x: 0, codes: {} };
            row.s5xx += g.count;
            row.codes[g.dimensions.edgeResponseStatus] = (row.codes[g.dimensions.edgeResponseStatus] || 0) + g.count;
            if (g.dimensions.edgeResponseStatus >= 520 && g.dimensions.edgeResponseStatus <= 527) row.s52x += g.count;
            hostMap.set(h, row);
          }
        }
        patch.hostErrors = [...hostMap.values()].sort((a, b) => b.s5xx - a.s5xx);
      } else {
        notes.push('No matching zones found for this token.');
      }
      if (this.config.cloudflare.accountId && (!this._pagesAt || now - this._pagesAt > 5 * MIN)) {
        patch.pages = await this.cloudflare.pagesProjects().catch((e) => (notes.push(`Pages: ${e.message}`), this.pipeline.cloudflare.pages));
        this._pagesAt = now;
      }
      if (notes.length) {
        patch.status = 'degraded';
        patch.message = notes.join(' · ');
      }
      p.setCloudflare(patch);
      p.setSource('cloudflare', patch.status, patch.message);
    } catch (e) {
      p.setCloudflare({ status: 'error', message: e.message });
      p.setSource('cloudflare', 'error', e.message);
    }
  }

  // ── Uptime ───────────────────────────────────────────────────────────────
  startUptime() {
    const targets = this.config.uptime || [];
    this.pipeline.setUptimeTargets(targets);
    this.uptime = new UptimeMonitor({ targets, onResult: (t, r) => this.pipeline.setUptime(t, r) }).start();
    this.pipeline.setSource('uptime', 'ok');
  }

  // ── On-demand ────────────────────────────────────────────────────────────
  followLogs({ pod, container, service }, onLines, onStatus) {
    if (!this.kube) throw new Error('Not connected to the cluster yet.');
    let buffer = [];
    const flush = setInterval(() => {
      if (buffer.length) {
        onLines(buffer);
        buffer = [];
      }
    }, 200);
    const handle = this.kube.followLogs({
      namespace: this.ns,
      pod,
      container,
      tailLines: 300,
      onLine: (text, ts) => buffer.push(k8sLogLine({ text, ts, pod, container, service })),
      onStatus: (st, msg) =>
        onStatus?.(
          st,
          st === 'forbidden'
            ? 'This key isn’t allowed to read pod logs (the Kubernetes Engine Viewer role doesn’t include it).'
            : st === 'error'
              ? friendlyK8sError({ message: msg, status: Number(String(msg).match(/HTTP (\d{3})/)?.[1]) || undefined }, this.kube.endpoint)
              : msg,
        ),
    });
    return () => {
      clearInterval(flush);
      handle.stop();
    };
  }

  async previousLogs({ pod, container, service }) {
    if (!this.kube) throw new Error('Not connected to the cluster yet.');
    let text;
    try {
      text = await this.kube.previousLogs({ namespace: this.ns, pod, container });
    } catch (e) {
      if (e.status === 400) return []; // no previous container
      if (e.status !== 403) throw e;
      // This key may not read pod logs: Cloud Logging has the same lines, a few
      // seconds later. Take the 10 minutes before the last crash.
      const lt = this.pipeline.model.pods.find((p) => p.name === pod)?.lastTermination;
      const until = (lt?.at || Date.now()) + 5_000;
      return this.queryLogs({ pod, from: until - 10 * MIN, until, limit: 400 });
    }
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) (.*)$/);
        return k8sLogLine({ text: m ? m[2] : line, ts: m ? Date.parse(m[1]) : Date.now(), pod, container, service });
      });
  }

  /** History search in Cloud Logging. */
  async queryLogs({ service, pod, level, text, from, until, limit = 500 }) {
    const parts = [`resource.type="k8s_container"`, `resource.labels.namespace_name="${this.ns}"`];
    if (service) parts.push(serviceFilter(service));
    if (pod) parts.push(`resource.labels.pod_name="${pod.replace(/"/g, '')}"`);
    if (level === 'ERROR') parts.push('severity>=ERROR');
    if (level === 'WARN') parts.push('severity>=WARNING');
    if (text) parts.push(`SEARCH("${String(text).replace(/["\\]/g, ' ')}")`);
    if (from) parts.push(`timestamp>="${iso(from)}"`);
    if (until) parts.push(`timestamp<"${iso(until)}"`);
    // Someone is looking at a spinner: this goes before background reads.
    const entries = await this.logging.listAll({ filter: parts.join(' AND '), orderBy: 'timestamp desc', max: Math.min(limit, 2000), priority: 'interactive' });
    const ctx = this.normalizeCtx();
    return entries.map((e) => normalizeEntry(e, ctx)).filter((x) => x.kind === 'log').reverse();
  }

  /**
   * The backend's log lines for one load-balancer request: exact when the request
   * carries a trace ID the service also logged, otherwise the service's lines from
   * the few seconds around it. `service` is the Kubernetes Service the load balancer
   * named; its pods (and logs) go by the workload's name.
   */
  async requestLogs({ service, ts, trace }) {
    const workload = this.pipeline.svcToWorkload?.get(service) || service;
    const ctx = this.normalizeCtx();
    const read = (filter, max) => this.logging.listAll({ filter, orderBy: 'timestamp asc', max, pageSize: max, priority: 'interactive' });
    const base = [`resource.type="k8s_container"`, `resource.labels.namespace_name="${this.ns}"`];
    if (trace && /^projects\/[a-z0-9-]+\/traces\/[a-f0-9]{16,32}$/i.test(trace)) {
      const lines = (await read([...base, `trace="${trace}"`, `timestamp>="${iso(ts - 10 * MIN)}"`, `timestamp<="${iso(ts + 10 * MIN)}"`].join(' AND '), 200)).map((e) => normalizeEntry(e, ctx)).filter((x) => x.kind === 'log');
      if (lines.length) return { match: 'trace', workload, lines };
    }
    if (!workload) return { match: 'none', workload, lines: [] };
    const lines = (await read([...base, serviceFilter(workload), `timestamp>="${iso(ts - 5_000)}"`, `timestamp<="${iso(ts + 5_000)}"`].join(' AND '), 300)).map((e) => normalizeEntry(e, ctx)).filter((x) => x.kind === 'log');
    return { match: 'time', workload, lines };
  }

  async recap({ since, until }) {
    return buildRecap({
      since,
      until,
      namespace: this.ns,
      projectId: this.config.projectId,
      logging: this.logging,
      cloudsql: this.cloudsql,
      sqlInstances: this.pipeline.database?.instances || [],
      sqlLogProjects: [...new Set((this.pipeline.database?.instances || []).map((i) => String(i.id).split(':')[0]).filter((x) => x && x !== this.config.projectId))].map((project) => ({
        project,
        logging: this.sqlAuth(project) === this.dbAuth ? this.dbLogging : this.logging,
      })),
      pods: this.pipeline.synced.has('pods') ? this.pipeline.model.pods : null,
      restartSnapshot: this.restartSnapshot,
      sentry: this.sentry,
      cloudflare: this.cloudflare,
      zones: this.cfZones || (this.cloudflare.configured ? await this.cloudflare.zones().then((z) => ((this.cfZones = z), (this._cfZonesAt = Date.now()), z)).catch(() => []) : []),
      knownErrors: this.knownErrors,
    });
  }

  /** CPU / memory per pod, collected from metrics-server while the app is open. */
  async usage({ service, range = 60 * MIN }) {
    return this.pipeline.usage({ service, range });
  }
}
