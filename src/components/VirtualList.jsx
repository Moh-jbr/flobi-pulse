// Fixed-row-height virtual list that can "follow" the newest rows (like tail -f).
//
// How it stays a normal scrollable list while rows keep arriving:
//  • The moment you scroll, drag the scrollbar or press a scroll key, following
//    stops, and the page freezes the rows it shows (so nothing moves under you).
//  • While not following, the list never moves the scroll position itself.
//  • Following turns back on only once you've scrolled away AND come back to the
//    newest rows. (Re-following as soon as the list was near the edge caught the
//    first few pixels of every smooth scroll and snapped it back.)
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cx } from './ui.jsx';

const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

// getKey(item, index) gives each row a stable React key (so a row keeps its DOM node, hover and
// focus while the list scrolls or grows); without it, rows use the key renderRow put on them.
export default function VirtualList({ items, rowHeight = 30, renderRow, getKey, follow = false, onFollowChange, overscan = 10, className, header, empty, reverse = false }) {
  const ref = useRef(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const programmatic = useRef(false);
  const count = items.length;
  const headerH = header ? 32 : 0;
  const latest = useRef({ follow, onFollowChange, reverse });
  latest.current = { follow, onFollowChange, reverse };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setHeight(e.contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Any deliberate scroll by the person stops following right away.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const stop = () => {
      const l = latest.current;
      if (l.follow) l.onFollowChange?.(false);
    };
    const onWheel = (e) => {
      const awayFromNewest = latest.current.reverse ? e.deltaY > 0 : e.deltaY < 0;
      if (awayFromNewest) stop();
    };
    const onKey = (e) => SCROLL_KEYS.has(e.key) && stop();
    const onPointer = (e) => {
      // Grabbing the scrollbar (the strip right of the content).
      if (e.offsetX > el.clientWidth) stop();
    };
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchmove', stop, { passive: true });
    el.addEventListener('keydown', onKey);
    el.addEventListener('pointerdown', onPointer);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchmove', stop);
      el.removeEventListener('keydown', onKey);
      el.removeEventListener('pointerdown', onPointer);
    };
  }, []);

  const awayMax = useRef(0); // furthest distance from the newest rows since following stopped

  const setTop = (el, top) => {
    programmatic.current = true;
    el.scrollTop = top;
    setScrollTop(el.scrollTop);
    requestAnimationFrame(() => (programmatic.current = false));
  };

  // Follow newest rows (bottom in normal order, top when reversed). When not
  // following, leave the scroll position alone.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !follow) return;
    awayMax.current = 0;
    setTop(el, reverse ? 0 : el.scrollHeight);
  }, [count, follow, reverse, items]);

  const onScroll = (e) => {
    const el = e.currentTarget;
    setScrollTop(el.scrollTop);
    if (programmatic.current) return;
    const dist = reverse ? el.scrollTop : el.scrollHeight - el.scrollTop - el.clientHeight;
    // Any other kind of scroll (scrollbar drag, touchpad, middle-click) that
    // takes the list away from the newest rows also stops following.
    if (follow && dist > 40) {
      awayMax.current = dist;
      onFollowChange?.(false);
      return;
    }
    if (!follow) {
      awayMax.current = Math.max(awayMax.current, dist);
      if (dist < 4 && awayMax.current > 40) {
        awayMax.current = 0;
        onFollowChange?.(true);
      }
    }
  };

  // Never render more than about a screenful, even if the layout is off.
  const viewH = Math.min(height, (typeof window !== 'undefined' ? window.innerHeight : 1200) * 1.5);
  const start = Math.max(0, Math.floor((scrollTop - headerH) / rowHeight) - overscan);
  const end = Math.min(count, Math.ceil((scrollTop - headerH + viewH) / rowHeight) + overscan);
  const rows = [];
  for (let i = start; i < end; i++) {
    const row = renderRow(items[i], i);
    rows.push(getKey ? <Fragment key={getKey(items[i], i)}>{row}</Fragment> : row);
  }

  return (
    // No position class here: callers pass `absolute inset-0`, and a `relative`
    // next to it wins in the generated CSS, which let the list grow to its full
    // height, so it couldn't scroll and rendered every row.
    <div ref={ref} tabIndex={-1} onScroll={onScroll} style={{ overflowAnchor: 'none' }} className={cx('overflow-auto outline-none overscroll-contain', className)}>
      {header && <div className="sticky top-0 z-10">{header}</div>}
      {count === 0 && empty}
      <div style={{ height: count * rowHeight, position: 'relative' }}>
        <div style={{ position: 'absolute', top: start * rowHeight, left: 0, right: 0 }}>{rows}</div>
      </div>
    </div>
  );
}
