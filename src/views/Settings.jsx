import { useEffect, useRef, useState } from 'react';
import { useStore, invoke, setState as setStore } from '../lib/store.js';
import { ViewScroll } from '../components/Toolbar.jsx';
import { Card, Button, Toggle, Segmented, Slider, TextField, StatusDot, cx, Pill } from '../components/ui.jsx';
import Icon from '../components/icons.jsx';
import { playSound, stopSounds } from '../lib/sounds.js';
import CloudSqlForm, { DatabaseKey } from '../components/CloudSqlForm.jsx';
import { ago } from '../lib/format.js';

function Group({ title, footer, children }) {
  return (
    <section className="mb-7 animate-rise">
      {title && <h2 className="text-headline font-semibold text-label-2 px-1 mb-2">{title}</h2>}
      <Card pad={false} className="divide-y divide-separator overflow-hidden">
        {children}
      </Card>
      {footer && <p className="text-subheadline text-label-3 px-1 mt-2 max-w-3xl">{footer}</p>}
    </section>
  );
}

function Row({ label, detail, children, icon, tone }) {
  return (
    <div className="flex items-center gap-4 px-4 min-h-12 py-2.5">
      {icon && (
        <div className={cx('w-7 h-7 rounded-[8px] grid place-items-center shrink-0 text-white', tone || 'bg-accent')}>
          <Icon name={icon} size={15} strokeWidth={1.9} />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-body">{label}</div>
        {detail && <div className="text-subheadline text-label-2 mt-0.5">{detail}</div>}
      </div>
      <div className="shrink-0 flex items-center gap-2">{children}</div>
    </div>
  );
}

function statusTone(st) {
  return !st ? 'gray' : st === 'ok' || st === 'streaming' ? 'green' : st === 'connecting' ? 'accent' : st === 'off' ? 'gray' : st === 'degraded' || st === 'unavailable' ? 'orange' : 'red';
}

const clean = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

const INTEGRATION = {
  sentry: { title: 'Sentry', sub: 'Frontend errors from the React apps', icon: 'errors', tone: 'bg-purple', placeholder: 'Integration token (not the Client Secret)' },
  cloudflare: { title: 'Cloudflare', sub: 'Edge traffic, 52x origin errors and Pages deploys', icon: 'globe', tone: 'bg-orange', placeholder: 'Read-only API token' },
  github: { title: 'GitHub', sub: 'Release notes of the team’s repos, for the Versions page', icon: 'tag', tone: 'bg-gray', placeholder: 'Fine-grained token with Contents: Read-only' },
};

function IntegrationForm({ kind, info, sources }) {
  const cfg = info.integrations[kind];
  const [host, setHost] = useState(cfg.host || 'sentry.io');
  const [org, setOrg] = useState(cfg.org || '');
  const [accountId, setAccountId] = useState(cfg.accountId || '');
  const [zones, setZones] = useState((cfg.zones || []).join(', '));
  const [token, setToken] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(null);
  const withToken = token ? { token: token.trim() } : {};
  const payload = () =>
    kind === 'sentry'
      ? { host: host.trim(), org: org.trim(), ...withToken }
      : kind === 'cloudflare'
        ? { accountId: accountId.trim(), zones: zones.split(',').map((z) => z.trim()).filter(Boolean), ...withToken }
        : withToken;
  const k = INTEGRATION[kind];
  const src = sources?.[kind];

  return (
    <div className="px-4 py-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className={cx('w-7 h-7 rounded-[8px] grid place-items-center text-white', k.tone)}>
          <Icon name={k.icon} size={15} strokeWidth={1.9} />
        </div>
        <div className="flex-1">
          <div className="text-body font-medium">{k.title}</div>
          <div className="text-subheadline text-label-2">{k.sub}</div>
        </div>
        <span className="inline-flex items-center gap-1.5 text-subheadline text-label-2">
          <StatusDot tone={statusTone(src?.status)} size={7} />
          {src?.status === 'off' || !src ? (cfg.hasToken ? 'Configured' : 'Not connected') : src.status}
        </span>
      </div>
      {src?.message && src.status !== 'off' && src.status !== 'ok' && <div className="text-callout text-orange selectable">{src.message}</div>}
      <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-2 items-center text-callout">
        {kind === 'sentry' ? (
          <>
            <span className="text-label-2">Region</span>
            <Segmented
              size="sm"
              value={['sentry.io', 'de.sentry.io'].includes(host) ? host : 'custom'}
              onChange={(v) => setHost(v === 'custom' ? '' : v)}
              options={[
                { value: 'sentry.io', label: 'US (sentry.io)' },
                { value: 'de.sentry.io', label: 'EU (de.sentry.io)' },
                { value: 'custom', label: 'Self-hosted' },
              ]}
            />
            {!['sentry.io', 'de.sentry.io'].includes(host) && (
              <>
                <span className="text-label-2">Host</span>
                <TextField value={host} onChange={setHost} placeholder="sentry.yourcompany.com" mono />
              </>
            )}
            <span className="text-label-2">Organization</span>
            <TextField value={org} onChange={setOrg} placeholder="your-org-slug" mono />
          </>
        ) : kind === 'cloudflare' ? (
          <>
            <span className="text-label-2">Account ID</span>
            <TextField value={accountId} onChange={setAccountId} placeholder="32-character account ID (for Pages)" mono />
            <span className="text-label-2">Zones</span>
            <TextField value={zones} onChange={setZones} placeholder="flobi.ai" mono />
          </>
        ) : (
          <>
            <span className="text-label-2">Organization</span>
            <span className="font-mono text-label-2">{cfg.owner || 'not set in the team config'}</span>
          </>
        )}
        <span className="text-label-2">API token</span>
        <TextField type="password" value={token} onChange={setToken} placeholder={cfg.hasToken ? '•••••••• saved (leave empty to keep)' : k.placeholder} mono />
      </div>
      <div className="flex items-center gap-2">
        <span className={cx('text-callout flex-1', result?.ok ? 'text-green' : 'text-red')}>{result?.message}</span>
        <Button
          loading={busy === 'test'}
          onClick={async () => {
            setBusy('test');
            setResult(null);
            try {
              const r = await invoke('integrations:test', { kind, config: payload() });
              if (kind === 'sentry' && r.host && r.host !== host) setHost(r.host);
              setResult(r);
            } catch (e) {
              setResult({ ok: false, message: clean(e) });
            }
            setBusy(null);
          }}
        >
          Test
        </Button>
        <Button
          variant="primary"
          loading={busy === 'save'}
          onClick={async () => {
            setBusy('save');
            setResult(null);
            try {
              // Check it first, so "Saved" never hides a token that doesn't work.
              let p = payload();
              let check;
              try {
                check = await invoke('integrations:test', { kind, config: p });
                if (kind === 'sentry' && check.host && check.host !== p.host) {
                  p = { ...p, host: check.host };
                  setHost(check.host);
                }
              } catch (e) {
                check = { ok: false, message: clean(e) };
              }
              const info2 = await invoke('integrations:set', { [kind]: p });
              setStore({ info: info2 });
              setToken('');
              setResult(check.ok ? { ok: true, message: `Saved · ${check.message}` } : { ok: false, message: `Saved, but it isn't working yet: ${check.message}` });
            } catch (e) {
              setResult({ ok: false, message: clean(e) });
            }
            setBusy(null);
          }}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

function UptimeEditor({ info }) {
  const [list, setList] = useState(info.uptime || []);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const update = (i, patch) => {
    setList(list.map((u, j) => (i === j ? { ...u, ...patch } : u)));
    setDirty(true);
  };
  return (
    <div className="px-4 py-3 flex flex-col gap-2">
      {list.map((u, i) => (
        <div key={i} className="grid grid-cols-[150px_minmax(0,1fr)_120px_28px] gap-2 items-center">
          <TextField value={u.name} onChange={(v) => update(i, { name: v })} placeholder="Name" />
          <TextField value={u.url} onChange={(v) => update(i, { url: v })} placeholder="https://…" mono />
          <Segmented
            size="sm"
            value={u.group}
            onChange={(v) => update(i, { group: v })}
            options={[
              { value: 'backend', label: 'API' },
              { value: 'frontend', label: 'App' },
            ]}
          />
          <button type="button" onClick={() => (setList(list.filter((_, j) => j !== i)), setDirty(true))} className="w-7 h-7 rounded-full hover:bg-red-tint text-label-3 hover:text-red grid place-items-center" aria-label="Remove">
            <Icon name="x" size={12} strokeWidth={2.2} />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2 mt-1">
        <Button size="sm" icon="globe" onClick={() => (setList([...list, { name: '', url: 'https://', group: 'frontend' }]), setDirty(true))}>
          Add URL
        </Button>
        <span className="flex-1" />
        {dirty && (
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              const info2 = await invoke('uptime:set', { targets: list });
              setStore({ info: info2 });
              setDirty(false);
              setBusy(false);
            }}
          >
            Save checks
          </Button>
        )}
      </div>
    </div>
  );
}

function SoundVolume({ value, onSave }) {
  const [v, setV] = useState(value);
  const timer = useRef(null);
  useEffect(() => setV(value), [value]);
  const change = (nv) => {
    setV(nv);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onSave(nv), 350);
  };
  const test = (kind) => {
    stopSounds();
    playSound(kind, v);
  };
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 min-h-12 py-2.5">
      <div className="min-w-0 flex-1 basis-40">
        <div className="text-body">Volume</div>
        <div className="text-subheadline text-label-2 mt-0.5">Try each sound at this volume</div>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <Icon name="mute" size={15} className="text-label-3" />
        <Slider value={v} onChange={change} className="w-36" />
        <span className="text-callout tabular text-label-2 w-9 text-right">{Math.round(v * 100)}%</span>
        <Button size="sm" icon="play" onClick={() => test('warning')}>
          Warning
        </Button>
        <Button size="sm" variant="danger" icon="play" onClick={() => test('critical')}>
          Critical
        </Button>
      </div>
    </div>
  );
}

function UpdatesRow({ version }) {
  const u = useStore((st) => st.update);
  const status = u?.status || 'unsupported';
  const pct = Math.round((u?.progress || 0) * 100);
  const detail = {
    idle: u?.error || (u?.lastError ? `Last check failed: ${u.lastError}. Trying again in 2 minutes.` : u?.checkedAt ? `Up to date · checked ${ago(u.checkedAt)}` : 'Up to date'),
    checking: 'Checking for a new version…',
    available: `Version ${u?.version} is ready to install`,
    downloading: `Downloading version ${u?.version} · ${pct}%`,
    installing: 'Installing and restarting…',
    error: u?.error,
    unsupported: u?.error || 'Updates only run in the installed app.',
  }[status];
  return (
    <Row label={`Flobi Pulse ${version}`} detail={detail} icon="download" tone="bg-accent">
      {u?.releasesUrl && (
        <Button variant="plain" onClick={() => invoke('open:external', { url: u.releasesUrl })}>
          Release notes
        </Button>
      )}
      {status === 'available' || status === 'error' ? (
        <Button variant="primary" onClick={() => invoke('update:install')}>
          Update now
        </Button>
      ) : (
        <Button loading={status === 'checking'} disabled={status !== 'idle'} onClick={() => invoke('update:check')}>
          Check now
        </Button>
      )}
    </Row>
  );
}

export default function Settings() {
  const info = useStore((s) => s.info);
  const sources = useStore((s) => s.sections.sources);
  const session = useStore((s) => s.sections.session);
  const [denied, setDenied] = useState([]);
  const s = info.settings;
  const set = async (patch) => setStore({ info: await invoke('settings:set', { patch }) });
  useEffect(() => {
    invoke('guard:denied').then(setDenied).catch(() => {});
  }, []);

  const identity = info.identity;
  const demo = info.mode === 'demo';

  return (
    <ViewScroll inner="max-w-[920px]">
      <Group title="Account" footer="Flobi Pulse is read-only by design: its service account only has Viewer roles, and the app itself refuses to send anything but read requests. It never reads Secrets and never changes pods, deployments or configuration.">
        <Row label={identity?.name || 'Signed in'} detail={identity?.kind === 'demo' ? 'Demo mode — simulated data, nothing is connected' : `Service account · ${identity?.email}`} icon="person">
          {demo ? (
            <Button onClick={async () => setStore({ info: await invoke('demo:stop') })}>Exit demo</Button>
          ) : (
            <Button variant="danger" onClick={async () => setStore({ info: await invoke('auth:signOut') })}>
              Sign out
            </Button>
          )}
        </Row>
        <Row label="Project" detail={`${info.team.projectId} · namespace ${info.team.namespace}`} icon="cloud" tone="bg-teal">
          <Pill tone="green" icon="shield" strong>
            Read-only
          </Pill>
        </Row>
        <Row label="Cluster" detail={`${session?.cluster?.name || info.team.clusterName} · ${session?.cluster?.location || info.team.clusterLocation}${session?.cluster?.endpoint ? ` · ${session.cluster.endpoint}` : ''}`} icon="infrastructure" tone="bg-indigo" />
      </Group>

      <Group title="Integrations" footer="Tokens are encrypted with your computer's keychain and never leave this machine except to talk to Sentry, Cloudflare or GitHub. The GitHub token can only read release notes.">
        <IntegrationForm kind="sentry" info={info} sources={sources} />
        <IntegrationForm kind="cloudflare" info={info} sources={sources} />
        {info.integrations.github && <IntegrationForm kind="github" info={info} sources={sources} />}
      </Group>

      <Group title="Database" footer="Leave both empty when the database is in the same project as the cluster: the app finds it by itself. When it lives in another Google Cloud project, add a key made in that project (the app then finds the instance there), or its connection name if the main key can already read that project. The database key is only used for Cloud SQL status and Postgres logs, is encrypted with your computer's keychain, and is removed when you sign out.">
        <div className="px-4 pt-3 text-body">Cloud SQL instance</div>
        <CloudSqlForm />
        <DatabaseKey />
      </Group>

      <Group title="Uptime checks" footer="Checked from this computer every 30 seconds. API endpoints alert when they fail twice in a row.">
        <UptimeEditor info={info} />
      </Group>

      <Group title="Notifications" footer="When the window is in front you get an in-app banner instead of a system notification. Sounds play even while Flobi Pulse sits in the tray.">
        <Row label="Critical alerts" detail="Service down, crash loops, out-of-memory, failing requests, database down" icon="bolt" tone="bg-red">
          <Toggle checked={s.notifications.critical} onChange={(v) => set({ notifications: { critical: v } })} label="Critical alerts" />
        </Row>
        <Row label="Warnings" detail="Degraded services, restarts, error spikes, new errors, failed deploys" icon="errors" tone="bg-orange">
          <Toggle checked={s.notifications.warning} onChange={(v) => set({ notifications: { warning: v } })} label="Warnings" />
        </Row>
        <Row label="New versions" detail="A release of one of the team’s repos (the Versions page)" icon="tag" tone="bg-accent">
          <Toggle checked={s.notifications.releases !== false} onChange={(v) => set({ notifications: { releases: v } })} label="New versions" />
        </Row>
        <Row label="Informational" detail="Everything else" icon="info" tone="bg-gray">
          <Toggle checked={s.notifications.info} onChange={(v) => set({ notifications: { info: v } })} label="Informational" />
        </Row>
        <Row label="Alert sounds" detail="A chime for warnings and a loud alarm for critical alerts" icon="bell" tone="bg-pink-500">
          <Toggle checked={s.notifications.sound} onChange={(v) => set({ notifications: { sound: v } })} label="Alert sounds" />
        </Row>
        {s.notifications.sound && (
          <>
            <SoundVolume value={s.notifications.volume ?? 0.8} onSave={(v) => set({ notifications: { volume: v } })} />
            <Row label="Repeat the critical alarm" detail="Rings again every 20 s until you press Silence, for up to 10 minutes">
              <Toggle checked={s.notifications.alarmRepeat !== false} onChange={(v) => set({ notifications: { alarmRepeat: v } })} label="Repeat the critical alarm" />
            </Row>
          </>
        )}
        <Row label="Send a test notification">
          <Button onClick={() => invoke('notify:test')}>Test</Button>
        </Row>
      </Group>

      <Group title="Appearance">
        <Row label="Theme" icon="sun" tone="bg-indigo">
          <Segmented
            value={s.appearance.theme}
            onChange={(v) => set({ appearance: { theme: v } })}
            options={[
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </Row>
        <Row label="Glass" detail="How see-through the sidebar, toolbars and sheets are" icon="sidebar" tone="bg-teal">
          <div className="flex items-center gap-3 w-64">
            <span className="text-subheadline text-label-2">Clear</span>
            <Slider value={s.appearance.glass} onChange={(v) => set({ appearance: { glass: v } })} className="flex-1" />
            <span className="text-subheadline text-label-2">Tinted</span>
          </div>
        </Row>
        <Row label="Density" detail="Row height in tables and logs" icon="events" tone="bg-gray">
          <Segmented
            value={s.appearance.density}
            onChange={(v) => set({ appearance: { density: v } })}
            options={[
              { value: 'regular', label: 'Regular' },
              { value: 'compact', label: 'Compact' },
            ]}
          />
        </Row>
      </Group>

      <Group title="General">
        <Row label="Keep running when the window is closed" detail="Stays in the menu bar / system tray so alerts keep coming">
          <Toggle checked={s.general.keepRunningInTray} onChange={(v) => set({ general: { keepRunningInTray: v } })} label="Keep running in tray" />
        </Row>
        <Row label="Open at login">
          <Toggle checked={s.general.openAtLogin} onChange={(v) => set({ general: { openAtLogin: v } })} label="Open at login" />
        </Row>
        <Row label="Include info logs in the live stream" detail="Turn off to stream only warnings and errors (lighter on busy days)">
          <Toggle checked={s.general.liveIncludesInfoLogs} onChange={(v) => set({ general: { liveIncludesInfoLogs: v } })} label="Include info logs" />
        </Row>
      </Group>

      <Group title="Data sources" footer={denied.length ? null : 'The read-only guard has not blocked anything this session.'}>
        {[
          ['kubernetes', 'Kubernetes API', 'Pods, deployments, events, autoscaling'],
          ['metrics', 'Metrics server', 'Live CPU and memory'],
          ['live', 'Cloud Logging (live)', 'Requests and logs as they happen'],
          ['cloudsql', 'Cloud SQL', 'Database status and recent operations'],
          ['cloudrun', 'Cloud Run', 'Serverless services'],
          ['uptime', 'Uptime checks', 'From this computer'],
          ['sentry', 'Sentry', 'Frontend errors'],
          ['cloudflare', 'Cloudflare', 'Edge and Pages'],
        ].map(([k, label, d]) => (
          <Row key={k} label={label} detail={sources?.[k]?.message || d}>
            <span className="inline-flex items-center gap-1.5 text-callout text-label-2">
              <StatusDot tone={statusTone(sources?.[k]?.status)} size={7} />
              {sources?.[k]?.status || 'waiting'}
            </span>
          </Row>
        ))}
        {denied.map((d, i) => (
          <Row key={i} label={`Blocked: ${d.method} ${d.url}`} detail={d.reason} icon="shield" tone="bg-red" />
        ))}
      </Group>

      <Group title="Updates" footer="Flobi Pulse looks for a new version when it starts and every 2 hours. An update installs where you put the app and keeps your settings and keys.">
        <UpdatesRow version={info.version} />
      </Group>

      <p className="text-subheadline text-label-3 px-1">
        Flobi Pulse {info.version} · {info.platform === 'darwin' ? 'macOS' : info.platform === 'win32' ? 'Windows' : info.platform} · secrets {info.secretsEncrypted ? 'encrypted by the OS keychain' : 'stored without OS encryption'}
      </p>
    </ViewScroll>
  );
}
