// Kubernetes objects → the app's summaries (services, pods, nodes, scaling,
// jobs, certificates, ingress) with a health verdict per service. Pure JS.
import { shortName } from './log-parse.mjs';

// ── Slimming (keeps memory small for 100+ pods) ─────────────────────────────
const pickMeta = (m = {}) => ({
  name: m.name,
  uid: m.uid,
  labels: m.labels || {},
  annotations: m.annotations ? { revision: m.annotations['deployment.kubernetes.io/revision'] } : {},
  ownerReferences: (m.ownerReferences || []).map((o) => ({ kind: o.kind, name: o.name })),
  creationTimestamp: m.creationTimestamp,
  deletionTimestamp: m.deletionTimestamp,
  generation: m.generation,
  resourceVersion: m.resourceVersion,
});

const pickContainer = (c) => ({ name: c.name, image: c.image, resources: c.resources || {} });

// Cloud SQL connection names ("project:region:instance") written in a pod's own
// settings: the Cloud SQL Auth Proxy arguments, INSTANCE_CONNECTION_NAME-style
// env values, or a /cloudsql/… socket path. Only plain values in the pod spec are
// looked at (never Secrets), and only the connection name is kept.
const SQL_CONN = /(?:^|[^a-z0-9-])([a-z][a-z0-9-]{4,28}[a-z0-9]):([a-z]+-[a-z]+[0-9]+):([a-z][a-z0-9-]{0,96}[a-z0-9])(?![a-z0-9-])/g;

export function sqlConnectionNames(spec = {}) {
  const out = new Set();
  const scan = (v) => {
    if (typeof v !== 'string' || v.length > 4000) return;
    for (const m of v.toLowerCase().matchAll(SQL_CONN)) out.add(`${m[1]}:${m[2]}:${m[3]}`);
  };
  for (const c of [...(spec.containers || []), ...(spec.initContainers || [])]) {
    for (const a of [...(c.command || []), ...(c.args || [])]) scan(a);
    for (const e of c.env || []) scan(e.value);
  }
  return [...out].slice(0, 10);
}

export function slim(kind, o) {
  switch (kind) {
    case 'pods':
      return {
        metadata: pickMeta(o.metadata),
        spec: { nodeName: o.spec?.nodeName, containers: (o.spec?.containers || []).map(pickContainer), sqlInstances: sqlConnectionNames(o.spec) },
        status: {
          phase: o.status?.phase,
          reason: o.status?.reason,
          message: o.status?.message,
          podIP: o.status?.podIP,
          startTime: o.status?.startTime,
          conditions: (o.status?.conditions || []).map((c) => ({ type: c.type, status: c.status, reason: c.reason, message: c.message, lastTransitionTime: c.lastTransitionTime })),
          containerStatuses: o.status?.containerStatuses || [],
          initContainerStatuses: o.status?.initContainerStatuses || [],
        },
      };
    case 'deployments':
    case 'statefulsets':
      return {
        metadata: pickMeta(o.metadata),
        spec: {
          replicas: o.spec?.replicas,
          selector: o.spec?.selector,
          containers: (o.spec?.template?.spec?.containers || []).map(pickContainer),
        },
        status: o.status || {},
      };
    case 'events':
    case 'nodeEvents':
      return {
        metadata: { uid: o.metadata?.uid, name: o.metadata?.name, creationTimestamp: o.metadata?.creationTimestamp },
        type: o.type,
        reason: o.reason,
        message: o.message,
        involvedObject: { kind: o.involvedObject?.kind, name: o.involvedObject?.name, namespace: o.involvedObject?.namespace },
        count: o.count || o.series?.count || 1,
        firstTimestamp: o.firstTimestamp || o.eventTime,
        lastTimestamp: o.lastTimestamp || o.series?.lastObservedTime || o.eventTime || o.metadata?.creationTimestamp,
        source: o.source?.component || o.reportingComponent,
      };
    case 'nodes':
      return {
        metadata: pickMeta(o.metadata),
        spec: { unschedulable: !!o.spec?.unschedulable, taints: o.spec?.taints || [] },
        status: {
          conditions: (o.status?.conditions || []).map((c) => ({ type: c.type, status: c.status, reason: c.reason, message: c.message, lastTransitionTime: c.lastTransitionTime })),
          allocatable: o.status?.allocatable || {},
          capacity: o.status?.capacity || {},
          nodeInfo: { kubeletVersion: o.status?.nodeInfo?.kubeletVersion, osImage: o.status?.nodeInfo?.osImage },
        },
      };
    default:
      return o;
  }
}

// ── Quantities ──────────────────────────────────────────────────────────────
export function cpuMilli(q) {
  if (q == null) return 0;
  const s = String(q);
  if (s.endsWith('n')) return parseFloat(s) / 1e6;
  if (s.endsWith('u')) return parseFloat(s) / 1e3;
  if (s.endsWith('m')) return parseFloat(s);
  return parseFloat(s) * 1000;
}

// `m` is milli: Kubernetes may store 1.2Gi as "1288490188800m".
const BIN = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, K: 1e3, k: 1e3, M: 1e6, G: 1e9, T: 1e12, m: 1e-3 };
export function bytes(q) {
  if (q == null) return 0;
  const m = String(q).match(/^([\d.]+)([A-Za-z]*)$/);
  if (!m) return 0;
  return parseFloat(m[1]) * (BIN[m[2]] || 1);
}

const t = (s) => (s ? Date.parse(s) : null);

// ── Pods ────────────────────────────────────────────────────────────────────
const BAD = new Set(['CrashLoopBackOff', 'ImagePullBackOff', 'ErrImagePull', 'CreateContainerConfigError', 'CreateContainerError', 'InvalidImageName', 'OOMKilled', 'Error', 'Failed', 'Unschedulable', 'Evicted', 'RunContainerError']);
const PENDINGISH = new Set(['ContainerCreating', 'PodInitializing', 'Pending']);
const UNSCHEDULABLE_GRACE_MS = 5 * 60_000;

export function workloadOf(pod) {
  const owner = pod.metadata.ownerReferences?.[0];
  if (!owner) return pod.metadata.labels?.app || pod.metadata.name;
  if (owner.kind === 'ReplicaSet') {
    const hash = pod.metadata.labels?.['pod-template-hash'];
    if (hash && owner.name.endsWith(`-${hash}`)) return owner.name.slice(0, -(hash.length + 1));
    return owner.name.replace(/-[a-z0-9]{8,10}$/, '');
  }
  if (owner.kind === 'Job') return owner.name.replace(/-\d{8,}$/, ''); // cronjob-created jobs
  return owner.name;
}

export function podStatus(pod) {
  const st = pod.status || {};
  if (pod.metadata.deletionTimestamp) return 'Terminating';
  if (st.reason === 'Evicted') return 'Evicted';
  // Like kubectl: a finished pod shows why the node ended it (NodeShutdown, Preempting, …).
  if (st.phase === 'Failed' && st.reason) return st.reason;
  for (const c of st.initContainerStatuses || []) {
    const w = c.state?.waiting?.reason;
    if (w && w !== 'PodInitializing') return `Init:${w}`;
    if (c.state?.terminated && c.state.terminated.exitCode !== 0) return 'Init:Error';
  }
  let reason = null;
  for (const c of st.containerStatuses || []) {
    const w = c.state?.waiting?.reason;
    const term = c.state?.terminated?.reason;
    if (w && (BAD.has(w) || !reason)) reason = w;
    if (term && !reason) reason = term === 'Completed' && st.phase === 'Succeeded' ? 'Completed' : term;
  }
  if (reason) return reason;
  if (st.phase === 'Pending') {
    const sched = (st.conditions || []).find((c) => c.type === 'PodScheduled');
    if (sched && sched.status === 'False') return 'Unschedulable';
    return 'Pending';
  }
  if (st.phase === 'Running') {
    const ready = (st.conditions || []).find((c) => c.type === 'Ready');
    return ready?.status === 'True' ? 'Running' : 'NotReady';
  }
  if (st.phase === 'Succeeded') return 'Completed';
  return st.phase || 'Unknown';
}

/**
 * A pod whose phase is Failed or Succeeded is over for good: Kubernetes never
 * restarts it (evicted, preempted, shut down with its node, a finished Job
 * attempt). Its workload already runs a replacement, so it's history, not trouble.
 */
export function isTerminal(pod) {
  const phase = pod.status?.phase;
  return phase === 'Failed' || phase === 'Succeeded';
}

/** When a finished pod stopped: its latest timestamp (container exits, condition changes). */
function finishedAt(pod) {
  const st = pod.status || {};
  const times = [...(st.containerStatuses || []).map((c) => t(c.state?.terminated?.finishedAt)), ...(st.conditions || []).map((c) => t(c.lastTransitionTime)), t(st.startTime), t(pod.metadata.creationTimestamp)].filter((x) => Number.isFinite(x));
  return times.length ? Math.max(...times) : null;
}

const TERMINAL_WARN_MS = 15 * 60_000;

export function podState(status, pod, now = Date.now()) {
  if (isTerminal(pod)) {
    // A Job run that finished is the normal end of it; anything else that ended
    // shows as a warning for a while so it's seen, then fades out.
    if (status === 'Completed' && pod.metadata.ownerReferences?.[0]?.kind === 'Job') return 'done';
    const at = finishedAt(pod);
    return at == null || now - at > TERMINAL_WARN_MS ? 'done' : 'warn';
  }
  // The cluster autoscaler usually adds a node for an unschedulable pod within a few
  // minutes (a scale-up from zero often waits for one), so only then is it broken.
  if (status === 'Unschedulable') return now - (t(pod.metadata.creationTimestamp) || now) > UNSCHEDULABLE_GRACE_MS ? 'bad' : 'pending';
  if (BAD.has(status) || status.startsWith('Init:') && status !== 'Init:PodInitializing') return 'bad';
  if (status === 'Running') return 'ok';
  if (status === 'Completed') return 'done';
  const age = now - (t(pod.status?.startTime) || t(pod.metadata.creationTimestamp) || now);
  if (status === 'Terminating') return age > 0 && now - (t(pod.metadata.deletionTimestamp) || now) > 120_000 ? 'warn' : 'pending';
  if (PENDINGISH.has(status)) return age > 180_000 ? 'warn' : 'pending';
  return 'warn'; // NotReady, Unknown
}

// Helper containers that run next to the app and rarely log anything useful.
const SIDECAR = /^(cloud-?sql-proxy|cloudsql|istio-proxy|linkerd-proxy|envoy|fluent-?bit|fluentd|otel|opentelemetry|vault-agent|datadog|consul|metrics-exporter)/i;

/**
 * The app's own container: the one named like its workload (flobi-brand or brand),
 * else the first one in the pod spec that isn't a known sidecar. Container statuses
 * come back sorted by name, so "the first container" would often be a sidecar.
 */
export function mainContainerName(specContainers, workload) {
  const names = (specContainers || []).map((c) => c.name);
  const short = String(workload || '').replace(/^flobi-/, '');
  return names.find((n) => n === workload || n === short) || names.find((n) => !SIDECAR.test(n)) || names[0] || null;
}

export function summarizePod(pod, metrics, now = Date.now()) {
  const status = podStatus(pod);
  const state = podState(status, pod, now);
  const specs = new Map((pod.spec?.containers || []).map((c) => [c.name, c]));
  const m = metrics?.get(pod.metadata.name);
  const usage = new Map((m?.containers || []).map((c) => [c.name, c.usage]));
  let restarts = 0;
  let lastTermination = null;
  const containers = (pod.status?.containerStatuses || []).map((c) => {
    restarts += c.restartCount || 0;
    const lt = c.lastState?.terminated;
    if (lt && (!lastTermination || t(lt.finishedAt) > lastTermination.at)) {
      lastTermination = { container: c.name, reason: lt.reason, exitCode: lt.exitCode, at: t(lt.finishedAt), message: lt.message || null };
    }
    const spec = specs.get(c.name) || {};
    const u = usage.get(c.name) || {};
    return {
      name: c.name,
      ready: !!c.ready,
      restarts: c.restartCount || 0,
      state: c.state?.running ? 'running' : c.state?.waiting ? 'waiting' : c.state?.terminated ? 'terminated' : 'unknown',
      reason: c.state?.waiting?.reason || c.state?.terminated?.reason || null,
      message: c.state?.waiting?.message || c.state?.terminated?.message || null,
      startedAt: t(c.state?.running?.startedAt),
      image: (c.image || spec.image || '').split('/').pop(),
      cpu: u.cpu ? cpuMilli(u.cpu) : null,
      mem: u.memory ? bytes(u.memory) : null,
      cpuRequest: cpuMilli(spec.resources?.requests?.cpu),
      cpuLimit: cpuMilli(spec.resources?.limits?.cpu),
      memRequest: bytes(spec.resources?.requests?.memory),
      memLimit: bytes(spec.resources?.limits?.memory),
    };
  });
  const sum = (k) => containers.reduce((a, c) => a + (c[k] || 0), 0);
  const readyCount = containers.filter((c) => c.ready).length;
  // Only a container with a memory limit can hit it: a sidecar without one (a
  // proxy next to the app) mustn't count against the app's limit.
  const memPcts = containers.filter((c) => c.mem != null && c.memLimit > 0).map((c) => c.mem / c.memLimit);
  return {
    name: pod.metadata.name,
    uid: pod.metadata.uid,
    service: workloadOf(pod),
    status,
    state,
    terminal: isTerminal(pod),
    ready: readyCount === containers.length && containers.length > 0,
    readyText: `${readyCount}/${containers.length || (pod.spec?.containers || []).length}`,
    restarts,
    lastTermination,
    node: pod.spec?.nodeName || null,
    ip: pod.status?.podIP || null,
    createdAt: t(pod.metadata.creationTimestamp),
    startedAt: t(pod.status?.startTime),
    message: pod.status?.message || containers.find((c) => c.message)?.message || null,
    containers,
    mainContainer: mainContainerName(pod.spec?.containers, workloadOf(pod)),
    cpu: m ? sum('cpu') : null,
    mem: m ? sum('mem') : null,
    memPct: memPcts.length ? Math.max(...memPcts) : null,
    cpuRequest: sum('cpuRequest'),
    cpuLimit: sum('cpuLimit'),
    memRequest: sum('memRequest'),
    memLimit: sum('memLimit'),
  };
}

// ── Services (workloads) ────────────────────────────────────────────────────
function hpaFor(name, hpas, scaledobjects) {
  const h = hpas.find((x) => x.spec?.scaleTargetRef?.name === name);
  const so = scaledobjects.find((x) => x.spec?.scaleTargetRef?.name === name);
  if (!h && !so) return null;
  const cpuMetric = (h?.spec?.metrics || []).find((m) => m.resource?.name === 'cpu');
  const cpuCurrent = (h?.status?.currentMetrics || []).find((m) => m.resource?.name === 'cpu');
  const memMetric = (h?.spec?.metrics || []).find((m) => m.resource?.name === 'memory');
  const memCurrent = (h?.status?.currentMetrics || []).find((m) => m.resource?.name === 'memory');
  // KEDA's defaults are 0 and 100 (its own HPA says min 1: KEDA does 0 ↔ 1 itself).
  const min = so ? so.spec?.minReplicaCount ?? 0 : h?.spec?.minReplicas ?? 1;
  const max = so?.spec?.maxReplicaCount ?? h?.spec?.maxReplicas ?? (so ? 100 : min);
  const current = h?.status?.currentReplicas ?? null;
  const desired = h?.status?.desiredReplicas ?? null;
  const cpuTarget = cpuMetric?.resource?.target?.averageUtilization ?? null;
  const cpuNow = cpuCurrent?.resource?.current?.averageUtilization ?? null;
  return {
    kind: so ? 'keda' : 'hpa',
    name: so?.metadata?.name || h?.metadata?.name,
    min,
    max,
    current,
    desired,
    cpuTarget,
    cpuNow,
    memTarget: memMetric?.resource?.target?.averageUtilization ?? null,
    memNow: memCurrent?.resource?.current?.averageUtilization ?? null,
    triggers: (so?.spec?.triggers || []).map((tr) => tr.type),
    atMax: current != null && max != null && current >= max && max > min,
    lastScaleAt: t(h?.status?.lastScaleTime),
    limited: (h?.status?.conditions || []).some((c) => c.type === 'ScalingLimited' && c.status === 'True'),
  };
}

export function serviceHealth(svc) {
  const reasons = [];
  let health = 'healthy';
  const bump = (h) => {
    const order = { healthy: 0, deploying: 1, degraded: 2, down: 3 };
    if (order[h] > order[health]) health = h;
  };
  if (svc.desired === 0) return { health: 'idle', reasons: ['Scaled to zero'] };
  const bad = svc.podList.filter((p) => p.state === 'bad');
  if (svc.ready === 0) {
    bump('down');
    reasons.push(`0 of ${svc.desired} pods ready`);
  } else if (svc.ready < svc.desired) {
    if (svc.rollingOut) {
      bump('deploying');
      reasons.push(`Rolling out (${svc.updated}/${svc.desired} updated)`);
    } else {
      bump('degraded');
      reasons.push(`${svc.ready} of ${svc.desired} pods ready`);
    }
  } else if (svc.rollingOut) {
    bump('deploying');
    reasons.push('Rolling out a new version');
  }
  // Kubernetes gave up waiting for the new pods (progressDeadlineSeconds): it
  // won't finish by itself, so it's no longer "deploying".
  if (svc.rolloutStuck) {
    bump('degraded');
    reasons.push("Rollout stuck: new pods didn't become ready in time");
  }
  for (const p of bad) {
    bump(svc.ready === 0 ? 'down' : 'degraded');
    const oom = p.lastTermination?.reason === 'OOMKilled';
    reasons.push(`${p.name.replace(`${svc.name}-`, '…')} ${p.status}${oom && p.status !== 'OOMKilled' ? ' (OOMKilled)' : ''}`);
  }
  if (svc.recentRestarts > 0) {
    bump('degraded');
    reasons.push(`${svc.recentRestarts} restart${svc.recentRestarts > 1 ? 's' : ''} in the last 15 min`);
  }
  if (svc.memPct != null && svc.memPct >= 0.9) {
    bump('degraded');
    reasons.push(`Memory at ${Math.round(svc.memPct * 100)}% of limit`);
  }
  if (svc.scaling?.atMax && svc.scaling.cpuTarget && svc.scaling.cpuNow > svc.scaling.cpuTarget) {
    bump('degraded');
    reasons.push(`At max replicas (${svc.scaling.max}) and CPU still ${svc.scaling.cpuNow}%`);
  }
  return { health, reasons };
}

/**
 * @param {object} raw  { pods, deployments, statefulsets, services, hpas, scaledobjects, nodes, jobs, cronjobs, ingresses, certificates, events, nodeEvents }
 * @param {Map<string,object>} podMetrics name → metrics
 * @param {Map<string,number[]>} restartLedger pod/container → restart timestamps
 */
export function buildModel(raw, { podMetrics = new Map(), nodeMetrics = new Map(), restartLedger = new Map(), now = Date.now() } = {}) {
  const pods = (raw.pods || []).map((p) => summarizePod(p, podMetrics, now));
  const byService = new Map();
  for (const p of pods) {
    if (!byService.has(p.service)) byService.set(p.service, []);
    byService.get(p.service).push(p);
  }
  const hpas = raw.hpas || [];
  const scaledobjects = raw.scaledobjects || [];

  // host/path → k8s service → workload (for "which service serves api.flobi.ai/x")
  const k8sServices = raw.services || [];
  const routes = [];
  for (const ing of raw.ingresses || []) {
    for (const rule of ing.spec?.rules || []) {
      for (const p of rule.http?.paths || []) {
        routes.push({ host: rule.host, path: p.path || '/', service: p.backend?.service?.name });
      }
    }
  }
  const workloadForK8sService = (svcName) => {
    const s = k8sServices.find((x) => x.metadata.name === svcName);
    const sel = s?.spec?.selector || {};
    const w = [...(raw.deployments || []), ...(raw.statefulsets || [])].find((d) => {
      const ml = d.spec?.selector?.matchLabels || {};
      return Object.keys(sel).length && Object.entries(sel).every(([k, v]) => ml[k] === v);
    });
    return w?.metadata?.name || svcName;
  };

  const workloads = [
    ...(raw.deployments || []).map((d) => ({ d, kind: 'Deployment' })),
    ...(raw.statefulsets || []).map((d) => ({ d, kind: 'StatefulSet' })),
  ];
  const services = workloads.map(({ d, kind }) => {
    const name = d.metadata.name;
    // Pods that finished long ago (evicted, preempted…) are left out; recent ones
    // are listed but never count against the service's health.
    const podList = (byService.get(name) || []).filter((p) => p.state !== 'done');
    const live = podList.filter((p) => !p.terminal);
    const desired = d.spec?.replicas ?? 1;
    const st = d.status || {};
    const ready = st.readyReplicas || 0;
    const updated = st.updatedReplicas || 0;
    const rollingOut = (d.metadata.generation && st.observedGeneration < d.metadata.generation) || (updated < desired && (st.replicas || 0) > 0 && (st.replicas || 0) !== updated);
    const rolloutStuck = (st.conditions || []).some((c) => c.type === 'Progressing' && c.status === 'False' && c.reason === 'ProgressDeadlineExceeded');
    const memPcts = live.map((p) => p.memPct).filter((x) => x != null);
    const cpuPcts = live.map((p) => (p.cpu != null && (p.cpuLimit || p.cpuRequest) ? p.cpu / (p.cpuLimit || p.cpuRequest) : null)).filter((x) => x != null);
    const container = d.spec?.containers?.find((c) => c.name === mainContainerName(d.spec?.containers, name)) || {};
    let recentRestarts = 0;
    for (const p of live) {
      for (const c of p.containers) {
        const times = restartLedger.get(`${p.name}/${c.name}`) || [];
        recentRestarts += times.filter((x) => now - x < 15 * 60_000).length;
      }
    }
    const svc = {
      name,
      short: shortName(name),
      kind,
      desired,
      ready,
      available: st.availableReplicas || 0,
      updated,
      rollingOut: !!rollingOut,
      revision: d.metadata.annotations?.revision || null,
      image: (container.image || '').split('/').pop(),
      podList,
      pods: podList.map((p) => ({ name: p.name, state: p.state, status: p.status })),
      restarts: podList.reduce((a, p) => a + p.restarts, 0),
      recentRestarts,
      rolloutStuck,
      cpu: podList.some((p) => p.cpu != null) ? podList.reduce((a, p) => a + (p.cpu || 0), 0) : null,
      mem: podList.some((p) => p.mem != null) ? podList.reduce((a, p) => a + (p.mem || 0), 0) : null,
      memPct: memPcts.length ? Math.max(...memPcts) : null,
      cpuPct: cpuPcts.length ? Math.max(...cpuPcts) : null,
      memLimit: container.resources?.limits?.memory || null,
      cpuLimit: container.resources?.limits?.cpu || null,
      scaling: hpaFor(name, hpas, scaledobjects),
      hosts: routes.filter((r) => workloadForK8sService(r.service) === name).map((r) => `${r.host}${r.path === '/' ? '' : r.path}`),
      createdAt: t(d.metadata.creationTimestamp),
    };
    const { health, reasons } = serviceHealth(svc);
    svc.health = health;
    svc.reasons = reasons;
    delete svc.podList;
    return svc;
  });

  // ── Nodes ────────────────────────────────────────────────────────────────
  const nodes = (raw.nodes || []).map((n) => {
    const cond = (type) => (n.status?.conditions || []).find((c) => c.type === type);
    const ready = cond('Ready')?.status === 'True';
    // When it stopped being ready; a node that never reported Ready counts from when it joined.
    const notReadySince = ready ? null : t(cond('Ready')?.lastTransitionTime) ?? t(n.metadata.creationTimestamp);
    const pressure = ['MemoryPressure', 'DiskPressure', 'PIDPressure'].filter((ty) => cond(ty)?.status === 'True');
    const m = nodeMetrics.get(n.metadata.name);
    const cpuAlloc = cpuMilli(n.status?.allocatable?.cpu);
    const memAlloc = bytes(n.status?.allocatable?.memory);
    const cpu = m ? cpuMilli(m.usage?.cpu) : null;
    const mem = m ? bytes(m.usage?.memory) : null;
    return {
      name: n.metadata.name,
      ready,
      notReadySince,
      pressure,
      unschedulable: !!n.spec?.unschedulable,
      pool: n.metadata.labels?.['cloud.google.com/gke-nodepool'] || null,
      machine: n.metadata.labels?.['node.kubernetes.io/instance-type'] || null,
      zone: n.metadata.labels?.['topology.kubernetes.io/zone'] || null,
      spot: n.metadata.labels?.['cloud.google.com/gke-spot'] === 'true' || n.metadata.labels?.['cloud.google.com/gke-preemptible'] === 'true',
      version: n.status?.nodeInfo?.kubeletVersion,
      cpuAlloc,
      memAlloc,
      cpu,
      mem,
      cpuPct: cpu != null && cpuAlloc ? cpu / cpuAlloc : null,
      memPct: mem != null && memAlloc ? mem / memAlloc : null,
      pods: pods.filter((p) => p.node === n.metadata.name && !p.terminal).length,
      createdAt: t(n.metadata.creationTimestamp),
      state: !ready ? 'bad' : pressure.length || n.spec?.unschedulable ? 'warn' : 'ok',
      message: !ready ? cond('Ready')?.message || 'Node is not ready' : pressure.length ? pressure.join(', ') : null,
    };
  });

  // ── Scaling ──────────────────────────────────────────────────────────────
  const scaling = services.filter((s) => s.scaling).map((s) => ({ service: s.name, short: s.short, ready: s.ready, ...s.scaling }));

  // ── Jobs & CronJobs ──────────────────────────────────────────────────────
  const jobs = (raw.jobs || [])
    .map((j) => {
      const st = j.status || {};
      const failed = (st.conditions || []).find((c) => c.type === 'Failed' && c.status === 'True');
      const complete = (st.conditions || []).find((c) => c.type === 'Complete' && c.status === 'True');
      return {
        name: j.metadata.name,
        owner: j.metadata.ownerReferences?.[0]?.name || null,
        startedAt: t(st.startTime),
        finishedAt: t(st.completionTime) || t(failed?.lastTransitionTime),
        status: failed ? 'failed' : complete ? 'succeeded' : st.active ? 'running' : 'pending',
        message: failed?.message || failed?.reason || null,
      };
    })
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  const cronjobs = (raw.cronjobs || []).map((c) => {
    const mine = jobs.filter((j) => j.owner === c.metadata.name);
    const last = mine[0] || null;
    return {
      name: c.metadata.name,
      schedule: c.spec?.schedule,
      suspended: !!c.spec?.suspend,
      lastScheduleAt: t(c.status?.lastScheduleTime),
      lastSuccessAt: t(c.status?.lastSuccessfulTime),
      active: (c.status?.active || []).length,
      lastStatus: last?.status || null,
      lastMessage: last?.message || null,
      state: last?.status === 'failed' ? 'bad' : 'ok',
    };
  });

  // ── Certificates & ingress ───────────────────────────────────────────────
  const certificates = (raw.certificates || []).map((c) => ({
    name: c.metadata.name,
    status: c.status?.certificateStatus || 'Unknown',
    expiresAt: t(c.status?.expireTime),
    domains: (c.status?.domainStatus || (c.spec?.domains || []).map((d) => ({ domain: d, status: 'Unknown' }))).map((d) => ({ domain: d.domain, status: d.status })),
    state: c.status?.certificateStatus === 'Active' ? 'ok' : 'warn',
  }));
  const ingress = (raw.ingresses || []).map((i) => ({
    name: i.metadata.name,
    ip: i.status?.loadBalancer?.ingress?.[0]?.ip || null,
    rules: (i.spec?.rules || []).flatMap((r) => (r.http?.paths || []).map((p) => ({ host: r.host, path: p.path || '/', service: p.backend?.service?.name, workload: workloadForK8sService(p.backend?.service?.name) }))),
  }));

  return { services, pods, nodes, scaling, jobs: { cronjobs, jobs: jobs.slice(0, 30) }, certificates, ingress, routes: routes.map((r) => ({ ...r, workload: workloadForK8sService(r.service) })) };
}

/** Longest-prefix route match: which workload serves host+path. */
export function makeRouter(routes) {
  const sorted = [...routes].sort((a, b) => (b.path || '').length - (a.path || '').length);
  return (host, path) => {
    for (const r of sorted) {
      if (r.host && r.host !== host) continue;
      if (path.startsWith(r.path)) return r.workload || r.service;
    }
    return null;
  };
}

export function summarizeEvent(e) {
  const at = t(e.lastTimestamp) || t(e.firstTimestamp) || t(e.metadata?.creationTimestamp) || Date.now();
  const kind = e.involvedObject?.kind;
  const name = e.involvedObject?.name || '';
  return {
    id: e.metadata?.uid || `${name}:${e.reason}:${at}`,
    at,
    firstAt: t(e.firstTimestamp) || at,
    type: e.type || 'Normal',
    reason: e.reason || '',
    message: e.message || '',
    kind,
    name,
    count: e.count || 1,
    // Raw events carry { component, host } (demo mode sends them unslimmed): the UI prints this.
    source: typeof e.source === 'string' ? e.source : e.source?.component || e.reportingComponent || null,
  };
}
