// "Export" for any table: a real Excel workbook, or Markdown / CSV on the
// clipboard. It exports exactly the rows the table shows (filters applied).
import { useRef, useState } from 'react';
import { invoke } from '../lib/store.js';
import { Button, Popover, cx } from './ui.jsx';
import Icon from './icons.jsx';
import { toXlsx, toMarkdown, toCsv, stamp } from '../lib/export.js';

// A Markdown table is for pasting into chat or a doc; past this it stops being readable.
const MARKDOWN_MAX = 1000;

// Defined once, outside ExportButton: live tables re-render it several times a
// second, and a component declared inside would be rebuilt each time (losing hover).
function Item({ icon, label, sub, disabled, onClick }) {
  return (
    <button type="button" role="menuitem" disabled={disabled} onClick={onClick} className="w-full flex items-center gap-3 px-3 py-2 rounded-[10px] text-left hover:bg-fill-4 disabled:opacity-40">
      <Icon name={icon} size={16} className="text-accent shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block text-body">{label}</span>
        <span className="block text-subheadline text-label-3">{sub}</span>
      </span>
    </button>
  );
}

/**
 * @param {{ name: string, title?: string, columns: {label: string, get: (row:any) => any}[], rows: any[], size?: 'sm'|'md' }} p
 * `name` becomes the file name ("live-traffic-2026-09-27-1403.xlsx"), `title` the sheet name.
 */
export default function ExportButton({ name, title, columns, rows = [], size = 'sm' }) {
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState(null); // { ok, text }
  const n = rows.length;

  const show = (ok, text) => {
    setResult({ ok, text });
    setTimeout(() => setResult(null), ok ? 1800 : 5000);
  };
  const run = async (kind) => {
    setOpen(false);
    try {
      if (kind === 'xlsx') {
        const file = `${name}-${stamp(new Date()).replace(/[: ]/g, '-').slice(0, 16)}.xlsx`;
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

  return (
    <>
      <span ref={ref} className="inline-flex" title={result && !result.ok ? result.text : undefined}>
        <Button size={size} variant={result ? (result.ok ? 'tinted' : 'danger') : 'secondary'} icon={result ? (result.ok ? 'check' : 'errors') : 'download'} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}>
          {result ? (result.ok ? result.text : 'Export failed') : 'Export'}
        </Button>
      </span>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} width={290}>
        <div role="menu" className="p-1.5">
          <div className={cx('px-3 pt-1.5 pb-1 text-subheadline text-label-3')}>{n ? `${n.toLocaleString()} row${n === 1 ? '' : 's'}, as shown (filters applied)` : 'Nothing to export yet'}</div>
          <Item disabled={!n} onClick={() => run('xlsx')} icon="download" label="Download as Excel (.xlsx)" sub="Opens in Excel, Numbers and Google Sheets" />
          <Item disabled={!n} onClick={() => run('md')} icon="copy" label="Copy as Markdown" sub={n > MARKDOWN_MAX ? `The first ${MARKDOWN_MAX.toLocaleString()} rows, for Slack, GitHub or docs` : 'For Slack, GitHub or docs'} />
          <Item disabled={!n} onClick={() => run('csv')} icon="copy" label="Copy as CSV" sub="Paste into any spreadsheet" />
        </div>
      </Popover>
    </>
  );
}
