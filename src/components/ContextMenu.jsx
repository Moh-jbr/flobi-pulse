// Right-click menu in the app's style (the window has none by default).
//  • in a text field: Cut / Copy / Paste / Select all
//  • on selected text: Copy
//  • on anything marked data-copy="…": Copy <what>
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './icons.jsx';
import { invoke } from '../lib/store.js';
import { cx, LAYER, useLayer } from './ui.jsx';
import { shortcut } from '../lib/platform.js';

const isEditable = (el) => !!el && (el.isContentEditable || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'submit'].includes(el.type)) || el.tagName === 'TEXTAREA');

export default function ContextMenu() {
  const [menu, setMenu] = useState(null); // { x, y, items }
  const box = useRef(null);
  const [pos, setPos] = useState(null);

  useEffect(() => {
    const onCtx = (e) => {
      const field = isEditable(e.target) ? e.target : null;
      const sel = window.getSelection()?.toString() || '';
      const copyEl = e.target.closest?.('[data-copy]');
      const items = [];
      if (field) {
        const has = field.selectionStart != null ? field.selectionStart !== field.selectionEnd : !!sel;
        const ro = field.readOnly || field.disabled;
        items.push(
          { label: 'Cut', action: 'cut', icon: null, disabled: !has || ro, keys: 'X' },
          { label: 'Copy', action: 'copy', icon: 'copy', disabled: !has, keys: 'C' },
          { label: 'Paste', action: 'paste', icon: null, disabled: ro, keys: 'V' },
          { sep: true },
          { label: 'Select all', action: 'selectAll', icon: null, disabled: !field.value && !field.textContent, keys: 'A' },
        );
      } else {
        if (sel.trim()) items.push({ label: 'Copy', action: 'copy', icon: 'copy', keys: 'C' });
        if (copyEl) items.push({ label: copyEl.getAttribute('data-copy-label') || 'Copy', text: copyEl.getAttribute('data-copy'), icon: 'copy' });
      }
      e.preventDefault();
      if (!items.length) return setMenu(null);
      setPos(null);
      setMenu({ x: e.clientX, y: e.clientY, items });
    };
    const close = () => setMenu(null);
    document.addEventListener('contextmenu', onCtx);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    document.addEventListener('wheel', close, { passive: true, capture: true });
    return () => {
      document.removeEventListener('contextmenu', onCtx);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
      document.removeEventListener('wheel', close, true);
    };
  }, []);

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    if (!menu || !box.current) return;
    const r = box.current.getBoundingClientRect();
    setPos({ left: Math.min(menu.x, window.innerWidth - r.width - 6), top: menu.y + r.height > window.innerHeight - 6 ? Math.max(6, menu.y - r.height) : menu.y });
  }, [menu]);

  // The topmost layer: Escape closes the menu and nothing under it.
  useLayer(!!menu, LAYER.menu, () => setMenu(null));

  if (!menu) return null;
  const run = async (it) => {
    setMenu(null);
    if (it.text != null) await invoke('clipboard:write', { text: it.text });
    else await invoke('edit:do', { action: it.action });
  };
  return createPortal(
    <div className="fixed inset-0 z-menu" data-layer="menu" onMouseDown={(e) => (e.preventDefault(), setMenu(null))} onContextMenu={(e) => (e.preventDefault(), setMenu(null))}>
      <div
        ref={box}
        role="menu"
        onMouseDown={(e) => (e.preventDefault(), e.stopPropagation())}
        className="absolute min-w-[180px] p-1 rounded-[12px] bg-elevated shadow-[var(--shadow-pop),0_0_0_0.5px_var(--separator)] animate-fade"
        style={{ left: pos?.left ?? menu.x, top: pos?.top ?? menu.y, visibility: pos ? 'visible' : 'hidden' }}
      >
        {menu.items.map((it, i) =>
          it.sep ? (
            <div key={i} className="my-1 mx-2 hairline-t" />
          ) : (
            <button
              key={i}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              onClick={() => run(it)}
              className={cx('group w-full h-7 px-2.5 rounded-[8px] flex items-center gap-2 text-callout text-left text-label', it.disabled ? 'opacity-35' : 'hover:bg-accent hover:text-white')}
            >
              <span className="w-3.5 grid place-items-center shrink-0">{it.icon && <Icon name={it.icon} size={13} />}</span>
              <span className="flex-1 truncate">{it.label}</span>
              {it.keys && <span className={cx('text-footnote text-label-3 tabular', !it.disabled && 'group-hover:text-white/80')}>{shortcut(it.keys)}</span>}
            </button>
          ),
        )}
      </div>
    </div>,
    document.body,
  );
}
