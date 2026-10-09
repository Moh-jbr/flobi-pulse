// What a service is using right now: shared by the Services cards and the table (and testable without React).

/**
 * CPU and memory for a card: live from metrics-server against the pod's limit
 * (or request), else what the service's autoscaler last measured, which is
 * against the request. `why` says what a dash means when there's neither.
 */
export function usageOf(s, metricsSource) {
  const scaled = (v) => (v != null ? v / 100 : null);
  const cpu = s.cpuPct ?? scaled(s.scaling?.cpuNow);
  const mem = s.memPct ?? scaled(s.scaling?.memNow);
  const fromScaler = (live, v) => live == null && v != null;
  const st = metricsSource?.status;
  const why = st && st !== 'ok' ? `Metrics server: ${st}${metricsSource.message ? ` — ${metricsSource.message}` : ''}` : !st ? 'Waiting for the metrics server' : 'No limit or request set, and no autoscaler measuring it';
  const title = (live, v, what) => (v == null ? why : fromScaler(live, v) ? `${what} as % of its request, from the autoscaler` : `${what} as % of its limit (or request when it has no limit)`);
  return { cpu, mem, cpuTitle: title(s.cpuPct, cpu, 'CPU'), memTitle: title(s.memPct, mem, 'Memory') };
}

/** "Memory runs out in ~12 min", at the pace of the last 15 minutes, when that's under half an hour away. */
export function memWarning(eta) {
  if (eta == null || eta > 30 * 60_000) return null;
  if (eta < 60_000) return 'Memory is at its limit';
  return `Memory runs out in ~${Math.round(eta / 60_000)} min`;
}

/** The top of a CPU line's scale: its own peak with some headroom, so a quiet service still shows its shape. */
export function cpuMax(spark) {
  if (!spark) return 1;
  return spark.unit === 'pct' ? Math.max(0.1, ...spark.points) * 1.15 : Math.max(...spark.points, 1e-6) * 1.15;
}
