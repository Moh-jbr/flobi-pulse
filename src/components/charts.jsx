// Hand-built SVG charts (no chart library). Thin marks, hairline grid, one
// axis, crosshair tooltip on lines, per-mark tooltip on columns.
import { useMemo, useRef, useState, useEffect } from 'react';
import { cx } from './ui.jsx';
import { clock, compact } from '../lib/format.js';

function useWidth(ref, fallback = 300) {
  const [w, setW] = useState(fallback);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(40, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

function niceMax(v) {
  if (!v || v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * exp;
}

// ── Sparkline ────────────────────────────────────────────────────────────────
export function Sparkline(props) {
  if (props.fluid) return <FluidSparkline {...props} />;
  return <SparklineSvg {...props} />;
}

function FluidSparkline({ className, height = 28, ...rest }) {
  const ref = useRef(null);
  const width = useWidth(ref, 200);
  return (
    <div ref={ref} className={cx('w-full', className)} style={{ height }}>
      <SparklineSvg {...rest} width={width} height={height} />
    </div>
  );
}

function SparklineSvg({ data, width = 96, height = 28, color = 'var(--accent)', area = true, className, max, strokeWidth = 1.5 }) {
  const path = useMemo(() => {
    const vals = (data || []).map((d) => (typeof d === 'number' ? d : d?.v ?? 0));
    if (vals.length < 2) return null;
    const m = max ?? Math.max(...vals, 1e-9);
    const pad = strokeWidth;
    const pts = vals.map((v, i) => [(i / (vals.length - 1)) * width, height - pad - (Math.min(v, m) / m) * (height - pad * 2)]);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
    return { line, area: `${line}L${width},${height}L0,${height}Z`, last: pts[pts.length - 1] };
  }, [data, width, height, max, strokeWidth]);
  if (!path) return <svg width={width} height={height} className={className} aria-hidden="true" />;
  return (
    <svg width={width} height={height} className={cx('overflow-visible', className)} aria-hidden="true">
      {area && <path d={path.area} fill={color} opacity="0.1" />}
      <path d={path.line} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={path.last[0]} cy={path.last[1]} r="2.5" fill={color} stroke="var(--bg-elevated)" strokeWidth="1.5" />
    </svg>
  );
}

// ── Tooltip shell ────────────────────────────────────────────────────────────
function ChartTip({ x, y, width, children }) {
  const left = Math.min(Math.max(x + 12, 4), width - 180);
  return (
    <div className="pointer-events-none absolute z-10 glass-strong rounded-xl px-3 py-2 text-callout min-w-[150px] animate-fade" style={{ left, top: Math.max(0, y - 8) }}>
      {children}
    </div>
  );
}

// ── Line / area chart with crosshair ─────────────────────────────────────────
/**
 * series: [{ key, label, color, points: [{t, v}] }]
 */
export function LineChart({ series, height = 160, format = compact, yMax, className, area = true, emptyText = 'No data yet' }) {
  const ref = useRef(null);
  const width = useWidth(ref);
  const [hover, setHover] = useState(null);
  const padL = 36;
  const padB = 20;
  const padT = 8;
  const innerW = Math.max(10, width - padL - 8);
  const innerH = height - padB - padT;

  const { xs, max, tMin, tMax } = useMemo(() => {
    const all = series.flatMap((s) => s.points);
    if (!all.length) return { xs: [], max: 1, tMin: 0, tMax: 1 };
    const tMin = Math.min(...all.map((p) => p.t));
    const tMax = Math.max(...all.map((p) => p.t));
    const max = yMax ?? niceMax(Math.max(...all.map((p) => p.v)) * 1.1);
    const xs = [...new Set(all.map((p) => p.t))].sort((a, b) => a - b);
    return { xs, max, tMin, tMax };
  }, [series, yMax]);

  const x = (t) => padL + (tMax === tMin ? innerW : ((t - tMin) / (tMax - tMin)) * innerW);
  const y = (v) => padT + innerH - (Math.min(v, max) / max) * innerH;

  if (!xs.length) {
    return (
      <div ref={ref} className={cx('grid place-items-center text-callout text-label-3', className)} style={{ height }}>
        {emptyText}
      </div>
    );
  }

  const ticks = [0, max / 2, max];
  const xTicks = 4;
  const onMove = (e) => {
    const r = ref.current.getBoundingClientRect();
    const px = e.clientX - r.left;
    const t = tMin + ((px - padL) / innerW) * (tMax - tMin);
    let best = xs[0];
    for (const v of xs) if (Math.abs(v - t) < Math.abs(best - t)) best = v;
    setHover({ t: best, px: x(best), py: e.clientY - r.top });
  };

  return (
    <div ref={ref} className={cx('relative select-none', className)} style={{ height }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg width={width} height={height} aria-hidden="true">
        {ticks.map((tv, i) => (
          <g key={i}>
            <line x1={padL} x2={width - 8} y1={y(tv)} y2={y(tv)} stroke="var(--separator)" strokeWidth="1" />
            <text x={padL - 6} y={y(tv) + 3.5} textAnchor="end" fontSize="10" fill="var(--label-3)" className="tabular">
              {format(tv)}
            </text>
          </g>
        ))}
        {Array.from({ length: xTicks + 1 }, (_, i) => {
          const t = tMin + ((tMax - tMin) * i) / xTicks;
          return (
            <text key={i} x={x(t)} y={height - 5} textAnchor={i === 0 ? 'start' : i === xTicks ? 'end' : 'middle'} fontSize="10" fill="var(--label-3)" className="tabular">
              {clock(t, false)}
            </text>
          );
        })}
        {series.map((s) => {
          const pts = [...s.points].sort((a, b) => a.t - b.t);
          if (!pts.length) return null;
          const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
          const areaPath = `${line}L${x(pts[pts.length - 1].t).toFixed(1)},${y(0)}L${x(pts[0].t).toFixed(1)},${y(0)}Z`;
          return (
            <g key={s.key}>
              {area && <path d={areaPath} fill={s.color} opacity="0.1" />}
              <path d={line} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            </g>
          );
        })}
        {hover && (
          <g>
            <line x1={hover.px} x2={hover.px} y1={padT} y2={padT + innerH} stroke="var(--label-3)" strokeWidth="1" />
            {series.map((s) => {
              const p = s.points.find((q) => q.t === hover.t);
              return p ? <circle key={s.key} cx={hover.px} cy={y(p.v)} r="4" fill={s.color} stroke="var(--bg-elevated)" strokeWidth="2" /> : null;
            })}
          </g>
        )}
      </svg>
      {hover && (
        <ChartTip x={hover.px} y={hover.py} width={width}>
          <div className="text-subheadline text-label-2 mb-1 tabular">{clock(hover.t, false)}</div>
          {series.map((s) => {
            const p = s.points.find((q) => q.t === hover.t);
            return (
              <div key={s.key} className="flex items-center gap-2 py-0.5">
                <span className="w-3 h-0.5 rounded-full" style={{ background: s.color }} />
                <span className="text-headline font-semibold tabular">{p ? format(p.v) : '—'}</span>
                <span className="text-label-2">{s.label}</span>
              </div>
            );
          })}
        </ChartTip>
      )}
    </div>
  );
}

// ── Status columns (requests per second by status class) ──────────────────────
const STATUS_SERIES = [
  { key: 'c2', label: '2xx', color: 'var(--accent)' },
  { key: 'c3', label: '3xx', color: 'var(--gray)' },
  { key: 'c4', label: '4xx', color: 'var(--orange)' },
  { key: 'c5', label: '5xx', color: 'var(--red)' },
];

export function StatusColumns({ rows, height = 120, className, unit = 'req/s' }) {
  const ref = useRef(null);
  const width = useWidth(ref);
  const [hover, setHover] = useState(null);
  const n = rows.length || 1;
  const gap = 2;
  const barW = Math.max(1, Math.min(24, width / n - gap));
  const totals = rows.map((r) => r.c2 + r.c3 + r.c4 + r.c5);
  const max = niceMax(Math.max(...totals, 1));
  const padB = 4;
  const innerH = height - padB;
  return (
    <div ref={ref} className={cx('relative', className)} style={{ height }} onMouseLeave={() => setHover(null)}>
      <svg width={width} height={height} aria-hidden="true">
        <line x1="0" x2={width} y1={innerH} y2={innerH} stroke="var(--separator)" />
        {rows.map((r, i) => {
          const bx = i * (barW + gap);
          let yCursor = innerH;
          const segs = STATUS_SERIES.filter((s) => r[s.key] > 0);
          return (
            <g key={r.t} onMouseEnter={(e) => setHover({ i, px: bx, py: e.nativeEvent.offsetY })}>
              <rect x={bx - 1} y={0} width={barW + gap} height={innerH} fill="transparent" />
              {segs.map((s, si) => {
                const h = (r[s.key] / max) * innerH;
                const segGap = si < segs.length - 1 ? 1.5 : 0;
                yCursor -= h;
                const isTop = si === segs.length - 1;
                const rr = Math.min(2, barW / 2, h / 2);
                const y0 = yCursor;
                const hh = Math.max(0.5, h - segGap);
                return isTop ? (
                  <path key={s.key} d={`M${bx},${y0 + hh}V${y0 + rr}q0,-${rr} ${rr},-${rr}h${barW - 2 * rr}q${rr},0 ${rr},${rr}V${y0 + hh}Z`} fill={s.color} opacity={hover && hover.i !== i ? 0.55 : 1} />
                ) : (
                  <rect key={s.key} x={bx} y={y0 + segGap} width={barW} height={hh} fill={s.color} opacity={hover && hover.i !== i ? 0.55 : 1} />
                );
              })}
            </g>
          );
        })}
      </svg>
      {hover && rows[hover.i] && (
        <ChartTip x={hover.px} y={8} width={width}>
          <div className="text-subheadline text-label-2 mb-1 tabular">{clock(rows[hover.i].t)}</div>
          {STATUS_SERIES.map((s) => (
            <div key={s.key} className="flex items-center gap-2 py-0.5">
              <span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: s.color }} />
              <span className="text-headline font-semibold tabular w-6">{rows[hover.i][s.key]}</span>
              <span className="text-label-2">{s.label}</span>
            </div>
          ))}
          <div className="mt-1 pt-1 hairline-t text-label-2 tabular">
            {totals[hover.i]} {unit}
          </div>
        </ChartTip>
      )}
    </div>
  );
}

export function StatusLegend({ counts }) {
  return (
    <div className="flex items-center gap-3 text-callout text-label-2">
      {STATUS_SERIES.map((s) => (
        <span key={s.key} className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-[3px]" style={{ background: s.color }} />
          {s.label}
          {counts && <span className="text-label tabular font-medium">{compact(counts[s.label] ?? 0)}</span>}
        </span>
      ))}
    </div>
  );
}

// ── Uptime history (one bar per check) ───────────────────────────────────────
export function UptimeBars({ history = [], slots = 30, className }) {
  const items = history.slice(-slots);
  const pad = Array.from({ length: Math.max(0, slots - items.length) });
  const color = (s) => (s === 'up' ? 'var(--green)' : s === 'slow' ? 'var(--orange)' : s === 'down' ? 'var(--red)' : 'var(--fill-1)');
  return (
    <div className={cx('flex items-end gap-[2px] h-5', className)}>
      {pad.map((_, i) => (
        <span key={`p${i}`} className="flex-1 h-full rounded-[2px] bg-fill-3" />
      ))}
      {items.map((h, i) => (
        <span key={i} title={`${clock(h.t)} · ${h.state}${h.ms ? ` · ${h.ms} ms` : ''}${h.status ? ` · HTTP ${h.status}` : ''}`} className="flex-1 h-full rounded-[2px]" style={{ background: color(h.state) }} />
      ))}
    </div>
  );
}

/** Inline latency bar for table rows (log scale so 20 ms and 3 s both read). */
export function LatencyBar({ ms: value, className }) {
  if (value == null) return <span className="text-label-3">—</span>;
  const w = Math.min(1, Math.log10(Math.max(1, value)) / Math.log10(10_000));
  const tone = value >= 3000 ? 'var(--red)' : value >= 1000 ? 'var(--orange)' : 'var(--accent)';
  return (
    <span className={cx('inline-flex items-center gap-2 w-full', className)}>
      <span className="relative flex-1 h-1 rounded-full bg-fill-3 overflow-hidden">
        <span className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${w * 100}%`, background: tone }} />
      </span>
      <span className="tabular text-label-2 w-12 text-right">{value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`}</span>
    </span>
  );
}
