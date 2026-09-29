// What a page's past data covers: the past week is loaded from Google's logs when
// Flobi Pulse starts (electron/core/engine/backfill.mjs). One quiet line while it
// loads, when it couldn't, or for a day that had more than one read takes.
import { useStore } from '../lib/store.js';
import { Spinner, cx } from './ui.jsx';
import Icon from './icons.jsx';
import { dayTime, num } from '../lib/format.js';

const WHAT = { errors: 'errors', events: 'Kubernetes events', failed: 'failed requests', sql: 'database errors' };
/** dayTime() inside a sentence: "yesterday 15:50", "Sat 26 Sep 15:50". */
const when = (ts) => dayTime(ts).replace(/^(Today|Yesterday)\b/, (w) => w.toLowerCase());

/** `kinds`: which reads matter to this page (errors, events, failed, sql). */
export default function PastWeekNote({ kinds, className }) {
  const b = useStore((s) => s.sections.backfill);
  if (!b || b.status === 'off') return null;
  const lines = [];
  if (b.status === 'loading') lines.push({ key: 'loading', spinner: true, text: `Loading the past ${b.days} days from Google's logs…${b.since ? ` Back to ${when(b.since)} so far.` : ''}` });
  if (b.status === 'error') lines.push({ key: 'error', tone: 'orange', text: `Couldn't load ${b.since ? 'all of ' : ''}the past ${b.days} days from Google's logs: ${b.error}` });
  for (const n of (b.notes || []).filter((x) => kinds.includes(x.kind))) {
    const range = `${when(n.from)} → ${when(n.until)}`;
    lines.push({ key: `${n.kind}:${n.from}`, text: n.busy ? `Busy day (${range}): showing its most recent ${num(n.n)} ${WHAT[n.kind]}.` : `Google's log search took too long for ${range}, so some ${WHAT[n.kind]} may be missing.` });
  }
  if (!lines.length) return null;
  return (
    <div className={cx('flex flex-col gap-1 mb-3 px-1 text-subheadline animate-fade', className)}>
      {lines.map((l) => (
        <div key={l.key} className={cx('flex items-start gap-2', l.tone === 'orange' ? 'text-orange' : 'text-label-2')}>
          {l.spinner ? <Spinner size={12} className="mt-0.5 shrink-0" /> : <Icon name="history" size={13} className="mt-0.5 shrink-0" />}
          <span className="selectable">{l.text}</span>
        </div>
      ))}
    </div>
  );
}
