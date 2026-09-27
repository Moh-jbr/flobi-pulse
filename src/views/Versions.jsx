// Versions: every release of the team's repos, newest first, with its changelog.
// The list of repos comes from flobi-release/repos.json, so a repo shows up here as
// soon as it's rolled out there.
import { useEffect, useMemo, useState } from 'react';
import { useStore, invoke, navigate } from '../lib/store.js';
import { ViewScroll } from '../components/Toolbar.jsx';
import { Card, Segmented, SearchField, Toggle, Button, Empty, Pill, Spinner, cx, useNow } from '../components/ui.jsx';
import Icon from '../components/icons.jsx';
import Markdown from '../components/Markdown.jsx';
import ExportButton from '../components/ExportButton.jsx';
import { ago, clock } from '../lib/format.js';

const BUMP = {
  major: { label: 'Major', tone: 'red', hint: 'Something that used to work changed: others may need to change too.' },
  minor: { label: 'New features', tone: 'accent', hint: 'Something new people can use.' },
  patch: { label: 'Fixes', tone: 'gray', hint: 'Fixes and small changes.' },
  first: { label: 'First version', tone: 'green', hint: 'Versioning starts here.' },
  other: { label: 'Release', tone: 'gray', hint: '' },
};

const COLUMNS = [
  { label: 'Product', get: (r) => r.product },
  { label: 'Repository', get: (r) => r.repo },
  { label: 'Version', get: (r) => r.tag },
  { label: 'Kind', get: (r) => BUMP[r.bump]?.label || r.bump },
  { label: 'Released', get: (r) => (r.publishedAt ? new Date(r.publishedAt) : '') },
  { label: 'By', get: (r) => r.author || '' },
  { label: 'Summary', get: (r) => r.notes?.first || '' },
  { label: 'Changelog', get: (r) => r.body || '' },
  { label: 'Link', get: (r) => r.url || '' },
];

function dayLabel(ts, now) {
  const d = new Date(ts);
  if (d.toDateString() === new Date(now).toDateString()) return 'Today';
  if (d.toDateString() === new Date(now - 86_400_000).toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

function VersionPill({ r }) {
  const b = BUMP[r.bump] || BUMP.other;
  return (
    <span title={b.hint} className={cx('inline-flex items-center h-6 px-2 rounded-[7px] font-mono text-callout font-semibold tabular', { red: 'bg-red-tint text-red', accent: 'bg-accent-tint text-accent', gray: 'bg-fill-3 text-label', green: 'bg-green-tint text-green' }[b.tone])}>
      {r.tag}
    </span>
  );
}

/** One release. `inRepo`: shown inside its repo's own history, so product and repo go without saying. */
function Release({ r, isNew, now, startOpen, inRepo }) {
  const [open, setOpen] = useState(startOpen);
  const b = BUMP[r.bump] || BUMP.other;
  return (
    <div className="p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            {!inRepo && <span className="text-headline font-semibold">{r.product}</span>}
            {!inRepo && <span className="font-mono text-subheadline text-label-2">{r.repo}</span>}
            <VersionPill r={r} />
            <Pill tone={b.tone === 'gray' ? 'gray' : b.tone}>{r.notes.breaking ? 'Breaking changes' : b.label}</Pill>
            {isNew && (
              <Pill tone="accent" icon="sparkles" strong>
                New
              </Pill>
            )}
          </div>
          <div className="text-subheadline text-label-3 mt-1">
            {clock(r.publishedAt)} · {ago(r.publishedAt, now)}
            {r.author ? ` · by ${r.author}` : ''}
            {r.notes.changes ? ` · ${r.notes.changes} change${r.notes.changes === 1 ? '' : 's'}` : ''}
          </div>
          {r.notes.first && !open && <div className="text-callout text-label-2 mt-1.5 line-clamp-2">{r.notes.first}</div>}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {r.body && (
            <Button size="sm" variant="plain" iconRight={open ? 'chevronDown' : 'chevronRight'} onClick={() => setOpen(!open)}>
              {open ? 'Hide changelog' : 'Changelog'}
            </Button>
          )}
          {r.url && (
            <Button size="sm" variant="plain" icon="external" onClick={() => invoke('open:external', { url: r.url })}>
              GitHub
            </Button>
          )}
        </div>
      </div>
      {open && r.body && (
        <div className="mt-3 rounded-[12px] bg-fill-4 p-3.5">
          <Markdown text={r.body} />
        </div>
      )}
    </div>
  );
}

function ConnectGitHub({ owner }) {
  return (
    <Card className="max-w-[720px]">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-[12px] bg-accent-tint grid place-items-center shrink-0">
          <Icon name="tag" size={19} className="text-accent" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-headline font-semibold">Connect GitHub to see every release</div>
          <div className="text-callout text-label-2 mt-1">The repos are private, so Flobi Pulse needs your own read-only GitHub token. It stays encrypted on this computer and can only read release notes.</div>
          <ol className="list-decimal pl-5 mt-3 text-callout text-label-2 flex flex-col gap-1">
            <li>GitHub → Settings → Developer settings → Personal access tokens → <b className="text-label">Fine-grained tokens</b> → Generate new token.</li>
            <li>
              Resource owner: <b className="text-label">{owner || 'your organization'}</b>. Repository access: <b className="text-label">All repositories</b>.
            </li>
            <li>
              Permissions → Repository → <b className="text-label">Contents: Read-only</b> (Metadata is added by itself). Nothing else.
            </li>
            <li>Paste it in Settings → Integrations → GitHub. If your organization requires approval, an owner approves it once.</li>
          </ol>
          <Button className="mt-4" variant="primary" icon="settings" onClick={() => navigate('settings')}>
            Open Settings
          </Button>
        </div>
      </div>
    </Card>
  );
}

export default function Versions() {
  const v = useStore((s) => s.versions);
  const now = useNow(30_000);
  const [view, setView] = useState('latest');
  const [q, setQ] = useState('');
  const [internal, setInternal] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // "New" means new since the last visit; opening the page marks everything as seen.
  const [seenBefore] = useState(() => v?.viewedAt || 0);
  useEffect(() => {
    invoke('versions:seen').catch(() => {});
  }, []);

  const match = (r) => (internal || r.audience !== 'internal') && (!q.trim() || `${r.product} ${r.repo || r.name} ${r.tag || ''} ${r.body || ''}`.toLowerCase().includes(q.trim().toLowerCase()));
  const feed = useMemo(() => (v?.feed || []).filter(match), [v?.feed, q, internal]);
  const products = useMemo(() => {
    const m = new Map();
    for (const r of (v?.repos || []).filter((x) => match({ ...x, repo: x.name }))) {
      if (!m.has(r.product)) m.set(r.product, []);
      m.get(r.product).push(r);
    }
    return [...m.entries()].sort((a, b) => (b[1][0]?.latest?.publishedAt || 0) - (a[1][0]?.latest?.publishedAt || 0) || a[0].localeCompare(b[0]));
  }, [v?.repos, q, internal]);
  const days = useMemo(() => {
    const out = [];
    for (const r of feed) {
      const label = dayLabel(r.publishedAt, now);
      if (out.at(-1)?.label !== label) out.push({ label, items: [] });
      out.at(-1).items.push(r);
    }
    return out;
  }, [feed, now]);

  if (!v || v.status === 'off') return <ViewScroll><Card><Empty icon="tag" tone="gray" title="Versions aren't set up" message="The team config has no release manifest (versions.manifest)." /></Card></ViewScroll>;
  if (v.status === 'needs-token') return <ViewScroll><ConnectGitHub owner={v.owner} /></ViewScroll>;

  const versioned = (v.repos || []).filter((r) => r.latest).length;
  const total = (v.repos || []).filter((r) => !r.skip).length;
  return (
    <ViewScroll inner="max-w-[1100px]">
      <div className="flex items-center gap-2 flex-wrap mb-4 animate-rise">
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: 'latest', label: 'Latest', count: feed.filter((r) => !r.baseline).length },
            { value: 'products', label: 'By product', count: products.length },
          ]}
        />
        <label className="inline-flex items-center gap-2 text-callout text-label-2 ml-1">
          <Toggle checked={internal} onChange={setInternal} label="Include internal" /> Include internal
        </label>
        <div className="flex-1" />
        {v.checkedAt && <span className="text-subheadline text-label-3">{versioned} of {total} repos versioned · checked {ago(v.checkedAt, now)}</span>}
        <SearchField value={q} onChange={setQ} placeholder="Repo, version, change…" width={220} />
        <Button size="sm" icon="refresh" loading={refreshing} onClick={async () => (setRefreshing(true), await invoke('versions:refresh').catch(() => {}), setRefreshing(false))}>
          Refresh
        </Button>
        <ExportButton name="versions" title="Versions" columns={COLUMNS} rows={feed} />
      </div>

      {v.status === 'error' && (
        <Card className="mb-4 !bg-orange-tint flex items-start gap-3">
          <Icon name="errors" size={16} className="text-orange mt-0.5" />
          <div className="text-callout text-label-2 flex-1 selectable">Couldn't read the releases: {v.error}</div>
        </Card>
      )}
      {v.status === 'loading' && !(v.feed || []).length && (
        <Card className="py-14 grid place-items-center gap-2 text-callout text-label-2">
          <Spinner size={18} /> Reading the release notes from GitHub…
        </Card>
      )}

      {view === 'latest' &&
        (days.length ? (
          days.map((d) => (
            <section key={d.label} className="mb-6 animate-rise">
              <h2 className="text-headline font-semibold text-label-2 px-1 mb-2">{d.label}</h2>
              <Card pad={false} className="overflow-hidden divide-y divide-separator">
                {d.items
                  .filter((r) => !r.baseline)
                  .map((r) => (
                    <Release key={`${r.repo}@${r.tag}`} r={r} now={now} isNew={r.publishedAt > seenBefore && seenBefore > 0} startOpen={r.publishedAt > seenBefore && seenBefore > 0} />
                  ))}
                <StartedVersioning list={d.items.filter((r) => r.baseline)} />
              </Card>
            </section>
          ))
        ) : v.status === 'ok' ? (
          <Card>
            <Empty icon="tag" tone="gray" title={q || !internal ? 'No releases match' : 'No releases yet'} message={internal ? 'Releases appear here as soon as a repo pushes to its live branch.' : 'Turn on “Include internal” to see infrastructure repos too.'} />
          </Card>
        ) : null)}

      {view === 'products' &&
        products.map(([product, repos]) => (
          <section key={product} className="mb-5 animate-rise">
            <h2 className="text-headline font-semibold text-label-2 px-1 mb-2">{product}</h2>
            <Card pad={false} className="overflow-hidden divide-y divide-separator">
              {repos.map((r) => (
                <RepoRow key={r.name} repo={r} now={now} />
              ))}
            </Card>
          </section>
        ))}
    </ViewScroll>
  );
}

/** Repos whose first (baseline) release landed that day: one line, not one card each. */
function StartedVersioning({ list }) {
  if (!list.length) return null;
  return (
    <div className="px-4 py-3 flex items-start gap-3">
      <div className="w-7 h-7 rounded-[9px] bg-green-tint grid place-items-center shrink-0">
        <Icon name="tag" size={14} className="text-green" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-callout font-semibold">
          Started versioning ({list.length})
          <span className="font-normal text-label-3"> · from now on every push to their live branch gets a version and notes</span>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {list.map((r) => (
            <span key={r.repo} title={`${r.product} · ${r.tag}`} className="font-mono text-subheadline px-1.5 h-5 inline-flex items-center rounded-[6px] bg-fill-3 text-label-2">
              {r.repo}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function RepoRow({ repo: r, now }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => r.releases.length && setOpen(!open)} className={cx('w-full text-left px-4 py-3 flex items-center gap-3', r.releases.length && 'hover:bg-fill-4')}>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-callout font-semibold">{r.name}</span>
            {r.audience === 'internal' && <Pill tone="gray">internal</Pill>}
          </div>
          <div className="text-subheadline text-label-3 mt-0.5 truncate">
            {r.skip ? `Not versioned: ${r.skip}` : r.error ? r.error : r.latest ? `${ago(r.latest.publishedAt, now)} · ${r.latest.notes.first || r.latest.name}` : `No releases yet · goes live from “${r.live || 'its live branch'}”`}
          </div>
        </div>
        {r.latest ? <VersionPill r={r.latest} /> : <span className="text-subheadline text-label-3">—</span>}
        {r.releases.length > 0 && <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} className="text-label-3" />}
      </button>
      {open && (
        <div className="bg-fill-4/60 divide-y divide-separator">
          {r.releases.map((x) => (
            <Release key={x.tag} r={x} now={now} isNew={false} startOpen={false} inRepo />
          ))}
        </div>
      )}
    </div>
  );
}
