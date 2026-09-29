import { createPortal } from 'react-dom';
import { useStore, dismissToast, navigate, silenceAlarm, setState } from '../lib/store.js';
import Icon from './icons.jsx';
import { cx, AlertText, refocusModal } from './ui.jsx';

// Toasts and the alarm banner live in <body> above sheets and the palette (z-toast): the alarm
// rings right when "While you were away" opens by itself, and Silence must stay clickable.
// Both regions are always in the page, so screen readers announce what appears in them: toasts
// politely, the alarm right away.
export default function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const alarm = useStore((s) => s.alarm);
  // Going somewhere from a toast closes the sheet or palette it may be sitting over, so you see where you went.
  const go = (to) => {
    setState({ recapOpen: false, palette: false });
    navigate(to);
  };
  return createPortal(
    <div data-toasts="" className="fixed bottom-4 right-4 z-toast flex flex-col w-[360px] max-w-[calc(100vw-32px)] no-drag pointer-events-none">
      <div role="alert" aria-live="assertive">
        {alarm?.ringing && (
          <div className={cx('pointer-events-auto rounded-[18px] p-3 flex items-center gap-3 bg-red text-white animate-alarm', toasts.length > 0 && 'mb-2')}>
            <div className="w-9 h-9 rounded-full bg-white/20 grid place-items-center shrink-0">
              <Icon name="bell" size={17} strokeWidth={2} className="animate-bell" />
            </div>
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => go({ to: 'alerts' })}>
              <div className="text-headline font-semibold">Critical alarm</div>
              <div className="text-callout text-white/90 line-clamp-2 break-words">{alarm.titles?.length ? alarm.titles.join(' · ') : 'A critical alert is open'}</div>
              <div className="text-footnote text-white/75 mt-0.5">Rings every 20 s until you silence it (up to 10 min per alert)</div>
            </button>
            <button type="button" title="Quiet until it’s fixed; anything new can ring again in 5 min" onClick={() => (silenceAlarm(), requestAnimationFrame(refocusModal))} className="press h-8 px-3.5 rounded-full bg-white text-red text-callout font-semibold inline-flex items-center gap-1.5 shrink-0">
              <Icon name="mute" size={14} strokeWidth={2} />
              Silence
            </button>
          </div>
        )}
      </div>
      <div aria-live="polite" aria-relevant="additions" className="flex flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className="pointer-events-auto glass-strong rounded-[18px] p-3 flex gap-3 animate-toast">
            <div className={cx('w-8 h-8 rounded-full grid place-items-center shrink-0', t.severity === 'critical' ? 'bg-red-tint' : t.severity === 'warning' ? 'bg-orange-tint' : 'bg-accent-tint')}>
              <Icon name={t.icon || (t.severity === 'critical' ? 'bolt' : t.severity === 'warning' ? 'errors' : 'bell')} size={15} strokeWidth={2} className={t.severity === 'critical' ? 'text-red' : t.severity === 'warning' ? 'text-orange' : 'text-accent'} />
            </div>
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => (dismissToast(t.id), t.view && go(t.view))}>
              <AlertText a={t} compact />
            </button>
            <button type="button" onClick={() => (dismissToast(t.id), requestAnimationFrame(refocusModal))} className="w-6 h-6 rounded-full hover:bg-fill-3 grid place-items-center text-label-3" aria-label="Dismiss">
              <Icon name="x" size={11} strokeWidth={2.4} />
            </button>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
