// A small Markdown renderer for release notes: headings, lists, paragraphs, code,
// bold, italic and links. It builds React elements (never raw HTML), and links open
// in the browser through the main process's allowlist.
import { invoke } from '../lib/store.js';
import { cx } from './ui.jsx';

const INLINE = /(\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_)/g;

function inline(text, key = 'i') {
  const out = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}${n++}`;
    if (m[2] || m[3]) out.push(<strong key={k} className="font-semibold text-label">{inline(m[2] || m[3], k)}</strong>);
    else if (m[4]) out.push(<code key={k} className="font-mono text-[0.92em] px-1 py-px rounded-[5px] bg-fill-3">{m[4]}</code>);
    else if (m[5]) {
      const url = m[6];
      out.push(
        <a key={k} href={url} onClick={(e) => (e.preventDefault(), invoke('open:external', { url }))} className="text-accent hover:underline cursor-pointer">
          {inline(m[5], k)}
        </a>,
      );
    } else out.push(<em key={k}>{inline(m[7] || m[8], k)}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export default function Markdown({ text = '', className }) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^```/.test(line)) {
      const code = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
      i++;
      blocks.push(<pre key={blocks.length} className="font-mono text-[11px] leading-[15px] bg-[var(--code-bg)] rounded-[10px] p-2.5 overflow-auto whitespace-pre">{code.join('\n')}</pre>);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push(<div key={blocks.length} className={cx('font-semibold text-label mt-3 first:mt-0', h[1].length <= 2 ? 'text-headline' : 'text-callout')}>{inline(h[2])}</div>);
      i++;
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s/.test(line);
      const items = [];
      for (; i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]); i++) {
        const depth = Math.min(3, Math.floor(/^\s*/.exec(lines[i])[0].length / 2));
        items.push({ depth, text: lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, '') });
      }
      const List = ordered ? 'ol' : 'ul';
      blocks.push(
        <List key={blocks.length} className={cx('my-1 flex flex-col gap-1', ordered ? 'list-decimal' : 'list-disc', 'pl-5')}>
          {items.map((it, j) => (
            <li key={j} style={{ marginLeft: it.depth * 16 }} className="marker:text-label-3">
              {inline(it.text, `l${j}`)}
            </li>
          ))}
        </List>,
      );
      continue;
    }
    const para = [];
    for (; i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*([-*+]|\d+[.)])\s)/.test(lines[i]); i++) para.push(lines[i].trim());
    blocks.push(<p key={blocks.length} className="my-1">{inline(para.join(' '))}</p>);
  }
  return <div className={cx('text-callout text-label-2 break-words selectable', className)}>{blocks}</div>;
}
