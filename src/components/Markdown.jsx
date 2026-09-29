// A small Markdown renderer for release notes: headings, lists, paragraphs, code,
// bold, italic and links. It builds React elements (never raw HTML), and links open
// in the browser through the main process's allowlist; only http(s) links become links.
import { invoke } from '../lib/store.js';
import { cx } from './ui.jsx';

const WORD = /[\p{L}\p{N}]/u;
const isWord = (ch) => !!ch && WORD.test(ch);
const isSpace = (ch) => !ch || /\s/.test(ch);

/**
 * `[label](url)` at i: the label up to the first `]`, then a URL whose parentheses may nest
 * (https://en.wikipedia.org/wiki/Foo_(bar)), optionally followed by a "title".
 */
function link(text, i) {
  const close = text.indexOf(']', i + 1);
  if (close < 0 || text[close + 1] !== '(') return null;
  let j = close + 2;
  let depth = 0;
  let url = '';
  for (; j < text.length; j++) {
    const ch = text[j];
    if (ch === '(') depth++;
    else if (ch === ')') {
      if (!depth) break;
      depth--;
    } else if (/\s/.test(ch)) break;
    url += ch;
  }
  // An optional title: [label](url "title")
  const title = /^\s+(?:"[^"]*"|'[^']*')\s*/.exec(text.slice(j));
  if (title) j += title[0].length;
  if (text[j] !== ')' || !url) return null;
  return { label: text.slice(i + 1, close), url, end: j + 1 };
}

/**
 * Emphasis at i (`*` or `_`, one for italic, two for bold). Like CommonMark's rules for `_`,
 * for both: the opening run can't follow a letter or digit and must be followed by text, and
 * the closing run must follow text and can't be followed by a letter or digit, so
 * `user_id and team_id` or `2*3*4` stay as written.
 */
function emphasis(text, i) {
  const ch = text[i];
  if (isWord(text[i - 1]) || text[i - 1] === ch) return null;
  const n = text[i + 1] === ch ? 2 : 1;
  const d = ch.repeat(n);
  const from = i + n;
  if (isSpace(text[from])) return null;
  for (let j = text.indexOf(d, from + 1); j >= 0; j = text.indexOf(d, j + 1)) {
    // In a longer closing run the last delimiters close (***x*** is bold around italic).
    let e = j;
    while (text[e + n] === ch) e++;
    if (isSpace(text[j - 1]) || isWord(text[e + n])) continue;
    // A single delimiter can't be part of a longer run (`*a**` isn't italic).
    if (n === 1 && (e !== j || text[j - 1] === ch)) continue;
    return { bold: n === 2, inner: text.slice(from, e), end: e + n };
  }
  return null;
}

function inline(text, key = 'i') {
  const out = [];
  let buf = '';
  let n = 0;
  const flush = () => {
    if (buf) out.push(buf);
    buf = '';
  };
  for (let i = 0; i < text.length; ) {
    const ch = text[i];
    const k = `${key}${n}`;
    if (ch === '\\' && /[\\`*_[\]()#+\-.!|]/.test(text[i + 1] || '')) {
      buf += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i + 1) {
        flush();
        out.push(
          <code key={k} className="font-mono text-[0.92em] px-1 py-px rounded-[5px] bg-fill-3">
            {text.slice(i + 1, end)}
          </code>,
        );
        n++;
        i = end + 1;
        continue;
      }
    }
    if (ch === '[') {
      const l = link(text, i);
      if (l) {
        flush();
        const label = inline(l.label, k);
        if (/^https?:\/\//i.test(l.url)) {
          const url = l.url;
          out.push(
            <a key={k} href={url} onClick={(e) => (e.preventDefault(), invoke('open:external', { url }))} className="text-accent hover:underline cursor-pointer">
              {label}
            </a>,
          );
        } else out.push(<span key={k}>{label}</span>); // not a web link: keep the words, drop the link
        n++;
        i = l.end;
        continue;
      }
    }
    if (ch === '*' || ch === '_') {
      const e = emphasis(text, i);
      if (e) {
        flush();
        out.push(
          e.bold ? (
            <strong key={k} className="font-semibold text-label">
              {inline(e.inner, k)}
            </strong>
          ) : (
            <em key={k}>{inline(e.inner, k)}</em>
          ),
        );
        n++;
        i = e.end;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

export default function Markdown({ text = '', className }) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
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
