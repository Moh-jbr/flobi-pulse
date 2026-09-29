// Settings → Costs: where the Costs page reads billing from (the Cloud Billing export table
// in BigQuery, which also has Google AI Studio's Gemini API; the GitHub organization that pays
// for GitHub; the OpenRouter and fal keys; Cloudflare uses the token from Integrations), what's
// paid that has no billing API (typed in once), and exchange rates when currencies mix.
// Everything is checked in the main process (cleanCostsSettings, cleanApiKey); the keys go to
// the encrypted secrets, and only whether one is saved ever comes back.
import { useEffect, useState } from 'react';
import { useStore, invoke, setState as setStore } from '../lib/store.js';
import { Button, TextField, Segmented, StatusDot, Toggle, cx } from './ui.jsx';
import Select from './Select.jsx';
import Icon from './icons.jsx';
import { cleanError as clean } from '../views/Traffic.jsx';
import { ago, num, money, bytes, dateShort } from '../lib/format.js';

const CYCLES = [
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'one-time', label: 'One-time' },
];

const PROBLEM = new Set(['forbidden', 'error', 'api-off', 'not-found', 'setup', 'invalid']);

function vendorStatus(v) {
  if (!v || v.status === 'off') return { tone: 'gray', text: 'Not set up' };
  if (v.status === 'loading') return { tone: 'accent', text: v.progress ? `Reading · day ${v.progress.done} of ${v.progress.total}` : 'Reading…' };
  if (v.status === 'forbidden') return { tone: 'orange', text: 'Missing permission' };
  if (PROBLEM.has(v.status)) return { tone: 'orange', text: 'Not working' };
  return { tone: 'green', text: v.okAt ? `Read ${ago(v.okAt)}` : 'Connected' };
}

function Head({ icon, tone, title, sub, vendor }) {
  const st = vendorStatus(vendor);
  return (
    <div className="flex items-center gap-2">
      <div className={cx('w-7 h-7 rounded-[8px] grid place-items-center text-white shrink-0', tone)}>
        <Icon name={icon} size={15} strokeWidth={1.9} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-body font-medium">{title}</div>
        <div className="text-subheadline text-label-2">{sub}</div>
      </div>
      {vendor !== undefined && (
        <span className="inline-flex items-center gap-1.5 text-subheadline text-label-2 shrink-0">
          <StatusDot tone={st.tone} size={7} />
          {st.text}
        </span>
      )}
    </div>
  );
}

/** A save that runs once at a time and shows what went wrong. */
function useSave() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const run = async (patch, done) => {
    if (busy) return;
    setBusy(true);
    setResult(null);
    try {
      setStore({ info: await invoke('costs:set', patch) });
      done?.();
      setResult({ ok: true, message: 'Saved' });
    } catch (e) {
      setResult({ ok: false, message: clean(e) });
    }
    setBusy(false);
  };
  return { busy, result, run, clear: () => setResult(null) };
}

function BillingTable({ info, vendor }) {
  const saved = info.settings.costs?.bigQueryTable || '';
  const [value, setValue] = useState(saved);
  const save = useSave();
  useEffect(() => setValue(saved), [saved]);
  const dirty = value.trim() !== saved;
  const problem = vendor && PROBLEM.has(vendor.status) ? vendor.message : null;
  return (
    <div className="px-4 py-4 flex flex-col gap-3">
      <Head icon="cloud" tone="bg-accent" title="Google Cloud" sub="The Cloud Billing export table in BigQuery (Google AI Studio’s Gemini API is in it too)" vendor={saved ? vendor : null} />
      <div className="flex items-center gap-2">
        <TextField mono value={value} onChange={(v) => (setValue(v), save.clear())} onKeyDown={(e) => e.key === 'Enter' && dirty && save.run({ bigQueryTable: value })} placeholder="project.dataset.gcp_billing_export_v1_…" aria-label="Billing export table" className="flex-1" />
        <Button variant="primary" loading={save.busy} disabled={!dirty} onClick={() => save.run({ bigQueryTable: value })}>
          Save
        </Button>
      </div>
      <div className={cx('text-subheadline', save.result && !save.result.ok ? 'text-red' : problem ? 'text-orange' : 'text-label-3')}>
        {save.result && !save.result.ok
          ? save.result.message
          : problem ||
            (vendor?.status === 'ok' && vendor.rows != null
              ? `Reading ${num(vendor.rows)} rows through BigQuery’s free table preview, never a query.${vendor.storage ? ` The table uses ${bytes(vendor.storage.bytes)} of BigQuery’s free 10 GB.` : ''}${vendor.catchingUp ? (vendor.catchingUp.stuck ? ' The export stopped updating: the Costs page says what to check.' : ` Google is still filling it in${vendor.catchingUp.through ? ` (usage up to ${dateShort(vendor.catchingUp.through)} so far)` : ''}: up to five days the first time.`) : ''}`
              : 'Billing → Billing export → BigQuery export → Standard usage cost shows the project and dataset. The service account needs BigQuery Data Viewer on that dataset only; the Costs page has the steps.')}
      </div>
    </div>
  );
}

function CloudflareBilling({ info, vendor }) {
  const cf = info.integrations.cloudflare || {};
  const text = !cf.hasToken
    ? 'Uses the Cloudflare token above. Add it first, then give it Account → Billing → Read.'
    : vendor?.status === 'forbidden'
      ? vendor.message
      : `Plans${cf.accountId ? ' and usage-based charges (Workers, R2…)' : ''} with the Cloudflare token above. It needs Account → Billing → Read too.${cf.accountId ? '' : ' Set the Account ID above to include account plans and usage.'}`;
  return (
    <div className="px-4 py-4 flex flex-col gap-2">
      <Head icon="globe" tone="bg-orange" title="Cloudflare" sub="Plans and usage-based billing" vendor={cf.hasToken ? vendor : null} />
      <div className={cx('text-subheadline', vendor?.status === 'forbidden' ? 'text-orange' : 'text-label-3')}>{text}</div>
    </div>
  );
}

function GitHubBilling({ info, vendor }) {
  const s = info.settings.costs?.github || {};
  const fallback = info.integrations.github?.owner || '';
  const hasToken = !!info.integrations.github?.hasToken;
  const initial = () => ({ kind: s.kind || 'org', owner: s.owner || '', price: s.seatPrice ?? '', currency: s.seatCurrency || 'USD' });
  const [f, setF] = useState(initial);
  const save = useSave();
  useEffect(() => setF(initial()), [s.kind, s.owner, s.seatPrice, s.seatCurrency]);
  const set = (patch) => (setF({ ...f, ...patch }), save.clear());
  const dirty = f.kind !== (s.kind || 'org') || f.owner.trim() !== (s.owner || '') || String(f.price).trim() !== String(s.seatPrice ?? '') || f.currency.trim().toUpperCase() !== (s.seatCurrency || 'USD');
  const submit = () => save.run({ github: { kind: f.kind, owner: f.owner, seatPrice: String(f.price).trim(), seatCurrency: f.currency } });
  const who = f.owner.trim() || fallback;
  const problem = vendor && PROBLEM.has(vendor.status) ? vendor.message : null;
  return (
    <div className="px-4 py-4 flex flex-col gap-3">
      <Head icon="tag" tone="bg-gray" title="GitHub" sub="Billing usage and seats" vendor={hasToken && who ? vendor : null} />
      <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-2 items-center text-callout">
        <span className="text-label-2">Billed to</span>
        <Segmented
          size="sm"
          label="Billed to"
          value={f.kind}
          onChange={(kind) => set({ kind })}
          options={[
            { value: 'org', label: 'Organization' },
            { value: 'user', label: 'Personal account' },
          ]}
        />
        <span className="text-label-2">{f.kind === 'org' ? 'Organization' : 'Username'}</span>
        <TextField mono value={f.owner} onChange={(owner) => set({ owner })} placeholder={fallback || (f.kind === 'org' ? 'your-org' : 'your-username')} aria-label={f.kind === 'org' ? 'GitHub organization' : 'GitHub username'} />
        {f.kind === 'org' && (
          <>
            <span className="text-label-2">Price per seat</span>
            <div className="flex items-center gap-2">
              <div className="w-32 shrink-0">
                <TextField value={f.price} onChange={(price) => set({ price })} placeholder="e.g. 4" inputMode="decimal" aria-label="Price per seat, a month" className="text-right tabular" />
              </div>
              <div className="w-16 shrink-0">
                <TextField mono value={f.currency} onChange={(currency) => set({ currency: currency.toUpperCase().slice(0, 3) })} aria-label="Seat price currency" className="text-center" />
              </div>
              <span className="text-subheadline text-label-3">a month, times the seats on the plan</span>
            </div>
          </>
        )}
      </div>
      <div className="flex items-start gap-2">
        <div className={cx('text-subheadline flex-1', save.result && !save.result.ok ? 'text-red' : problem ? 'text-orange' : 'text-label-3')}>
          {save.result && !save.result.ok
            ? save.result.message
            : problem ||
              (!hasToken
                ? 'Uses the GitHub token above (the Versions page’s). Add it first.'
                : f.kind === 'org'
                  ? 'Uses the GitHub token above. For billing it also needs Administration: Read-only (organization permissions), and only owners and billing managers can see billing. GitHub shows the seat count to owners; its price isn’t in the API, so type it here.'
                  : 'A personal account’s billing needs a token whose resource owner is you, with Plan: Read-only. The Versions page needs one for the organization, so keep Organization unless GitHub is paid from a personal account.')}
        </div>
        {dirty && (
          <Button variant="primary" loading={save.busy} onClick={submit}>
            Save
          </Button>
        )}
      </div>
    </div>
  );
}

const KEYS = {
  openrouter: {
    title: 'OpenRouter',
    sub: 'Usage per model and the credits left',
    icon: 'traffic',
    tone: 'bg-indigo',
    field: 'openrouterKey',
    placeholder: 'Management key (sk-or-v1-…)',
    help: 'A management key (OpenRouter → Settings → Management keys → Create): an ordinary API key can’t read usage.',
  },
  fal: {
    title: 'fal',
    sub: 'Usage per endpoint and the credit balance',
    icon: 'bolt',
    tone: 'bg-purple',
    field: 'falKey',
    placeholder: 'Admin key (key id:secret)',
    help: 'An Admin key (fal → Settings → API keys → Create key, scope Admin): fal’s usage API needs one.',
  },
};

/**
 * A low-credits alert: on or off, and the amount it goes off below. While it's on, the balance is
 * checked every 30 minutes; the alert shows like the app's other warnings (toast, notification,
 * Recent issues) and clears once the balance is back above the amount.
 */
function CreditAlert({ id, info, vendor }) {
  const k = KEYS[id];
  const saved = { on: false, below: null, ...(info.settings.costs?.creditAlerts?.[id] || {}) };
  const b = vendor?.balance;
  const cur = b?.currency || 'USD';
  // Suggested when it's turned on with no amount: about a week at this month's pace, rounded up to 5.
  const suggest = b?.perDay ? Math.max(5, Math.ceil((b.perDay * 7) / 5) * 5) : 20;
  const [below, setBelow] = useState(saved.below ?? '');
  const save = useSave();
  useEffect(() => setBelow(saved.below ?? ''), [saved.below]);
  const typed = String(below).trim();
  const dirty = typed !== String(saved.below ?? '');
  const run = (on) => save.run({ creditAlerts: { [id]: { on, below: typed || (on ? String(suggest) : '') } } });
  const status = !saved.on
    ? `Off. When it’s on, the balance is checked every 30 minutes and an alert shows (like the app’s other warnings) once it drops below the amount.`
    : b?.alerting
      ? `On. The credits are below it now: ${money(b.amount, cur)} left.`
      : `On. ${b ? `${money(b.amount, cur)} left now; ` : ''}checked every 30 minutes. It clears once the balance is back above the amount.`;
  return (
    <div className="flex flex-col gap-1.5 pt-3 hairline-t">
      <div className="flex items-center gap-2 flex-wrap text-callout text-label-2">
        <Toggle checked={!!saved.on} onChange={run} label={`Alert when ${k.title} credits are low`} />
        <span>Alert me when the {k.title} credits are below</span>
        <span className="w-24 inline-block">
          <TextField value={below} onChange={(v) => (setBelow(v), save.clear())} onKeyDown={(e) => e.key === 'Enter' && dirty && run(saved.on || !!typed)} placeholder={String(suggest)} inputMode="decimal" aria-label={`${k.title} alert amount (${cur})`} className="text-right tabular" />
        </span>
        <span>{cur}</span>
        {dirty && (
          <Button size="sm" variant="primary" loading={save.busy} onClick={() => run(saved.on || !!typed)}>
            Save
          </Button>
        )}
      </div>
      <div className={cx('text-subheadline', save.result && !save.result.ok ? 'text-red selectable' : saved.on && b?.alerting ? 'text-orange' : 'text-label-3')}>{save.result && !save.result.ok ? save.result.message : status}</div>
    </div>
  );
}

/** An API key only the Costs page uses (OpenRouter, fal): saved encrypted, read-only through the guard. */
function KeyCard({ id, info, vendor }) {
  const k = KEYS[id];
  const hasKey = !!info.integrations?.[id]?.hasKey;
  const [value, setValue] = useState('');
  const save = useSave();
  const problem = hasKey && vendor && PROBLEM.has(vendor.status) ? vendor.message : null;
  const submit = () => value.trim() && save.run({ [k.field]: value }, () => setValue(''));
  return (
    <div className="px-4 py-4 flex flex-col gap-3">
      <Head icon={k.icon} tone={k.tone} title={k.title} sub={k.sub} vendor={hasKey ? vendor : null} />
      <div className="flex items-center gap-2">
        <TextField type="password" mono value={value} onChange={(v) => (setValue(v), save.clear())} onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder={hasKey ? '•••••••• saved (paste a new one to replace it)' : k.placeholder} aria-label={`${k.title} key`} className="flex-1" />
        {hasKey && !value && (
          <Button loading={save.busy} onClick={() => save.run({ [k.field]: '' })}>
            Remove
          </Button>
        )}
        <Button variant="primary" loading={save.busy && !!value} disabled={!value.trim()} onClick={submit}>
          Save
        </Button>
      </div>
      <div className={cx('text-subheadline', save.result && !save.result.ok ? 'text-red selectable' : problem ? 'text-orange selectable' : 'text-label-3')}>
        {save.result && !save.result.ok ? save.result.message : problem || `${k.help} Flobi Pulse only reads usage and credits with it (its read-only guard blocks the rest) and keeps it encrypted. Usage counts as it’s spent, so don’t also type in top-ups.`}
      </div>
      {hasKey && <CreditAlert id={id} info={info} vendor={vendor} />}
    </div>
  );
}

const blank = (preset = {}) => ({ id: `n${Math.random().toString(36).slice(2, 9)}`, vendor: '', item: '', amount: '', currency: 'USD', cycle: 'monthly', date: '', note: '', ...preset });

function Items({ info }) {
  const saved = info.settings.costs?.items || [];
  const [list, setList] = useState(saved);
  const [dirty, setDirty] = useState(false);
  const save = useSave();
  useEffect(() => {
    if (!dirty) setList(saved);
  }, [saved]);
  const update = (i, patch) => {
    setList(list.map((it, j) => (i === j ? { ...it, ...patch } : it)));
    setDirty(true);
    save.clear();
  };
  const add = (preset) => {
    setList([...list, blank(preset)]);
    setDirty(true);
    save.clear();
  };
  const submit = () => save.run({ items: list.map((it) => ({ ...it, amount: String(it.amount).trim() })) }, () => setDirty(false));
  return (
    <div className="px-4 py-4 flex flex-col gap-3">
      <Head icon="receipt" tone="bg-teal" title="Paid without a billing API" sub="Replicate, Sentry, Clerk and anything else: typed in once, counted every month" />
      {list.map((it, i) => (
        <div key={it.id} className={cx('flex flex-col gap-1.5', i > 0 && 'pt-3 hairline-t')}>
          <div className="grid grid-cols-[112px_minmax(0,1fr)_88px_56px_118px_28px] gap-2 items-center">
            <TextField value={it.vendor} onChange={(vendor) => update(i, { vendor })} placeholder="Vendor" aria-label="Vendor" />
            <TextField value={it.item} onChange={(item) => update(i, { item })} placeholder="What (plan, seats…)" aria-label="What it is" />
            <TextField value={it.amount} onChange={(amount) => update(i, { amount })} placeholder="Amount" inputMode="decimal" aria-label="Amount" className="text-right tabular" />
            <TextField mono value={it.currency} onChange={(currency) => update(i, { currency: currency.toUpperCase().slice(0, 3) })} aria-label="Currency" className="text-center" />
            <Select size="md" value={it.cycle} onChange={(cycle) => update(i, { cycle })} options={CYCLES} ariaLabel="How often" className="w-full" maxWidth={118} />
            <button type="button" onClick={() => (setList(list.filter((_, j) => j !== i)), setDirty(true), save.clear())} className="w-7 h-7 rounded-full hover:bg-red-tint text-label-3 hover:text-red grid place-items-center" aria-label={`Remove ${it.vendor || 'item'}`}>
              <Icon name="x" size={12} strokeWidth={2.2} />
            </button>
          </div>
          <div className="grid grid-cols-[112px_150px_minmax(0,1fr)_28px] gap-2 items-center">
            <span className="text-subheadline text-label-3 text-right pr-1">{it.cycle === 'one-time' ? 'Paid on' : 'Renews on'}</span>
            <TextField type="date" value={it.date} onChange={(date) => update(i, { date })} aria-label={it.cycle === 'one-time' ? 'Paid on' : 'Renews on (optional)'} className="tabular" />
            <TextField value={it.note} onChange={(note) => update(i, { note })} placeholder="Note (optional)" aria-label="Note" />
            <span />
          </div>
        </div>
      ))}
      <div className="flex items-center gap-2 flex-wrap">
        <Button size="sm" icon="receipt" onClick={() => add()}>
          Add item
        </Button>
        {!list.some((it) => /^sentry$/i.test(it.vendor.trim())) && (
          <Button size="sm" icon="errors" onClick={() => add({ vendor: 'Sentry', item: 'Plan' })}>
            Add Sentry
          </Button>
        )}
        {!list.some((it) => /^clerk$/i.test(it.vendor.trim())) && (
          <Button size="sm" icon="person" onClick={() => add({ vendor: 'Clerk', item: 'Plan' })}>
            Add Clerk
          </Button>
        )}
        {!list.some((it) => /^replicate$/i.test(it.vendor.trim())) && (
          <Button size="sm" icon="stack" onClick={() => add({ vendor: 'Replicate', item: 'Monthly usage' })}>
            Add Replicate
          </Button>
        )}
        <span className={cx('flex-1 text-subheadline', save.result && !save.result.ok ? 'text-red selectable' : 'text-label-3')}>
          {save.result && !save.result.ok ? save.result.message : list.length ? 'Yearly items count as a twelfth each month, quarterly as a third, weekly as 52 weeks over 12 months; one-time items in the month they were paid. Recurring ones count from the month they’re added.' : 'Nothing yet.'}
        </span>
        {dirty && (
          <Button variant="primary" loading={save.busy} onClick={submit}>
            Save items
          </Button>
        )}
      </div>
    </div>
  );
}

function Rates({ info, costs }) {
  const saved = info.settings.costs?.rates || {};
  const codes = [...new Set([...(costs?.currencies || []), ...Object.keys(saved)])].filter((c) => c !== costs?.currency).sort();
  const [rates, setRates] = useState(saved);
  const save = useSave();
  useEffect(() => setRates(saved), [JSON.stringify(saved)]);
  if (!codes.length || !costs) return null;
  const dirty = codes.some((c) => String(rates[c] ?? '') !== String(saved[c] ?? ''));
  return (
    <div className="px-4 py-4 flex flex-col gap-3">
      <Head icon="refresh" tone="bg-indigo" title="Exchange rates" sub={`Totals are in ${costs.currency}; other currencies count at the rate typed here (the app doesn’t look rates up)`} />
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {codes.map((c) => (
          <label key={c} className="inline-flex items-center gap-2 text-callout text-label-2">
            1 {c} =
            <span className="w-24 inline-block">
              <TextField value={rates[c] ?? ''} onChange={(v) => (setRates({ ...rates, [c]: v }), save.clear())} placeholder="rate" inputMode="decimal" aria-label={`${costs.currency} per ${c}`} className="text-right tabular" />
            </span>
            {costs.currency}
            {rates[c] && Number(rates[c]) > 0 && <span className="text-label-3">· {money(100, c, { cents: false })} ≈ {money(100 * Number(rates[c]), costs.currency)}</span>}
          </label>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <span className={cx('flex-1 text-subheadline', save.result && !save.result.ok ? 'text-red' : 'text-label-3')}>{save.result && !save.result.ok ? save.result.message : costs.missingRates.length ? `Without a rate, amounts in ${costs.missingRates.join(', ')} are left out of the totals.` : 'Each line still shows its own currency.'}</span>
        {dirty && (
          <Button variant="primary" loading={save.busy} onClick={() => save.run({ rates: Object.fromEntries(codes.map((c) => [c, String(rates[c] ?? '').trim()])) })}>
            Save rates
          </Button>
        )}
      </div>
    </div>
  );
}

/** The rows of the Settings → Costs group. */
export default function CostsSettings({ info }) {
  const costs = useStore((s) => s.costs);
  const vendor = (id) => costs?.vendors?.find((v) => v.id === id);
  return (
    <>
      <BillingTable info={info} vendor={vendor('gcp')} />
      <CloudflareBilling info={info} vendor={vendor('cloudflare')} />
      <GitHubBilling info={info} vendor={vendor('github')} />
      <KeyCard id="openrouter" info={info} vendor={vendor('openrouter')} />
      <KeyCard id="fal" info={info} vendor={vendor('fal')} />
      <Items info={info} />
      <Rates info={info} costs={costs} />
    </>
  );
}
