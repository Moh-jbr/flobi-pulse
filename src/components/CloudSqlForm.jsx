// Where the database is: a Cloud SQL connection name ("project:region:instance").
// Only needed when the instance is in another Google Cloud project and no pod
// names it in its own settings.
import { useEffect, useRef, useState } from 'react';
import { useStore, invoke, setState } from '../lib/store.js';
import { Button, TextField } from './ui.jsx';
import Icon from './icons.jsx';
import { cleanError as clean } from '../views/Traffic.jsx';

const VALID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]:[a-z]+-[a-z]+[0-9]+:[a-z][a-z0-9-]{0,96}[a-z0-9]$/;

export default function CloudSqlForm({ compact = false }) {
  const info = useStore((s) => s.info);
  const saved = (info?.integrations?.cloudsql?.instances || []).join(', ');
  const [value, setValue] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  // Set at once (state only updates on the next render): a second click or Enter while saving does nothing.
  const saving = useRef(false);
  useEffect(() => setValue(saved), [saved]);

  const list = value
    .split(/[\s,]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  const invalid = list.find((x) => !VALID.test(x));
  const dirty = list.join(', ') !== saved;

  const save = async () => {
    if (saving.current || !dirty || invalid) return;
    saving.current = true;
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      setState({ info: await invoke('cloudsql:set', { instances: list }) });
      setDone(true);
    } catch (e) {
      setError(clean(e));
    }
    saving.current = false;
    setBusy(false);
  };

  return (
    <div className={compact ? '' : 'px-4 py-3'}>
      <div className="flex items-center gap-2">
        <TextField
          mono
          value={value}
          onChange={(v) => (setValue(v), setDone(false))}
          onKeyDown={(e) => e.key === 'Enter' && save()}
          readOnly={busy}
          placeholder="project:region:instance"
          aria-label="Cloud SQL connection name"
          className="flex-1"
        />
        <Button variant="primary" loading={busy} disabled={!dirty || !!invalid} onClick={save}>
          Save
        </Button>
      </div>
      <div className={`text-subheadline mt-1.5 ${invalid || error ? 'text-red' : 'text-label-3'}`}>
        {error ||
          (invalid
            ? `“${invalid}” isn't a connection name. It looks like my-project:europe-west1:my-db.`
            : done
              ? 'Saved. Checking the instance now…'
              : 'In Google Cloud: SQL → click your instance → Overview → "Connection name". Several? Separate them with commas.')}
      </div>
    </div>
  );
}

// A second service-account key, made in the database's own Google Cloud project,
// for when the main key can't read that project. The main process keeps the key;
// the UI only ever sees its email and project.
export function DatabaseKey({ compact = false }) {
  const key = useStore((s) => s.info?.integrations?.databaseKey);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const run = async (which, cmd) => {
    setBusy(which);
    setError(null);
    try {
      const res = await invoke(cmd);
      if (!res?.canceled) setState({ info: res });
    } catch (e) {
      setError(clean(e));
    }
    setBusy(null);
  };
  const actions = key ? (
    <>
      <Button size={compact ? 'sm' : 'md'} loading={busy === 'set'} onClick={() => run('set', 'database:setKey')}>
        Replace…
      </Button>
      <Button size={compact ? 'sm' : 'md'} variant="danger" loading={busy === 'remove'} onClick={() => run('remove', 'database:removeKey')}>
        Remove
      </Button>
    </>
  ) : (
    <Button size={compact ? 'sm' : 'md'} icon="key" loading={busy === 'set'} onClick={() => run('set', 'database:setKey')}>
      Choose key file…
    </Button>
  );
  const detail = key ? `${key.email} · project ${key.projectId}` : "Only when the database is in another Google Cloud project that the main key can't read.";

  if (compact) {
    return (
      <div className="mt-3">
        <div className="text-subheadline font-semibold text-label-2 mb-1.5">{key ? 'Database key' : "Or a key from the database's project"}</div>
        <div className="flex items-center gap-2 flex-wrap">
          {key && <span className="text-callout font-mono text-label-2 truncate selectable">{key.email}</span>}
          {actions}
        </div>
        {error && <div className="text-subheadline text-red mt-1.5 selectable">{error}</div>}
      </div>
    );
  }
  return (
    <div className="px-4 py-2.5">
      <div className="flex items-center gap-4 min-h-12">
        <div className="w-7 h-7 rounded-[8px] grid place-items-center shrink-0 text-label-2 bg-fill-3">
          <Icon name="key" size={15} strokeWidth={1.9} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-body">Database key</div>
          <div className={`text-subheadline text-label-2 mt-0.5 ${key ? 'font-mono truncate selectable' : ''}`}>{detail}</div>
        </div>
        <div className="shrink-0 flex items-center gap-2">{actions}</div>
      </div>
      {error && <div className="text-subheadline text-red pl-11 pb-1 selectable">{error}</div>}
    </div>
  );
}
