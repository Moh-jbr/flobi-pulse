import { useLayoutEffect, useRef, useState } from 'react';
import { useStore, inspect } from '../lib/store.js';
import { HealthPill, Pill, cx, STATE_TONE } from '../components/ui.jsx';
import Icon from '../components/icons.jsx';
import { compact, pct } from '../lib/format.js';
import { usageOf, memWarning, UsageLine, cpuMax } from '../components/usage.jsx';

export const HEALTH_ORDER = { down: 0, degraded: 1, deploying: 2, healthy: 3, idle: 4 };

const MIN = 60_000;

const errRate = (v) => (v ? (v < 1 ? v.toFixed(1) : String(Math.round(v))) : '0');

/**
 * How worried each part of a row looks: null, 'orange' (warning) or 'red' (danger). The same rules
 * as the cards: a down or degraded row takes its colour, and inside it only the figures that made it
 * so; memory about to run out warns on its own, as do errors and fresh restarts.
 */
export function levelsOf(s) {
  const problem = s.health === 'down' || s.health === 'degraded';
  const tone = s.health === 'down' ? 'red' : 'orange';
  const caused = (k) => (problem && s.causes?.includes(k) ? tone : null);
  const memSoon = memWarning(s.memEta) ? (s.memEta < 5 * MIN ? 'red' : 'orange') : null;
  return {
    row: problem ? tone : memSoon,
    cpu: caused('cpu'),
    mem: caused('mem') || memSoon,
    pods: caused('pods') || (s.desired > 0 && s.ready === 0 ? 'red' : null),
    restarts: caused('restarts') || (s.recentRestarts > 0 ? 'orange' : null),
    errors: s.errorsPerMin >= 30 ? 'red' : s.errorsPerMin >= 5 ? 'orange' : null,
  };
}

/**
 * The table's columns. `min` is the narrowest table that still has room for the column: the
 * table drops the less important ones first rather than squeezing every one of them.
 */
const COLUMNS = [
  { key: 'service', label: 'Service', width: 'minmax(150px,1.5fr)', by: (s) => s.short },
  { key: 'health', label: 'Health', width: '118px', by: (s) => HEALTH_ORDER[s.health] ?? 5 },
  { key: 'cpu', label: 'CPU', width: '84px', num: true, by: (s, u) => u.cpu ?? -1 },
  { key: 'mem', label: 'Memory', width: '84px', num: true, by: (s, u) => u.mem ?? -1 },
  { key: 'pods', label: 'Pods', width: '104px', num: true, min: 600, by: (s) => (s.desired ? s.ready / s.desired : 2) },
  { key: 'errors', label: 'Err/min', width: '80px', num: true, min: 520, by: (s) => s.errorsPerMin || 0 },
  { key: 'rpm', label: 'Req/min', width: '84px', num: true, min: 760, by: (s) => (s.hosts?.length && s.rpm != null ? s.rpm : -1) },
  { key: 'restarts', label: 'Restarts', width: '84px', num: true, min: 860, by: (s) => s.restarts || 0 },
  { key: 'hour', label: 'Last hour', width: 'minmax(110px,1fr)', min: 980, by: null },
];

export const DEFAULT_SORT = { key: 'health', dir: 'asc' };

/** Rows in the table's order: the chosen column, then health, then name. */
export function sortServices(list, sort, metricsSource) {
  const col = COLUMNS.find((c) => c.key === sort?.key && c.by) || COLUMNS[1];
  const sign = sort?.dir === 'desc' ? -1 : 1;
  const rows = list.map((s) => ({ s, u: usageOf(s, metricsSource) }));
  rows.sort((a, b) => {
    const x = col.by(a.s, a.u);
    const y = col.by(b.s, b.u);
    const c = typeof x === 'string' ? x.localeCompare(y) : x - y;
    return sign * c || (HEALTH_ORDER[a.s.health] ?? 5) - (HEALTH_ORDER[b.s.health] ?? 5) || a.s.short.localeCompare(b.s.short);
  });
  return rows.map((r) => r.s);
}

function useWidth(ref) {
  const [w, setW] = useState(1200);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

const TEXT = { red: 'text-red', orange: 'text-orange' };
const ROW_TINT = {
  red: 'bg-[color-mix(in_srgb,var(--red)_9%,transparent)] hover:bg-[color-mix(in_srgb,var(--red)_14%,transparent)] shadow-[inset_2px_0_0_var(--red),inset_0_-1px_0_var(--separator)]',
  orange: 'bg-[color-mix(in_srgb,var(--orange)_8%,transparent)] hover:bg-[color-mix(in_srgb,var(--orange)_13%,transparent)] shadow-[inset_2px_0_0_var(--orange),inset_0_-1px_0_var(--separator)]',
};

/** A figure in its level's colour, or quiet when it says nothing is happening. */
function Figure({ level, children, title, quiet }) {
  return (
    <span title={title} className={cx('tabular', level ? cx(TEXT[level], 'font-medium') : quiet ? 'text-label-3' : 'text-label')}>
      {children}
    </span>
  );
}

function Cell({ col, s, u, lv }) {
  const k = col.key;
  if (k === 'service') {
    const memSoon = memWarning(s.memEta);
    const notes = [memSoon, ...(s.health === 'down' || s.health === 'degraded' ? s.reasons || [] : [])].filter(Boolean);
    return (
      <span className="min-w-0 flex flex-col">
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="text-callout font-semibold truncate">{s.short}</span>
          {s.hosts?.length > 0 && <Icon name="globe" size={11} className="text-label-3 shrink-0" />}
        </span>
        {notes.length > 0 && (
          <span className={cx('text-subheadline truncate', TEXT[lv.row] || 'text-label-2')} title={notes.join('\n')}>
            {notes.join(' · ')}
          </span>
        )}
      </span>
    );
  }
  if (k === 'health')
    return memWarning(s.memEta) && s.health === 'healthy' ? (
      <Pill tone={lv.row} icon="errors">
        Memory rising
      </Pill>
    ) : (
      <HealthPill health={s.health} />
    );
  if (k === 'cpu' || k === 'mem') {
    const v = u[k];
    const title = k === 'cpu' ? u.cpuTitle : u.memTitle;
    if (v == null) return <span title={title} className="text-label-3">—</span>;
    return (
      <Figure level={lv[k]} title={title} quiet={k === 'mem'}>
        {pct(v)}
      </Figure>
    );
  }
  if (k === 'pods')
    return (
      <span className="flex items-center gap-1 min-w-0" title={s.pods.map((p) => `${p.name} · ${p.status}`).join('\n')}>
        {s.pods.slice(0, 5).map((p) => (
          <span key={p.name} className={cx('w-1.5 h-1.5 rounded-full shrink-0', { green: 'bg-green', orange: 'bg-orange', red: 'bg-red', accent: 'bg-accent', gray: 'bg-gray' }[STATE_TONE[p.state]])} />
        ))}
        <span className="ml-1">
          <Figure level={lv.pods} quiet>
            {s.ready}/{s.desired}
          </Figure>
        </span>
      </span>
    );
  if (k === 'errors')
    return (
      <Figure level={lv.errors} quiet={!s.errorsPerMin}>
        {errRate(s.errorsPerMin)}
      </Figure>
    );
  if (k === 'rpm') return s.hosts?.length && s.rpm != null ? <span className="tabular text-label-2">{compact(s.rpm)}</span> : <span className="text-label-4">—</span>;
  if (k === 'restarts')
    return (
      <Figure level={lv.restarts} quiet={!s.restarts} title={s.recentRestarts ? `${s.recentRestarts} in the last 15 min` : undefined}>
        {s.restarts || 0}
      </Figure>
    );
  if (k === 'hour') {
    if (!s.cpuSpark && !s.memSpark) return <span className="text-label-4">—</span>;
    return (
      <span className="block w-full">
        <UsageLine
          height={24}
          cpu={s.cpuSpark}
          mem={s.memSpark}
          deploys={s.deploys}
          max={cpuMax(s.cpuSpark)}
          color={lv.cpu ? `var(--${lv.cpu})` : 'var(--label-3)'}
          memColor={lv.mem ? `var(--${lv.mem})` : 'color-mix(in srgb, var(--label-3) 70%, transparent)'}
        />
      </span>
    );
  }
  return null;
}

function HeaderCell({ col, sort, onSort }) {
  const active = sort.key === col.key;
  if (!col.by) return <span className="px-2.5 flex items-center truncate">{col.label}</span>;
  const dir = active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
  return (
    <button
      type="button"
      onClick={() => onSort(active ? { key: col.key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key: col.key, dir: col.num ? 'desc' : 'asc' })}
      className={cx('group h-full px-2.5 flex items-center gap-1 min-w-0 hover:text-label', active && 'text-label')}
      title={`Sort by ${col.label}`}
      aria-label={`${col.label}, sorted ${dir}`}
    >
      <span className="truncate">{col.label}</span>
      <Icon name="chevronDown" size={10} strokeWidth={2.2} className={cx('shrink-0 transition-transform', active ? 'opacity-100' : 'opacity-0 group-hover:opacity-40', active && sort.dir === 'asc' && 'rotate-180')} />
    </button>
  );
}

/** ↑ and ↓ move between rows, wherever focus is in the table. */
function onRowKeys(e) {
  const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
  if (!step) return;
  const rows = [...e.currentTarget.querySelectorAll('[data-row]')];
  const i = rows.indexOf(document.activeElement);
  const next = rows[i < 0 ? 0 : Math.max(0, Math.min(rows.length - 1, i + step))];
  if (!next) return;
  e.preventDefault();
  next.focus();
}

/**
 * The Services table: one row per workload with the same figures and colours as its card, sortable by
 * any column. A down row is tinted red and a degraded one orange; a row opens the service's
 * inspector, like a card.
 */
export default function ServicesTable({ rows, sort, onSort, metricsSource }) {
  const ref = useRef(null);
  const width = useWidth(ref);
  const inspector = useStore((s) => s.inspector);
  const cols = COLUMNS.filter((c) => !c.min || width >= c.min);
  const template = cols.map((c) => c.width).join(' ');
  return (
    <div ref={ref} className="card overflow-hidden" onKeyDown={onRowKeys}>
      <div style={{ gridTemplateColumns: template }} className="grid h-8 px-1.5 items-stretch text-subheadline font-semibold text-label-2 hairline-b bg-fill-4">
        {cols.map((c) => (
          <HeaderCell key={c.key} col={c} sort={sort} onSort={onSort} />
        ))}
      </div>
      {rows.map((s) => {
        const u = usageOf(s, metricsSource);
        const lv = levelsOf(s);
        const selected = inspector?.type === 'service' && inspector.id === s.name;
        return (
          <button
            key={s.name}
            type="button"
            data-row=""
            onClick={() => inspect('service', s.name)}
            style={{ gridTemplateColumns: template }}
            className={cx('w-full text-left grid items-stretch min-h-10 px-1.5 hairline-b focus-visible:outline-none focus-visible:bg-fill-3', ROW_TINT[lv.row] || 'hover:bg-fill-4', selected && '!bg-accent-tint')}
          >
            {cols.map((c) => (
              <span key={c.key} className="px-2.5 py-1.5 flex items-center min-w-0 text-callout">
                <Cell col={c} s={s} u={u} lv={lv} />
              </span>
            ))}
          </button>
        );
      })}
    </div>
  );
}
