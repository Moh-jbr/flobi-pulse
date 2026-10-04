import { useMemo } from 'react';
import { useStore, navigate, invoke } from '../lib/store.js';
import { ViewScroll } from '../components/Toolbar.jsx';
import { Card, SectionTitle, Empty, Pill, StatusDot, cx, useNow, Button } from '../components/ui.jsx';
import { Sparkline, UptimeBars } from '../components/charts.jsx';
import Icon from '../components/icons.jsx';
import { compact, pct, ago, countryName, bytes } from '../lib/format.js';
import ExportButton from '../components/ExportButton.jsx';

const UPTIME_COLUMNS = [
  { label: 'App', get: (u) => u.name },
  { label: 'URL', get: (u) => u.url },
  { label: 'State', get: (u) => u.state },
  { label: 'Response (ms)', get: (u) => u.ms ?? '' },
  { label: 'HTTP status', get: (u) => u.status ?? '' },
  { label: 'Error', get: (u) => u.error || '' },
  { label: 'TLS days left', get: (u) => u.certDaysLeft ?? '' },
];
const ZONE_COLUMNS = [
  { label: 'Zone', get: (z) => z.name },
  { label: 'Plan', get: (z) => z.plan || '' },
  { label: 'Window', get: (z) => z.windowLabel || 'last hour' },
  { label: 'Requests', get: (z) => z.totals?.requests ?? '' },
  { label: 'Cached %', get: (z) => (z.totals?.requests ? Math.round(((z.totals.cached || 0) / z.totals.requests) * 1000) / 10 : '') },
  { label: '4xx', get: (z) => z.totals?.s4xx ?? '' },
  { label: '5xx', get: (z) => z.totals?.s5xx ?? '' },
  { label: '52x', get: (z) => z.totals?.s52x ?? '' },
  { label: 'Bytes served', get: (z) => z.totals?.bytes ?? '' },
  { label: 'Top countries', get: (z) => (z.topCountries || []).map((c) => `${c.country} ${c.requests}`).join(', ') },
];
const EDGE_5XX_COLUMNS = [
  { label: 'Host', get: (h) => h.host },
  { label: '5xx', get: (h) => h.s5xx },
  { label: '52x (origin unreachable)', get: (h) => h.s52x },
  { label: 'Status codes', get: (h) => Object.entries(h.codes || {}).map(([code, n]) => `${code}: ${n}`).join(', ') },
];
const PAGES_COLUMNS = [
  { label: 'Project', get: (p) => p.name },
  { label: 'Domains', get: (p) => (p.domains || []).join(', ') },
  { label: 'Latest deploy', get: (p) => p.latest?.status || '' },
  { label: 'Branch', get: (p) => p.latest?.branch || '' },
  { label: 'Commit', get: (p) => p.latest?.commit || '' },
  { label: 'Message', get: (p) => p.latest?.message || '' },
  { label: 'Deployed', get: (p) => (p.latest?.createdAt ? new Date(p.latest.createdAt) : '') },
];
const SENTRY_COLUMNS = [
  { label: 'App', get: (p) => p.project },
  { label: 'Unresolved issues', get: (p) => p.issues },
  { label: 'Events (24 h)', get: (p) => p.events },
  { label: 'Users affected by its worst issue', get: (p) => p.users },
  { label: 'New issues', get: (p) => p.newIssues },
];

function ConnectCard({ title, message }) {
  return (
    <Card className="flex items-center gap-3">
      <div className="w-9 h-9 rounded-xl bg-accent-tint grid place-items-center">
        <Icon name="link" size={18} className="text-accent" />
      </div>
      <div className="flex-1">
        <div className="text-headline font-semibold">{title}</div>
        <div className="text-callout text-label-2">{message}</div>
      </div>
      <Button variant="tinted" onClick={() => navigate({ to: 'settings', tab: 'integrations' })}>
        Connect
      </Button>
    </Card>
  );
}

const PAGE_STATUS = {
  success: { tone: 'green', label: 'Live' },
  failure: { tone: 'red', label: 'Failed' },
  active: { tone: 'accent', label: 'Building' },
  idle: { tone: 'gray', label: 'Queued' },
  canceled: { tone: 'gray', label: 'Canceled' },
};

export default function Frontends() {
  const cf = useStore((s) => s.sections.cloudflare);
  const uptime = useStore((s) => s.sections.uptime) || [];
  const errors = useStore((s) => s.sections.errors);
  const sentry = useStore((s) => s.sections.sentry);
  const now = useNow(20_000);
  const front = uptime.filter((u) => u.group === 'frontend');
  const cfOff = !cf || cf.status === 'off';

  const projects = useMemo(() => {
    const m = new Map();
    for (const i of errors?.frontend || []) {
      const p = m.get(i.project) || { project: i.project, issues: 0, events: 0, users: 0, newIssues: 0, spark: Array(24).fill(0) };
      p.issues++;
      p.events += i.count;
      // Sentry counts users per issue, and one person often hits several issues: adding them
      // up would count people twice. The worst issue's count is a true lower bound.
      p.users = Math.max(p.users, i.users || 0);
      if (i.isNew) p.newIssues++;
      (i.spark || []).forEach((v, idx) => (p.spark[idx] = (p.spark[idx] || 0) + v));
      m.set(i.project, p);
    }
    return [...m.values()].sort((a, b) => b.events - a.events);
  }, [errors?.frontend]);

  return (
    <ViewScroll>
      <section className="animate-rise">
        <SectionTitle title="Uptime" subtitle="Each app's home page, checked from this computer every 30 s" right={<ExportButton name="frontend-uptime" title="Uptime" columns={UPTIME_COLUMNS} rows={front} />} />
        <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3">
          {front.map((u) => (
            <Card key={u.id} className={cx('flex flex-col gap-2', u.state === 'down' && 'shadow-[0_0_0_1.5px_var(--red),var(--shadow-card)]')}>
              <div className="flex items-center gap-2">
                <StatusDot tone={u.state === 'up' ? 'green' : u.state === 'slow' ? 'orange' : u.state === 'down' ? 'red' : 'gray'} size={8} pulse={u.state === 'down'} />
                <span className="text-headline font-semibold truncate" title={u.fromPages ? `Checked because ${u.fromPages} is a Cloudflare Pages project` : undefined}>{u.name}</span>
                <button type="button" onClick={() => invoke('open:external', { url: u.url })} className="ml-auto text-label-3 hover:text-accent" title={u.url}>
                  <Icon name="external" size={13} />
                </button>
              </div>
              <UptimeBars history={u.history} />
              <div className="flex justify-between text-subheadline text-label-2 tabular">
                <span className={cx(u.state === 'slow' && 'text-orange', u.state === 'down' && 'text-red')}>{u.state === 'offline' ? 'Offline: not checked' : u.state === 'down' ? u.error || `HTTP ${u.status}` : u.ms != null ? `${u.ms} ms` : 'checking…'}</span>
                <span>{u.certDaysLeft != null ? `TLS ${u.certDaysLeft}d` : ''}</span>
              </div>
            </Card>
          ))}
          {!front.length && (
            <Card className="col-span-full">
              <Empty icon="globe" tone="gray" title="No frontend URLs configured" message="Add them in Settings → Uptime checks." />
            </Card>
          )}
        </div>
      </section>

      <section className="mt-8 animate-rise" style={{ animationDelay: '60ms' }}>
        <SectionTitle title="Cloudflare edge" subtitle="Traffic and errors as Cloudflare sees them — including 52x errors that never reach Google" right={cfOff ? null : <ExportButton name="cloudflare-zones" title="Cloudflare zones" columns={ZONE_COLUMNS} rows={cf.zones || []} />} />
        {cfOff ? (
          <ConnectCard title="Connect Cloudflare" message="See edge traffic, 52x origin errors and Pages deployments." />
        ) : (
          <>
            {cf.status !== 'ok' && cf.message && (
              <Card className="mb-3 flex items-center gap-2 !bg-orange-tint text-callout">
                <Icon name="errors" size={16} className="text-orange" /> {cf.message}
              </Card>
            )}
            <div className="grid grid-cols-1 2xl:grid-cols-2 gap-3">
              {(cf.zones || []).map((z) => (
                <Card key={z.id || z.name} className="flex flex-col gap-3">
                  <div className="flex items-center gap-2">
                    <Icon name="globe" size={16} className="text-accent" />
                    <span className="text-headline font-semibold">{z.name}</span>
                    {z.plan && <span className="text-subheadline text-label-3">{z.plan}</span>}
                    <span className="ml-auto text-subheadline text-label-2">{z.windowLabel || 'last hour'}</span>
                  </div>
                  <div className="grid grid-cols-5 gap-3">
                    {[
                      ['Requests', compact(z.totals?.requests)],
                      ['Cached', pct((z.totals?.cached || 0) / Math.max(1, z.totals?.requests || 0))],
                      ['4xx', compact(z.totals?.s4xx)],
                      ['5xx', compact(z.totals?.s5xx), z.totals?.s5xx > 0 ? 'orange' : null],
                      ['52x', compact(z.totals?.s52x), z.totals?.s52x > 0 ? 'red' : null],
                    ].map(([k, v, tone]) => (
                      <div key={k}>
                        <div className="text-subheadline text-label-2">{k}</div>
                        <div className={cx('text-title3 font-semibold tabular', tone === 'red' && 'text-red', tone === 'orange' && 'text-orange')}>{v}</div>
                      </div>
                    ))}
                  </div>
                  <Sparkline fluid data={(z.series || []).map((p) => p.requests)} height={46} />
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-callout">
                    {(z.topCountries || []).map((c) => (
                      <span key={c.country} className="text-label-2">
                        {countryName(c.country)} <span className="text-label font-medium tabular">{pct(c.requests / Math.max(1, z.totals?.requests || 1))}</span>
                      </span>
                    ))}
                    <span className="text-label-3 ml-auto">{bytes(z.totals?.bytes)} served</span>
                  </div>
                </Card>
              ))}
            </div>
            {cf.perHost === false && (
              <p className="text-footnote text-label-3 mt-2 px-1">Errors per hostname (api, ws, agents…) are a paid Cloudflare feature, so on the Free plan 5xx and 52x are counted for the whole zone. Everything else here works the same.</p>
            )}
            {(cf.hostErrors || []).length > 0 && (
              <Card pad={false} className="mt-3 overflow-hidden">
                <div className="px-4 py-2.5 text-headline font-semibold hairline-b flex items-center gap-2">
                  <span className="flex-1">5xx at the edge · last 15 minutes{cf.perHost === false ? ' · whole zone' : ''}</span>
                  <span className="font-normal">
                    <ExportButton name="cloudflare-edge-5xx" title="Edge 5xx" columns={EDGE_5XX_COLUMNS} rows={cf.hostErrors} />
                  </span>
                </div>
                {cf.hostErrors.map((h) => (
                  <div key={h.host} className="px-4 py-2.5 hairline-b grid grid-cols-[220px_90px_90px_minmax(0,1fr)] gap-4 text-callout items-center">
                    <span className="font-semibold">{h.host}</span>
                    <span className="tabular">{compact(h.s5xx)} × 5xx</span>
                    <span className={cx('tabular', h.s52x && 'text-red font-semibold')}>{compact(h.s52x)} × 52x</span>
                    <span className="text-label-2 truncate font-mono text-subheadline">
                      {Object.entries(h.codes || {})
                        .map(([c, n]) => `${c}: ${n}`)
                        .join('  ')}
                    </span>
                  </div>
                ))}
              </Card>
            )}
          </>
        )}
      </section>

      <div className="mt-8 grid grid-cols-1 2xl:grid-cols-2 gap-6">
        <section className="animate-rise" style={{ animationDelay: '90ms' }}>
          <SectionTitle title="Pages deployments" subtitle="Latest production deploy of each Cloudflare Pages project" right={cfOff ? null : <ExportButton name="pages-deployments" title="Pages deployments" columns={PAGES_COLUMNS} rows={cf.pages || []} />} />
          {cfOff ? (
            <ConnectCard title="Connect Cloudflare" message="Deploy status needs the Cloudflare Pages: Read permission and your account ID." />
          ) : (
            <Card pad={false} className="overflow-hidden">
              {!(cf.pages || []).length && <Empty icon="rocket" tone="gray" title="No Pages projects" message="Add your Cloudflare account ID in Settings to see deployments." />}
              {(cf.pages || []).map((p) => {
                const st = PAGE_STATUS[p.latest?.status] || PAGE_STATUS.idle;
                return (
                  <div key={p.name} className={cx('px-4 py-3 hairline-b flex items-center gap-3', p.latest?.status === 'failure' && 'bg-red-tint/50')}>
                    <Icon name="rocket" size={16} className="text-label-2" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-headline font-semibold">{p.name}</span>
                        <span className="text-subheadline text-label-3 truncate">{(p.domains || []).join(', ')}</span>
                      </div>
                      <div className="text-subheadline text-label-2 truncate">
                        {p.latest ? (
                          <>
                            <span className="font-mono">
                              {p.latest.branch}@{p.latest.commit}
                            </span>{' '}
                            · {p.latest.message} · {ago(p.latest.createdAt, now)}
                          </>
                        ) : (
                          'No deployments'
                        )}
                      </div>
                    </div>
                    <Pill tone={st.tone} strong={st.tone === 'red'}>
                      {st.label}
                    </Pill>
                  </div>
                );
              })}
            </Card>
          )}
        </section>

        <section className="animate-rise" style={{ animationDelay: '120ms' }}>
          <SectionTitle title="Sentry" subtitle="Unresolved issues seen in the last 24 hours, per app" right={<>{projects.length ? <button type="button" className="text-callout text-accent" onClick={() => navigate({ to: 'errors', filter: { source: 'frontend' } })}>Open in Errors</button> : null}<ExportButton name="sentry-apps" title="Sentry per app" columns={SENTRY_COLUMNS} rows={projects} /></>} />
          {!sentry || sentry.status === 'off' ? (
            <ConnectCard title="Connect Sentry" message="Frontend errors from the React apps, with alerts for new issues." />
          ) : (
            <Card pad={false} className="overflow-hidden">
              {!projects.length && <Empty title="No frontend errors in the last 24 hours" />}
              {projects.map((p) => (
                <button key={p.project} type="button" onClick={() => navigate({ to: 'errors', filter: { source: 'frontend', service: p.project } })} className="w-full text-left px-4 py-3 hairline-b hover:bg-fill-4 grid grid-cols-[minmax(0,1fr)_100px_90px_104px] gap-4 items-center">
                  <div className="min-w-0">
                    <div className="text-headline font-semibold truncate">{p.project}</div>
                    <div className="text-subheadline text-label-2">
                      {p.issues} issue{p.issues === 1 ? '' : 's'}
                      {p.newIssues ? <span className="text-accent font-medium"> · {p.newIssues} new</span> : null}
                    </div>
                  </div>
                  <Sparkline data={p.spark} width={100} height={26} color="var(--red)" />
                  <div className="text-right">
                    <div className="text-headline font-semibold tabular">{compact(p.events)}</div>
                    <div className="text-subheadline text-label-3">events</div>
                  </div>
                  <div className="text-right" title="Users hit by this app's worst issue. Sentry counts users per issue, so they can't be added up across issues.">
                    <div className="text-headline font-semibold tabular">{compact(p.users)}</div>
                    <div className="text-subheadline text-label-3 whitespace-nowrap">users, worst issue</div>
                  </div>
                </button>
              ))}
            </Card>
          )}
        </section>
      </div>
    </ViewScroll>
  );
}
