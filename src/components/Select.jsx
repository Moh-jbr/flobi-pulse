// Custom dropdown that replaces the native <select> (whose popup is drawn by the
// OS and can't be styled). Pill trigger + floating list with keyboard support,
// optional search, groups, icons/dots and descriptions.
//
//   <Select value={v} onChange={setV} options={[{ value, label, description?, icon?, dot? }]} />
//   <Select groups={[{ label, options: [...] }]} searchable />
//   <Select placeholder="Search history…" action options={...} onChange={run} />   ← menu of actions
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './icons.jsx';
import { cx, StatusDot, LAYER, useLayer } from './ui.jsx';

function flatten(options, groups) {
  if (groups) return groups.flatMap((g, gi) => g.options.map((o) => ({ ...o, group: g.label, gi })));
  return (options || []).map((o) => ({ ...o, group: null, gi: 0 }));
}

export default function Select({
  value,
  onChange,
  options,
  groups,
  placeholder = 'Choose…',
  searchable,
  action = false, // menu of actions: no "selected" state, trigger always shows the placeholder
  size = 'sm',
  icon,
  className,
  menuWidth,
  maxWidth = 280,
  align = 'start',
  ariaLabel,
}) {
  const btn = useRef(null);
  const list = useRef(null);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState(null);
  const all = useMemo(() => flatten(options, groups), [options, groups]);
  const canSearch = searchable ?? all.length > 10;
  const shown = useMemo(() => {
    const ql = q.trim().toLowerCase();
    return ql ? all.filter((o) => `${o.label} ${o.description || ''} ${o.value}`.toLowerCase().includes(ql)) : all;
  }, [all, q]);
  const current = action ? null : all.find((o) => o.value === value);

  const place = () => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.max(menuWidth || 0, r.width, 200);
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const up = below < 260 && above > below;
    const maxH = Math.min(380, Math.max(160, up ? above : below));
    let left = align === 'end' ? r.right - width : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    setPos({ left, width, maxH, ...(up ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }) });
  };

  const openMenu = () => {
    place();
    setQ('');
    const i = all.findIndex((o) => o.value === value);
    setActive(i >= 0 && !action ? i : 0);
    setOpen(true);
  };
  const close = (focus = true) => {
    setOpen(false);
    if (focus) btn.current?.focus();
  };
  const choose = (o) => {
    if (!o || o.disabled) return;
    close();
    onChange?.(o.value, o);
  };
  // Escape closes the list (and only the list) wherever focus is; focus goes back to the trigger.
  useLayer(open, LAYER.picker, () => close());

  useLayoutEffect(() => {
    if (!open) return;
    const onWin = () => place();
    window.addEventListener('resize', onWin);
    window.addEventListener('scroll', onWin, true);
    return () => {
      window.removeEventListener('resize', onWin);
      window.removeEventListener('scroll', onWin, true);
    };
  }, [open]);

  useEffect(() => {
    if (active >= shown.length) setActive(Math.max(0, shown.length - 1));
  }, [shown.length]);

  // Keep the highlighted row visible while moving with the keyboard.
  useEffect(() => {
    if (!open) return;
    list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const onKey = (e) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(shown.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(shown.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(shown[active]);
    } else if (e.key === 'Tab') close(false);
  };

  const h = size === 'md' ? 'h-7 text-body' : 'h-6 text-callout';
  const label = current ? current.label : placeholder;
  const listId = `${id}-list`;
  const optionId = (i) => `${id}-o${i}`;
  // Focus stays on the trigger (or in the filter field) while the list is open; this tells
  // screen readers which option the arrow keys are on.
  const activeDescendant = open && shown[active] ? optionId(active) : undefined;

  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={canSearch ? undefined : activeDescendant}
        aria-label={ariaLabel}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onKey}
        className={cx(
          // The app's focus ring (an accent outline, see :focus-visible in styles.css) shows on keyboard focus.
          'no-drag press inline-flex items-center gap-1.5 rounded-full bg-fill-3 hover:bg-fill-2 pl-2.5 pr-2 min-w-0 transition-colors',
          h,
          open && 'bg-fill-2 shadow-[0_0_0_3px_var(--accent-tint)]',
          className,
        )}
        style={{ maxWidth }}
      >
        {icon && <Icon name={icon} size={14} className="text-label-2 shrink-0" />}
        {current?.dot && <StatusDot tone={current.dot} size={6} />}
        <span className={cx('truncate', current ? 'text-label font-medium' : 'text-label-2')}>{label}</span>
        <Icon name="chevronDown" size={12} strokeWidth={2} className={cx('shrink-0 text-label-3 transition-transform duration-200', open && 'rotate-180')} />
      </button>
      {open &&
        pos &&
        createPortal(
          <div className="fixed inset-0 z-picker no-drag" data-layer="picker" onMouseDown={(e) => e.target === e.currentTarget && close(false)}>
            <div
              id={listId}
              role="listbox"
              aria-label={ariaLabel || placeholder}
              className="absolute rounded-[14px] bg-elevated shadow-[var(--shadow-pop),0_0_0_0.5px_var(--separator)] overflow-hidden animate-sheet flex flex-col"
              style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: pos.width, maxHeight: pos.maxH, transformOrigin: pos.bottom != null ? 'bottom left' : 'top left' }}
            >
              {canSearch && (
                <div className="p-1.5 hairline-b shrink-0">
                  <label className="flex items-center gap-2 h-7 px-2 rounded-[9px] bg-fill-4">
                    <Icon name="search" size={13} className="text-label-3" />
                    <input autoFocus value={q} onChange={(e) => (setQ(e.target.value), setActive(0))} onKeyDown={onKey} placeholder="Filter…" aria-label="Filter" aria-controls={listId} aria-activedescendant={activeDescendant} spellCheck={false} className="flex-1 min-w-0 bg-transparent outline-none text-callout placeholder:text-label-3" />
                  </label>
                </div>
              )}
              {/* Clicking an option mustn't take focus from the trigger or the filter field (the list's own scrollbar still works). */}
              <div ref={list} className="overflow-y-auto p-1 min-h-0" onMouseDown={(e) => e.target !== e.currentTarget && e.preventDefault()}>
                {!shown.length && <div className="px-3 py-2.5 text-callout text-label-3">Nothing matches “{q}”.</div>}
                {shown.map((o, i) => {
                  const newGroup = o.group && (i === 0 || shown[i - 1].group !== o.group);
                  const selected = !action && o.value === value;
                  return (
                    <div key={`${o.gi}:${String(o.value)}`}>
                      {newGroup && <div className={cx('px-2.5 pt-2 pb-1 text-footnote font-semibold text-label-3 uppercase tracking-wide', i > 0 && 'mt-1 hairline-t')}>{o.group}</div>}
                      <button
                        type="button"
                        id={optionId(i)}
                        role="option"
                        aria-selected={selected}
                        tabIndex={-1}
                        data-i={i}
                        disabled={o.disabled}
                        onMouseEnter={() => setActive(i)}
                        onClick={() => choose(o)}
                        className={cx('w-full flex items-center gap-2 px-2.5 py-1.5 rounded-[9px] text-left text-callout disabled:opacity-40', i === active ? 'bg-accent text-white' : 'text-label')}
                      >
                        <span className="w-3.5 shrink-0 grid place-items-center">{selected && <Icon name="check" size={13} strokeWidth={2.2} />}</span>
                        {o.icon && <Icon name={o.icon} size={14} className={cx('shrink-0', i === active ? 'text-white' : 'text-label-2')} />}
                        {o.dot && <StatusDot tone={o.dot} size={6} />}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{o.label}</span>
                          {o.description && <span className={cx('block truncate text-footnote', i === active ? 'text-white/80' : 'text-label-3')}>{o.description}</span>}
                        </span>
                        {o.meta != null && <span className={cx('text-footnote tabular shrink-0', i === active ? 'text-white/80' : 'text-label-3')}>{o.meta}</span>}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
