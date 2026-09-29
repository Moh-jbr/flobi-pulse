// Replaces the operating system's plain tooltips everywhere. Any element with a
// `title` keeps working as before in the code; on hover the title is moved to
// data-tip (so the native tooltip never shows) and drawn in the app's style.
// Elements with data-info (the InfoTip (i) buttons) get a larger explanation
// card instead, sooner, and also on keyboard focus. That card stays open while
// the pointer is on it, so it can be read (and its text selected) at leisure.
//
// Moving the title must not lose it or let it go stale:
//  • An empty title="" stays in its place, so when React later changes or removes
//    the title, that shows up as a change (watched below) and data-tip follows it:
//    a new text replaces it, an empty or removed title clears it (and hides it).
//  • The title was also the element's accessible name or description. It becomes
//    aria-label when the element has no name of its own (icon-only buttons), else
//    aria-description, and is removed again with the title.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LAYER, useLayer } from './ui.jsx';

function hasOwnName(el) {
  if (el.hasAttribute('aria-labelledby') || el.hasAttribute('alt')) return true;
  if (el.getAttribute('aria-label')?.trim() && el.dataset.tipAria !== 'label') return true;
  return !!el.textContent.trim();
}

/** Mirrors `text` (the title) into aria-label or aria-description; null removes what was added. */
function describe(el, text) {
  const own = el.dataset.tipAria;
  if (own === 'label') el.removeAttribute('aria-label');
  if (own === 'description') el.removeAttribute('aria-description');
  delete el.dataset.tipAria;
  // A decorative image (alt="") stays hidden from screen readers.
  if (!text || (el.tagName === 'IMG' && el.getAttribute('alt') === '')) return;
  if (!hasOwnName(el)) {
    el.setAttribute('aria-label', text);
    el.dataset.tipAria = 'label';
  } else if (text !== (el.getAttribute('aria-label') || el.textContent).trim() && !el.hasAttribute('aria-description')) {
    el.setAttribute('aria-description', text);
    el.dataset.tipAria = 'description';
  }
}

/** Takes over an element's title: data-tip gets the text, title stays as an empty placeholder. */
function adopt(el) {
  const t = el.getAttribute('title');
  if (!t) return;
  el.setAttribute('data-tip', t);
  el.setAttribute('title', '');
  describe(el, t);
}

export default function Tooltips() {
  const [tip, setTip] = useState(null); // { text | info: {title, body, note}, r: target rect }
  const [pos, setPos] = useState(null);
  const timer = useRef(null);
  const hideTimer = useRef(null);
  const target = useRef(null);
  const box = useRef(null);
  const hideRef = useRef(() => {});

  // Escape hides a visible tooltip first (and only it).
  useLayer(!!tip, LAYER.tooltip, () => hideRef.current());

  useEffect(() => {
    const hide = () => {
      clearTimeout(timer.current);
      clearTimeout(hideTimer.current);
      target.current = null;
      setTip(null);
    };
    hideRef.current = hide;
    // Leaving the (i) waits a moment, long enough to cross the gap into its card.
    const hideSoon = () => {
      clearTimeout(hideTimer.current);
      hideTimer.current = setTimeout(hide, 160);
    };
    const inCard = (node) => !!(node && box.current?.contains(node));
    let pointerOnTip = false; // on the open card or its (i)
    const show = (el, delay) => {
      const content = el.hasAttribute('data-info') ? { info: { title: el.dataset.info, body: el.dataset.infoBody, note: el.dataset.infoNote } } : { text: el.getAttribute('data-tip') };
      hide();
      if (!content.info && !content.text) return;
      target.current = el;
      timer.current = setTimeout(() => {
        if (target.current !== el || !el.isConnected) return;
        setPos(null);
        setTip({ ...content, r: el.getBoundingClientRect() });
      }, delay);
    };
    const onOver = (e) => {
      const onCard = inCard(e.target);
      // An empty title (ours, or one set on purpose) doesn't hide a tooltip further up.
      const el = onCard ? null : e.target.closest?.('[title]:not([title=""]), [data-tip], [data-info]');
      // On the open card, or back on its (i): keep it open.
      if (target.current && (onCard || el === target.current)) {
        pointerOnTip = true;
        clearTimeout(hideTimer.current);
        return;
      }
      pointerOnTip = false;
      if (!el) return;
      adopt(el);
      show(el, el.hasAttribute('data-info') ? 120 : 450);
      pointerOnTip = true;
    };
    const onOut = (e) => {
      if (!target.current) return;
      const to = e.relatedTarget;
      if (target.current.contains(to) || inCard(to)) return;
      pointerOnTip = false;
      if (target.current.hasAttribute('data-info')) hideSoon();
      else hide();
    };
    // Keyboard focus only: a clicked (i) already shows its card from the hover,
    // and focus coming back with the window shouldn't pop it open again.
    const onFocusIn = (e) => {
      const el = e.target.closest?.('[data-info]');
      if (el && el !== target.current && el.matches(':focus-visible')) show(el, 0);
    };
    // Clicking the (i) or inside its card keeps the card; any other click closes tooltips.
    const onDown = (e) => {
      if (inCard(e.target) || (target.current?.hasAttribute('data-info') && target.current.contains(e.target))) return;
      hide();
    };
    // Tabbing away closes the card; clicking into it to select text doesn't.
    const onFocusOut = (e) => {
      if (target.current && e.target === target.current && !pointerOnTip) hide();
    };
    // React changing or removing a title we took over. Our own placeholder write shows up
    // here too (as a change away from a non-empty text) and is ignored.
    const titles = new MutationObserver((records) => {
      for (const { target: el, oldValue } of records) {
        const t = el.getAttribute('title');
        if (t) {
          if (el.hasAttribute('data-tip')) adopt(el);
          else continue; // not taken over yet: it's read on hover
        } else if (t === null || oldValue === '') {
          if (!el.hasAttribute('data-tip')) continue;
          el.removeAttribute('data-tip');
          describe(el, null);
        } else continue;
        if (target.current === el) {
          const text = el.getAttribute('data-tip');
          if (text) setTip((cur) => (cur && !cur.info ? { ...cur, text } : cur));
          else hide();
        }
      }
    });
    titles.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['title'], attributeOldValue: true });
    // Escape is handled through the layer stack (above), so it closes only the tooltip.
    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('mouseout', onOut, true);
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    document.addEventListener('wheel', hide, { capture: true, passive: true });
    window.addEventListener('blur', hide);
    return () => {
      titles.disconnect();
      document.removeEventListener('mouseover', onOver, true);
      document.removeEventListener('mouseout', onOut, true);
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
      document.removeEventListener('wheel', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, []);

  // Measure the bubble, then place it below the element (or above when it
  // wouldn't fit), always inside the window.
  useLayoutEffect(() => {
    if (!tip || !box.current) return;
    const b = box.current.getBoundingClientRect();
    const { r } = tip;
    const fitsBelow = r.bottom + 8 + b.height <= window.innerHeight - 6;
    const top = fitsBelow ? r.bottom + 8 : Math.max(6, r.top - 8 - b.height);
    const left = Math.max(6, Math.min(r.left + r.width / 2 - b.width / 2, window.innerWidth - b.width - 6));
    setPos({ top, left });
  }, [tip]);

  if (!tip) return null;
  const style = { top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' };
  if (tip.info) {
    return createPortal(
      <div ref={box} role="tooltip" className="fixed z-tooltip selectable w-[300px] max-w-[calc(100vw-12px)] p-3 rounded-[14px] glass-strong break-words animate-fade" style={style}>
        <div className="text-callout font-semibold text-label">{tip.info.title}</div>
        <p className="text-callout leading-[17px] text-label-2 mt-1">{tip.info.body}</p>
        {tip.info.note && <p className="text-subheadline leading-[16px] text-label-2 mt-2.5 pt-2.5 hairline-t">{tip.info.note}</p>}
      </div>,
      document.body,
    );
  }
  return createPortal(
    <div
      ref={box}
      aria-hidden="true"
      className="fixed z-tooltip pointer-events-none max-w-[360px] px-2.5 py-1.5 rounded-[9px] bg-[var(--tooltip-bg)] text-[var(--tooltip-fg)] text-footnote leading-[15px] shadow-[0_6px_20px_rgb(0_0_0/0.18)] whitespace-pre-wrap break-words animate-fade"
      style={style}
    >
      {tip.text}
    </div>,
    document.body,
  );
}
