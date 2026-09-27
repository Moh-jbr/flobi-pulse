// Cloud SQL Admin API (read-only, free): instance status and recent operations
// (backups, maintenance, restarts, failovers, setting changes). Needs the
// "Cloud SQL Viewer" role. CPU / memory / connection graphs would need Cloud
// Monitoring, which is billed per read, so the app doesn't show them.
import { json } from '../net/http.mjs';

const BASE = 'https://sqladmin.googleapis.com/v1/projects';

const STATE_TEXT = {
  RUNNABLE: 'Running',
  SUSPENDED: 'Suspended (often a billing problem)',
  PENDING_DELETE: 'Being deleted',
  PENDING_CREATE: 'Being created',
  MAINTENANCE: 'Under maintenance',
  FAILED: 'Failed',
  ONLINE_MAINTENANCE: 'Under maintenance',
  REPAIRING: 'Being repaired',
};

export const OPERATION_TEXT = {
  BACKUP_VOLUME: 'Backup',
  BACKUP: 'Backup',
  SNAPSHOT: 'Snapshot',
  MAINTENANCE: 'Maintenance',
  RESTART: 'Restart',
  FAILOVER: 'Failover',
  SWITCHOVER: 'Switchover',
  UPDATE: 'Settings changed',
  START_REPLICA: 'Replica started',
  STOP_REPLICA: 'Replica stopped',
  PROMOTE_REPLICA: 'Replica promoted',
  CREATE_REPLICA: 'Replica created',
  RECREATE_REPLICA: 'Replica recreated',
  RESTORE_VOLUME: 'Restore from backup',
  IMPORT: 'Import',
  EXPORT: 'Export',
  CLONE: 'Clone',
  CREATE_DATABASE: 'Database created',
  DELETE_DATABASE: 'Database deleted',
  UPDATE_DATABASE: 'Database changed',
  CREATE_USER: 'User created',
  DELETE_USER: 'User deleted',
  UPDATE_USER: 'User changed',
  DELETE_BACKUP: 'Backup deleted',
  TRUNCATE_LOG: 'Log truncated',
  CREATE: 'Instance created',
  DELETE: 'Instance deleted',
};

/** Operations that interrupt connections or change the database's setup. */
export const DISRUPTIVE_OPERATIONS = new Set(['MAINTENANCE', 'RESTART', 'FAILOVER', 'SWITCHOVER', 'UPDATE', 'RESTORE_VOLUME', 'PROMOTE_REPLICA', 'DELETE_DATABASE']);

function versionText(v = '') {
  const m = String(v).match(/^(POSTGRES|MYSQL|SQLSERVER)_(.*)$/);
  if (!m) return v || null;
  const name = { POSTGRES: 'PostgreSQL', MYSQL: 'MySQL', SQLSERVER: 'SQL Server' }[m[1]];
  return `${name} ${m[2].replace(/_/g, '.')}`;
}

const DAYS = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function summarizeInstance(i, projectId) {
  const stopped = i.settings?.activationPolicy === 'NEVER';
  const state = i.state || 'SQL_INSTANCE_STATE_UNSPECIFIED';
  const down = stopped || state === 'FAILED' || state === 'SUSPENDED';
  const mw = i.settings?.maintenanceWindow;
  return {
    id: i.connectionName || `${projectId}:${i.region}:${i.name}`,
    name: i.name,
    region: i.region || null,
    version: versionText(i.databaseVersion),
    tier: i.settings?.tier || null,
    edition: i.settings?.edition || null,
    state,
    stateText: stopped ? 'Stopped (activation policy is "never")' : STATE_TEXT[state] || state,
    status: down ? 'down' : state === 'MAINTENANCE' || state === 'ONLINE_MAINTENANCE' ? 'maintenance' : state === 'RUNNABLE' ? 'up' : 'other',
    down,
    highAvailability: i.settings?.availabilityType === 'REGIONAL',
    diskGb: i.settings?.dataDiskSizeGb ? Number(i.settings.dataDiskSizeGb) : null,
    diskAutoResize: i.settings?.storageAutoResize !== false,
    maintenanceWindow: mw && mw.day ? `${DAYS[mw.day] || 'Any day'} ${String(mw.hour ?? 0).padStart(2, '0')}:00 UTC` : 'Any time',
    scheduledMaintenance: i.scheduledMaintenance?.startTime ? Date.parse(i.scheduledMaintenance.startTime) : null,
    backupsEnabled: !!i.settings?.backupConfiguration?.enabled,
    pitr: !!i.settings?.backupConfiguration?.pointInTimeRecoveryEnabled,
    replicaOf: i.masterInstanceName ? i.masterInstanceName.split(':').pop() : null,
    createdAt: i.createTime ? Date.parse(i.createTime) : null,
  };
}

export function summarizeOperation(o) {
  const t = (s) => (s ? Date.parse(s) : null);
  return {
    id: o.name,
    type: o.operationType,
    label: OPERATION_TEXT[o.operationType] || String(o.operationType || 'Operation').toLowerCase().replace(/_/g, ' '),
    status: o.status, // PENDING | RUNNING | DONE
    failed: !!o.error?.errors?.length,
    error: o.error?.errors?.[0]?.message || o.error?.errors?.[0]?.code || null,
    instance: o.targetId || null,
    by: o.user || null,
    queuedAt: t(o.insertTime),
    startedAt: t(o.startTime) || t(o.insertTime),
    endedAt: t(o.endTime),
    disruptive: DISRUPTIVE_OPERATIONS.has(o.operationType),
  };
}

/** "project:region:instance" → parts, or null. */
export function parseConnectionName(id) {
  const m = /^([a-z][a-z0-9-]{4,28}[a-z0-9]):([a-z]+-[a-z]+[0-9]+):([a-z][a-z0-9-]{0,96}[a-z0-9])$/.exec(String(id || '').trim().toLowerCase());
  return m ? { project: m[1], region: m[2], name: m[3], id: `${m[1]}:${m[2]}:${m[3]}` } : null;
}

export class CloudSqlClient {
  /**
   * @param {{projectId: string, getToken: (project: string) => Promise<string>}} o
   * getToken gets the project being read, so a database in another project can
   * use that project's own service account.
   */
  constructor({ projectId, getToken }) {
    this.projectId = projectId;
    this.getToken = getToken;
  }

  async _get(url, project) {
    return json({ url, headers: { authorization: `Bearer ${await this.getToken(project)}` }, timeoutMs: 30_000 });
  }

  /** Every instance in a project (the app's own project by default). */
  async instances(project = this.projectId) {
    const res = await this._get(`${BASE}/${project}/instances`, project);
    return (res?.items || []).map((i) => summarizeInstance(i, project));
  }

  /** One instance, e.g. one that lives in another project. */
  async instance(project, name) {
    if (!/^[a-z][a-z0-9-]{0,97}$/.test(name)) throw new Error(`Invalid Cloud SQL instance name: ${name}`);
    return summarizeInstance(await this._get(`${BASE}/${project}/instances/${name}`, project), project);
  }

  /** Most recent operations for one instance, newest first. */
  async operations(instance, max = 25, project = this.projectId) {
    if (!/^[a-z][a-z0-9-]{0,97}$/.test(instance)) throw new Error(`Invalid Cloud SQL instance name: ${instance}`);
    const q = new URLSearchParams({ instance, maxResults: String(Math.min(100, max)) });
    const res = await this._get(`${BASE}/${project}/operations?${q}`, project);
    return (res?.items || []).map(summarizeOperation);
  }
}
