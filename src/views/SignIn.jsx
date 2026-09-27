import { useState } from 'react';
import { invoke, setState } from '../lib/store.js';
import { Button, cx } from '../components/ui.jsx';
import Icon from '../components/icons.jsx';

export default function SignIn({ info }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [drag, setDrag] = useState(false);
  const isMac = info.platform === 'darwin';

  const run = async (kind, fn) => {
    setBusy(kind);
    setError(null);
    try {
      const next = await fn();
      if (next && !next.canceled) setState({ info: next });
    } catch (e) {
      setError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
    setBusy(null);
  };

  const onDrop = async (e) => {
    e.preventDefault();
    setDrag(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    const text = await file.text();
    run('key', () => invoke('auth:serviceAccount', { text }));
  };

  return (
    <div className="h-full relative overflow-hidden drag" onDragOver={(e) => (e.preventDefault(), setDrag(true))} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(1200px 600px at 15% -10%, color-mix(in srgb, var(--accent) 22%, transparent), transparent 60%), radial-gradient(900px 500px at 110% 110%, color-mix(in srgb, var(--indigo) 20%, transparent), transparent 60%), var(--bg-grouped)',
        }}
      />
      <div className={cx('relative h-full grid place-items-center p-8', isMac && 'pt-12')}>
        <div className={cx('no-drag glass-strong rounded-[30px] w-[420px] px-9 pt-9 pb-7 flex flex-col items-center text-center animate-sheet transition-shadow', drag && 'shadow-[0_0_0_3px_var(--accent),var(--shadow-pop)]')}>
          <img src="./icon.png" alt="" className="w-[76px] h-[76px] drop-shadow-xl" />
          <h1 className="text-large-title font-bold tracking-[-0.02em] mt-4">Flobi Pulse</h1>
          <p className="text-body text-label-2 mt-1.5 max-w-[300px]">Live health for the whole Flobi platform — every service, request, error and crash.</p>

          <div className="w-full flex flex-col gap-2.5 mt-7">
            <Button variant="primary" size="lg" icon="key" className="w-full" loading={busy === 'key'} disabled={!!busy} onClick={() => run('key', () => invoke('auth:serviceAccount'))}>
              Choose the key file…
            </Button>
            <p className="text-subheadline text-label-3">Or drop the .json key anywhere on this window. Don't have one? Ask whoever set up Flobi Pulse for the team.</p>
          </div>

          {error && (
            <div className="w-full mt-4 rounded-[14px] bg-red-tint px-3.5 py-2.5 text-callout text-left flex gap-2 animate-rise">
              <Icon name="errors" size={15} className="text-red shrink-0 mt-px" />
              <span className="selectable">{error}</span>
            </div>
          )}

          <button type="button" disabled={!!busy} onClick={() => run('demo', () => invoke('demo:start'))} className="mt-5 text-callout text-accent hover:underline disabled:opacity-40">
            Explore with demo data
          </button>

          <div className="w-full mt-6 pt-4 hairline-t flex items-center gap-2 text-subheadline text-label-2 text-left">
            <Icon name="shield" size={16} className="text-green shrink-0" />
            <span>
              Read-only. Flobi Pulse can't change anything in <span className="font-medium text-label">{info.team.projectId}</span> — it only reads.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
