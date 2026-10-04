import { Fragment, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore, setState, navigate, inspect, invoke, logs, traffic } from '../lib/store.js';
import Icon from './icons.jsx';
import { cx, HealthPill, StatusDot, STATE_TONE, LAYER, useLayer, useModalFocus, Kbd } from './ui.jsx';
import { deepSearch } from '../lib/search.js';
import { ago, clockHM } from '../lib/format.js';
import { NAV_GROUPS } from './Sidebar.jsx';

// "Go to" lists the views in sidebar order, with the sidebar's names; Settings (the sidebar's footer) last.
const VIEWS = [...NAV_GROUPS.flatMap((g) => g.items), { id: 'settings', label: 'Settings', icon: 'settings' }];

function score(text, q) {
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 3;
  if (t.split(/[\s\-_/.:]+/).some((w) => w.startsWith(q))) return 2;
  return t.includes(q) ? 1 : 0;
}

const GROUP_ORDER = ['Go to', 'Actions'];

export default function CommandPalette() {
  const open = useStore((s) => s.palette);
  const services = useStore((s) => s.sections.services) || [];
  const pods = useStore((s) => s.sections.pods) || [];
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const listRef = useRef(null);
  const box = useRef(null);
  const id = useId();
  const close = () => setState({ palette: false });
  useLayer(open, LAYER.sheet, close);
  useModalFocus(box, open);

  useEffect(() => {
    if (open) {
      setQ('');
      setIdx(0);
    }
  }, [open]);

  const alerts = useStore((s) => s.sections.alerts);
  const errors = useStore((s) => s.sections.errors);
  const crashes = useStore((s) => s.sections.crashes);
  const events = useStore((s) => s.sections.events);
  const nodes = useStore((s) => s.sections.nodes);
  const uptime = useStore((s) => s.sections.uptime);
  const pages = useStore((s) => s.sections.cloudflare?.pages);
  // Typing stays quick: the deep part (every log line and request in memory) follows a beat behind.
  const deepQ = useDeferredValue(q);

  const quick = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const all = [
      ...VIEWS.map((v) => ({ key: `v:${v.id}`, group: 'Go to', title: v.label, icon: v.icon, run: () => navigate(v.id) })),
      { key: 'a:recap', group: 'Actions', title: 'While you were away…', icon: 'timeline', run: () => setState({ recapOpen: true }) },
      { key: 'a:test', group: 'Actions', title: 'Send a test notification', icon: 'bell', run: () => invoke('notify:test') },
    ];
    if (!ql) return [...all, ...services.filter((x) => x.health === 'down' || x.health === 'degraded').map((x) => ({ key: `s:${x.name}`, group: 'Needs attention', title: x.short, sub: x.reasons?.join(' · '), health: x.health, icon: 'stack', run: () => inspect('service', x.name) }))];
    if (/^\w+:/.test(ql)) return [];
    return all
      .map((x) => ({ ...x, s: score(x.title, ql) }))
      .filter((x) => x.s >= 2)
      .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || b.s - a.s);
  }, [q, services]);

  const deep = useMemo(
    () => deepSearch(deepQ, { services, alerts, errors, crashes, events, pods, nodes, uptime, pages, logs, traffic }),
    // The log and request rings are read when the words change, not on every line that arrives.
    [deepQ, services, alerts, errors, crashes, events, pods, nodes, uptime, pages],
  );

  const items = useMemo(() => {
    const out = [...quick];
    const run = (o) => () => (o.inspect ? inspect(...o.inspect) : navigate(o.navigate));
    for (const g of deep.groups) {
      g.items.forEach((it, i) => out.push({ ...it, group: g.title, groupInfo: i === 0 ? g : null, run: run(it.open) }));
      if (g.more && (g.total > g.items.length || g.id === 'logs' || g.id === 'requests')) out.push({ key: `more:${g.id}`, group: g.title, title: g.total > g.items.length ? `See all ${g.total.toLocaleString()} · ${g.more.label}` : g.more.label, icon: 'chevronRight', more: true, run: run(g.more) });
    }
    const words = deep.terms.join(' ');
    if (words) {
      out.push({ key: 'deep:logs', group: 'Search further back', title: `Search every log in Cloud Logging for “${words}”`, sub: 'The last 24 hours, every service, including pods that are gone', icon: 'history', run: () => navigate({ to: 'logs', q: words, from: Date.now() - 24 * 3600_000, until: Date.now(), ...(deep.filters.level && { level: deep.filters.level.toUpperCase() }) }) });
    }
    return out;
  }, [quick, deep]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${idx}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  if (!open) return null;
  const pick = (it) => {
    close();
    it?.run();
  };
  const optionId = (i) => `${id}-o${i}`;

  const terms = deep.terms;
  const searching = !!q.trim();
  const counted = deep.groups.reduce((n, g) => n + (g.id === 'follow' ? 0 : g.total), 0);
  let lastGroup = null;
  return createPortal(
    <div className="fixed inset-0 z-sheet no-drag" data-layer="palette" onMouseDown={(e) => e.target === e.currentTarget && close()} style={{ background: 'var(--scrim)' }}>
      <div ref={box} role="dialog" aria-modal="true" aria-label="Search" tabIndex={-1} className="absolute left-1/2 top-[12%] -translate-x-1/2 w-[760px] max-w-[calc(100vw-32px)] glass-strong rounded-[14px] overflow-hidden animate-sheet outline-none flex flex-col">
        <div className="flex items-center gap-3 px-5 h-14 hairline-b shrink-0">
          <Icon name="search" size={19} className="text-label-2" />
          <input
            data-autofocus=""
            role="combobox"
            aria-label="Search everything: services, issues, errors, crashes, events, pods, logs and requests"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-autocomplete="list"
            aria-activedescendant={items[idx] ? optionId(idx) : undefined}
            value={q}
            onChange={(e) => (setQ(e.target.value), setIdx(0))}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') (e.preventDefault(), setIdx((i) => Math.min(items.length - 1, i + 1)));
              else if (e.key === 'ArrowUp') (e.preventDefault(), setIdx((i) => Math.max(0, i - 1)));
              else if (e.key === 'Enter') pick(items[idx]);
            }}
            placeholder="Search services, issues, errors, logs, requests, pods…"
            className="flex-1 bg-transparent outline-none text-title3 placeholder:text-label-3"
            spellCheck={false}
          />
          {searching && counted > 0 && <span className="text-subheadline text-label-3 tabular shrink-0">{counted.toLocaleString()} found</span>}
        </div>
        <div ref={listRef} id={`${id}-list`} role="listbox" aria-label="Results" className="max-h-[min(560px,calc(100vh-240px))] overflow-y-auto p-2">
          {!items.length && (
            <div className="py-10 text-center text-callout text-label-2">
              Nothing matches “{q.trim()}”
              {deep.filters.in && <div className="mt-1 text-subheadline text-label-3">Only looking in {deep.filters.in}. Take out “in:” to search everything.</div>}
            </div>
          )}
          {items.map((it, i) => {
            const header = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            const g = it.groupInfo;
            const on = i === idx;
            return (
              <div key={it.key} role="presentation">
                {header && (
                  <div role="presentation" className="px-3 pt-3 pb-1 flex items-baseline gap-2 text-subheadline">
                    <span className="font-semibold text-label-3">{header}</span>
                    {g && <span className="text-label-3 tabular">{g.total.toLocaleString()}</span>}
                    {g?.note?.since && <span className="ml-auto text-footnote text-label-3">kept in memory since {clockHM(g.note.since)}</span>}
                  </div>
                )}
                {/* Options aren't tab stops: the arrow keys move through them from the search field. */}
                <button
                  type="button"
                  id={optionId(i)}
                  role="option"
                  aria-selected={on}
                  tabIndex={-1}
                  data-i={i}
                  onMouseMove={() => setIdx(i)}
                  onClick={() => pick(it)}
                  className={cx('w-full min-h-9 px-3 py-1.5 rounded-[8px] flex items-center gap-3 text-left', on ? 'bg-fill-2 text-label' : '', it.more && 'text-callout text-label-2')}
                >
                  <Icon name={it.icon} size={16} className={cx('shrink-0', on ? 'text-label' : it.tone === 'red' ? 'text-red' : it.tone === 'orange' ? 'text-orange' : 'text-label-2')} />
                  <span className="min-w-0 flex-1">
                    <span className={cx('block truncate', it.mono ? 'font-mono text-[12px] leading-[17px]' : it.more ? '' : 'text-body')}>
                      <Marked text={it.title} terms={terms} />
                    </span>
                    {it.sub && (
                      <span className="block truncate text-footnote text-label-3">
                        <Marked text={it.sub} terms={terms} />
                      </span>
                    )}
                  </span>
                  {it.podState && <StatusDot tone={STATE_TONE[it.podState]} size={7} />}
                  {it.health && !on && <HealthPill health={it.health} />}
                  {it.at && !on && <span className="shrink-0 text-footnote text-label-3 tabular">{ago(it.at)}</span>}
                  {on && <span className="text-subheadline opacity-80 shrink-0">↵</span>}
                </button>
              </div>
            );
          })}
        </div>
        <div className="shrink-0 hairline-t px-4 h-9 flex items-center gap-3 text-footnote text-label-3 overflow-hidden whitespace-nowrap">
          <span>Narrow it:</span>
          {['service:brand', 'status:5xx', 'level:error', 'in:logs', '"exact words"'].map((x) => (
            <button key={x} type="button" tabIndex={-1} className="font-mono hover:text-label" onClick={() => (setQ((v) => `${v.trim()} ${x.includes('"') ? '""' : x.split(':')[0] + ':'}`.trimStart()), setIdx(0), box.current?.querySelector('input')?.focus())}>
              {x}
            </button>
          ))}
          <span className="ml-auto flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> to move <Kbd>↵</Kbd> to open
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The words searched for, picked out where they appear. */
function Marked({ text, terms }) {
  const t = String(text ?? '');
  if (!terms.length || !t) return t;
  const re = new RegExp(`(${terms.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  const parts = t.split(re);
  return parts.map((p, i) => (i % 2 ? <mark key={i} className="bg-[var(--accent-tint)] text-label rounded-[2px] font-semibold">{p}</mark> : <Fragment key={i}>{p}</Fragment>));
}
