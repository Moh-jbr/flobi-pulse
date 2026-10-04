import { useState } from 'react';
import { useStore } from '../lib/store.js';
import { ViewScroll } from '../components/Toolbar.jsx';
import { Card, SectionTitle, Empty, Pill, KeyValue, cx, useNow, Segmented, InfoTip } from '../components/ui.jsx';
import Icon from '../components/icons.jsx';
import CloudSqlForm, { DatabaseKey } from '../components/CloudSqlForm.jsx';
import { num, ago, dayTime, duration } from '../lib/format.js';
import ExportButton from '../components/ExportButton.jsx';

const OPERATION_COLUMNS = [
  { label: 'Started', get: (o) => (o.startedAt ? new Date(o.startedAt) : '') },
  { label: 'Operation', get: (o) => o.label },
  { label: 'Type', get: (o) => o.type },
  { label: 'Status', get: (o) => (o.failed ? 'Failed' : o.status === 'DONE' ? 'Done' : 'Running') },
  { label: 'Took (min)', get: (o) => (o.endedAt && o.startedAt ? Math.round((o.endedAt - o.startedAt) / 6000) / 10 : '') },
  { label: 'Can interrupt connections', get: (o) => (o.disruptive ? 'yes' : '') },
  { label: 'By', get: (o) => o.by || '' },
  { label: 'Instance', get: (o) => o.instance || '' },
  { label: 'Error', get: (o) => o.error || '' },
];
const CONN_ERROR_COLUMNS = [
  { label: 'When', get: (x) => new Date(x.ts) },
  { label: 'Service', get: (x) => x.service },
  { label: 'Log line', get: (x) => x.text },
];
const PG_LOG_COLUMNS = [
  { label: 'When', get: (e) => new Date(e.ts) },
  { label: 'Level', get: (e) => (e.slow ? 'Slow' : e.level) },
  { label: 'Duration (ms)', get: (e) => (e.slow ? e.durationMs : '') },
  { label: 'Message', get: (e) => e.text },
];

// What each box means, in plain words (the (i) next to it). Keep these in step
// with how the numbers are worked out in pipeline.databaseView() and alerts.mjs.
const INFO = {
  status: {
    title: 'Status',
    body: 'What Google Cloud reports about the database server itself: running, under maintenance, stopped or failed. Checked every 2 minutes.',
    note: '“High availability” means a standby copy in a second zone takes over if the main one fails. “Single zone” has no standby.',
  },
  reach: {
    title: 'Apps → database',
    body: "Whether your services can actually reach the database, judged from their own logs: refused connections, timeouts, “connection terminated”.",
    note: 'Connected: none of those errors. Hiccups: some in the last 15 minutes, which is normal during maintenance or a restart. Failing: many in the last 2 minutes, and a critical alert goes out.',
  },
  errors: {
    title: 'Postgres errors',
    body: 'Errors the database logged in the last hour, like a query breaking a unique rule (duplicate key), a missing table or a canceled statement. Warnings are milder notices.',
    note: 'Most come from app code, not from an unhealthy database. A few are normal; a sudden jump usually follows a deploy or a migration. Each one is in the Postgres log below.',
  },
  connLimit: {
    title: 'Connection limit hit',
    body: 'How many times in the last hour Postgres turned away a new connection because every slot was taken (“too many clients”). Each pod keeps its own pool of connections, so scaling up can use them all.',
    note: 'Should be 0. Three or more in an hour sends a warning. Fixes: smaller pools per pod, a connection pooler like PgBouncer, or a bigger machine.',
  },
  deadlocks: {
    title: 'Deadlocks',
    body: "Two queries each waited for rows the other had locked, so neither could finish. Postgres notices within about a second and cancels one of them, which returns an error to that app.",
    note: 'An occasional one under load is normal. Frequent ones mean app code updates the same rows in a different order.',
  },
  slow: {
    title: 'Slow queries',
    body: "Queries that ran longer than the database's slow-query threshold in the last hour, as logged by Postgres.",
    note: 'Postgres only logs them when the log_min_duration_statement flag is set, so 0 can also mean it is off. The Slow queries tab below shows each one and how long it took.',
  },
  setup: {
    title: 'Setup',
    body: 'How the database server is configured in Google Cloud: machine size, disk, backups and the weekly window when Google may apply updates.',
    note: 'The connection name (project:region:instance) is how the apps find this database.',
  },
  activity: {
    title: 'Recent activity',
    body: 'What Google Cloud or your team did to the database: backups, maintenance, restarts and setting changes, newest first.',
    note: 'The orange bolt marks operations that can drop connections or change the setup: worth lining up with any errors from the same time.',
  },
  connErrors: {
    title: 'Connection errors from the apps',
    body: "Log lines from your services showing they couldn't reach the database in the last 15 minutes, newest first.",
    note: 'Errors from one service usually point at that service (wrong settings, a full pool). Errors from several at once point at the database.',
  },
  log: {
    title: 'Postgres log',
    body: "Messages from the database's own log in Cloud SQL as they happen: errors and warnings, and on the second tab, slow statements.",
    note: 'Read from Cloud Logging, which is free. Nothing here connects to the database or reads your data.',
  },
};

function Tile({ label, value, sub, tone, info }) {
  return (
    <Card className="flex flex-col gap-1 min-w-0">
      <div className="flex items-center justify-between gap-2 text-callout text-label-2">
        <span className="truncate">{label}</span>
        {info && <InfoTip {...info} />}
      </div>
      <div className={cx('text-title2 font-semibold tracking-[-0.02em] truncate', tone === 'red' && 'text-red', tone === 'orange' && 'text-orange', tone === 'green' && 'text-green')}>{value}</div>
      {sub && <div className="text-subheadline text-label-3 truncate">{sub}</div>}
    </Card>
  );
}

function statusPill(d, unreachable) {
  if (d.down) return <Pill tone="red" icon="x" strong>{d.stateText}</Pill>;
  if (unreachable) return <Pill tone="red" icon="x" strong>Apps can't connect</Pill>;
  if (d.status === 'maintenance') return <Pill tone="orange" strong>{d.stateText}</Pill>;
  if (d.status === 'up') return <Pill tone="green" icon="check">Running</Pill>;
  return <Pill tone="gray">{d.stateText}</Pill>;
}

function Activity({ operations, now }) {
  if (!operations?.length) return <Empty compact tone="gray" icon="history" title="No recent activity" />;
  return operations.slice(0, 12).map((o) => (
    <div key={o.id} className="px-4 py-2.5 hairline-b grid grid-cols-[minmax(0,1fr)_auto] gap-3 items-center">
      <div className="min-w-0">
        <div className="text-body font-medium truncate flex items-center gap-1.5">
          {o.disruptive && !o.failed && (
            <span title="Can interrupt connections or change the database's setup" className="shrink-0 text-orange inline-flex">
              <Icon name="bolt" size={12} strokeWidth={2} />
            </span>
          )}
          <span className="truncate">
            {o.label}
            {o.by && o.type === 'UPDATE' && <span className="text-label-2 font-normal"> · by {o.by}</span>}
          </span>
        </div>
        <div className="text-subheadline text-label-3 truncate">
          {dayTime(o.startedAt)} · {ago(o.startedAt, now)}
          {o.endedAt && o.endedAt - o.startedAt >= 60_000 ? ` · took ${duration(o.endedAt - o.startedAt)}` : ''}
          {o.error ? ` · ${o.error}` : ''}
        </div>
      </div>
      {o.failed ? (
        <Pill tone="red" strong>Failed</Pill>
      ) : o.status !== 'DONE' ? (
        <Pill tone="accent" strong>Running</Pill>
      ) : (
        <Pill tone="gray">Done</Pill>
      )}
    </div>
  ));
}

export default function Database() {
  const db = useStore((s) => s.sections.database);
  const now = useNow(20_000);
  const [tab, setTab] = useState('errors');
  const instances = db?.instances || [];
  const reach = db?.reachability || { last15m: 0, latest: [], services: [] };
  const stats = db?.stats || {};
  const errors = (db?.errors || []).filter((e) => !e.slow);
  const slow = (db?.errors || []).filter((e) => e.slow).sort((a, b) => b.durationMs - a.durationMs);

  return (
    <ViewScroll>
      {!instances.length && (
        <Card className={cx('mb-4 animate-rise', (db?.status === 'forbidden' || db?.status === 'error') && '!bg-orange-tint')}>
          <div className="flex items-start gap-3">
            <Icon name="database" size={18} className="text-label-2 mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-headline font-semibold">
                {db?.status === 'none'
                  ? `No Cloud SQL instance found${db.project ? ` in ${db.project}` : ''}`
                  : db?.status === 'forbidden'
                    ? "Can't read your Cloud SQL instance yet"
                    : db?.status === 'error'
                      ? "Can't read Cloud SQL status"
                      : 'Checking Cloud SQL…'}
              </div>
              <div className="text-callout text-label-2 mt-0.5 selectable">{db?.message || 'Instance status refreshes every 2 minutes. Database errors below come from the live logs.'}</div>
              {!!db?.inUse?.length && (
                <div className="mt-2.5 text-callout">
                  <div className="text-label-2">The apps are set up to connect to:</div>
                  {db.inUse.map((u) => (
                    <div key={u.id} className="mt-1 flex flex-wrap items-baseline gap-x-2">
                      <span className="font-mono text-label selectable">{u.id}</span>
                      <span className="text-subheadline text-label-3">
                        used by {u.services.slice(0, 4).join(', ')}
                        {u.services.length > 4 ? ` +${u.services.length - 4}` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {(db?.status === 'none' || db?.status === 'forbidden') && (
                <div className="mt-3 max-w-[640px]">
                  <div className="text-subheadline font-semibold text-label-2 mb-1.5">Your database's connection name</div>
                  <CloudSqlForm compact />
                  <DatabaseKey compact />
                </div>
              )}
            </div>
          </div>
        </Card>
      )}
      {!!instances.length && db?.message && (
        <Card className="mb-4 flex items-start gap-3 !bg-orange-tint animate-rise">
          <Icon name="errors" size={16} className="text-orange mt-0.5 shrink-0" />
          <div className="text-callout text-label-2 selectable">{db.message}</div>
        </Card>
      )}

      {instances.map((d) => (
        <section key={d.id} className="mb-8 animate-rise">
          <div className="flex items-center gap-3 mb-3 px-1">
            <div className="w-10 h-10 rounded-xl bg-accent-tint grid place-items-center shrink-0">
              <Icon name="database" size={20} className="text-accent" />
            </div>
            <div className="min-w-0">
              <div className="text-title3 font-semibold truncate">{d.name}</div>
              <div className="text-callout text-label-2 truncate">
                {[d.version, d.region, d.replicaOf ? `replica of ${d.replicaOf}` : null, `checked ${ago(db.at, now)}`].filter(Boolean).join(' · ')}
              </div>
            </div>
            <span className="ml-auto">{statusPill(d, reach.unreachable)}</span>
          </div>
          <div className="grid grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6 gap-3">
            <Tile info={INFO.status} label="Status" value={d.down ? 'Down' : d.status === 'maintenance' ? 'Maintenance' : d.status === 'up' ? 'Running' : d.stateText} sub={d.highAvailability ? 'High availability (2 zones)' : 'Single zone'} tone={d.down ? 'red' : d.status === 'maintenance' ? 'orange' : 'green'} />
            <Tile info={INFO.reach} label="Apps → database" value={reach.unreachable ? 'Failing' : reach.last15m ? 'Hiccups' : 'Connected'} sub={`${num(reach.last15m)} connection errors · 15 min`} tone={reach.unreachable ? 'red' : reach.last15m ? 'orange' : 'green'} />
            <Tile info={INFO.errors} label="Postgres errors" value={num(stats.errors1h || 0)} sub={`${num(stats.warnings1h || 0)} warnings · last hour`} tone={stats.errors1h ? 'orange' : null} />
            <Tile info={INFO.connLimit} label="Connection limit hit" value={num(stats.connLimit1h || 0)} sub="“too many clients” · last hour" tone={stats.connLimit1h ? 'orange' : null} />
            <Tile info={INFO.deadlocks} label="Deadlocks" value={num(stats.deadlocks1h || 0)} sub="last hour" tone={stats.deadlocks1h ? 'orange' : null} />
            <Tile info={INFO.slow} label="Slow queries" value={num(stats.slow1h || 0)} sub="logged · last hour" />
          </div>
          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-start gap-3 mt-3">
            <Card>
              <div className="text-headline font-semibold mb-3 flex items-center gap-1.5">
                Setup
                <InfoTip {...INFO.setup} />
              </div>
              <KeyValue
                items={[
                  ['Machine', d.tier],
                  ['Disk', d.diskGb ? `${d.diskGb} GB${d.diskAutoResize ? ', grows automatically' : ''}` : null],
                  ['Backups', d.backupsEnabled ? `Daily${d.pitr ? ' · point-in-time recovery on' : ''}` : 'Off'],
                  ['Maintenance window', d.maintenanceWindow],
                  d.scheduledMaintenance ? ['Next maintenance', `${dayTime(d.scheduledMaintenance)}`] : null,
                  ['Connection name', d.id],
                ]}
              />
            </Card>
            <Card pad={false} className="overflow-hidden">
              <div className="px-4 pt-3.5 pb-2 text-headline font-semibold flex items-center gap-1.5">
                Recent activity
                <InfoTip {...INFO.activity} />
                <span className="ml-auto font-normal">
                  <ExportButton name={`database-activity-${d.name}`} title="Database activity" columns={OPERATION_COLUMNS} rows={(db.operations || []).filter((o) => !o.instance || o.instance === d.name)} />
                </span>
              </div>
              <Activity operations={(db.operations || []).filter((o) => !o.instance || o.instance === d.name)} now={now} />
            </Card>
          </div>
        </section>
      ))}

      {reach.last15m > 0 && (
        <section className="mb-8 animate-rise">
          <SectionTitle title="Connection errors from the apps" info={INFO.connErrors} right={<ExportButton name="database-connection-errors" title="Connection errors" columns={CONN_ERROR_COLUMNS} rows={reach.latest} />} subtitle={`Services that couldn't talk to the database in the last 15 minutes: ${reach.services.join(', ')}`} />
          <Card pad={false} className="overflow-hidden">
            {reach.latest.map((x, i) => (
              <div key={i} className="px-4 py-2.5 hairline-b grid grid-cols-[80px_140px_minmax(0,1fr)] gap-3 items-start">
                <span className="text-callout text-label-2 tabular">{ago(x.ts, now)}</span>
                <span className="text-callout font-medium truncate">{x.service}</span>
                <span className="font-mono text-callout break-words selectable">{x.text}</span>
              </div>
            ))}
          </Card>
        </section>
      )}

      <section className="animate-rise" style={{ animationDelay: '80ms' }}>
        <SectionTitle
          title="Postgres log"
          info={INFO.log}
          subtitle={db?.logsNote || 'Errors, warnings and slow statements from Cloud SQL, live'}
          right={
            <>
              <Segmented
                size="sm"
                value={tab}
                onChange={setTab}
                options={[
                  { value: 'errors', label: 'Errors & warnings', count: errors.length },
                  { value: 'slow', label: 'Slow queries', count: slow.length },
                ]}
              />
              <ExportButton name={tab === 'errors' ? 'postgres-errors' : 'postgres-slow-queries'} title={tab === 'errors' ? 'Postgres errors' : 'Slow queries'} columns={PG_LOG_COLUMNS} rows={tab === 'errors' ? errors : slow} />
            </>
          }
        />
        <Card pad={false} className="overflow-hidden">
          {(tab === 'errors' ? errors : slow).map((e) => (
            <div key={e.id} className="px-4 py-2.5 hairline-b grid grid-cols-[80px_60px_minmax(0,1fr)] gap-3 items-start">
              <span className="text-callout text-label-2 tabular">{ago(e.ts, now)}</span>
              <span>
                {e.slow ? (
                  <Pill tone="orange" strong>
                    {(e.durationMs / 1000).toFixed(1)}s
                  </Pill>
                ) : (
                  <Pill tone={e.level === 'ERROR' ? 'red' : 'orange'} strong>
                    {e.level === 'ERROR' ? 'Error' : 'Warn'}
                  </Pill>
                )}
              </span>
              <span className="font-mono text-callout break-words selectable">{e.text}</span>
            </div>
          ))}
          {!(tab === 'errors' ? errors : slow).length && <Empty title={tab === 'errors' ? 'No database errors' : 'No slow queries logged'} message={tab === 'slow' ? 'Slow statements appear here when Postgres logs them (log_min_duration_statement). Turning that on is a Cloud SQL flag change — ask before changing it.' : null} />}
        </Card>
        <p className="text-footnote text-label-3 mt-3 px-1">CPU, memory and connection-count graphs would need Cloud Monitoring, which Google bills per read, so Flobi Pulse doesn't use it. Everything on this page is free.</p>
      </section>
    </ViewScroll>
  );
}
