import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import Icon from './icons.jsx';
import { invoke } from '../lib/store.js';

export const cx = (...a) => a.filter(Boolean).join(' ');

export const TONE = {
  green: { fg: 'text-green', bg: 'bg-green-tint', dot: 'bg-green' },
  orange: { fg: 'text-orange', bg: 'bg-orange-tint', dot: 'bg-orange' },
  red: { fg: 'text-red', bg: 'bg-red-tint', dot: 'bg-red' },
  gray: { fg: 'text-gray', bg: 'bg-gray-tint', dot: 'bg-gray' },
  accent: { fg: 'text-accent', bg: 'bg-accent-tint', dot: 'bg-accent' },
};

export const HEALTH = {
  healthy: { tone: 'green', label: 'Healthy', icon: 'check' },
  idle: { tone: 'gray', label: 'Scaled to zero', icon: 'dot' },
  deploying: { tone: 'accent', label: 'Rolling out', icon: 'refresh' },
  degraded: { tone: 'orange', label: 'Degraded', icon: 'errors' },
  down: { tone: 'red', label: 'Down', icon: 'x' },
  unknown: { tone: 'gray', label: 'Unknown', icon: 'dot' },
};

export const STATE_TONE = { ok: 'green', warn: 'orange', bad: 'red', pending: 'accent', done: 'gray' };
export const SEV_TONE = { critical: 'red', warning: 'orange', info: 'accent' };

// ── Buttons ──────────────────────────────────────────────────────────────────
// `loading` always disables the button (a second click must not submit again), whatever `disabled` says.
export function Button({ variant = 'secondary', size = 'md', icon, iconRight, children, className, loading, disabled, ...rest }) {
  const sizes = { sm: 'h-6 px-2.5 text-callout gap-1', md: 'h-7 px-3 text-body gap-1.5', lg: 'h-9 px-4 text-title3 gap-2' };
  const variants = {
    primary: 'bg-accent text-on-accent hover:opacity-85',
    secondary: 'bg-fill-3 hover:bg-fill-2 text-label shadow-[inset_0_0_0_1px_var(--line)]',
    glass: 'glass text-label',
    plain: 'hover:bg-fill-3 text-label',
    tinted: 'bg-accent-tint text-accent hover:bg-fill-2',
    danger: 'bg-red-tint text-red hover:brightness-105',
  };
  return (
    <button
      type="button"
      {...rest}
      className={cx('no-drag press inline-flex shrink-0 items-center justify-center rounded-full font-medium whitespace-nowrap disabled:opacity-40 disabled:pointer-events-none', sizes[size], variants[variant], className)}
      disabled={!!(loading || disabled)}
      aria-busy={loading ? true : undefined}
    >
      {loading ? <Spinner size={size === 'lg' ? 16 : 13} /> : icon ? <Icon name={icon} size={size === 'lg' ? 17 : 15} /> : null}
      {children}
      {iconRight && <Icon name={iconRight} size={13} className="opacity-60" />}
    </button>
  );
}

export function IconButton({ icon, label, active, className, size = 28, iconSize = 16, variant = 'plain', badge, ...rest }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={cx(
        'no-drag press relative inline-flex shrink-0 items-center justify-center rounded-full text-label-2 hover:text-label',
        variant === 'glass' ? 'glass' : 'hover:bg-fill-3',
        active && 'bg-fill-2 !text-label',
        className,
      )}
      style={{ width: size, height: size }}
      {...rest}
    >
      <Icon name={icon} size={iconSize} />
      {badge ? (
        <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-red text-white text-footnote font-semibold grid place-items-center tabular shadow-[0_0_0_2px_var(--bg-content)]">{badge > 99 ? '99+' : badge}</span>
      ) : null}
    </button>
  );
}

export function Spinner({ size = 14, className }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" className={cx('spinner text-label-3', className)} aria-hidden="true">
      <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.4" />
      <path d="M10 2.5a7.5 7.5 0 0 1 7.5 7.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

// ── Status ───────────────────────────────────────────────────────────────────
export function StatusDot({ tone = 'gray', pulse, size = 8, className }) {
  return (
    <span className={cx('relative inline-block shrink-0 rounded-full', TONE[tone]?.dot, TONE[tone]?.fg, pulse && 'live-dot', className)} style={{ width: size, height: size }} />
  );
}

export function Pill({ tone = 'gray', icon, children, className, strong }) {
  return (
    <span className={cx('inline-flex items-center gap-1 h-5 px-2 rounded-full text-subheadline font-semibold whitespace-nowrap', TONE[tone]?.bg, strong ? TONE[tone]?.fg : 'text-label', className)}>
      {icon ? <Icon name={icon} size={11} strokeWidth={2.2} className={TONE[tone]?.fg} /> : <StatusDot tone={tone} size={6} />}
      {children}
    </span>
  );
}

export function HealthPill({ health, className }) {
  const h = HEALTH[health] || HEALTH.unknown;
  return (
    <Pill tone={h.tone} icon={h.icon} className={className}>
      {h.label}
    </Pill>
  );
}

/** An HTTP status. 0 means the client closed the connection before any response: a 4xx-class outcome, not a server error. */
export function StatusCode({ status }) {
  const tone = status === 0 ? 'orange' : status >= 500 || !status ? 'red' : status >= 400 ? 'orange' : status >= 300 ? 'gray' : 'green';
  return (
    <span className={cx('inline-flex items-center justify-center h-5 min-w-10 px-1.5 rounded-md text-subheadline font-semibold tabular font-mono', TONE[tone].bg)}>
      <span className={TONE[tone].fg}>{status === 0 ? '0' : status || 'ERR'}</span>
    </span>
  );
}

// ── Surfaces ─────────────────────────────────────────────────────────────────
export function Card({ children, className, pad = true, as: As = 'div', ...rest }) {
  return (
    <As className={cx('card', pad && 'p-4', className)} {...rest}>
      {children}
    </As>
  );
}

/**
 * An (i) that explains the thing next to it. Tooltips draws the card on hover,
 * click or keyboard focus; screen readers get the same words.
 * @param {{title: string, body: string, note?: string, className?: string}} p
 */
export function InfoTip({ title, body, note, className }) {
  return (
    <button
      type="button"
      data-info={title}
      data-info-body={body}
      data-info-note={note || undefined}
      aria-label={`About ${title}`}
      aria-description={[body, note].filter(Boolean).join(' ')}
      className={cx('no-drag inline-grid place-items-center w-4 h-4 rounded-full shrink-0 text-label-3 hover:text-label-2 focus-visible:text-label-2 cursor-help', className)}
    >
      <Icon name="info" size={13} strokeWidth={1.9} />
    </button>
  );
}

export function SectionTitle({ title, subtitle, right, className, icon, info }) {
  return (
    <div className={cx('flex items-end justify-between gap-4 mb-2.5 px-1', className)}>
      <div className="min-w-0 flex-1">
        <h2 className="text-title3 font-semibold flex items-center gap-1.5">
          {icon && <Icon name={icon} size={15} className="text-label-2" />}
          {title}
          {info && <InfoTip {...info} />}
        </h2>
        {subtitle && <p className="text-callout text-label-2 mt-0.5 truncate">{subtitle}</p>}
      </div>
      {right && <div className="flex items-center gap-2 shrink-0">{right}</div>}
    </div>
  );
}

export function Empty({ icon = 'check', title, message, action, tone = 'green', className, compact }) {
  if (compact) {
    return (
      <div className={cx('flex items-center gap-3 px-4 py-4 animate-fade', className)}>
        <div className={cx('w-7 h-7 rounded-full grid place-items-center shrink-0', TONE[tone]?.bg)}>
          <Icon name={icon} size={14} className={TONE[tone]?.fg} strokeWidth={2} />
        </div>
        <div className="min-w-0">
          <div className="text-headline font-semibold">{title}</div>
          {message && <div className="text-callout text-label-2">{message}</div>}
        </div>
      </div>
    );
  }
  return (
    <div className={cx('flex flex-col items-center justify-center text-center py-14 px-6 animate-fade', className)}>
      <div className={cx('w-12 h-12 rounded-2xl grid place-items-center mb-3', TONE[tone]?.bg)}>
        <Icon name={icon} size={24} className={TONE[tone]?.fg} strokeWidth={1.8} />
      </div>
      <div className="text-title3 font-semibold">{title}</div>
      {message && <div className="text-body text-label-2 mt-1 max-w-sm">{message}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/**
 * An alert in words: what's wrong, the evidence, who's affected and what to do.
 * `compact` (toasts, the alerts popover) drops the impact and clamps long lines.
 */
export function AlertText({ a, compact }) {
  return (
    <>
      <div className="text-headline font-semibold break-words">{a.title}</div>
      {a.detail && <div className={cx('text-callout text-label-2 mt-0.5 break-words', compact && 'line-clamp-2')}>{a.detail}</div>}
      {!compact && a.impact && <div className="text-callout text-label-2 mt-1 break-words">{a.impact}</div>}
      {a.action && (
        <div className={cx('mt-1.5 text-callout text-label break-words', compact && 'line-clamp-3')}>
          <span className="font-semibold">What to do: </span>
          {a.action}
        </div>
      )}
    </>
  );
}

export function Kbd({ children }) {
  return <kbd className="inline-flex items-center h-[18px] px-1.5 rounded-[5px] bg-fill-3 text-footnote font-medium text-label-2 font-sans">{children}</kbd>;
}

// ── Inputs ───────────────────────────────────────────────────────────────────
/**
 * A segmented control: a radio group (one tab stop; arrow keys, Home and End move the choice).
 * `label` names the group for screen readers.
 */
export function Segmented({ value, onChange, options, size = 'md', className, label }) {
  const ref = useRef(null);
  const [thumb, setThumb] = useState(null);
  const measure = useCallback(() => {
    const el = ref.current?.querySelector(`[data-v="${CSS.escape(String(value))}"]`);
    if (el) setThumb({ left: el.offsetLeft, width: el.offsetWidth });
  }, [value]);
  useLayoutEffect(measure, [measure, options.length]);
  useEffect(() => {
    const ro = new ResizeObserver(measure);
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, [measure]);
  const current = options.findIndex((o) => o.value === value);
  const onKeyDown = (e) => {
    const n = options.length;
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    let next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : null;
    if (step) next = ((current < 0 ? (step > 0 ? -1 : 0) : current) + step + n) % n;
    if (next == null || !n) return;
    e.preventDefault();
    if (next !== current) onChange(options[next].value);
    ref.current?.querySelector(`[data-v="${CSS.escape(String(options[next].value))}"]`)?.focus();
  };
  const h = size === 'sm' ? 'h-6' : 'h-7';
  return (
    <div ref={ref} role="radiogroup" aria-label={label} onKeyDown={onKeyDown} className={cx('no-drag relative inline-flex items-center p-0.5 rounded-[8px] bg-fill-4 shadow-[inset_0_0_0_1px_var(--line)]', h, className)}>
      {thumb && (
        <span
          className="absolute top-0.5 bottom-0.5 rounded-[6px] bg-thumb shadow-[0_1px_2px_rgb(0_0_0/0.08),inset_0_0_0_1px_var(--line-strong)]"
          style={{ left: thumb.left, width: thumb.width, transition: 'left 420ms var(--ease-spring), width 420ms var(--ease-spring)' }}
        />
      )}
      {options.map((o, i) => (
        <button
          key={String(o.value)}
          data-v={String(o.value)}
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value || (current < 0 && i === 0) ? 0 : -1}
          type="button"
          onClick={() => onChange(o.value)}
          className={cx('relative z-10 h-full px-3 rounded-[6px] inline-flex items-center gap-1.5 whitespace-nowrap transition-colors duration-200', size === 'sm' ? 'text-callout' : 'text-body', o.value === value ? 'text-label font-medium' : 'text-label-2 hover:text-label')}
        >
          {o.dot && <StatusDot tone={o.dot} size={6} />}
          {o.label}
          {o.count != null && <span className={cx('tabular text-subheadline', o.value === value ? 'text-label-2' : 'text-label-3')}>{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function SearchField({ value, onChange, placeholder = 'Search', className, autoFocus, inputRef, onKeyDown, width = 220 }) {
  return (
    <label className={cx('no-drag relative inline-flex items-center h-7 rounded-full bg-fill-3 focus-within:bg-fill-4 focus-within:shadow-[0_0_0_3px_var(--accent-tint)] transition-shadow', className)} style={{ width }}>
      <Icon name="search" size={14} className="absolute left-2.5 text-label-3" />
      <input
        ref={inputRef}
        value={value}
        autoFocus={autoFocus}
        onKeyDown={onKeyDown}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className="w-full h-full bg-transparent pl-8 pr-7 outline-none text-body placeholder:text-label-3"
      />
      {value && (
        <button type="button" onClick={() => onChange('')} className="absolute right-1.5 w-4 h-4 rounded-full bg-label-3 text-content grid place-items-center" aria-label="Clear">
          <Icon name="x" size={9} strokeWidth={2.6} />
        </button>
      )}
    </label>
  );
}

export function TextField({ value, onChange, placeholder, type = 'text', className, mono, ...rest }) {
  return (
    <input
      type={type}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      spellCheck={false}
      className={cx('no-drag h-8 w-full rounded-lg bg-fill-4 px-3 text-body outline-none shadow-[inset_0_0_0_1px_var(--line)] focus:shadow-[0_0_0_3px_var(--accent-tint),inset_0_0_0_1px_var(--label-3)] placeholder:text-label-3 transition-shadow', mono && 'font-mono text-callout', className)}
      {...rest}
    />
  );
}

export function Toggle({ checked, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx('no-drag relative w-[38px] h-[22px] rounded-full shrink-0 transition-colors duration-300', checked ? 'bg-accent' : 'bg-fill-1')}
    >
      <span
        className={cx('absolute top-[2px] left-[2px] w-[18px] h-[18px] rounded-full shadow-[0_1px_3px_rgb(0_0_0/0.25)]', checked ? 'bg-on-accent' : 'bg-white')}
        style={{ transform: `translateX(${checked ? 16 : 0}px)`, transition: 'transform 460ms var(--ease-spring)' }}
      />
    </button>
  );
}

export function Slider({ value, onChange, min = 0, max = 1, step = 0.01, className }) {
  const pctv = ((value - min) / (max - min)) * 100;
  return (
    <div className={cx('no-drag relative h-6 flex items-center', className)}>
      <div className="absolute inset-x-0 h-1 rounded-full bg-fill-2" />
      <div className="absolute left-0 h-1 rounded-full bg-accent" style={{ width: `${pctv}%` }} />
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="absolute inset-0 w-full opacity-0 cursor-pointer" />
      <div className="absolute w-[26px] h-[18px] -ml-[13px] rounded-full bg-white shadow-[0_1px_4px_rgb(0_0_0/0.22),0_0_0_0.5px_rgb(0_0_0/0.06)] pointer-events-none" style={{ left: `${pctv}%` }} />
    </div>
  );
}

export function CopyButton({ text, label = 'Copy' }) {
  const [done, setDone] = useState(null); // 'ok' | 'failed' for a moment after a click
  return (
    <Button
      size="sm"
      variant="plain"
      icon={done === 'ok' ? 'check' : done === 'failed' ? 'errors' : 'copy'}
      onClick={async () => {
        // The clipboard can refuse (a browser preview without permission): say so, the text stays selectable.
        const ok = await invoke('clipboard:write', { text }).then(
          () => true,
          () => false,
        );
        setDone(ok ? 'ok' : 'failed');
        setTimeout(() => setDone(null), ok ? 1400 : 2500);
      }}
    >
      {done === 'ok' ? 'Copied' : done === 'failed' ? 'Couldn’t copy' : label}
    </Button>
  );
}

// ── Meters & stats ───────────────────────────────────────────────────────────
export function Meter({ value, warn = 0.8, danger = 0.92, className, height = 4 }) {
  const v = value == null ? null : Math.max(0, Math.min(1, value));
  const tone = v == null ? 'gray' : v >= danger ? 'red' : v >= warn ? 'orange' : 'accent';
  const color = { red: 'var(--red)', orange: 'var(--orange)', accent: 'var(--accent)', gray: 'var(--gray)' }[tone];
  return (
    <div className={cx('relative w-full rounded-full overflow-hidden', className)} style={{ height, background: `color-mix(in srgb, ${color} 18%, transparent)` }}>
      {v != null && <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${v * 100}%`, background: color, transition: 'width 700ms var(--ease-smooth)' }} />}
    </div>
  );
}

// ── Layers ───────────────────────────────────────────────────────────────────
// Everything that floats registers here while it's open, so one Escape closes only the
// topmost thing, wherever focus is: tooltip > right-click menu > list or date picker >
// popover > sheet or palette > inspector. The stacking itself is the z-scale in styles.css
// (z-inspector … z-menu); floating roots carry data-layer so focus handling can tell them apart.
export const LAYER = { inspector: 1, sheet: 2, popover: 3, picker: 4, menu: 5, tooltip: 6 };
const layers = [];
let layerSeq = 0;

function onLayerKey(e) {
  if (e.key !== 'Escape' || e.isComposing || !layers.length) return;
  const top = layers.reduce((a, b) => (b.rank > a.rank || (b.rank === a.rank && b.seq > a.seq) ? b : a));
  if (top.onEscape.current?.(e) === false) return; // it let the key through (the inspector while you type)
  e.preventDefault();
  e.stopPropagation();
}

/** While `open`, Escape calls `onEscape` if this is the topmost layer (return false to let the key through). */
export function useLayer(open, rank, onEscape) {
  const cb = useRef(onEscape);
  useLayoutEffect(() => {
    cb.current = onEscape;
  });
  useEffect(() => {
    if (!open) return;
    const layer = { rank, seq: ++layerSeq, onEscape: cb };
    // A sheet or the palette opening (Ctrl+K with a popover open) closes whatever floats above
    // that level first: it would otherwise sit on top of the modal and swallow its clicks.
    if (rank === LAYER.sheet) for (const l of [...layers]) if (l.rank > LAYER.sheet) l.onEscape.current?.();
    layers.push(layer);
    if (layers.length === 1) window.addEventListener('keydown', onLayerKey, true);
    return () => {
      layers.splice(layers.indexOf(layer), 1);
      if (!layers.length) window.removeEventListener('keydown', onLayerKey, true);
    };
  }, [open, rank]);
}

const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]';
/** What Tab can reach inside `root`, in order. */
export function tabbables(root) {
  return root ? [...root.querySelectorAll(TABBABLE)].filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0) : [];
}

function restoreFocus(opener, box) {
  const a = document.activeElement;
  if (opener && opener !== document.body && opener.isConnected && (!a || a === document.body || box.contains(a))) opener.focus({ preventScroll: true });
}

const modals = []; // open sheets and palettes, newest last

/** Puts focus back into the topmost sheet or palette (after the control that had it went away, like Silence). */
export function refocusModal() {
  const box = modals[modals.length - 1];
  if (box && !box.contains(document.activeElement)) box.focus({ preventScroll: true });
}

/**
 * Focus for a modal (sheet, command palette). It moves in on open (to [data-autofocus], else the
 * first control); while open, Tab cycles through the modal and the toast stack (so the alarm's
 * Silence button stays reachable) and focus can't land behind it; on close it goes back to
 * whatever had it before.
 */
export function useModalFocus(ref, open) {
  useLayoutEffect(() => {
    const box = ref.current;
    if (!open || !box) return;
    const opener = document.activeElement;
    modals.push(box);
    // The modal itself unless something asks for focus (the palette's search field): a sheet that
    // opens by itself ("While you were away") shouldn't start with a focus ring on its first button.
    // Tab from there goes to the first control.
    if (!box.contains(document.activeElement)) (box.querySelector('[data-autofocus]') || box).focus({ preventScroll: true });
    const top = () => modals[modals.length - 1] === box;
    const onKey = (e) => {
      if (e.key !== 'Tab' || !top()) return;
      const active = document.activeElement;
      // A popover or list opened from the modal looks after its own Tab.
      if (active && !box.contains(active) && active.closest?.('[data-layer]')) return;
      const list = [...tabbables(box), ...tabbables(document.querySelector('[data-toasts]'))];
      e.preventDefault();
      if (!list.length) return box.focus();
      const i = list.indexOf(active);
      list[i < 0 ? (e.shiftKey ? list.length - 1 : 0) : (i + (e.shiftKey ? -1 : 1) + list.length) % list.length].focus();
    };
    const onFocusIn = (e) => {
      if (!top() || box.contains(e.target) || e.target.closest?.('[data-layer], [data-toasts]')) return;
      (tabbables(box)[0] || box).focus({ preventScroll: true });
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocusIn, true);
    return () => {
      modals.splice(modals.indexOf(box), 1);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocusIn, true);
      restoreFocus(opener, box);
    };
  }, [open, ref]);
}

/**
 * Focus for a floating panel (popover, date picker): it moves in on open (to [data-autofocus],
 * else the panel itself, so Tab continues inside it) and back to the opener on close. Returns the
 * panel's keydown handler: tabbing past either end closes the panel.
 */
export function useFloatingFocus(ref, open, onClose) {
  useLayoutEffect(() => {
    const box = ref.current;
    if (!open || !box) return;
    const opener = document.activeElement;
    (box.querySelector('[data-autofocus]') || box).focus({ preventScroll: true });
    return () => restoreFocus(opener, box);
  }, [open, ref]);
  return (e) => {
    if (e.key !== 'Tab' || e.defaultPrevented) return;
    const list = tabbables(ref.current);
    const i = list.indexOf(document.activeElement);
    if (!list.length || (e.shiftKey ? i <= 0 : i === list.length - 1)) {
      e.preventDefault();
      onClose();
    }
  };
}

// ── Overlays ─────────────────────────────────────────────────────────────────
export function Sheet({ open, onClose, children, width = 720, className, label }) {
  const box = useRef(null);
  useLayer(open, LAYER.sheet, () => onClose?.());
  useModalFocus(box, open);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-sheet grid place-items-center p-8 no-drag" data-layer="sheet">
      <div className="absolute inset-0 animate-fade" style={{ background: 'var(--scrim)' }} onClick={onClose} />
      <div ref={box} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} className={cx('relative glass-strong rounded-[14px] animate-sheet max-h-full flex flex-col overflow-hidden outline-none', className)} style={{ width }}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** A floating panel under (or above) `anchor`. `role` and `label` describe the panel to screen readers (e.g. "dialog", "Alerts"). */
export function Popover({ open, onClose, anchor, children, width = 380, align = 'end', role, label }) {
  const panel = useRef(null);
  const [pos, setPos] = useState(null);
  useLayer(open, LAYER.popover, () => onClose());
  // Below the anchor, or above it when it doesn't fit below and there's more room above (the
  // Export button at the bottom of a sheet). Measured before the first paint, so it never jumps.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const a = anchor?.current?.getBoundingClientRect();
      const p = panel.current;
      if (!a || !p) return;
      const w = Math.min(width, window.innerWidth - 16);
      const left = align === 'end' ? Math.max(8, a.right - w) : Math.max(8, Math.min(window.innerWidth - w - 8, a.left));
      const below = window.innerHeight - a.bottom - 20;
      const above = a.top - 20;
      const up = p.scrollHeight > below && above > below;
      setPos(up ? { left, width: w, bottom: window.innerHeight - a.top + 8, maxHeight: above, up } : { left, width: w, top: a.bottom + 8, maxHeight: below });
    };
    place();
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('resize', place);
      setPos(null);
    };
  }, [open, anchor, width, align]);
  const onKeyDown = useFloatingFocus(panel, open, onClose);
  if (!open) return null;
  const side = align === 'end' ? 'right' : 'left';
  return createPortal(
    <div className="fixed inset-0 z-popover no-drag" data-layer="popover" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panel}
        role={role}
        aria-label={label}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="absolute glass-strong rounded-[14px] animate-sheet overflow-hidden flex flex-col outline-none"
        // Until measured (never painted: the layout effect places it first) it sits at the top left.
        style={pos ? { top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width, maxHeight: pos.maxHeight, transformOrigin: `${pos.up ? 'bottom' : 'top'} ${side}` } : { top: 0, left: 0, width: Math.min(width, window.innerWidth - 16) }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** Window width, updated on resize (for layouts that change with the window size). */
export function useWindowWidth() {
  const [w, setW] = useState(typeof window !== 'undefined' ? window.innerWidth : 1400);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return w;
}

/** Re-render every `ms` (for "3m ago" labels). */
export function useNow(ms = 10_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function KeyValue({ items, className }) {
  return (
    <dl className={cx('grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-callout', className)}>
      {items.filter(Boolean).map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-label-2 whitespace-nowrap">{k}</dt>
          <dd className="text-label min-w-0 truncate selectable tabular">{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
