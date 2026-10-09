// What a service is using right now and over the last hour: shared by the Services cards and the table.
import { useLayoutEffect, useRef, useState } from 'react';
import { pct, ago, clockHM } from '../lib/format.js';

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

const H = 34;
const GAP = 2 * 60_000; // points further apart than this were a time the app was closed: the line breaks there

/** Line and area paths for points on a time axis, broken wherever the app wasn't watching. 100 × H units. */
function linePaths(times, values, x, y, h = H) {
  let line = '';
  let area = '';
  let seg = [];
  const flush = () => {
    if (seg.length > 1) {
      const d = seg.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join('');
      line += d;
      area += `${d}L${seg[seg.length - 1][0].toFixed(2)},${h}L${seg[0][0].toFixed(2)},${h}Z`;
    }
    seg = [];
  };
  times.forEach((t, i) => {
    if (i && t - times[i - 1] > GAP) flush();
    seg.push([x(t), y(values[i])]);
  });
  flush();
  return { line, area };
}

/**
 * A card's last hour along its bottom edge, laid out by time:
 * - CPU, solid, scaled to its own peak so a quiet service still shows its shape.
 * - Memory, dashed, on 0–100% of the limit, so near the top means near the limit.
 * - A mark where the service was deployed.
 * Pointing at it says what both were at that moment, and names a deploy under the pointer.
 */
export function UsageLine({ cpu, mem, deploys, max, color, memColor, height = H }) {
  const [at, setAt] = useState(null); // a moment, ms
  const boxRef = useRef(null);
  const tipRef = useRef(null);
  const ends = [cpu?.times, mem?.times].filter((t) => t?.length);
  const until = Math.max(...ends.map((t) => t[t.length - 1]));
  const since = Math.max(until - 60 * 60_000, Math.min(...ends.map((t) => t[0])));
  const span = Math.max(1, until - since);
  const x = (t) => ((t - since) / span) * 100;
  const yOf = (m) => (v) => height - 1.25 - (Math.min(Math.max(v, 0), m) / m) * (height - 2.5);
  const cpuPaths = cpu && linePaths(cpu.times, cpu.points, x, yOf(max), height);
  const memPaths = mem && linePaths(mem.times, mem.points, x, yOf(1), height);
  const marks = (deploys || []).filter((t) => t >= since && t <= until);
  const nearest = (s) => {
    if (!s || at == null) return null;
    let best = 0;
    for (let i = 1; i < s.times.length; i++) if (Math.abs(s.times[i] - at) < Math.abs(s.times[best] - at)) best = i;
    return Math.abs(s.times[best] - at) <= GAP ? best : null;
  };
  const ci = nearest(cpu);
  const mi = nearest(mem);
  const deploy = at != null ? marks.find((t) => Math.abs(t - at) <= span / 40) : null;
  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    setAt(since + Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * span);
  };
  const ax = at != null ? x(at) : 0;
  // The label sits centred on the pointer, but never past either edge of the card (which clips it).
  useLayoutEffect(() => {
    const box = boxRef.current;
    const tip = tipRef.current;
    if (!box || !tip) return;
    const w = box.clientWidth;
    const tw = tip.offsetWidth;
    tip.style.left = `${Math.max(6, Math.min(w - tw - 6, (ax / 100) * w - tw / 2))}px`;
  });
  const cpuText = ci != null ? (cpu.unit === 'pct' ? `${pct(cpu.points[ci])} CPU` : `${cpu.points[ci].toFixed(2)} cores`) : null;
  const memText = mi != null ? `${pct(mem.points[mi])} mem` : null;
  return (
    <div ref={boxRef} className="relative" style={{ height }} onMouseMove={onMove} onMouseLeave={() => setAt(null)}>
      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className="absolute inset-0 w-full h-full overflow-visible" aria-hidden="true">
        {cpuPaths && <path d={cpuPaths.area} fill={color} opacity="0.1" />}
        {memPaths && <path d={memPaths.line} fill="none" stroke={memColor} strokeWidth="1.25" strokeDasharray="3 2.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
        {cpuPaths && <path d={cpuPaths.line} fill="none" stroke={color} strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
      </svg>
      {marks.map((t) => (
        <span key={t} className="absolute top-0 bottom-0 pointer-events-none" style={{ left: `${x(t)}%` }}>
          <span className="absolute top-0 bottom-0 w-px -ml-px bg-[color-mix(in_srgb,var(--accent)_55%,transparent)]" />
          <span className="absolute top-0 w-[5px] h-[5px] -ml-[3px] rotate-45 bg-[var(--accent)]" />
        </span>
      ))}
      {at != null && (cpuText || memText || deploy) && (
        <>
          <span className="absolute top-0 bottom-0 w-px bg-[var(--line-strong)] pointer-events-none" style={{ left: `${ax}%` }} />
          <span
            ref={tipRef}
            className="absolute top-0.5 px-1.5 py-px rounded-[6px] bg-[var(--bg-elevated)] shadow-[inset_0_0_0_1px_var(--line-strong)] text-footnote tabular whitespace-nowrap pointer-events-none"
          >
            {deploy ? (
              <span className="text-accent font-medium">Deployed {clockHM(deploy)}</span>
            ) : (
              <span className="text-label">{[cpuText, memText].filter(Boolean).join(' · ')}</span>
            )}
            <span className="text-label-3"> · {ago(deploy || (ci != null ? cpu.times[ci] : mem.times[mi]))}</span>
          </span>
        </>
      )}
    </div>
  );
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
