// Costs: what the platform costs each month, per vendor and in total. Google Cloud comes
// from the Cloud Billing export in BigQuery (read through BigQuery's free table preview,
// never a query), and Google AI Studio's Gemini API from the same export; Cloudflare from its
// plans and usage-based billing, GitHub from its billing usage and seats, OpenRouter and fal
// from their usage and credits APIs, and the rest (Replicate, Sentry, Clerk…) from what's typed
// in Settings → Costs. Every number is what a vendor reported or what was typed in: unknown is
// "—", never a guess.
import { useRef, useState } from 'react';
import { useStore, invoke, navigate, setState } from '../lib/store.js';
import { ViewScroll } from '../components/Toolbar.jsx';
import { Card, Button, Pill, Spinner, InfoTip, Meter, Popover, CopyButton, cx, useNow } from '../components/ui.jsx';
import Icon from '../components/icons.jsx';
import ExportButton from '../components/ExportButton.jsx';
import { money, monthName, dateShort, ago, clockHM, bytes } from '../lib/format.js';
import { BQ_MIN_KEEP_DAYS } from '../../electron/core/engine/costs.mjs';

const LOOK = {
  gcp: { icon: 'cloud', tone: 'bg-accent' },
  cloudflare: { icon: 'globe', tone: 'bg-orange' },
  github: { icon: 'tag', tone: 'bg-gray' },
  sentry: { icon: 'errors', tone: 'bg-purple' },
  clerk: { icon: 'person', tone: 'bg-indigo' },
  aistudio: { icon: 'sparkles', tone: 'bg-accent' },
  openrouter: { icon: 'traffic', tone: 'bg-indigo' },
  fal: { icon: 'bolt', tone: 'bg-purple' },
  replicate: { icon: 'stack', tone: 'bg-gray' },
  other: { icon: 'receipt', tone: 'bg-teal' },
};

// What the lines of a vendor are, for the table's first column.
const LINE_KIND = { gcp: 'Service', aistudio: 'Service', openrouter: 'Model', fal: 'Endpoint' };

// Lines shown before "Show N more" (Google Cloud lists every service it billed).
const FIRST_LINES = 8;

const INFO = {
  thisMonth: {
    title: 'This month so far',
    body: 'Usage billed so far this month (Google Cloud, Cloudflare, GitHub, OpenRouter and fal usage, as each reports it), plus this month’s share of every plan and item: a yearly one counts as a twelfth, a quarterly one as a third, a weekly one as 52 weeks over 12 months. One-time items count in their own month.',
    note: 'Google’s billing data runs about a day behind and OpenRouter counts whole days, so yesterday’s or today’s usage may still be coming in.',
  },
  projected: {
    title: 'Projected for the month',
    body: 'Usage so far continued at this month’s pace to the end of the month, plus the plans and items as they are. From the third day of the month on; before that it’s what’s billed so far.',
    note: 'A projection, not a bill: a spike or a new service changes it.',
  },
  lastMonth: {
    title: 'Last month',
    body: 'What each source reported for last month. Google Cloud counts by invoice month, the way Google’s invoice adds up, so late usage can land in the month after.',
    note: 'Plans and items count from the month Flobi Pulse first saw them, so the first month after setting up can leave some out; the page says which.',
  },
};

const amount = (v, cur) => (v == null ? '—' : money(v, cur));

function cycleLabel(l) {
  const price = l.price != null ? money(l.price, l.currency) : '';
  switch (l.cycle) {
    case 'usage':
      return 'Usage';
    case 'monthly':
      return l.perSeat ? 'Monthly, per seat' : 'Monthly';
    case 'yearly':
      return `Yearly · ${price}`;
    case 'quarterly':
      return `Quarterly · ${price}`;
    case 'weekly':
      return `Weekly · ${price}`;
    case 'one-time':
      return 'One-time';
    default:
      return 'Not on a cycle';
  }
}

function lineDetail(l, c) {
  const bits = [];
  if (l.credits && l.credits[c.month]) bits.push(`incl. ${money(l.credits[c.month], l.currency)} in credits`);
  if (l.state) bits.push(`${l.state}: not charged`);
  if (l.renews) bits.push(`Renews ${dateShort(l.renews)}`);
  if (l.perSeat && l.seats != null) bits.push(`${l.seats} seat${l.seats === 1 ? '' : 's'} × ${money(l.price, l.currency)}${l.filled != null && l.filled !== l.seats ? ` (${l.filled} in use)` : ''}`);
  if (l.kind === 'one-time' && l.date) bits.push(l.date.slice(0, 7) > c.month ? `Upcoming, on ${dateShort(l.date)}` : `On ${dateShort(l.date)}`);
  else if (l.manual && l.date) bits.push(`Renews ${dateShort(l.date)}`);
  if (l.manual && l.kind !== 'one-time' && l.lastMonth == null && l.addedAt) {
    const d = new Date(l.addedAt);
    bits.push(`Counted from ${monthName(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, 'month')}, when it was added`);
  }
  if (l.note) bits.push(l.note);
  return bits.join(' · ');
}

function Tile({ label, value, sub, info, loading }) {
  return (
    <Card className="flex flex-col gap-1 min-w-0">
      <div className="flex items-center justify-between gap-2 text-callout text-label-2">
        <span className="truncate">{label}</span>
        {info && <InfoTip {...info} />}
      </div>
      <div className="text-title1 font-semibold tracking-[-0.02em] truncate">{loading ? <span className="inline-block skeleton h-6 w-28 align-middle" /> : value}</div>
      {sub && <div className="text-subheadline text-label-3 truncate">{sub}</div>}
    </Card>
  );
}

/**
 * The last six months as columns: past months quiet, this month in the accent with the rest of
 * its projection as a lighter step. Each column's title is its value (also in the Export).
 */
function MonthBars({ v, c }) {
  const current = c.month;
  const proj = v.projection?.estimated ? v.projection.amount : null;
  const top = Math.max(1e-9, ...v.trend.map((t) => (t.month === current ? Math.max(t.amount || 0, proj || 0) : t.amount || 0)));
  const H = 34;
  return (
    <div role="img" aria-label={`${v.name}, last six months: ${v.trend.map((t) => `${monthName(t.month, 'short')} ${amount(t.amount, c.currency)}`).join(', ')}`} className="flex items-end gap-1 shrink-0">
      {v.trend.map((t) => {
        const now = t.month === current;
        const h = t.amount == null ? 0 : Math.max(2, Math.round((Math.max(0, t.amount) / top) * H));
        const ph = now && proj != null ? Math.max(h, Math.round((Math.max(0, proj) / top) * H)) : h;
        const tip = t.amount == null ? `${monthName(t.month)}: not known` : now ? `${monthName(t.month)}: ${money(t.amount, c.currency)} so far${proj != null ? `, about ${money(proj, c.currency)} at this pace` : ''}` : `${monthName(t.month)}: ${money(t.amount, c.currency)}`;
        return (
          <span key={t.month} title={tip} className="w-[22px] flex flex-col items-center gap-1">
            <span className="relative w-3.5 flex flex-col justify-end" style={{ height: H }}>
              {now && ph > h && <span className="absolute inset-x-0 bottom-0 rounded-t-[4px] bg-accent-tint" style={{ height: ph }} />}
              {t.amount == null ? (
                <span className="absolute inset-x-0 bottom-0 h-px bg-separator" />
              ) : (
                <span className={cx('relative rounded-t-[4px]', now ? 'bg-accent' : '')} style={{ height: h, background: now ? undefined : 'color-mix(in srgb, var(--gray) 55%, transparent)' }} />
              )}
            </span>
            <span className={cx('text-footnote leading-none truncate max-w-full', now ? 'text-label-2 font-medium' : 'text-label-3')}>{monthName(t.month, 'short')}</span>
          </span>
        );
      })}
    </div>
  );
}

function Notice({ tone = 'plain', icon = 'info', title, children, action }) {
  return (
    <Card className={cx('mb-3 flex items-start gap-3', tone === 'orange' && '!bg-orange-tint')}>
      <Icon name={icon} size={16} className={cx('mt-0.5 shrink-0', tone === 'orange' ? 'text-orange' : 'text-label-2')} />
      <div className="min-w-0 flex-1">
        {title && <div className="text-headline font-semibold">{title}</div>}
        <div className={cx('text-callout text-label-2 selectable', title && 'mt-0.5')}>{children}</div>
      </div>
      {action}
    </Card>
  );
}

const Code = ({ children }) => <code className="font-mono text-[11px] px-1 py-px rounded-[5px] bg-fill-3 text-label break-all">{children}</code>;
const B = ({ children }) => <b className="text-label">{children}</b>;

/** Google Cloud (and AI Studio) while the export isn't whole yet: nothing to count until it is. */
const waitingForExport = (v, c) => !!(v.catchingUp || (v.exportFrom && c.month < v.exportFrom));

/**
 * The billing export while Google is still filling it in: the first days after it's turned on,
 * Google copies the month before and then catches up to now. Or, still behind a week later, it
 * stopped updating.
 */
function ExportNotice({ v, c }) {
  const up = v.catchingUp;
  if (up?.stuck)
    return (
      <Notice tone="orange" icon="clock" title="The billing export stopped updating">
        {up.through ? `Its newest usage is from ${dateShort(up.through)}` : 'It has no usage in it'}, so Google Cloud isn’t counted. In Google Cloud, check Billing → Billing export → BigQuery export: it may have been turned off, or moved to another dataset.
      </Notice>
    );
  if (up)
    return (
      <Notice icon="cloud" title="Google is still filling in the billing export" action={<Spinner size={16} />}>
        {up.through ? `So far it has usage up to ${dateShort(up.through)}, ${clockHM(up.through)}.` : 'Nothing has arrived in it yet.'} The first time, Google copies everything from the start of {v.exportFrom ? monthName(v.exportFrom, 'month') : 'last month'} up to now, which can take up to five days, and the months only count once it’s past them. Nothing to do: the page checks again every 6 hours.
      </Notice>
    );
  return (
    <Notice icon="cloud" title={`Counted from ${monthName(v.exportFrom, 'month')}`}>
      The export went into a regional dataset{v.created ? ` on ${dateShort(v.created)}` : ''}, so Google only copies usage from that day on and {monthName(c.month, 'month')} isn’t whole. {monthName(v.exportFrom, 'month')} is the first month counted. (A dataset in the US or EU multi-region also gets the month before.)
    </Notice>
  );
}

/**
 * A prepaid balance (OpenRouter, fal) that runs out within a week at this pace, or has, or is
 * below the amount set to alert at in Settings → Costs.
 */
function LowBalance({ v }) {
  const b = v.balance;
  const out = b.amount <= 0;
  const where = v.id === 'openrouter' ? 'OpenRouter → Credits' : 'fal → Billing';
  const what = v.id === 'openrouter' ? 'requests through OpenRouter start failing' : 'fal generations start failing';
  const pace = b.perDay ? ` at about ${money(b.perDay, b.currency)} a day` : '';
  if (out)
    return (
      <Notice tone="orange" icon="clock" title={`${v.name} credits are used up`}>
        The balance is {money(b.amount, b.currency)}{b.perDay ? ` (it was going at about ${money(b.perDay, b.currency)} a day)` : ''}, so {what.replace('start failing', 'can fail')} until you top up in {where}. Automatic top-ups there keep it from running out.
      </Notice>
    );
  return (
    <Notice tone="orange" icon="clock" title={b.low ? `${v.name} credits run out in about ${b.daysLeft} day${b.daysLeft === 1 ? '' : 's'}` : `${v.name} credits are below your ${money(b.alertBelow, b.currency)} alert`}>
      {money(b.amount, b.currency)} left{pace}. Top up in {where} (or turn on automatic top-ups) before {what}.
    </Notice>
  );
}
const SettingsButton = () => (
  <Button size="sm" variant="tinted" icon="settings" onClick={() => navigate('settings')}>
    Settings
  </Button>
);

/** What a vendor needs, or what went wrong, in words. Null when there's nothing to say. */
function VendorNotice({ v, c, now }) {
  const staleNote = v.okAt && v.stale ? ` Showing what was read ${ago(v.okAt, now)}.` : '';
  if (v.id === 'gcp') {
    if (v.status === 'off')
      return (
        <Notice icon="cloud" title="Not set up" action={<SettingsButton />}>
          Google has no API for spend, so Flobi Pulse reads the billing export Google Cloud keeps in BigQuery:
          <ol className="list-decimal pl-5 mt-2 flex flex-col gap-1">
            <li>
              In Google Cloud, open <b className="text-label">Billing → Billing export → BigQuery export</b> and turn on <b className="text-label">Standard usage cost</b>. Pick a project and a new dataset in a multi-region location (US or EU), so it also brings in last month. It takes a billing account administrator.
            </li>
            <li>
              Give the app’s service account {v.email ? <Code>{v.email}</Code> : null} the <b className="text-label">BigQuery Data Viewer</b> role on that dataset only: BigQuery → the dataset → Sharing → Permissions → Add principal.
            </li>
            <li>
              A table named <Code>gcp_billing_export_v1_…</Code> appears within a few hours. Paste it in Settings → Costs as <Code>project.dataset.table</Code>.
            </li>
          </ol>
          <div className="mt-2">Free: the app only previews the table (never a query), and the export takes a few MB of BigQuery’s free 10 GiB of storage.</div>
        </Notice>
      );
    if (v.status === 'loading')
      return (
        <Notice icon="cloud" title="Reading the billing export" action={<Spinner size={16} />}>
          {v.progress ? `Day ${v.progress.done} of ${v.progress.total}. ` : ''}The first read goes through every day once and remembers it, so later checks take seconds.
        </Notice>
      );
    if (v.status === 'forbidden')
      return (
        <Notice tone="orange" icon="shield" title="Missing permission" action={<SettingsButton />}>
          Give {v.email ? <Code>{v.email}</Code> : 'the app’s service account'} the <b className="text-label">BigQuery Data Viewer</b> role on the <Code>{v.dataset}</Code> dataset: BigQuery → {v.dataset} → Sharing → Permissions → Add principal. That’s all it needs; the app never runs queries, so no Job User role.{staleNote}
        </Notice>
      );
    const titles = { 'api-off': 'The BigQuery API is off', 'not-found': 'Table not found', setup: 'Not a billing export table', invalid: 'Not a table name' };
    if (v.status !== 'ok') return <Notice tone="orange" icon="errors" title={titles[v.status] || 'Couldn’t read the billing export'} action={<SettingsButton />}>{v.message}{staleNote}</Notice>;
    if (waitingForExport(v, c)) return <ExportNotice v={v} c={c} />;
  }
  if (v.id === 'cloudflare') {
    if (v.status === 'off')
      return (
        <Notice icon="globe" title="Not set up" action={<SettingsButton />}>
          Connect Cloudflare in Settings → Integrations. For billing, the token also needs <b className="text-label">Account → Billing → Read</b>, and the Account ID set there.
        </Notice>
      );
    if (v.status === 'loading') return <Notice icon="globe" title="Reading Cloudflare billing" action={<Spinner size={16} />}>Plans and usage-based charges.</Notice>;
    if (v.status === 'forbidden') return <Notice tone="orange" icon="shield" title="Missing permission">{v.message}{staleNote}</Notice>;
    if (v.status !== 'ok') return <Notice tone="orange" icon="errors" title="Couldn’t read Cloudflare billing">{v.message}{staleNote}</Notice>;
  }
  if (v.id === 'github') {
    if (v.status === 'off' && v.reason === 'no-token')
      return (
        <Notice icon="tag" title="Not set up" action={<SettingsButton />}>
          Add a GitHub token in Settings → Integrations (the Versions page uses the same one). For billing it also needs <b className="text-label">Administration: Read-only</b> under Organization permissions, and only owners and billing managers can see billing.
        </Notice>
      );
    if (v.status === 'off')
      return (
        <Notice icon="tag" title="Not set up" action={<SettingsButton />}>
          Set the GitHub organization that pays for GitHub in Settings → Costs.
        </Notice>
      );
    if (v.status === 'loading') return <Notice icon="tag" title="Reading GitHub billing" action={<Spinner size={16} />}>Usage for the last six months, and the plan’s seats.</Notice>;
    if (v.status !== 'ok') return <Notice tone="orange" icon={v.status === 'forbidden' || v.status === 'not-found' ? 'shield' : 'errors'} title={v.status === 'forbidden' || v.status === 'not-found' ? 'Missing permission' : 'Couldn’t read GitHub billing'}>{v.message}{staleNote}</Notice>;
  }
  if (v.id === 'sentry' && v.status === 'off')
    return (
      <Notice icon="errors" title="Add your plan" action={<SettingsButton />}>
        Sentry has no billing API. Add your plan once in Settings → Costs → Add Sentry, and it counts every month.
      </Notice>
    );
  if (v.id === 'clerk' && v.status === 'off')
    return (
      <Notice icon="person" title="Add your plan" action={<SettingsButton />}>
        Clerk has no billing API. Add your plan once in Settings → Costs → Add Clerk (and any add-on, or extra users past your plan, as its own item), and it counts every month.
      </Notice>
    );
  if (v.id === 'replicate' && v.status === 'off')
    return (
      <Notice icon="stack" title="Add what it costs" action={<SettingsButton />}>
        Replicate has no billing API. Add what you spend in a month in Settings → Costs → Add Replicate (Replicate → Account → Billing shows it), and it counts every month. Change it when the bill does, or add each invoice as a one-time item.
      </Notice>
    );
  if (v.id === 'aistudio') {
    if (v.status === 'off' && v.reason === 'via-gcp')
      return (
        <Notice icon="sparkles" title="Comes from the Google Cloud billing export" action={<SettingsButton />}>
          Google bills AI Studio’s Gemini API through Cloud Billing, so it’s in the same export as Google Cloud: set that up above and it shows here. If AI Studio’s project is billed to another billing account, type what it costs in Settings → Costs, with Google AI Studio as the vendor.
        </Notice>
      );
    if (v.status === 'ok' && waitingForExport(v, c))
      return (
        <Notice icon="sparkles" title="Waiting for the billing export">
          The Gemini API comes from the Google Cloud billing export, which doesn’t have {monthName(c.month, 'month')} whole yet (see Google Cloud above). It shows here once it does.
        </Notice>
      );
    if (v.status === 'off' && v.reason === 'none')
      return (
        <Notice icon="sparkles" title="No Gemini API in the billing export">
          Nothing was billed for the Gemini API on this billing account in the last six months: it’s on the free tier, or AI Studio’s project is billed to another billing account. Then type what it costs in Settings → Costs, with Google AI Studio as the vendor.
        </Notice>
      );
    if (v.status === 'loading') return <Notice icon="sparkles" title="Reading the billing export" action={<Spinner size={16} />}>The Gemini API comes from the same export as Google Cloud.</Notice>;
    if (v.status !== 'ok') return <Notice tone="orange" icon="errors" title="The billing export can’t be read">See Google Cloud above: the Gemini API comes from the same export.{staleNote}</Notice>;
  }
  if (v.id === 'openrouter' || v.id === 'fal') {
    const or = v.id === 'openrouter';
    if (v.status === 'off')
      return (
        <Notice icon={LOOK[v.id].icon} title="Not set up" action={<SettingsButton />}>
          {or ? (
            <>
              Paste a <B>management key</B> in Settings → Costs (OpenRouter → Settings → Management keys → Create): an ordinary API key can’t read usage. Flobi Pulse only reads usage and credits with it; its read-only guard blocks everything else the key could do.
            </>
          ) : (
            <>
              Paste an <B>Admin key</B> in Settings → Costs (fal → Settings → API keys → Create key, scope Admin): fal’s usage API needs one. Flobi Pulse only reads usage and the balance with it; its read-only guard blocks everything else the key could do.
            </>
          )}
        </Notice>
      );
    if (v.status === 'loading')
      return (
        <Notice icon={LOOK[v.id].icon} title={`Reading ${v.name} usage`} action={<Spinner size={16} />}>
          {or ? 'Usage per model for the last 30 days (all OpenRouter keeps; from now on the page keeps the days it reads), and the credits left.' : 'Usage per endpoint for the last six months, and the credit balance.'}
        </Notice>
      );
    if (v.status === 'forbidden')
      return (
        <Notice tone="orange" icon="shield" title="Missing permission" action={<SettingsButton />}>
          {v.message}
          {staleNote}
        </Notice>
      );
    if (v.status !== 'ok') return <Notice tone="orange" icon="errors" title={`Couldn’t read ${v.name} usage`}>{v.message}{staleNote}</Notice>;
    if (v.balance?.low || v.balance?.alerting) return <LowBalance v={v} />;
  }
  if (v.stale && v.okAt) return <Notice tone="orange" icon="clock" title="Not updated lately">Last read {ago(v.okAt, now)}.{c.nextPollAt ? ` The next check is at ${clockHM(c.nextPollAt)}.` : ''}</Notice>;
  return null;
}

/**
 * How much of BigQuery's free 10 GB the billing export uses. A quiet line under Google Cloud,
 * or a card above it once it's getting close; either way "Keep it small" has the one-time
 * command (to copy and run in BigQuery) that keeps only recent days. Flobi Pulse never runs it.
 */
function BigQueryStorage({ s }) {
  const ref = useRef(null);
  const [open, setOpen] = useState(false);
  const close = s.level !== 'ok';
  const pct = Math.round(s.share * 100);
  const later = s.cappedAt != null ? `levels off around ${bytes(s.cappedAt)}` : s.bytesPerDay ? `grows about ${bytes(s.bytesPerDay)} a day` : null;
  const summary = `${bytes(s.bytes)} of the free 10 GB${later ? ` · ${later}` : ''}`;
  const button = (
    <span ref={ref} className="inline-flex shrink-0">
      <Button size="sm" variant={close ? 'tinted' : 'plain'} icon="database" onClick={() => setOpen(!open)} aria-haspopup="dialog" aria-expanded={open}>
        Keep it small
      </Button>
    </span>
  );
  return (
    <>
      {close ? (
        <Card className={cx('mb-3 flex items-center gap-3', s.level === 'full' ? '!bg-red-tint' : '!bg-orange-tint')}>
          <Icon name="database" size={16} className={cx('shrink-0', s.level === 'full' ? 'text-red' : 'text-orange')} />
          <div className="min-w-0 flex-1">
            <div className="text-headline font-semibold">{s.level === 'full' ? 'The billing data is about at BigQuery’s free 10 GB' : 'The billing data is getting close to BigQuery’s free 10 GB'}</div>
            <div className="text-callout text-label-2 mt-0.5">{summary}. Past 10 GB, BigQuery storage costs about 2 cents per GB a month.</div>
            <Meter value={s.share} warn={0.8} danger={0.95} className="mt-2 max-w-[360px]" height={5} />
          </div>
          {button}
        </Card>
      ) : (
        <div className="flex items-center gap-3 px-1 mt-2.5">
          <span className="text-footnote text-label-3 shrink-0">BigQuery storage</span>
          <span className="w-[120px] shrink-0" title={`${bytes(s.bytes)} of BigQuery’s free 10 GB (${pct}%)`}>
            <Meter value={s.share} warn={0.8} danger={0.95} />
          </span>
          <span className="text-footnote text-label-3 truncate min-w-0 flex-1">{summary}</span>
          {button}
        </div>
      )}
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} width={440} role="dialog" label="Keep the billing data small">
        <div className="p-4 flex flex-col gap-2.5 text-callout text-label-2">
          <div className="text-headline font-semibold text-label">Keep the billing data small</div>
          <p className="selectable">
            The billing export uses <b className="text-label">{bytes(s.bytes)}</b> ({pct}%) of BigQuery’s free 10 GB. That 10 GB is for all the BigQuery data in your Google Cloud account, so anything else there counts too.
            {s.cappedAt != null ? ` Days older than ${s.expirationDays} are already deleted, so it levels off around ${bytes(s.cappedAt)}.` : ''}
          </p>
          <p className="selectable">
            To keep only the last {s.keepDays} days, run this once in BigQuery (Google Cloud console → BigQuery → Query editor). From then on BigQuery deletes the older days by itself, for free{s.settlesAt ? `, and the table stays around ${bytes(s.settlesAt)}` : ''}.
          </p>
          <pre className="font-mono text-[11.5px] leading-snug p-2.5 rounded-[10px] bg-fill-3 text-label whitespace-pre-wrap break-all selectable">{s.command}</pre>
          <div className="flex items-center justify-between gap-3">
            <span className="text-footnote text-label-3">Flobi Pulse never runs it: it only reads.</span>
            <CopyButton text={s.command} label="Copy command" />
          </div>
          <p className="text-footnote text-label-3">
            Don’t use the table’s Expiration setting: that deletes the whole table and stops the export. The Costs page needs the last {BQ_MIN_KEEP_DAYS} days for its six months, so keep at least that many.
          </p>
        </div>
      </Popover>
    </>
  );
}

function sourceLine(v, now) {
  const parts = [];
  if (v.id === 'gcp') parts.push(v.table ? 'Billing export in BigQuery' : 'Billing export in BigQuery (not set up)');
  else if (v.id === 'aistudio') parts.push('Gemini API, in the Google Cloud billing export');
  else if (v.id === 'cloudflare') parts.push('Plans and usage-based billing');
  else if (v.id === 'github') parts.push(v.owner ? `${v.owner} · usage and seats` : 'Usage and seats');
  else if (v.id === 'openrouter') parts.push(v.status === 'off' ? 'Usage and credits' : 'Usage per model');
  else if (v.id === 'fal') parts.push(v.account ? `${v.account} · usage per endpoint` : v.status === 'off' ? 'Usage and credits' : 'Usage per endpoint');
  else parts.push(v.source);
  const b = v.balance;
  if (b) parts.push(`${money(b.amount, b.currency)} credits left${b.daysLeft != null && !b.low ? `, about ${b.daysLeft} day${b.daysLeft === 1 ? '' : 's'}` : ''}${v.creditAlert ? ` (alert below ${money(v.creditAlert.below, b.currency)})` : ''}`);
  if (v.okAt) parts.push(`read ${ago(v.okAt, now)}`);
  if (v.through && (v.id === 'gcp' || v.id === 'aistudio' || v.id === 'cloudflare')) parts.push(`usage through ${dateShort(v.through)}${v.id !== 'cloudflare' ? ` ${clockHM(v.through)}` : ''}`);
  if (v.id === 'openrouter' && v.lastDay && v.status !== 'off') parts.push(`through ${dateShort(v.lastDay)}`);
  if ((v.id === 'gcp' || v.id === 'aistudio') && v.catchingUp) parts.push(v.catchingUp.through ? `the export has usage up to ${dateShort(v.catchingUp.through)}` : 'the export is still empty');
  return parts.join(' · ');
}

function VendorSection({ v, c, now }) {
  const [all, setAll] = useState(false);
  const look = LOOK[v.id] || LOOK.other;
  // While the export isn't whole, the services it has so far (all unknown) aren't listed.
  const waiting = waitingForExport(v, c);
  const lines = v.lines.filter((l) => !l.hidden && !(waiting && !l.manual && l.thisMonth == null && l.lastMonth == null));
  const shown = all ? lines : lines.slice(0, FIRST_LINES);
  const seatsLine = v.lines.some((l) => l.perSeat);
  const problem = ['forbidden', 'error', 'api-off', 'not-found', 'setup', 'invalid'].includes(v.status);
  return (
    <section className="mb-7 animate-rise">
      <div className="flex items-end gap-3 mb-2.5 px-1">
        <div className={cx('w-8 h-8 rounded-[10px] grid place-items-center text-white shrink-0 mb-0.5', look.tone)}>
          <Icon name={look.icon} size={16} strokeWidth={1.9} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-title3 font-semibold flex items-center gap-2">
            {v.name}
            {v.status === 'off' && v.reason !== 'manual' && v.reason !== 'none' && <Pill tone="gray">Not set up</Pill>}
            {problem && <Pill tone="orange">{v.status === 'forbidden' ? 'Missing permission' : 'Not updated'}</Pill>}
            {v.refreshing && v.status !== 'loading' && <Spinner size={12} />}
          </h2>
          <p className="text-callout text-label-2 mt-0.5 truncate">{sourceLine(v, now)}</p>
        </div>
        {v.showTrend && <MonthBars v={v} c={c} />}
        {v.totals.thisMonth != null && (
          <div className="text-right shrink-0 min-w-[96px]">
            <div className="text-title3 font-semibold">{money(v.totals.thisMonth, c.currency)}</div>
            <div className="text-subheadline text-label-3">this month so far</div>
          </div>
        )}
      </div>
      <VendorNotice v={v} c={c} now={now} />
      {v.id === 'gcp' && v.storage && v.storage.level !== 'ok' && <BigQueryStorage s={v.storage} />}
      {lines.length > 0 && (
        <Card pad={false} className="overflow-hidden">
          <div className="grid grid-cols-[minmax(0,1fr)_150px_112px_112px] gap-4 px-4 pt-2.5 pb-2 text-subheadline text-label-3 hairline-b">
            <span>{LINE_KIND[v.id] || 'Item'}</span>
            <span>Billed</span>
            <span className="text-right">{monthName(c.month, 'month')} so far</span>
            <span className="text-right">{monthName(c.lastMonth, 'month')}</span>
          </div>
          {shown.map((l) => {
            const detail = lineDetail(l, c);
            return (
              <div key={l.id} className="grid grid-cols-[minmax(0,1fr)_150px_112px_112px] gap-4 px-4 py-2.5 items-center hairline-b">
                <div className="min-w-0">
                  <div className="text-body truncate" title={l.name.length > 40 ? l.name : undefined}>
                    {v.id === 'other' && l.vendor && <span className="text-label-2">{l.vendor} · </span>}
                    {l.name}
                    {l.manual && !['other', 'sentry', 'clerk', 'replicate'].includes(v.id) && <span className="text-label-3"> · typed in</span>}
                  </div>
                  {detail && <div className="text-subheadline text-label-3 truncate">{detail}</div>}
                </div>
                <div className="text-callout text-label-2 truncate">{cycleLabel(l)}</div>
                <div className={cx('text-right text-body tabular', l.thisMonth == null ? 'text-label-3' : !l.thisMonth && 'text-label-3')} title={l.thisMonth == null ? 'Not known yet' : undefined}>
                  {amount(l.thisMonth, l.currency)}
                </div>
                <div className={cx('text-right text-body tabular', l.lastMonth == null || !l.lastMonth ? 'text-label-3' : 'text-label-2')} title={l.lastMonth == null ? (l.kind === 'usage' ? 'Not read' : 'Not tracked then') : undefined}>
                  {amount(l.lastMonth, l.currency)}
                </div>
              </div>
            );
          })}
          {lines.length > FIRST_LINES && (
            <button type="button" onClick={() => setAll(!all)} className="w-full px-4 py-2 text-left text-callout text-accent hover:bg-fill-4 hairline-b">
              {all ? 'Show fewer' : `Show ${lines.length - FIRST_LINES} more`}
            </button>
          )}
          <div className="grid grid-cols-[minmax(0,1fr)_150px_112px_112px] gap-4 px-4 py-2.5 items-center bg-fill-4/60">
            <span className="text-headline font-semibold">{v.name}</span>
            <span />
            <span className="text-right text-headline font-semibold tabular" title={v.partial[c.month] ? 'Leaves out something that isn’t known yet' : undefined}>
              {amount(v.totals.thisMonth, c.currency)}
            </span>
            <span className="text-right text-headline font-semibold tabular text-label-2" title={v.partial[c.lastMonth] ? 'Leaves out something that wasn’t tracked last month' : undefined}>
              {amount(v.totals.lastMonth, c.currency)}
            </span>
          </div>
        </Card>
      )}
      {v.id === 'gcp' && v.storage && v.storage.level === 'ok' && <BigQueryStorage s={v.storage} />}
      {v.id === 'cloudflare' && v.status === 'ok' && v.usageStatus && v.usageStatus !== 'ok' && v.usageMessage && <p className="text-footnote text-label-3 mt-2 px-1">Usage-based charges: {v.usageMessage}</p>}
      {v.id === 'cloudflare' && v.status === 'ok' && v.message && <p className="text-footnote text-label-3 mt-2 px-1">{v.message}</p>}
      {v.id === 'github' && v.status === 'ok' && !seatsLine && v.seats && (
        <p className="text-footnote text-label-3 mt-2 px-1">
          {v.seats.seats || v.seats.filled} seats on the {v.seats.plan || 'current'} plan. Add the price per seat in Settings → Costs to count them.
        </p>
      )}
      {v.id === 'github' && v.status === 'ok' && v.seatsNote && <p className="text-footnote text-label-3 mt-2 px-1">Seats: {v.seatsNote}</p>}
      {v.id === 'openrouter' && v.status === 'ok' && (v.byok?.thisMonth > 0 || v.byok?.lastMonth > 0) && (
        <p className="text-footnote text-label-3 mt-2 px-1">
          Also {money(v.byok.thisMonth ?? 0, v.byok.currency)} this month{v.byok.lastMonth != null ? ` (${money(v.byok.lastMonth, v.byok.currency)} in ${monthName(c.lastMonth, 'month')})` : ''} on your own provider keys (BYOK): those providers bill it, so it isn’t counted here.
        </p>
      )}
      {v.id === 'openrouter' && v.status === 'ok' && v.totals.lastMonth == null && v.lines.some((l) => l.kind === 'usage') && (
        <p className="text-footnote text-label-3 mt-2 px-1">OpenRouter only keeps 30 days of usage, so {monthName(c.lastMonth, 'month')} and earlier can’t be shown. The page keeps each day it reads, so from next month on, last month is complete too.</p>
      )}
      {(v.id === 'openrouter' || v.id === 'fal') && v.status === 'ok' && v.message && <p className="text-footnote text-label-3 mt-2 px-1">{v.message}</p>}
      {(v.id === 'openrouter' || v.id === 'fal') && v.status === 'ok' && v.balanceNote && <p className="text-footnote text-label-3 mt-2 px-1">Credits: {v.balanceNote}</p>}
    </section>
  );
}

function TotalCard({ c }) {
  const rows = c.vendors.filter((v) => v.lines.length || v.status !== 'off');
  const cur = c.currency;
  const grid = 'grid grid-cols-[minmax(0,1fr)_112px_112px_112px] gap-4 px-4 items-center';
  const notes = [];
  if (c.missingRates.length) notes.push(`Amounts in ${c.missingRates.join(', ')} aren’t in the totals: add a rate in Settings → Costs.`);
  if (c.total.lastMonthPartial) notes.push(c.lastMonthGaps.length ? `${monthName(c.lastMonth, 'month')} leaves out what wasn’t tracked yet: ${c.lastMonthGaps.slice(0, 4).join(', ')}${c.lastMonthGaps.length > 4 ? ` and ${c.lastMonthGaps.length - 4} more` : ''}.` : `${monthName(c.lastMonth, 'month')} leaves out what wasn’t read or tracked then.`);
  const gcp = c.vendors.find((v) => v.id === 'gcp');
  if (gcp?.catchingUp) notes.push(gcp.catchingUp.stuck ? 'Google Cloud isn’t in the totals: its billing export stopped updating (see above).' : 'Google Cloud isn’t in the totals yet: Google is still filling in its billing export (up to five days the first time).');
  else if (gcp && waitingForExport(gcp, c)) notes.push(`Google Cloud is counted from ${monthName(gcp.exportFrom, 'month')} (see above).`);
  if (c.notSetUp.length) notes.push(`Not included yet: ${c.notSetUp.join(', ')} (not set up).`);
  return (
    <section className="mb-4 animate-rise">
      <div className="px-1 mb-2.5">
        <h2 className="text-title3 font-semibold">Total</h2>
        <p className="text-callout text-label-2 mt-0.5">
          In {cur}
          {Object.keys(c.rates).length ? ` (${Object.entries(c.rates).map(([k, r]) => `1 ${k} = ${r} ${cur}`).join(', ')}, from Settings)` : ''}. Yearly items count as a twelfth each month, quarterly as a third, weekly as 52 weeks over 12 months; one-time items only in their month.
        </p>
      </div>
      <Card pad={false} className="overflow-hidden">
        <div className={cx(grid, 'pt-2.5 pb-2 text-subheadline text-label-3 hairline-b')}>
          <span>Vendor</span>
          <span className="text-right">{monthName(c.month, 'month')} so far</span>
          <span className="text-right">Projected</span>
          <span className="text-right">{monthName(c.lastMonth, 'month')}</span>
        </div>
        {rows.map((v) => (
          <div key={v.id} className={cx(grid, 'py-2.5 hairline-b')}>
            <span className="text-body truncate">{v.name}</span>
            <span className="text-right text-body tabular">{amount(v.totals.thisMonth, cur)}</span>
            <span className="text-right text-body tabular text-label-2">{amount(v.projection.amount, cur)}</span>
            <span className="text-right text-body tabular text-label-2">{amount(v.totals.lastMonth, cur)}</span>
          </div>
        ))}
        <div className={cx(grid, 'py-3 bg-fill-4/60')}>
          <span className="text-title3 font-semibold">Total</span>
          <span className="text-right text-title3 font-semibold tabular">{amount(c.total.thisMonth, cur)}</span>
          <span className="text-right text-title3 font-semibold tabular text-label-2">{amount(c.total.projected, cur)}</span>
          <span className="text-right text-title3 font-semibold tabular text-label-2">{amount(c.total.lastMonth, cur)}</span>
        </div>
      </Card>
      {notes.map((n) => (
        <p key={n} className="text-footnote text-label-3 mt-2 px-1">
          {n}
        </p>
      ))}
    </section>
  );
}

function exportTable(c) {
  const months = [...c.months].reverse();
  const label = (m) => (m === c.month ? `${monthName(m, 'shortYear')} (so far)` : monthName(m, 'shortYear'));
  const round = (n) => (n == null ? '' : Math.round(n * 100) / 100);
  const rows = [];
  for (const v of c.vendors) {
    for (const l of v.lines.filter((x) => !x.hidden)) rows.push({ vendor: v.name, item: l.vendor && v.id === 'other' ? `${l.vendor} · ${l.name}` : l.name, billed: cycleLabel(l), currency: l.currency, months: l.months, note: lineDetail(l, c) });
    if (v.lines.length) rows.push({ vendor: v.name, item: `${v.name} total`, billed: '', currency: c.currency, months: v.byMonth, projected: v.projection.amount, note: '' });
  }
  rows.push({ vendor: 'All', item: 'Total', billed: '', currency: c.currency, months: c.total.byMonth, projected: c.total.projected, note: c.missingRates.length ? `Leaves out amounts in ${c.missingRates.join(', ')} (no rate)` : '' });
  const columns = [
    { label: 'Vendor', get: (r) => r.vendor },
    { label: 'Item', get: (r) => r.item },
    { label: 'Billed', get: (r) => r.billed },
    { label: 'Currency', get: (r) => r.currency },
    ...months.map((m) => ({ label: label(m), get: (r) => round(r.months?.[m]) })),
    { label: `Projected ${monthName(c.month, 'shortYear')}`, get: (r) => round(r.projected) },
    { label: 'Note', get: (r) => r.note },
  ];
  return { rows, columns };
}

export default function Costs() {
  const c = useStore((s) => s.costs);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(null);
  const cooling = !!(c?.cooldownUntil && c.cooldownUntil > Date.now());
  // Every second while Refresh cools down (so it comes back on time), else twice a minute.
  const now = useNow(cooling ? 1000 : 30_000);

  if (!c)
    return (
      <ViewScroll>
        <Card className="py-14 grid place-items-center gap-2 text-callout text-label-2">
          <Spinner size={18} /> Loading costs…
        </Card>
      </ViewScroll>
    );

  const refresh = async () => {
    setBusy(true);
    setRefused(null);
    try {
      const r = await invoke('costs:refresh');
      if (r?.costs) setState({ costs: r.costs });
      if (r && !r.started && r.reason === 'cooldown') setRefused(`Refreshed moments ago. Again in ${Math.ceil(r.retryInMs / 1000)} s.`);
      if (r && !r.started && r.reason === 'demo') setRefused('Demo data: there’s nothing to read.');
    } catch (e) {
      setRefused(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
    setBusy(false);
  };
  const waitS = cooling ? Math.ceil((c.cooldownUntil - now) / 1000) : 0;
  const { rows, columns } = exportTable(c);
  const monthDay = new Date(now).getDate();
  const anyLoading = c.vendors.some((v) => v.status === 'loading');
  // Sources this month's numbers don't fully cover yet (still reading, or something not known).
  const incomplete = c.vendors.filter((v) => v.status === 'loading' || v.partial?.[c.month] || (v.totals.thisMonth == null && v.lines.length > 0)).map((v) => v.name);
  const reading = c.vendors.filter((v) => v.status === 'loading').map((v) => v.name);
  const projectedSub = reading.length ? `Without ${reading.join(', ')} (still reading)` : c.total.projectionEstimated ? 'Usage at this month’s pace, plus plans' : c.total.projectionEarly ? 'Too early to project usage: billed so far' : 'Plans and items as they are';
  const lastSub = `${monthName(c.lastMonth)}${reading.length ? ` · without ${reading.join(', ')} (still reading)` : c.total.lastMonthPartial ? ' · leaves some out (below)' : monthDay <= 5 ? ' · may still change' : ''}`;
  const status = c.refreshing ? 'Checking every source now…' : c.mode === 'demo' ? 'Demo data' : c.checkedAt ? `Checked ${ago(c.checkedAt, now)}${c.nextPollAt ? ` · next check at ${clockHM(c.nextPollAt)}` : ''}` : 'Not checked yet';

  return (
    <ViewScroll inner="max-w-[1100px]">
      <div className="flex items-center gap-2 flex-wrap mb-4 animate-rise">
        <span className="text-subheadline text-label-3 inline-flex items-center gap-1.5">
          {c.refreshing && <Spinner size={12} />}
          {status}
        </span>
        {refused && <span className="text-subheadline text-orange">{refused}</span>}
        <div className="flex-1" />
        <Button size="sm" icon="refresh" loading={busy || c.refreshing} disabled={cooling} title={cooling ? `You can refresh again in ${waitS} s` : 'Read every source again now'} onClick={refresh}>
          Refresh
        </Button>
        <ExportButton name="costs" title="Costs" columns={columns} rows={rows} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4 animate-rise">
        <Tile label="This month so far" value={amount(c.total.thisMonth, c.currency)} sub={`${monthName(c.month, 'month')} 1–${monthDay}${incomplete.length ? ` · ${incomplete.join(', ')} not complete yet` : ''}`} info={INFO.thisMonth} loading={c.total.thisMonth == null && anyLoading} />
        <Tile label={`Projected for ${monthName(c.month, 'month')}`} value={amount(c.total.projected, c.currency)} sub={projectedSub} info={INFO.projected} loading={c.total.projected == null && anyLoading} />
        <Tile label="Last month" value={amount(c.total.lastMonth, c.currency)} sub={lastSub} info={INFO.lastMonth} loading={c.total.lastMonth == null && anyLoading} />
      </div>

      {c.missingRates.length > 0 && (
        <Notice tone="orange" icon="errors" title="Some amounts aren’t in the totals" action={<SettingsButton />}>
          They’re in {c.missingRates.join(', ')}. Add a rate in Settings → Costs (1 {c.missingRates[0]} = ? {c.currency}) and they’re counted; the app doesn’t look rates up.
        </Notice>
      )}

      {c.vendors.map((v) => (
        <VendorSection key={v.id} v={v} c={c} now={now} />
      ))}

      <TotalCard c={c} />

      <p className="text-footnote text-label-3 px-1 mt-3 max-w-3xl">
        Reading these costs is free. Google Cloud’s (and Google AI Studio’s Gemini API) come from the billing export in BigQuery, read with BigQuery’s free table preview (never a query, which BigQuery would bill); Cloudflare’s, GitHub’s, OpenRouter’s and fal’s from their billing APIs; the rest is typed in Settings → Costs. Checked every 6 hours.
      </p>
    </ViewScroll>
  );
}
