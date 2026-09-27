/** GKE NEG backend service name → Kubernetes service.
 *  "k8s1-1a2b3c4d-flobi-flobi-gateway-80-9x8y7z6w" → { namespace:'flobi', service:'flobi-gateway', port:80 } */
export function parseBackendName(name, namespace) {
  if (!name) return null;
  const m = String(name).match(/^k8s1-[a-z0-9]+-(.+)-(\d+)-[a-z0-9]+$/);
  if (!m) return null;
  const rest = m[1];
  if (namespace && rest.startsWith(`${namespace}-`)) {
    return { namespace, service: rest.slice(namespace.length + 1), port: Number(m[2]) };
  }
  const i = rest.indexOf('-');
  return { namespace: rest.slice(0, i), service: rest.slice(i + 1), port: Number(m[2]) };
}
