import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sqlConnectionNames, slim } from '../electron/core/engine/model.mjs';
import { parseConnectionName, CloudSqlClient } from '../electron/core/sources/cloudsql.mjs';

test('finds the Cloud SQL instance a pod connects to', () => {
  const spec = {
    containers: [
      { name: 'app', image: 'eu.gcr.io/x/app:1', env: [{ name: 'DB_HOST', value: '127.0.0.1' }, { name: 'DB_PASS', valueFrom: { secretKeyRef: { name: 's', key: 'k' } } }] },
      { name: 'proxy', image: 'gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.11.0', args: ['--structured-logs', '--port=5432', 'flobi-db-prod:europe-west1:flobi-pg'] },
    ],
    initContainers: [{ name: 'old-proxy', command: ['/cloud_sql_proxy', '-instances=other-proj-1:us-central1:legacy-db=tcp:5433'] }],
  };
  assert.deepEqual(sqlConnectionNames(spec).sort(), ['flobi-db-prod:europe-west1:flobi-pg', 'other-proj-1:us-central1:legacy-db']);
  assert.deepEqual(sqlConnectionNames({ containers: [{ env: [{ name: 'DATABASE_URL', value: 'postgres://u:p@/app?host=/cloudsql/flobi-prod-2026:europe-west1:main-db' }] }] }), ['flobi-prod-2026:europe-west1:main-db']);
  // Look-alikes are ignored.
  assert.deepEqual(sqlConnectionNames({ containers: [{ image: 'gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.8.0', args: ['redis://cache:6379', 'http://api:3000/v1:x', '12:30:45'] }] }), []);
  // Only the name is kept on the slimmed pod.
  const pod = slim('pods', { metadata: { name: 'p' }, spec, status: {} });
  assert.equal(pod.spec.sqlInstances.length, 2);
  assert.equal(JSON.stringify(pod).includes('DB_HOST'), false);
});

test('parses connection names', () => {
  assert.deepEqual(parseConnectionName(' Flobi-DB-prod:europe-west1:flobi-pg '), { project: 'flobi-db-prod', region: 'europe-west1', name: 'flobi-pg', id: 'flobi-db-prod:europe-west1:flobi-pg' });
  assert.equal(parseConnectionName('flobi-pg'), null);
  assert.equal(parseConnectionName('a:b:c'), null);
  assert.equal(parseConnectionName('flobi-db-prod:europe-west1:flobi-pg/../x'), null);
});

import { LiveConnector } from '../electron/core/engine/live.mjs';
import { resetGuard, configureGuard, checkRequest } from '../electron/core/net/guard.mjs';

function fakeConnector({ primaryItems = [], other = {}, inUse = [], configured = [], seenInLogs = [], dbKey = null }) {
  const c = Object.create(LiveConnector.prototype);
  const db = {};
  const sources = {};
  c.config = { projectId: 'flobi-prod-2026', cloudsql: { instances: configured } };
  c.auth = { identity: { email: 'pulse-viewer@flobi-prod-2026.iam.gserviceaccount.com', projectId: 'flobi-prod-2026' } };
  c.dbAuth = dbKey && { identity: { email: `pulse-db@${dbKey.project}.iam.gserviceaccount.com`, projectId: dbKey.project } };
  c._sqlStarted = true;
  c.pipeline = {
    database: {},
    sqlInstancesInUse: () => new Map(inUse.map((id) => [id, new Set(['brand'])])),
    sqlSeenInLogs: new Set(seenInLogs),
    setDatabase: (p) => Object.assign(db, p),
    setSource: (k, st, msg) => (sources[k] = { st, msg }),
  };
  const inst = (project, name) => ({ id: `${project}:europe-west1:${name}`, name, status: 'up' });
  c.cloudsql = {
    instances: async (p) => {
      checkRequest({ url: `https://sqladmin.googleapis.com/v1/projects/${p}/instances` });
      if (dbKey && p === dbKey.project) {
        if (dbKey.items === 403) throw Object.assign(new Error('nope'), { status: 403 });
        return dbKey.items.map((n) => inst(p, n));
      }
      return p === 'flobi-prod-2026' ? primaryItems.map((n) => inst(p, n)) : [];
    },
    instance: async (p, n) => {
      checkRequest({ url: `https://sqladmin.googleapis.com/v1/projects/${p}/instances/${n}` });
      const r = other[`${p}/${n}`];
      if (r === 403 || r === 404) throw Object.assign(new Error('nope'), { status: r });
      return inst(p, n);
    },
    operations: async () => [],
  };
  return { c, db, sources };
}

test('database in the app project is found as before', async () => {
  resetGuard();
  configureGuard({ projectId: 'flobi-prod-2026' });
  const { c, db } = fakeConnector({ primaryItems: ['main-db'] });
  await c.pollCloudSql();
  assert.equal(db.status, 'ok');
  assert.equal(db.instances[0].name, 'main-db');
});

test('database in another project, found from the pods', async () => {
  resetGuard();
  configureGuard({ projectId: 'flobi-prod-2026' });
  const { c, db } = fakeConnector({ inUse: ['flobi-db-prod:europe-west1:flobi-pg'], other: { 'flobi-db-prod/flobi-pg': 200 } });
  await c.pollCloudSql();
  assert.equal(db.status, 'ok');
  assert.equal(db.instances[0].id, 'flobi-db-prod:europe-west1:flobi-pg');
});

test('database in another project the account cannot read yet', async () => {
  resetGuard();
  configureGuard({ projectId: 'flobi-prod-2026' });
  const { c, db, sources } = fakeConnector({ configured: ['flobi-db-prod:europe-west1:flobi-pg'], other: { 'flobi-db-prod/flobi-pg': 403 } });
  await c.pollCloudSql();
  assert.equal(db.status, 'forbidden');
  assert.match(db.message, /flobi-db-prod/);
  assert.match(db.message, /Cloud SQL Viewer/);
  assert.equal(sources.cloudsql.st, 'forbidden');
});

test('nothing anywhere: says which project was checked and what to do', async () => {
  resetGuard();
  configureGuard({ projectId: 'flobi-prod-2026' });
  const { c, db } = fakeConnector({});
  await c.pollCloudSql();
  assert.equal(db.status, 'none');
  assert.equal(db.project, 'flobi-prod-2026');
  assert.match(db.message, /connection name/);
});

test('instance seen in the Postgres logs is looked up even if the list is empty', async () => {
  resetGuard();
  configureGuard({ projectId: 'flobi-prod-2026' });
  const { c, db } = fakeConnector({ seenInLogs: ['flobi-prod-2026:europe-west1:flobi-pg'], other: { 'flobi-prod-2026/flobi-pg': 200 } });
  await c.pollCloudSql();
  assert.equal(db.status, 'ok');
  assert.equal(db.instances[0].name, 'flobi-pg');
});

test('database key: its project is searched, no connection name needed', async () => {
  resetGuard();
  configureGuard({ projectId: 'flobi-prod-2026' });
  const { c, db } = fakeConnector({ dbKey: { project: 'flobi-db-prod', items: ['flobi-pg'] } });
  await c.pollCloudSql();
  assert.equal(db.status, 'ok');
  assert.equal(db.instances[0].id, 'flobi-db-prod:europe-west1:flobi-pg');
  assert.equal(db.message, null);
});

test('database key without the Cloud SQL Viewer role: names the key and its project', async () => {
  resetGuard();
  configureGuard({ projectId: 'flobi-prod-2026' });
  const { c, db, sources } = fakeConnector({ dbKey: { project: 'flobi-db-prod', items: 403 } });
  await c.pollCloudSql();
  assert.equal(db.status, 'forbidden');
  assert.match(db.message, /pulse-db@flobi-db-prod/);
  assert.match(db.message, /Cloud SQL Viewer/);
  assert.equal(sources.cloudsql.st, 'forbidden');
});

test('Cloud SQL outside our project is read with the database key, ours with the main key', () => {
  const { c } = fakeConnector({ dbKey: { project: 'flobi-db-prod', items: [] } });
  assert.equal(c.sqlAuth('flobi-prod-2026'), c.auth);
  assert.equal(c.sqlAuth('flobi-db-prod'), c.dbAuth);
  assert.equal(c.sqlAuth('some-third-project'), c.dbAuth);
  const { c: plain } = fakeConnector({});
  assert.equal(plain.sqlAuth('flobi-db-prod'), plain.auth);
});

test('the Cloud SQL client asks for a token for the project it reads', async () => {
  const asked = [];
  const client = new CloudSqlClient({ projectId: 'flobi-prod-2026', getToken: async (p) => (asked.push(p), Promise.reject(new Error('stop before the network'))) });
  await assert.rejects(client.instance('flobi-db-prod', 'flobi-pg'));
  await assert.rejects(client.operations('flobi-pg', 25, 'flobi-db-prod'));
  await assert.rejects(client.instances());
  assert.deepEqual(asked, ['flobi-db-prod', 'flobi-db-prod', 'flobi-prod-2026']);
});
