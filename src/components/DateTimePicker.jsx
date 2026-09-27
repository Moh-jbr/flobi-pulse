// Date + time picker that replaces <input type="datetime-local"> (whose calendar
// popup is drawn by the OS). Value is the same "YYYY-MM-DDTHH:mm" local string.
import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './icons.jsx';
import { cx } from './ui.jsx';

const pad = (n) => String(n).padStart(2, '0');
export const toLocalInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const parse = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v || '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : new Date();
};
const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

function Stepper({ value, onChange, max, label }) {
  const set = (v) => onChange(((v % (max + 1)) + (max + 1)) % (max + 1));
  return (
    <div className="flex flex-col items-center gap-0.5">
      <button type="button" aria-label={`${label} up`} onClick={() => set(value + 1)} className="w-9 h-5 rounded-md grid place-items-center text-label-2 hover:bg-fill-3">
        <Icon name="chevronDown" size={12} strokeWidth={2} className="rotate-180" />
      </button>
      <input
        value={pad(value)}
        onChange={(e) => {
          const n = parseInt(e.target.value.replace(/\D/g, '').slice(-2), 10);
          if (!Number.isNaN(n) && n <= max) onChange(n);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') (e.preventDefault(), set(value + 1));
          if (e.key === 'ArrowDown') (e.preventDefault(), set(value - 1));
        }}
        onWheel={(e) => set(value + (e.deltaY < 0 ? 1 : -1))}
        aria-label={label}
        className="w-11 h-8 rounded-lg bg-fill-4 text-center text-title3 font-semibold tabular outline-none focus:shadow-[0_0_0_3px_var(--accent-tint),inset_0_0_0_1px_var(--accent)]"
      />
      <button type="button" aria-label={`${label} down`} onClick={() => set(value - 1)} className="w-9 h-5 rounded-md grid place-items-center text-label-2 hover:bg-fill-3">
        <Icon name="chevronDown" size={12} strokeWidth={2} />
      </button>
    </div>
  );
}

export default function DateTimePicker({ value, onChange, max, label }) {
  const btn = useRef(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const sel = parse(value);
  const [month, setMonth] = useState(() => new Date(sel.getFullYear(), sel.getMonth(), 1));

  const place = () => {
    const r = btn.current.getBoundingClientRect();
    const w = 296;
    const h = 380;
    const up = window.innerHeight - r.bottom < h + 16 && r.top > window.innerHeight - r.bottom;
    setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - w - 8)), width: w, ...(up ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }) });
  };
  useLayoutEffect(() => {
    if (!open) return;
    const f = () => place();
    window.addEventListener('resize', f);
    return () => window.removeEventListener('resize', f);
  }, [open]);

  const emit = (d) => {
    const limit = max ? parse(max) : null;
    onChange(toLocalInput(limit && d > limit ? limit : d));
  };
  const setDay = (d) => emit(new Date(d.getFullYear(), d.getMonth(), d.getDate(), sel.getHours(), sel.getMinutes()));

  // Monday-first grid of 6 weeks
  const first = new Date(month);
  const offset = (first.getDay() + 6) % 7;
  const days = Array.from({ length: 42 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), 1 - offset + i));
  const today = new Date();
  const same = (a, b) => a.toDateString() === b.toDateString();
  const limit = max ? parse(max) : null;

  const text = sel.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-label={label}
        onClick={() => {
          setMonth(new Date(sel.getFullYear(), sel.getMonth(), 1));
          place();
          setOpen((o) => !o);
        }}
        className={cx('no-drag press h-7 px-3 rounded-full inline-flex items-center gap-2 text-callout bg-fill-3 hover:bg-fill-2 transition-colors', open && 'bg-fill-2 shadow-[0_0_0_3px_var(--accent-tint)]')}
      >
        <Icon name="clock" size={14} className="text-label-2" />
        <span className="tabular font-medium">{text}</span>
      </button>
      {open &&
        pos &&
        createPortal(
          <div className="fixed inset-0 z-[60] no-drag" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setOpen(false))}>
            <div className="absolute rounded-[18px] bg-elevated shadow-[var(--shadow-pop),0_0_0_0.5px_var(--separator)] p-3 animate-sheet" style={{ left: pos.left, top: pos.top, bottom: pos.bottom, width: pos.width }}>
              <div className="flex items-center justify-between mb-2 px-1">
                <span className="text-headline font-semibold">{month.toLocaleString([], { month: 'long', year: 'numeric' })}</span>
                <span className="flex gap-1">
                  <button type="button" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} className="w-7 h-7 rounded-full grid place-items-center hover:bg-fill-3 text-label-2">
                    <Icon name="chevronLeft" size={14} strokeWidth={2} />
                  </button>
                  <button type="button" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} className="w-7 h-7 rounded-full grid place-items-center hover:bg-fill-3 text-label-2">
                    <Icon name="chevronRight" size={14} strokeWidth={2} />
                  </button>
                </span>
              </div>
              <div className="grid grid-cols-7 gap-0.5 text-center">
                {WEEKDAYS.map((w) => (
                  <span key={w} className="text-footnote font-semibold text-label-3 h-6 grid place-items-center">
                    {w}
                  </span>
                ))}
                {days.map((d) => {
                  const inMonth = d.getMonth() === month.getMonth();
                  const isSel = same(d, sel);
                  const future = limit && d > new Date(limit.getFullYear(), limit.getMonth(), limit.getDate(), 23, 59);
                  return (
                    <button
                      key={d.toISOString()}
                      type="button"
                      disabled={future}
                      onClick={() => setDay(d)}
                      className={cx(
                        'h-8 rounded-full text-callout tabular transition-colors disabled:opacity-25',
                        isSel ? 'bg-accent text-white font-semibold' : same(d, today) ? 'text-accent font-semibold hover:bg-fill-3' : inMonth ? 'text-label hover:bg-fill-3' : 'text-label-3 hover:bg-fill-4',
                      )}
                    >
                      {d.getDate()}
                    </button>
                  );
                })}
              </div>
              <div className="mt-3 pt-3 hairline-t flex items-center justify-between">
                <div className="flex items-center gap-1">
                  <Stepper label="Hour" value={sel.getHours()} max={23} onChange={(h) => emit(new Date(sel.getFullYear(), sel.getMonth(), sel.getDate(), h, sel.getMinutes()))} />
                  <span className="text-title3 font-semibold text-label-3 pb-0.5">:</span>
                  <Stepper label="Minute" value={sel.getMinutes()} max={59} onChange={(m) => emit(new Date(sel.getFullYear(), sel.getMonth(), sel.getDate(), sel.getHours(), m))} />
                </div>
                <div className="flex flex-col gap-1.5 items-end">
                  <button type="button" onClick={() => emit(new Date())} className="h-6 px-2.5 rounded-full bg-fill-3 hover:bg-fill-2 text-callout">
                    Now
                  </button>
                  <button type="button" onClick={() => setOpen(false)} className="h-6 px-3 rounded-full bg-accent text-white text-callout font-medium">
                    Done
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
