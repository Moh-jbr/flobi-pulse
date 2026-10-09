import { useLayoutEffect, useRef, useState } from 'react';
import { useStore, inspect } from '../lib/store.js';
import { HealthPill, Pill, StatusDot, SearchField, Button, cx, STATE_TONE, HEALTH } from '../components/ui.jsx';
import Icon from '../components/icons.jsx';
import { compact, pct } from '../lib/format.js';
import { usageOf, cpuMax } from '../lib/usage.js';
import { UsageLine } from '../components/usage.jsx';
import { levelsOf, notesOf, fitColumns, nextSort, isDefaultSort, DEFAULT_SORT, COLUMNS } from '../lib/services-table.js';

const errRate = (v) => (v ? (v < 1 ? v.toFixed(1) : String(Math.round(v))) : '0');

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
// The row's tint and its coloured edge, with the row's hairline kept under them (both are shadows).
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

function Cell({ col, s, u, lv, compactHealth }) {
  const k = col.key;
  if (k === 'service') {
    const notes = notesOf(s);
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
  if (k === 'health') {
    const w = lv.warning;
    if (compactHealth) {
      const h = HEALTH[s.health] || HEALTH.unknown;
      return (
        <span title={w ? w.label : h.label} className="flex items-center">
          <StatusDot tone={w ? w.tone : h.tone} size={8} />
        </span>
      );
    }
    return w ? (
      <Pill tone={w.tone} icon="errors">
        {w.label}
      </Pill>
    ) : (
      <HealthPill health={s.health} />
    );
  }
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

/**
 * A column's header: a click sorts by it (again: the other way round). `hiddenSort` is the column the
 * table is sorted by when that column has no room right now; the Service header says so instead.
 */
function HeaderCell({ col, sort, onSort, compactHealth, hiddenSort }) {
  const active = sort.key === col.key;
  if (!col.by) return <span className="px-2 flex items-center truncate">{col.label}</span>;
  const dir = active ? `, sorted ${sort.dir === 'asc' ? 'ascending' : 'descending'}` : '';
  return (
    <button
      type="button"
      onClick={() => onSort(nextSort(sort, col))}
      className={cx('h-full px-2 flex items-center gap-1 min-w-0 hover:text-label', active && 'text-label', compactHealth && col.key === 'health' && '!px-0 justify-center')}
      title={hiddenSort && col.key === 'service' ? `Sorted by ${hiddenSort.label}. Click to sort by name.` : `Sort by ${col.label}`}
      aria-label={`Sort by ${col.label}${dir}`}
    >
      {!(compactHealth && col.key === 'health') && <span className="truncate">{col.label}</span>}
      {hiddenSort && col.key === 'service' && <span className="truncate font-normal text-label-3">· by {hiddenSort.label}</span>}
      {(active || (hiddenSort && col.key === 'service')) && <Icon name="chevronDown" size={10} strokeWidth={2.2} className={cx('shrink-0', sort.dir === 'asc' && 'rotate-180')} />}
    </button>
  );
}

/** ↑ and ↓ move between rows; ↓ from the search goes to the first row. */
function onRowKeys(e) {
  const step = { ArrowDown: 1, ArrowUp: -1 }[e.key];
  const fromRow = e.target.hasAttribute?.('data-row');
  if (!step || !(fromRow || (step > 0 && e.target.tagName === 'INPUT'))) return;
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
export default function ServicesTable({ rows, total, sort, onSort, query, onQuery, metricsSource }) {
  const ref = useRef(null);
  const searchRef = useRef(null);
  const width = useWidth(ref);
  const inspector = useStore((s) => s.inspector);
  const { cols, compact: compactHealth, template } = fitColumns(width);
  const hidden = cols.some((c) => c.key === sort.key) ? null : COLUMNS.find((c) => c.key === sort.key);
  const sortedBy = isDefaultSort(sort) ? null : COLUMNS.find((c) => c.key === sort.key);
  return (
    <div ref={ref} className="card overflow-x-auto overflow-y-hidden" onKeyDown={onRowKeys}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 hairline-b">
        <SearchField inputRef={searchRef} value={query} onChange={onQuery} placeholder="Search services" width={220} onKeyDown={(e) => e.key === 'Escape' && query && (e.stopPropagation(), onQuery(''))} />
        {query.trim() && (
          <span className="text-subheadline text-label-3 tabular">
            {rows.length} of {total}
          </span>
        )}
        {sortedBy && (
          <button
            type="button"
            onClick={() => onSort(DEFAULT_SORT)}
            title="Take the sort off: problems first, then by name"
            className="ml-auto inline-flex items-center gap-1 h-6 pl-2.5 pr-1.5 rounded-full bg-fill-3 hover:bg-fill-2 text-callout text-label-2 hover:text-label"
          >
            Sorted by {sortedBy.label} {sort.dir === 'asc' ? '↑' : '↓'}
            <Icon name="x" size={11} strokeWidth={2.4} />
          </button>
        )}
      </div>
      <div style={{ gridTemplateColumns: template }} className="grid h-8 px-1.5 items-stretch text-subheadline font-semibold text-label-2 hairline-b bg-fill-4">
        {cols.map((c) => (
          <HeaderCell key={c.key} col={c} sort={sort} onSort={onSort} compactHealth={compactHealth} hiddenSort={hidden} />
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
            aria-current={selected || undefined}
            onClick={() => inspect('service', s.name)}
            style={{ gridTemplateColumns: template }}
            className={cx(
              'w-full text-left grid items-stretch min-h-10 px-1.5 hairline-b focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--accent)]',
              ROW_TINT[lv.row] || (selected ? 'bg-accent-tint' : 'hover:bg-fill-4'),
              selected && 'outline outline-[1.5px] -outline-offset-[1.5px] outline-[var(--label-3)]',
            )}
          >
            {cols.map((c) => (
              <span key={c.key} className={cx('py-1.5 flex items-center min-w-0 text-callout', compactHealth && c.key === 'health' ? 'justify-center' : 'px-2')}>
                <Cell col={c} s={s} u={u} lv={lv} compactHealth={compactHealth} />
              </span>
            ))}
          </button>
        );
      })}
      {!rows.length && (
        <div className="px-4 py-8 flex flex-col items-center gap-2 text-callout text-label-2">
          No service matches “{query.trim()}”
          <Button
            size="sm"
            onClick={() => {
              onQuery('');
              searchRef.current?.focus();
            }}
          >
            Clear search
          </Button>
        </div>
      )}
    </div>
  );
}
