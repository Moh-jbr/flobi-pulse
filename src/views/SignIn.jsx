import { useState } from 'react';
import { invoke, setState } from '../lib/store.js';
import { Button, cx } from '../components/ui.jsx';
import Icon from '../components/icons.jsx';
import { cleanError } from './Traffic.jsx';
import { isMac } from '../lib/platform.js';

// A service-account key is a JSON file of about 2 KB.
const MAX_KEY_BYTES = 64 * 1024;

export default function SignIn({ info }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [drag, setDrag] = useState(false);
  const mac = isMac();

  const run = async (kind, fn) => {
    setBusy(kind);
    setError(null);
    try {
      const next = await fn();
      if (next && !next.canceled) setState({ info: next });
    } catch (e) {
      setError(cleanError(e));
    }
    setBusy(null);
  };

  const onDrop = async (e) => {
    e.preventDefault();
    setDrag(false);
    if (busy) return;
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    if (file.size > MAX_KEY_BYTES) {
      setError(`${file.name} is too big to be a key file. The key is the small .json file Google Cloud downloaded when the key was made.`);
      return;
    }
    let text;
    try {
      text = await file.text();
      JSON.parse(text);
    } catch {
      setError(`${file.name} isn't a .json key file. Drop the .json file Google Cloud downloaded when the key was made.`);
      return;
    }
    run('key', () => invoke('auth:serviceAccount', { text }));
  };

  return (
    // The whole window takes the dropped key file. Drag regions (the strip at the top, for moving the
    // window) swallow drag-and-drop in Electron, so the rest of the window is not one.
    <div
      className="h-full relative overflow-hidden no-drag"
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDrag(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget) && setDrag(false)}
      onDrop={onDrop}
    >
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(1200px 600px at 15% -10%, color-mix(in srgb, var(--accent) 22%, transparent), transparent 60%), radial-gradient(900px 500px at 110% 110%, color-mix(in srgb, var(--indigo) 20%, transparent), transparent 60%), var(--bg-grouped)',
        }}
      />
      <div className="drag absolute top-0 inset-x-0 h-11 z-10" />
      <div className={cx('relative h-full grid place-items-center p-8', mac && 'pt-12')}>
        <div className={cx('glass-strong rounded-[14px] w-[420px] px-9 pt-9 pb-7 flex flex-col items-center text-center animate-sheet transition-shadow', drag && 'shadow-[0_0_0_3px_var(--accent),var(--shadow-pop)]')}>
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
            <div className="w-full mt-4 rounded-[10px] bg-red-tint px-3.5 py-2.5 text-callout text-left flex gap-2 animate-rise">
              <Icon name="errors" size={15} className="text-red shrink-0 mt-px" />
              <span className="selectable break-words min-w-0">{error}</span>
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
