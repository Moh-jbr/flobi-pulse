import { useEffect, useRef, useState } from 'react';
import { useStore, setState, navigate, invoke } from '../lib/store.js';
import { Sheet, Button, Spinner, Empty } from './ui.jsx';
import Icon from './icons.jsx';
import { SummaryChips, TimelineStrip, IncidentList, RecapExtras, INCIDENT_COLUMNS, byStart } from './Recap.jsx';
import { dayTime, duration } from '../lib/format.js';
import ExportButton from './ExportButton.jsx';
import { cleanError } from '../views/Traffic.jsx';

/** "While you were away" — opens by itself when there's a recap to show. */
export default function RecapSheet() {
  const open = useStore((s) => s.recapOpen);
  const auto = useStore((s) => s.sections.recap);
  const [recap, setRecap] = useState(null);
  const [load, setLoad] = useState({ loading: false, error: null });
  const shown = useRef(new Set());
  const openedByAuto = useRef(false);
  const run = useRef(0);

  // A new automatic recap opens the sheet by itself, showing exactly that recap.
  useEffect(() => {
    if (auto?.auto && !shown.current.has(auto.generatedAt)) {
      shown.current.add(auto.generatedAt);
      run.current++; // a read still running mustn't replace it
      if (!open) openedByAuto.current = true;
      setRecap(auto);
      setLoad({ loading: false, error: null });
      setState({ recapOpen: true });
    }
  }, [auto]);

  // Opened by hand: read it again every time, so it runs up to now.
  const refresh = () => {
    const id = ++run.current;
    setLoad({ loading: true, error: null });
    invoke('recap:get', { since: auto?.since ?? Date.now() - 12 * 3600_000 })
      .then((r) => {
        if (id !== run.current) return;
        setRecap(r);
        setLoad({ loading: false, error: null });
      })
      .catch((e) => id === run.current && setLoad({ loading: false, error: cleanError(e) }));
  };
  useEffect(() => {
    if (!open) return;
    if (openedByAuto.current) openedByAuto.current = false;
    else refresh();
  }, [open]);

  const close = () => {
    run.current++;
    setLoad((l) => (l.loading ? { loading: false, error: null } : l));
    setState({ recapOpen: false });
  };
  const go = (view) => {
    close();
    navigate(view);
  };
  const ready = recap && !load.loading && !load.error;

  return (
    <Sheet open={open} onClose={close} width={760} label="While you were away">
      <div className="px-7 pt-6 pb-4">
        <div className="flex items-start gap-3">
          <div className="w-11 h-11 rounded-2xl bg-accent-tint grid place-items-center shrink-0">
            <Icon name="timeline" size={22} className="text-accent" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-title1 font-semibold tracking-[-0.02em]">While you were away</h2>
            {ready && (
              <p className="text-body text-label-2 mt-0.5">
                {dayTime(recap.since)} → {dayTime(recap.until)} · {duration(recap.until - recap.since)}
              </p>
            )}
          </div>
          <button type="button" onClick={close} className="w-7 h-7 rounded-full bg-fill-3 hover:bg-fill-2 grid place-items-center text-label-2" aria-label="Close">
            <Icon name="x" size={12} strokeWidth={2.4} />
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-7 pb-4">
        {load.error ? (
          <div className="py-14 flex flex-col items-center gap-3 text-center">
            <div className="text-callout text-red max-w-[460px] selectable">Couldn't read what happened: {load.error}</div>
            <Button icon="refresh" onClick={refresh}>
              Try again
            </Button>
          </div>
        ) : !ready ? (
          <div className="py-16 grid place-items-center text-callout text-label-2 gap-2">
            <Spinner size={20} /> Reading what happened from Google Cloud…
          </div>
        ) : (
          <div className="flex flex-col gap-5 animate-rise">
            <div>
              <div className="text-title2 font-semibold mb-3">{recap.headline}</div>
              <SummaryChips summary={recap.summary} />
            </div>
            {recap.incidents.length > 0 && <TimelineStrip recap={recap} />}
            {recap.incidents.length ? <IncidentList incidents={recap.incidents} onNavigate={go} /> : <Empty title="All quiet" message="No crashes, outages, error spikes or new errors in this period." />}
            <RecapExtras recap={recap} />
            {recap.notes?.length > 0 && (
              <div className="text-subheadline text-label-3">
                {recap.notes.map((n, i) => (
                  <div key={i}>{n}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <div className="px-7 py-4 hairline-t flex items-center justify-between">
        {ready && recap.incidents?.length > 0 && <ExportButton size="md" name="while-you-were-away" title="While you were away" columns={INCIDENT_COLUMNS} rows={byStart(recap.incidents)} />}
        <Button variant="plain" icon="history" onClick={() => go('timeline')}>
          Open Timeline
        </Button>
        <Button variant="primary" size="lg" onClick={close}>
          Done
        </Button>
      </div>
    </Sheet>
  );
}
