import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore, setState, navigate, inspect, invoke } from '../lib/store.js';
import Icon from './icons.jsx';
import { cx, HealthPill, StatusDot, STATE_TONE, LAYER, useLayer, useModalFocus } from './ui.jsx';
import { NAV_GROUPS } from './Sidebar.jsx';

// "Go to" lists the views in sidebar order, with the sidebar's names; Settings (the sidebar's footer) last.
const VIEWS = [...NAV_GROUPS.flatMap((g) => g.items), { id: 'settings', label: 'Settings', icon: 'settings' }];

function score(text, q) {
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 3;
  if (t.split(/[\s\-_/.:]+/).some((w) => w.startsWith(q))) return 2;
  return t.includes(q) ? 1 : 0;
}

const GROUP_ORDER = ['Go to', 'Services', 'Follow logs', 'Pods', 'Actions'];

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

  const items = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const all = [
      ...VIEWS.map((v) => ({ key: `v:${v.id}`, group: 'Go to', label: v.label, icon: v.icon, run: () => navigate(v.id) })),
      ...services.map((s) => ({ key: `s:${s.name}`, group: 'Services', label: s.short, sub: s.name, health: s.health, icon: 'stack', run: () => inspect('service', s.name) })),
      ...services.map((s) => ({ key: `l:${s.name}`, group: 'Follow logs', label: `Logs: ${s.short}`, icon: 'logs', run: () => navigate({ to: 'logs', service: s.name }) })),
      ...pods.map((p) => ({ key: `p:${p.name}`, group: 'Pods', label: p.name, podState: p.state, icon: 'pod', run: () => inspect('pod', p.name) })),
      { key: 'a:recap', group: 'Actions', label: 'While you were away…', icon: 'timeline', run: () => setState({ recapOpen: true }) },
      { key: 'a:test', group: 'Actions', label: 'Send a test notification', icon: 'bell', run: () => invoke('notify:test') },
    ];
    if (!ql) return all.filter((x) => x.group === 'Go to' || x.group === 'Actions' || (x.group === 'Services' && (x.health === 'down' || x.health === 'degraded')));
    return all
      .map((x) => ({ ...x, s: score(`${x.label} ${x.sub || ''}`, ql) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || b.s - a.s)
      .slice(0, 40);
  }, [q, services, pods]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${idx}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  if (!open) return null;
  const pick = (it) => {
    close();
    it?.run();
  };
  const optionId = (i) => `${id}-o${i}`;

  let lastGroup = null;
  return createPortal(
    <div className="fixed inset-0 z-sheet no-drag" data-layer="palette" onMouseDown={(e) => e.target === e.currentTarget && close()} style={{ background: 'var(--scrim)' }}>
      <div ref={box} role="dialog" aria-modal="true" aria-label="Search" tabIndex={-1} className="absolute left-1/2 top-[14%] -translate-x-1/2 w-[620px] max-w-[calc(100vw-32px)] glass-strong rounded-[14px] overflow-hidden animate-sheet outline-none">
        <div className="flex items-center gap-3 px-5 h-14 hairline-b">
          <Icon name="search" size={19} className="text-label-2" />
          <input
            data-autofocus=""
            role="combobox"
            aria-label="Jump to a service, pod, view or action"
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
            placeholder="Jump to a service, pod, view or action…"
            className="flex-1 bg-transparent outline-none text-title3 placeholder:text-label-3"
            spellCheck={false}
          />
        </div>
        <div ref={listRef} id={`${id}-list`} role="listbox" aria-label="Results" className="max-h-[min(420px,calc(100vh-220px))] overflow-y-auto p-2">
          {!items.length && <div className="py-10 text-center text-callout text-label-2">No matches</div>}
          {items.map((it, i) => {
            const header = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <div key={it.key} role="presentation">
                {header && (
                  <div role="presentation" className="px-3 pt-2 pb-1 text-subheadline font-semibold text-label-3">
                    {header}
                  </div>
                )}
                {/* Options aren't tab stops: the arrow keys move through them from the search field. */}
                <button
                  type="button"
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === idx}
                  tabIndex={-1}
                  data-i={i}
                  onMouseMove={() => setIdx(i)}
                  onClick={() => pick(it)}
                  className={cx('w-full h-9 px-3 rounded-[8px] flex items-center gap-3 text-body text-left', i === idx ? 'bg-fill-2 text-label' : '')}
                >
                  <Icon name={it.icon} size={16} className={i === idx ? 'text-label' : 'text-label-2'} />
                  <span className="truncate flex-1">{it.label}</span>
                  {it.podState && <StatusDot tone={STATE_TONE[it.podState]} size={7} />}
                  {it.health && i !== idx && <HealthPill health={it.health} />}
                  {i === idx && <span className="text-subheadline opacity-80">↵</span>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
