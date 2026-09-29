import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as norm from '../electron/core/engine/normalize.mjs';
import { LiveConnector } from '../electron/core/engine/live.mjs';

const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();

/** A connector with fake Kubernetes / Cloud Logging clients (no network). */
function setup({ pods = [], kubeError = null } = {}) {
  const calls = { kube: [], logging: [] };
  const c = new LiveConnector({
    config: { namespace: 'flobi', projectId: 'flobi-prod-2026', cluster: { name: 'flobi-cluster' } },
    auth: { identity: {}, getToken: async () => 'token' },
    pipeline: { model: { pods }, router: () => null },
    settings: {},
  });
  c.kube = {
    endpoint: '10.0.0.1',
    previousLogs: async (a) => {
      calls.kube.push(a);
      if (kubeError) throw kubeError;
      return '2026-09-28T10:00:00.000Z FATAL ERROR: heap out of memory\n';
    },
  };
  c.logging = {
    listAll: async (a) => {
      calls.logging.push(a);
      return [{ insertId: 'i1', timestamp: '2026-09-28T09:59:58.000Z', severity: 'ERROR', textPayload: 'boom', resource: { type: 'k8s_container', labels: { pod_name: 'flobi-brand-7d9f8c6b5-x2x9z', container_name: 'flobi-brand' } } }];
    },
  };
  return { c, calls };
}

const brandPod = (restarts) => ({ name: 'flobi-brand-7d9f8c6b5-x2x9z', service: 'flobi-brand', containers: [{ name: 'flobi-brand', restarts }], lastTermination: { at: Date.parse('2026-09-28T10:00:00Z') } });

test('previous logs: an older crash of a pod that restarted since comes from Cloud Logging around it', async () => {
  const { c, calls } = setup({ pods: [brandPod(5)] });
  const at = Date.parse('2026-09-28T09:00:00Z');
  const lines = await c.previousLogs({ pod: 'flobi-brand-7d9f8c6b5-x2x9z', container: 'flobi-brand', service: 'flobi-brand', restarts: 3, at });
  assert.equal(calls.kube.length, 0, 'Kubernetes only has the latest run');
  assert.equal(calls.logging.length, 1);
  const f = calls.logging[0].filter;
  assert.match(f, /resource\.labels\.pod_name="flobi-brand-7d9f8c6b5-x2x9z"/);
  assert.ok(f.includes(`timestamp>="${iso(at - 10 * MIN)}"`), f);
  assert.ok(f.includes(`timestamp<"${iso(at + 5_000)}"`), f);
  assert.deepEqual(lines.map((l) => [l.text, l.service]), [['boom', 'flobi-brand']]);
});

test('previous logs: the latest crash, or no crash given, reads the previous run from Kubernetes', async () => {
  for (const args of [{ restarts: 5, at: Date.parse('2026-09-28T10:00:00Z') }, {}]) {
    const { c, calls } = setup({ pods: [brandPod(5)] });
    const lines = await c.previousLogs({ pod: 'flobi-brand-7d9f8c6b5-x2x9z', container: 'flobi-brand', service: 'flobi-brand', ...args });
    assert.equal(calls.logging.length, 0);
    assert.deepEqual(calls.kube, [{ namespace: 'flobi', pod: 'flobi-brand-7d9f8c6b5-x2x9z', container: 'flobi-brand' }]);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].ts, Date.parse('2026-09-28T10:00:00.000Z'));
    assert.equal(lines[0].service, 'flobi-brand');
  }
  // A pod that's gone isn't known to have restarted since: Kubernetes decides.
  const { c, calls } = setup({ pods: [] });
  await c.previousLogs({ pod: 'flobi-brand-7d9f8c6b5-x2x9z', container: 'flobi-brand', service: 'flobi-brand', restarts: 1, at: Date.now() });
  assert.equal(calls.kube.length, 1);
});

test('previous logs: no previous run is an empty list; without pod-log access, Cloud Logging before the crash', async () => {
  const none = setup({ pods: [brandPod(0)], kubeError: Object.assign(new Error('HTTP 400'), { status: 400 }) });
  assert.deepEqual(await none.c.previousLogs({ pod: 'flobi-brand-7d9f8c6b5-x2x9z', container: 'flobi-brand', service: 'flobi-brand' }), []);

  const forbidden = setup({ pods: [brandPod(2)], kubeError: Object.assign(new Error('HTTP 403'), { status: 403 }) });
  const at = Date.parse('2026-09-28T08:00:00Z');
  await forbidden.c.previousLogs({ pod: 'flobi-brand-7d9f8c6b5-x2x9z', container: 'flobi-brand', service: 'flobi-brand', restarts: 2, at });
  assert.ok(forbidden.calls.logging[0].filter.includes(`timestamp<"${iso(at + 5_000)}"`));
  // The pod inspector gives no time: the pod's last termination.
  const inspector = setup({ pods: [brandPod(2)], kubeError: Object.assign(new Error('HTTP 403'), { status: 403 }) });
  await inspector.c.previousLogs({ pod: 'flobi-brand-7d9f8c6b5-x2x9z', container: 'flobi-brand', service: 'flobi-brand' });
  assert.ok(inspector.calls.logging[0].filter.includes(`timestamp<"${iso(Date.parse('2026-09-28T10:00:00Z') + 5_000)}"`));

  const broken = setup({ pods: [brandPod(0)], kubeError: Object.assign(new Error('HTTP 500'), { status: 500 }) });
  await assert.rejects(broken.c.previousLogs({ pod: 'flobi-brand-7d9f8c6b5-x2x9z', container: 'flobi-brand', service: 'flobi-brand' }), /HTTP 500/);
});

test('log lines of pods that are gone still count for their workload', () => {
  const { c } = setup({ pods: [brandPod(0)] });
  const ctx = c.normalizeCtx();
  assert.equal(ctx.podToService('flobi-brand-7d9f8c6b5-x2x9z'), 'flobi-brand');
  // Not in the pod list anymore: from the name, when normalize.mjs can tell.
  assert.equal(ctx.podToService('flobi-drive-5f6d7c8b9k-bcdfg'), norm.workloadFromPodName ? 'flobi-drive' : null);
  assert.equal(ctx.podToService('nonsense'), null);
});
