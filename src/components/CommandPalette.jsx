import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore, setState, navigate, inspect, invoke } from '../lib/store.js';
import Icon from './icons.jsx';
import { cx, HealthPill, StatusDot, STATE_TONE } from './ui.jsx';

const VIEWS = [
  ['overview', 'Overview', 'overview'],
  ['recent', 'Recent issues', 'bell'],
  ['versions', 'Versions', 'tag'],
  ['traffic', 'Live Traffic', 'traffic'],
  ['errors', 'Errors', 'errors'],
  ['crashes', 'Crashes & Down', 'crashes'],
  ['logs', 'Logs', 'logs'],
  ['events', 'Events', 'events'],
  ['infrastructure', 'Infrastructure', 'infrastructure'],
  ['database', 'Database', 'database'],
  ['frontends', 'Frontends', 'frontends'],
  ['timeline', 'Timeline', 'timeline'],
  ['settings', 'Settings', 'settings'],
];

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

  useEffect(() => {
    if (open) {
      setQ('');
      setIdx(0);
    }
  }, [open]);

  const items = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const all = [
      ...VIEWS.map(([id, label, icon]) => ({ key: `v:${id}`, group: 'Go to', label, icon, run: () => navigate(id) })),
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
  const close = () => setState({ palette: false });
  const pick = (it) => {
    close();
    it?.run();
  };

  let lastGroup = null;
  return createPortal(
    <div className="fixed inset-0 z-50 no-drag" onMouseDown={(e) => e.target === e.currentTarget && close()} style={{ background: 'var(--scrim)' }}>
      <div className="absolute left-1/2 top-[14%] -translate-x-1/2 w-[620px] glass-strong rounded-[24px] overflow-hidden animate-sheet">
        <div className="flex items-center gap-3 px-5 h-14 hairline-b">
          <Icon name="search" size={19} className="text-label-2" />
          <input
            autoFocus
            value={q}
            onChange={(e) => (setQ(e.target.value), setIdx(0))}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') (e.preventDefault(), setIdx((i) => Math.min(items.length - 1, i + 1)));
              else if (e.key === 'ArrowUp') (e.preventDefault(), setIdx((i) => Math.max(0, i - 1)));
              else if (e.key === 'Enter') pick(items[idx]);
              else if (e.key === 'Escape') close();
            }}
            placeholder="Jump to a service, pod, view or action…"
            className="flex-1 bg-transparent outline-none text-title3 placeholder:text-label-3"
            spellCheck={false}
          />
        </div>
        <div ref={listRef} className="max-h-[min(420px,calc(100vh-220px))] overflow-y-auto p-2">
          {!items.length && <div className="py-10 text-center text-callout text-label-2">No matches</div>}
          {items.map((it, i) => {
            const header = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <div key={it.key}>
                {header && <div className="px-3 pt-2 pb-1 text-subheadline font-semibold text-label-3">{header}</div>}
                <button
                  type="button"
                  data-i={i}
                  onMouseMove={() => setIdx(i)}
                  onClick={() => pick(it)}
                  className={cx('w-full h-9 px-3 rounded-[12px] flex items-center gap-3 text-body text-left', i === idx ? 'bg-accent text-white' : '')}
                >
                  <Icon name={it.icon} size={16} className={i === idx ? 'text-white' : 'text-accent'} />
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
