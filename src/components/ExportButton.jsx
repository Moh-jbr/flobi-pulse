// "Export" for any table: a real Excel workbook, or Markdown / CSV on the
// clipboard. It exports exactly the rows the table shows (filters applied).
import { useEffect, useRef, useState } from 'react';
import { invoke } from '../lib/store.js';
import { Button, Popover, cx } from './ui.jsx';
import Icon from './icons.jsx';
import { toXlsx, toMarkdown, toCsv, stamp } from '../lib/export.js';
import { num } from '../lib/format.js';

// A Markdown table is for pasting into chat or a doc; past this it stops being readable.
const MARKDOWN_MAX = 1000;

// Defined once, outside ExportButton: live tables re-render it several times a
// second, and a component declared inside would be rebuilt each time (losing hover).
function Item({ icon, label, sub, disabled, onClick, first }) {
  return (
    <button type="button" role="menuitem" disabled={disabled} data-autofocus={first && !disabled ? '' : undefined} onClick={onClick} className="w-full flex items-center gap-3 px-3 py-2 rounded-[10px] text-left hover:bg-fill-4 focus-visible:bg-fill-4 disabled:opacity-40">
      <Icon name={icon} size={16} className="text-accent shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block text-body">{label}</span>
        <span className="block text-subheadline text-label-3">{sub}</span>
      </span>
    </button>
  );
}

// Up/Down (and Home/End) move between the menu's items.
function onMenuKey(e) {
  const items = [...e.currentTarget.querySelectorAll('[role="menuitem"]:not(:disabled)')];
  const i = items.indexOf(document.activeElement);
  const next = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
  if (next == null || !items.length) return;
  e.preventDefault();
  items[(next + items.length) % items.length].focus();
}

/**
 * @param {{ name: string, title?: string, columns: {label: string, get: (row:any) => any}[], rows: any[], size?: 'sm'|'md' }} p
 * `name` becomes the file name ("live-traffic-2026-09-27-1403.xlsx"), `title` the sheet name.
 */
export default function ExportButton({ name, title, columns, rows = [], size = 'sm' }) {
  const ref = useRef(null);
  const timer = useRef(null);
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState(null); // { ok, text }
  const n = rows.length;
  useEffect(() => () => clearTimeout(timer.current), []);

  const show = (ok, text) => {
    clearTimeout(timer.current);
    setResult({ ok, text });
    timer.current = setTimeout(() => setResult(null), ok ? 1800 : 5000);
  };
  const run = async (kind) => {
    setOpen(false);
    try {
      if (kind === 'xlsx') {
        const t = stamp(new Date()); // "2026-09-27 14:03:22"
        const file = `${name}-${t.slice(0, 10)}-${t.slice(11, 13)}${t.slice(14, 16)}.xlsx`;
        const res = await invoke('export:save', { name: file, data: toXlsx(columns, rows, title || name) });
        if (!res?.canceled) show(true, 'Saved');
      } else {
        await invoke('clipboard:write', { text: kind === 'md' ? toMarkdown(columns, rows.slice(0, MARKDOWN_MAX)) : toCsv(columns, rows) });
        show(true, 'Copied');
      }
    } catch (e) {
      show(false, String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
  };

  const failed = result && !result.ok;
  return (
    <>
      <span ref={ref} className="inline-flex">
        {/* The reason for a failure is the button's tooltip until the button goes back to "Export". */}
        <Button size={size} variant={result ? (result.ok ? 'tinted' : 'danger') : 'secondary'} icon={result ? (result.ok ? 'check' : 'errors') : 'download'} onClick={() => setOpen(!open)} title={failed ? result.text : undefined} aria-haspopup="menu" aria-expanded={open}>
          {result ? (result.ok ? result.text : 'Export failed') : 'Export'}
        </Button>
      </span>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} width={290}>
        <div role="menu" aria-label="Export" className="p-1.5" onKeyDown={onMenuKey}>
          <div className={cx('px-3 pt-1.5 pb-1 text-subheadline text-label-3')}>{n ? `${num(n)} row${n === 1 ? '' : 's'}, as shown (filters applied)` : 'Nothing to export yet'}</div>
          <Item first disabled={!n} onClick={() => run('xlsx')} icon="download" label="Download as Excel (.xlsx)" sub="Opens in Excel, Numbers and Google Sheets" />
          <Item disabled={!n} onClick={() => run('md')} icon="copy" label="Copy as Markdown" sub={n > MARKDOWN_MAX ? `The first ${num(MARKDOWN_MAX)} rows, for Slack, GitHub or docs` : 'For Slack, GitHub or docs'} />
          <Item disabled={!n} onClick={() => run('csv')} icon="copy" label="Copy as CSV" sub="Paste into any spreadsheet" />
        </div>
      </Popover>
    </>
  );
}
