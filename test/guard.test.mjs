import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { checkRequest, configureGuard, resetGuard, ReadOnlyViolation } from '../electron/core/net/guard.mjs';
import { EDGE_QUERY, EDGE_ADAPTIVE_QUERY, EDGE_HOURLY_QUERY, HOST_ERRORS_QUERY } from '../electron/core/sources/cloudflare.mjs';
import { encodeTailRequest } from '../electron/core/net/protobuf.mjs';

const K8S = 'https://34.77.1.2';

beforeEach(() => {
  resetGuard();
  configureGuard({
    projectId: 'flobi-prod-2026',
    kubernetesHost: '34.77.1.2',
    uptimeUrls: ['https://api.flobi.ai/health'],
  });
});

const allowed = (req) => assert.equal(checkRequest(req), true);
const blocked = (req) => assert.throws(() => checkRequest(req), ReadOnlyViolation);

test('Kubernetes: reads are allowed', () => {
  allowed({ method: 'GET', url: `${K8S}/api/v1/namespaces/flobi/pods` });
  allowed({ method: 'GET', url: `${K8S}/api/v1/namespaces/flobi/pods?watch=1&resourceVersion=12` });
  allowed({ method: 'GET', url: `${K8S}/apis/apps/v1/namespaces/flobi/deployments` });
  allowed({ method: 'GET', url: `${K8S}/api/v1/namespaces/flobi/pods/flobi-brand-abc/log?follow=true` });
  allowed({ method: 'GET', url: `${K8S}/apis/metrics.k8s.io/v1beta1/namespaces/flobi/pods` });
  allowed({ method: 'GET', url: `${K8S}/version` });
});

test('Kubernetes: every write verb is blocked', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    blocked({ method, url: `${K8S}/api/v1/namespaces/flobi/pods/flobi-brand-abc` });
    blocked({ method, url: `${K8S}/apis/apps/v1/namespaces/flobi/deployments/flobi-brand` });
    blocked({ method, url: `${K8S}/apis/apps/v1/namespaces/flobi/deployments/flobi-brand/scale` });
  }
});

test('Kubernetes: encoded, relative and unknown paths are blocked', () => {
  blocked({ method: 'GET', url: `${K8S}/api/v1/namespaces/kube-system/%73ecrets/x` });
  blocked({ method: 'GET', url: `${K8S}/api/v1/namespaces/flobi/services/web:80/%70roxy/admin` });
  blocked({ method: 'GET', url: `${K8S}/api/v1/namespaces/flobi/secrets%2fx` });
  blocked({ method: 'GET', url: `${K8S}/api/v1/namespaces/flobi/pods/../../kube-system/secrets/x/log` });
  blocked({ method: 'GET', url: `${K8S}/api/v1/namespaces/flobi/pods/a/log?container=c&command=sh` });
  blocked({ method: 'GET', url: `${K8S}/api/v1/namespaces/flobi/configmaps` });
  blocked({ method: 'GET', url: `${K8S}/api/v1/namespaces/flobi/Secrets` });
  blocked({ method: 'GET', url: `${K8S}/apis/rbac.authorization.k8s.io/v1/clusterroles` });
  allowed({ method: 'GET', url: `${K8S}/api/v1/events?fieldSelector=involvedObject.kind%3DNode` });
});

test('Headers: only the known set is allowed', () => {
  blocked({ method: 'GET', url: `${K8S}/api/v1/namespaces/flobi/pods`, headers: { 'X-Method-Override': 'DELETE' } });
  blocked({ method: 'GET', url: `${K8S}/api/v1/namespaces/flobi/pods`, headers: { 'X-Something': '1' } });
  allowed({ method: 'GET', url: `${K8S}/api/v1/namespaces/flobi/pods`, headers: { Authorization: 'Bearer x', Accept: 'application/json' } });
});

test('Kubernetes: exec, attach, port-forward, proxy and secrets are blocked even for GET', () => {
  blocked({ method: 'GET', url: `${K8S}/api/v1/namespaces/flobi/pods/p/exec?command=sh` });
  blocked({ method: 'GET', url: `${K8S}/api/v1/namespaces/flobi/pods/p/attach` });
  blocked({ method: 'GET', url: `${K8S}/api/v1/namespaces/flobi/pods/p/portforward` });
  blocked({ method: 'GET', url: `${K8S}/api/v1/namespaces/flobi/services/s/proxy/` });
  blocked({ method: 'GET', url: `${K8S}/api/v1/namespaces/flobi/secrets` });
  blocked({ method: 'GET', url: `${K8S}/api/v1/namespaces/flobi/secrets/flobi-secrets` });
  blocked({ method: 'GET', url: `${K8S}/api/v1/nodes/n1/proxy/metrics` });
  blocked({ method: 'GET', url: `${K8S}/api/v1/namespaces/flobi/pods`, headers: { Upgrade: 'websocket' } });
  blocked({ method: 'GET', url: `${K8S}/api/v1/namespaces/flobi/pods`, headers: { 'X-HTTP-Method-Override': 'DELETE' } });
});

test('Unknown hosts and plain HTTP are blocked', () => {
  blocked({ method: 'GET', url: 'https://evil.example.com/' });
  blocked({ method: 'GET', url: 'http://34.77.1.2/api/v1/pods' });
  blocked({ method: 'GET', url: 'https://user:pw@34.77.1.2/api/v1/pods' });
});

test('Google APIs: only the read endpoints are allowed', () => {
  allowed({ method: 'POST', url: 'https://oauth2.googleapis.com/token' });
  allowed({ method: 'GET', url: 'https://container.googleapis.com/v1/projects/flobi-prod-2026/locations/europe-west1/clusters/flobi-cluster' });
  blocked({ method: 'DELETE', url: 'https://container.googleapis.com/v1/projects/flobi-prod-2026/locations/europe-west1/clusters/flobi-cluster' });
  blocked({ method: 'POST', url: 'https://container.googleapis.com/v1/projects/flobi-prod-2026/locations/europe-west1/clusters/flobi-cluster:setSize' });
  blocked({ method: 'GET', url: 'https://container.googleapis.com/v1/projects/other-project/locations/europe-west1/clusters/x' });

  allowed({ method: 'POST', url: 'https://logging.googleapis.com/v2/entries:list', body: JSON.stringify({ resourceNames: ['projects/flobi-prod-2026'] }) });
  blocked({ method: 'POST', url: 'https://logging.googleapis.com/v2/entries:list', body: JSON.stringify({ resourceNames: ['projects/someone-else'] }) });
  allowed({ method: 'POST', url: 'https://logging.googleapis.com/google.logging.v2.LoggingServiceV2/TailLogEntries', body: encodeTailRequest({ resourceNames: ['projects/flobi-prod-2026'] }) });
  blocked({ method: 'POST', url: 'https://logging.googleapis.com/v2/entries:write' });
  blocked({ method: 'DELETE', url: 'https://logging.googleapis.com/v2/projects/flobi-prod-2026/logs/x' });
  blocked({ method: 'POST', url: 'https://logging.googleapis.com/v2/projects/flobi-prod-2026/sinks' });

  // Cloud Monitoring is billed per read, so it is never allowed, not even GET.
  blocked({ method: 'GET', url: 'https://monitoring.googleapis.com/v3/projects/flobi-prod-2026/timeSeries?filter=x' });
  blocked({ method: 'GET', url: 'https://monitoring.googleapis.com/v1/projects/flobi-prod-2026/location/global/prometheus/api/v1/query' });
  blocked({ method: 'POST', url: 'https://monitoring.googleapis.com/v3/projects/flobi-prod-2026/timeSeries' });

  allowed({ method: 'GET', url: 'https://sqladmin.googleapis.com/v1/projects/flobi-prod-2026/instances' });
  allowed({ method: 'GET', url: 'https://sqladmin.googleapis.com/v1/projects/flobi-prod-2026/operations?instance=flobi-db&maxResults=25' });
  blocked({ method: 'GET', url: 'https://sqladmin.googleapis.com/v1/projects/flobi-prod-2026/operations?instance=flobi-db&filter=x' });
  blocked({ method: 'POST', url: 'https://sqladmin.googleapis.com/v1/projects/flobi-prod-2026/instances/flobi-db/restart' });
  blocked({ method: 'PATCH', url: 'https://sqladmin.googleapis.com/v1/projects/flobi-prod-2026/instances/flobi-db' });
  blocked({ method: 'GET', url: 'https://sqladmin.googleapis.com/v1/projects/flobi-prod-2026/instances/flobi-db/users' });
  blocked({ method: 'GET', url: 'https://sqladmin.googleapis.com/v1/projects/someone-else/instances' });

  allowed({ method: 'GET', url: 'https://run.googleapis.com/v2/projects/flobi-prod-2026/locations/europe-west1/services' });
  blocked({ method: 'PATCH', url: 'https://run.googleapis.com/v2/projects/flobi-prod-2026/locations/europe-west1/services/x' });

  blocked({ method: 'GET', url: 'https://secretmanager.googleapis.com/v1/projects/flobi-prod-2026/secrets' });
  blocked({ method: 'POST', url: 'https://iam.googleapis.com/v1/projects/flobi-prod-2026/serviceAccounts' });
});

test('Cloudflare: only the built-in analytics queries, no writes', () => {
  const url = 'https://api.cloudflare.com/client/v4/graphql';
  allowed({ method: 'POST', url, body: JSON.stringify({ query: EDGE_QUERY, variables: { zoneTags: ['a'] } }) });
  allowed({ method: 'POST', url, body: JSON.stringify({ query: HOST_ERRORS_QUERY, variables: {} }) });
  allowed({ method: 'POST', url, body: JSON.stringify({ query: EDGE_ADAPTIVE_QUERY, variables: {} }) });
  allowed({ method: 'POST', url, body: JSON.stringify({ query: EDGE_HOURLY_QUERY, variables: {} }) });
  blocked({ method: 'POST', url, body: JSON.stringify({ query: 'query { viewer { zones { zoneTag } } }' }) });
  blocked({ method: 'POST', url, body: JSON.stringify({ query: 'mutation { deleteZone(id: 1) }' }) });
  blocked({ method: 'POST', url, body: JSON.stringify({ query: `${EDGE_QUERY} mutation { b }` }) });
  allowed({ method: 'GET', url: 'https://api.cloudflare.com/client/v4/zones' });
  allowed({ method: 'GET', url: 'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/pages/projects' });
  blocked({ method: 'DELETE', url: 'https://api.cloudflare.com/client/v4/zones/0123456789abcdef0123456789abcdef' });
  blocked({ method: 'PATCH', url: 'https://api.cloudflare.com/client/v4/zones/0123456789abcdef0123456789abcdef/settings/ssl' });
  blocked({ method: 'GET', url: 'https://api.cloudflare.com/client/v4/zones/0123456789abcdef0123456789abcdef/dns_records' });
});

test('Sentry: GET only, organization/projects/issues only', () => {
  allowed({ method: 'GET', url: 'https://sentry.io/api/0/organizations/flobi/issues/?project=-1&query=is:unresolved' });
  allowed({ method: 'GET', url: 'https://de.sentry.io/api/0/organizations/flobi/projects/' });
  allowed({ method: 'GET', url: 'https://sentry.io/api/0/organizations/flobi/' });
  blocked({ method: 'GET', url: 'https://sentry.io/api/0/organizations/flobi/members/' });
  blocked({ method: 'GET', url: 'https://sentry.io/api/0/organizations/flobi/../../projects/x/keys/' });
  blocked({ method: 'PUT', url: 'https://sentry.io/api/0/organizations/flobi/issues/?id=1' });
  blocked({ method: 'DELETE', url: 'https://sentry.io/api/0/issues/1/' });
});

test('Uptime: only exact configured URLs, only GET/HEAD', () => {
  allowed({ method: 'GET', url: 'https://api.flobi.ai/health' });
  allowed({ method: 'HEAD', url: 'https://api.flobi.ai/health' });
  blocked({ method: 'POST', url: 'https://api.flobi.ai/health' });
  blocked({ method: 'GET', url: 'https://api.flobi.ai/admin/delete-everything' });
});

test('Cloud SQL in another project: only once named, and only reads', () => {
  const other = 'https://sqladmin.googleapis.com/v1/projects/flobi-db-prod/instances';
  blocked({ method: 'GET', url: other });
  blocked({ method: 'GET', url: `${other}/flobi-pg` });
  configureGuard({ sqlProjects: ['flobi-db-prod'] });
  allowed({ method: 'GET', url: other });
  allowed({ method: 'GET', url: `${other}/flobi-pg` });
  allowed({ method: 'GET', url: 'https://sqladmin.googleapis.com/v1/projects/flobi-db-prod/operations?instance=flobi-pg&maxResults=25' });
  blocked({ method: 'POST', url: `${other}/flobi-pg/restart` });
  blocked({ method: 'PATCH', url: `${other}/flobi-pg` });
  blocked({ method: 'GET', url: `${other}/flobi-pg/users` });
  // Other APIs in that project stay closed.
  blocked({ method: 'GET', url: 'https://run.googleapis.com/v2/projects/flobi-db-prod/locations/europe-west1/services' });
});

test('Logs of the database project: Cloud SQL entries only', () => {
  configureGuard({ sqlProjects: ['flobi-db-prod'] });
  const list = (resourceNames, filter) => ({ method: 'POST', url: 'https://logging.googleapis.com/v2/entries:list', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resourceNames, filter }) });
  allowed(list(['projects/flobi-db-prod'], 'resource.type="cloudsql_database" AND severity>=WARNING AND timestamp>"2026-09-25T10:00:00Z"'));
  allowed(list(['projects/flobi-db-prod'], 'resource.type="cloudsql_database" AND textPayload:"duration:" AND timestamp>"2026-09-25T10:00:00Z"'));
  blocked(list(['projects/flobi-db-prod'], 'resource.type="k8s_container"'));
  blocked(list(['projects/flobi-db-prod'], 'resource.type="cloudsql_database" AND severity>=WARNING OR resource.type="gce_instance"'));
  blocked(list(['projects/flobi-db-prod'], 'resource.type="cloudsql_database" AND (severity>=WARNING)'));
  blocked(list(['projects/flobi-db-prod', 'projects/flobi-prod-2026'], 'resource.type="cloudsql_database" AND severity>=WARNING'));
  blocked(list(['projects/someone-else'], 'resource.type="cloudsql_database" AND severity>=WARNING'));
});
