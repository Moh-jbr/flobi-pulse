// What alerts say. Every alert answers four questions, in plain words:
//   title  – what is wrong ("brand keeps crashing on start")
//   detail – the evidence, with numbers ("exit code 1 · 6 restarts in 15 min")
//   impact – who or what is affected ("Requests to api.flobi.ai/brand are failing")
//   action – the next step ("Open the pod and read the logs from right before the crash")
// Vague alerts get ignored, so none of these should be vague.
import { shortName } from './log-parse.mjs';

const pct = (x) => `${Math.round(x * 100)}%`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "1536Mi" → "1.5 GB", "512Mi" → "512 MB" (also "1288490188800m", how Kubernetes may store 1.2Gi). */
export function memText(limit) {
  const m = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|k|M|G|T|m)?$/.exec(String(limit || ''));
  if (!m) return limit || null;
  const mib = Number(m[1]) * ({ Ki: 1 / 1024, K: 1 / 1024 / 1.048576, k: 1 / 1024 / 1.048576, Mi: 1, M: 1 / 1.048576, Gi: 1024, G: 1000 / 1.048576, Ti: 1024 * 1024, T: 1e6 / 1.048576, m: 1 / 1000 / 1048576 }[m[2]] ?? 1 / 1048576);
  return mib >= 1024 ? `${(mib / 1024).toFixed(mib % 1024 ? 1 : 0)} GB` : `${Math.round(mib)} MB`;
}

/** Why a container stopped, from its exit code. */
export function exitText(code, reason) {
  if (reason === 'OOMKilled' || code === 137) return reason === 'OOMKilled' ? 'ran out of memory' : 'was killed (exit 137: out of memory or force-stopped)';
  if (code === 143) return 'was stopped (exit 143)';
  if (code === 139) return 'crashed (exit 139: segmentation fault)';
  if (code === 1) return 'crashed (exit code 1: the app threw an error on its way out)';
  if (code === 0) return "exited on its own (exit 0), which a server shouldn't do";
  return code != null ? `stopped with exit code ${code}` : 'stopped';
}

function whoIsHit(s) {
  const hosts = s.hosts || [];
  if (hosts.length) return `Requests to ${hosts.slice(0, 2).join(' and ')}${hosts.length > 2 ? ` (+${hosts.length - 2})` : ''} are affected.`;
  return `Anything that calls ${shortName(s.name)} is affected.`;
}

/** What most of a service's broken pods are stuck on, if anything. */
function podTrouble(s) {
  const bad = (s.pods || []).filter((p) => p.state === 'bad').map((p) => p.status);
  const has = (...xs) => bad.some((b) => xs.includes(b));
  if (has('OOMKilled')) return 'oom';
  if (has('CrashLoopBackOff', 'Error', 'RunContainerError')) return 'crash';
  if (has('ImagePullBackOff', 'ErrImagePull', 'InvalidImageName')) return 'image';
  if (has('CreateContainerConfigError', 'CreateContainerError')) return 'config';
  if (has('Unschedulable')) return 'schedule';
  if (has('Evicted')) return 'evicted';
  return null;
}

const TROUBLE_ACTION = {
  oom: (s) => `Its pods run out of memory${s.memLimit ? ` (limit ${memText(s.memLimit)})` : ''}. Raise the memory limit, or look for a leak in the latest changes.`,
  crash: () => 'Its pods crash right after starting. Open a pod and read the logs from right before the crash: the error is there.',
  image: () => "Its pods can't download their container image. The image tag in the last deploy probably doesn't exist, or the registry refused access.",
  config: () => "Its pods can't start because a Secret or ConfigMap they need is missing. The pod's events name it.",
  schedule: () => 'No node has room for its pods. The cluster needs another node, or the pods ask for too much CPU or memory.',
  evicted: () => 'Kubernetes evicted its pods because their node ran short on memory or disk.',
};

/** svc-down / svc-degraded */
export function serviceCopy(s) {
  const name = shortName(s.name);
  const trouble = podTrouble(s);
  if (s.health === 'down' && s.desired === 0) {
    // Scaled to 0 by hand (no autoscaler does it): nothing is broken, it's off.
    return {
      title: `${name} is stopped: it was scaled down to 0 pods`,
      detail: s.reasons.join(' · '),
      impact: `${whoIsHit(s)} They fail until it runs again.`,
      action: `If that wasn't on purpose, scale it back up (kubectl scale ${String(s.kind || 'deployment').toLowerCase()} ${s.name} --replicas=1) or re-run its deploy.`,
    };
  }
  if (s.health === 'down') {
    return {
      title: s.desired === 1 ? `${name} is down: its pod isn't ready` : `${name} is down: none of its ${s.desired} pods are ready`,
      detail: s.reasons.join(' · '),
      impact: `${whoIsHit(s)} They fail until a pod is ready again.`,
      action: trouble ? TROUBLE_ACTION[trouble](s) : 'Open the service to see why its pods aren’t ready (pod events and logs).',
    };
  }
  if (s.memPct != null && s.memPct >= 0.9) {
    return {
      title: `${name} is at ${pct(s.memPct)} of its memory limit`,
      detail: s.reasons.join(' · '),
      impact: `At 100% Kubernetes kills the pod (out of memory), and requests fail while it restarts. ${whoIsHit(s)}`,
      action: `Raise its memory limit${s.memLimit ? ` (now ${memText(s.memLimit)})` : ''}, or look for what's holding memory (a leak or a big cache) in recent changes.`,
    };
  }
  if (trouble) {
    return {
      title: `${name}: ${s.ready} of ${s.desired} pods working, the rest ${{ oom: 'run out of memory', crash: 'keep crashing', image: "can't download their image", config: 'are missing a Secret or ConfigMap', schedule: "can't find a node", evicted: 'were evicted' }[trouble]}`,
      detail: s.reasons.join(' · '),
      impact: `It runs with less capacity. If the working pods fail too, ${name} goes down. ${whoIsHit(s)}`,
      action: TROUBLE_ACTION[trouble](s),
    };
  }
  if (s.rolloutStuck) {
    return {
      title: `${name}: the new version is stuck rolling out`,
      detail: s.reasons.join(' · '),
      impact: `Its new pods didn't become ready in time, so Kubernetes marked the rollout as failed. The old pods keep serving meanwhile. ${whoIsHit(s)}`,
      action: 'Open the service: the new pods’ events and logs say why they don’t get ready (often a failing health check or a crash on start). Fix it and deploy again, or roll back.',
    };
  }
  if (s.recentRestarts > 0) {
    return {
      title: `${name} restarted ${s.recentRestarts}× in the last 15 minutes`,
      detail: s.reasons.join(' · '),
      impact: `Requests in flight fail every time it restarts. ${whoIsHit(s)}`,
      action: 'Open Crashes & Down: each restart shows its reason and the logs from right before it.',
    };
  }
  if (s.ready < s.desired) {
    return {
      title: `${name}: only ${s.ready} of ${s.desired} pods are ready`,
      detail: s.reasons.join(' · '),
      impact: `It runs with less capacity than planned. ${whoIsHit(s)}`,
      action: 'Open the service to see why the other pods aren’t ready (events and logs).',
    };
  }
  if (s.scaling?.atMax) {
    return {
      title: `${name} is at its maximum of ${s.scaling.max} pods and still busy (CPU ${s.scaling.cpuNow}%)`,
      detail: s.reasons.join(' · '),
      impact: `It can't add pods, so it may slow down or drop requests under more load. ${whoIsHit(s)}`,
      action: `Raise max replicas in its autoscaler (now ${s.scaling.max}), or find what's using the CPU.`,
    };
  }
  return { title: `${name} isn't healthy`, detail: s.reasons.join(' · '), impact: whoIsHit(s), action: 'Open the service to see what’s wrong.' };
}

/** pod:<name> — a pod stuck in a bad state. */
export function podCopy(p) {
  const name = shortName(p.service || p.name);
  const lt = p.lastTermination;
  const evidence = [lt?.reason && `last exit: ${lt.reason}${lt.exitCode != null ? ` (code ${lt.exitCode})` : ''}`, p.message, p.restarts ? `${plural(p.restarts, 'restart')}` : null].filter(Boolean).join(' · ');
  const by = {
    CrashLoopBackOff: [`${name}: a pod keeps crashing on start`, 'Open the pod and read “Logs before the crash”: the error that makes it exit is there.'],
    OOMKilled: [`${name}: a pod ran out of memory`, 'Raise the memory limit, or find what uses the memory (open the pod for its usage chart).'],
    Error: [`${name}: a pod ${exitText(lt?.exitCode, lt?.reason)}`, 'Open the pod and read the logs from right before it stopped.'],
    RunContainerError: [`${name}: a pod can't start its container`, 'Open the pod: its events say why (often a bad command or missing file).'],
    ImagePullBackOff: [`${name}: a pod can't download its image`, "The image tag in the last deploy probably doesn't exist, or the registry refused access. Check the deploy."],
    ErrImagePull: [`${name}: a pod can't download its image`, "The image tag in the last deploy probably doesn't exist, or the registry refused access. Check the deploy."],
    InvalidImageName: [`${name}: a pod has an invalid image name`, 'Fix the image name in the deployment.'],
    CreateContainerConfigError: [`${name}: a pod is missing a Secret or ConfigMap`, 'The pod’s events name the missing one. Create it, or fix the name in the deployment.'],
    CreateContainerError: [`${name}: a pod can't create its container`, 'Open the pod: its events say why.'],
    Unschedulable: [`${name}: a pod can't be placed on any node`, 'No node has enough free CPU or memory. The cluster needs another node, or the pod asks for too much.'],
    Evicted: [`${name}: a pod was evicted`, 'Its node ran short on memory or disk. Kubernetes starts a replacement by itself; if it keeps happening, check node usage.'],
    Failed: [`${name}: a pod failed`, 'Open the pod to see its events and logs.'],
  }[p.status] || [`${name}: a pod is ${p.status}`, 'Open the pod to see its events and logs.'];
  return { title: by[0], detail: evidence || p.status, impact: 'This pod serves no requests; the others take its share.', action: by[1] };
}

/** A failed uptime check, in words. */
export function uptimeCopy(u) {
  const err = String(u.error || '');
  const host = (() => {
    try {
      return new URL(u.url).host;
    } catch {
      return u.url;
    }
  })();
  let why;
  let action;
  if (/ENOTFOUND|EAI_AGAIN/.test(err)) (why = `the domain ${host} doesn't resolve`), (action = 'Check the DNS record for this domain (Cloudflare or your DNS host).');
  else if (/ECONNREFUSED/.test(err)) (why = 'nothing accepts connections there'), (action = 'The service or its load balancer is down: open the service it points to.');
  else if (/ETIMEDOUT|timed out|ESOCKETTIMEDOUT/i.test(err)) (why = "it doesn't answer in time"), (action = "It's overloaded or unreachable: check the service's pods and Live Traffic.");
  else if (/CERT|certificate|SSL|TLS/i.test(err)) (why = 'its HTTPS certificate is invalid or expired'), (action = 'Check the certificate on Infrastructure → Certificates.');
  else if (/ECONNRESET|socket hang up/i.test(err)) (why = 'the connection drops before it answers'), (action = 'The service is probably restarting or crashing: check Crashes & Down.');
  else if (u.status >= 500) (why = `it answers with a server error (HTTP ${u.status})`), (action = "Open the service's logs: the error is logged there.");
  else if (u.status >= 400) (why = `it answers HTTP ${u.status}`), (action = 'The URL may have moved or now needs sign-in. Check the uptime URL in Settings.');
  else (why = err || `HTTP ${u.status}`), (action = 'Open the page in a browser to see what visitors get.');
  return { title: `${u.name} is unreachable: ${why}`, detail: `${u.url} → ${err || `HTTP ${u.status}`} · failed ${u.failStreak} checks in a row`, impact: 'Users of this page or API can’t use it right now.', action };
}

/** A container restart seen by the app (one-shot). */
export function crashCopy(crash) {
  const name = shortName(crash.service);
  const oom = crash.reason === 'OOMKilled';
  return {
    title: oom ? `${name} ran out of memory and restarted` : `${name} crashed and restarted`,
    detail: `${crash.pod}: it ${exitText(crash.exitCode, crash.reason)} · ${plural(crash.restarts, 'restart')} so far`,
    impact: 'Requests it was handling failed; it is back up now if the next start works.',
    action: oom ? 'Raise its memory limit, or look for a leak. Open the crash for the logs from right before it.' : 'Open the crash: it shows the logs from right before it stopped, where the error is.',
  };
}
