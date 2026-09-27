import { useEffect, useState } from 'react';
import { useStore, invoke, navigate } from '../lib/store.js';
import { ViewScroll } from '../components/Toolbar.jsx';
import { Card, Segmented, Spinner, Empty, Button } from '../components/ui.jsx';
import { SummaryChips, TimelineStrip, IncidentList, RecapExtras, INCIDENT_COLUMNS } from '../components/Recap.jsx';
import { dayTime, duration } from '../lib/format.js';
import DateTimePicker from '../components/DateTimePicker.jsx';
import ExportButton from '../components/ExportButton.jsx';

const H = 3600_000;
const PRESETS = [
  { value: '1h', label: '1 hour', ms: H },
  { value: '6h', label: '6 hours', ms: 6 * H },
  { value: '24h', label: '24 hours', ms: 24 * H },
  { value: '7d', label: '7 days', ms: 7 * 24 * H },
  { value: 'custom', label: 'Custom' },
];

const toLocalInput = (ms) => {
  const d = new Date(ms);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

export default function Timeline() {
  const auto = useStore((s) => s.sections.recap);
  const [preset, setPreset] = useState('24h');
  const [from, setFrom] = useState(toLocalInput(Date.now() - 24 * H));
  const [until, setUntil] = useState(toLocalInput(Date.now()));
  const [state, setState] = useState({ loading: false, recap: null, error: null });

  const load = async (since, to) => {
    setState({ loading: true, recap: null, error: null });
    try {
      const recap = await invoke('recap:get', { since, until: to });
      setState({ loading: false, recap, error: null });
    } catch (e) {
      setState({ loading: false, recap: null, error: e.message });
    }
  };

  useEffect(() => {
    if (preset === 'custom') return;
    const p = PRESETS.find((x) => x.value === preset);
    load(Date.now() - p.ms, Date.now());
  }, [preset]);

  const { recap } = state;
  return (
    <ViewScroll>
      <div className="flex items-center gap-2 flex-wrap mb-4 animate-rise">
        <Segmented value={preset} onChange={setPreset} options={PRESETS.map(({ value, label }) => ({ value, label }))} />
        {auto && (
          <Button size="md" variant="tinted" icon="history" onClick={() => setState({ loading: false, recap: auto, error: null })}>
            Since I was last here
          </Button>
        )}
        {preset === 'custom' && (
          <div className="flex items-center gap-2 ml-2 animate-fade">
            <DateTimePicker label="From" value={from} onChange={setFrom} max={until} />
            <span className="text-label-3">→</span>
            <DateTimePicker label="Until" value={until} onChange={setUntil} max={toLocalInput(Date.now())} />
            <Button variant="primary" onClick={() => load(new Date(from).getTime(), new Date(until).getTime())}>
              Show
            </Button>
          </div>
        )}
      </div>

      {state.loading && (
        <Card className="py-16 grid place-items-center gap-2 text-callout text-label-2">
          <Spinner size={20} /> Rebuilding the timeline from Cloud Logging…
        </Card>
      )}
      {state.error && <Card className="!bg-red-tint text-callout">{state.error}</Card>}
      {recap && (
        <div className="flex flex-col gap-4 animate-rise">
          <Card className="flex flex-col gap-4">
            <div className="flex items-baseline justify-between gap-4 flex-wrap">
              <div className="text-title2 font-semibold">{recap.headline}</div>
              <div className="flex items-center gap-3">
                <span className="text-callout text-label-2">
                  {dayTime(recap.since)} → {dayTime(recap.until)} · {duration(recap.until - recap.since)}
                </span>
                <ExportButton name="timeline" title="Timeline" columns={INCIDENT_COLUMNS} rows={recap.incidents} />
              </div>
            </div>
            <SummaryChips summary={recap.summary} />
            {recap.incidents.length > 0 && <TimelineStrip recap={recap} />}
          </Card>
          <Card>{recap.incidents.length ? <IncidentList incidents={recap.incidents} onNavigate={navigate} /> : <Empty title="All quiet" message="Nothing went wrong in this period." />}</Card>
          <RecapExtras recap={recap} />
          {recap.notes?.length > 0 && <div className="text-subheadline text-label-3 px-1">{recap.notes.join(' · ')}</div>}
        </div>
      )}
    </ViewScroll>
  );
}
