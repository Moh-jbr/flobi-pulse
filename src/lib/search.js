// The search box (⌘K): one query over everything the app holds — services, issues,
// errors, crashes, events, pods, nodes, endpoints, Pages projects, and every log
// line and request still in memory. Plain data in, plain results out, so it can be
// tested without React; the palette turns each result's `open` into a click.
//
// A query is words that must all appear (in any order, any case), plus filters:
//   service:brand   status:503 or status:5xx   level:error   in:logs
// A quoted "two words" must appear together.

const FILTER_KEYS = { service: 'service', svc: 'service', status: 'status', level: 'level', in: 'in' };
export const SCOPES = { services: 'Services', follow: 'Follow live logs', issues: 'Issues', errors: 'Errors', crashes: 'Crashes', events: 'Events', pods: 'Pods', nodes: 'Nodes', endpoints: 'Endpoints', pages: 'Pages projects', logs: 'Log lines', requests: 'Requests' };
const LEVEL_ALIASES = { err: 'error', errors: 'error', warning: 'warn', warnings: 'warn' };
const SCOPE_ALIASES = { log: 'logs', request: 'requests', traffic: 'requests', alert: 'issues', alerts: 'issues', issue: 'issues', error: 'errors', crash: 'crashes', event: 'events', pod: 'pods', node: 'nodes', service: 'services', uptime: 'endpoints', endpoint: 'endpoints', page: 'pages', deploys: 'pages' };

/** "brand status:5xx \"heap out\"" → { terms: ['brand', 'heap out'], filters: { status: '5xx' } } */
export function parseQuery(q) {
  const terms = [];
  const filters = {};
  const re = /(\w+):("[^"]*"|\S+)|"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(q || '')))) {
    const key = m[1] && FILTER_KEYS[m[1].toLowerCase()];
    if (key) {
      const v = m[2].replace(/^"|"$/g, '').toLowerCase();
      if (v) filters[key] = key === 'in' ? SCOPE_ALIASES[v] || v : key === 'level' ? LEVEL_ALIASES[v] || v : v;
    } else {
      const t = (m[1] ? m[0] : m[3] ?? m[4]).toLowerCase().trim();
      if (t) terms.push(t);
    }
  }
  return { terms, filters };
}

const lower = (...parts) => parts.filter((x) => x != null && x !== '').join(' • ').toLowerCase();
const short = (name) => String(name || '').replace(/^flobi-/, '');

function statusOk(status, want) {
  if (!want) return true;
  if (status == null) return false;
  if (/^\dxx$/.test(want)) return String(status)[0] === want[0];
  return String(status) === want;
}

/** The service filter matches "brand", "flobi-brand" and the start of either. */
function serviceOk(service, want) {
  if (!want) return true;
  const s = String(service || '').toLowerCase();
  return s === want || short(s) === want || short(s).startsWith(short(want)) || s.startsWith(want);
}

/** Up to ~`width` characters of `text` around the first term found, with "…" where it was cut. */
export function snippet(text, terms, width = 110) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= width) return t;
  const low = t.toLowerCase();
  const hit = Math.min(...terms.map((x) => low.indexOf(x)).filter((i) => i >= 0), Infinity);
  if (!Number.isFinite(hit) || hit < width * 0.6) return `${t.slice(0, width)}…`;
  const start = Math.max(0, hit - Math.round(width * 0.3));
  const end = Math.min(t.length, start + width);
  return `${start ? '…' : ''}${t.slice(start, end)}${end < t.length ? '…' : ''}`;
}

/** Repeats of the same thing (an alert raised again, an event reported again) as one result, newest kept, with a count. */
function fold(list, keyOf, atOf) {
  const m = new Map();
  for (const x of list) {
    const k = keyOf(x);
    const cur = m.get(k);
    if (!cur) m.set(k, { x, n: 1 });
    else {
      cur.n++;
      if ((atOf(x) || 0) > (atOf(cur.x) || 0)) cur.x = x;
    }
  }
  return [...m.values()];
}

/** How well a result's title answers the words: a title that starts with one beats one that only contains it. */
function rank(title, terms) {
  const t = String(title || '').toLowerCase();
  let r = 0;
  for (const x of terms) r += t === x ? 4 : t.startsWith(x) ? 3 : t.split(/[\s\-_/.:]+/).some((w) => w.startsWith(x)) ? 2 : t.includes(x) ? 1 : 0;
  return r;
}

/**
 * Everything that answers the query, in groups.
 * @param {string} q
 * @param {object} d - { services, alerts, errors, crashes, events, pods, nodes, uptime, pages, logs, traffic, now }
 * @returns {{ terms: string[], filters: object, groups: { id, title, total, items, more?, note? }[] }}
 */
export function deepSearch(q, d = {}, { perGroup = 5 } = {}) {
  const { terms, filters } = parseQuery(q);
  const empty = { terms, filters, groups: [] };
  if (!terms.length && !Object.keys(filters).length) return empty;
  const has = (hay) => terms.every((t) => hay.includes(t));
  const want = (scope) => !filters.in || filters.in === scope;
  // Status and level only make sense for requests and log lines; with one set, the rest stay out.
  const onlyStatus = !!filters.status;
  const onlyLevel = !!filters.level;
  const plain = !onlyStatus && !onlyLevel;
  const groups = [];
  const add = (id, list, { by = 'rank', note, more } = {}) => {
    if (!list.length) return;
    const sorted = by === 'time' ? list.sort((a, b) => (b.at || 0) - (a.at || 0)) : list.sort((a, b) => b.r - a.r || (b.at || 0) - (a.at || 0));
    groups.push({ id, title: SCOPES[id], total: list.length, items: sorted.slice(0, perGroup), note, more });
  };

  if (plain && want('services')) {
    const matched = (d.services || []).filter((s) => serviceOk(s.name, filters.service) && has(lower(s.name, s.short, (s.hosts || []).join(' '), s.health, (s.reasons || []).join(' '))));
    add(
      'services',
      matched.map((s) => ({ key: `s:${s.name}`, icon: 'stack', title: s.short || short(s.name), sub: s.health !== 'healthy' && s.reasons?.length ? s.reasons.join(' · ') : (s.hosts || []).join(', ') || s.name, health: s.health, r: rank(s.short || s.name, terms) + 2, open: { inspect: ['service', s.name] } })),
    );
    // A service's logs as they happen, the way "Logs: brand" always worked.
    add(
      'follow',
      [...matched].sort((a, b) => rank(b.short || b.name, terms) - rank(a.short || a.name, terms)).slice(0, 3).map((s) => ({ key: `f:${s.name}`, icon: 'logs', title: `Follow ${s.short || short(s.name)}'s logs`, sub: 'Live, as they happen', r: rank(s.short || s.name, terms), open: { navigate: { to: 'logs', service: s.name } } })),
    );
  }

  if (plain && want('issues')) {
    add(
      'issues',
      fold(
        (d.alerts?.history || []).filter((a) => serviceOk(a.service, filters.service) && has(lower(a.title, a.detail, a.impact, a.service, a.kind))),
        (a) => a.key || a.title,
        (a) => a.openedAt,
      ).map(({ x: a, n }) => ({ key: `a:${a.id}`, icon: 'bell', title: a.title, sub: `${n > 1 ? `${n} times · ` : ''}${snippet(a.detail, terms)}`, tone: a.severity === 'critical' ? 'red' : 'orange', at: a.openedAt ?? a.at, r: rank(a.title, terms), open: a.view ? { navigate: a.view } : { navigate: { to: 'recent' } } })),
      { by: 'time', more: { navigate: { to: 'recent' }, label: 'Open Recent issues' } },
    );
  }

  if (plain && want('errors')) {
    const backend = (d.errors?.backend || []).map((g) => ({ g, service: g.service, hay: lower(g.title, g.context, g.service, ...(g.samples || []).map((x) => x?.text || x)) }));
    const frontend = (d.errors?.frontend || []).map((g) => ({ g, service: g.project, hay: lower(g.title, g.culprit, g.project, 'frontend sentry') }));
    add(
      'errors',
      [...backend, ...frontend]
        .filter((x) => serviceOk(x.service, filters.service) && has(x.hay))
        .map(({ g, service }) => ({ key: `e:${g.id}`, icon: 'errors', title: g.title, sub: [short(service), g.context || g.culprit, `${g.count ?? 0}×`].filter(Boolean).join(' · '), tone: g.active ? 'orange' : null, at: g.lastSeen, r: rank(g.title, terms) + (g.active ? 1 : 0), open: { navigate: { to: 'errors', id: g.id } } })),
      { more: { navigate: { to: 'errors', q: terms.join(' ') }, label: 'Open in Errors' } },
    );
  }

  if (plain && want('crashes')) {
    add(
      'crashes',
      (d.crashes || [])
        .filter((c) => serviceOk(c.service, filters.service) && has(lower(c.service, c.pod, c.container, c.reason, c.message, c.exitCode != null ? `exit ${c.exitCode}` : '')))
        .map((c) => ({ key: `c:${c.id}`, icon: 'crashes', title: `${short(c.service)} · ${c.reason}${c.exitCode != null ? ` (exit ${c.exitCode})` : ''}`, sub: c.message ? snippet(c.message, terms) : c.pod, tone: 'red', at: c.at, r: 0, open: { navigate: { to: 'crashes', id: c.id } } })),
      { by: 'time', more: { navigate: { to: 'crashes' }, label: 'Open Crashes & Down' } },
    );
  }

  if (plain && want('events')) {
    add(
      'events',
      fold(
        (d.events || []).filter((e) => serviceOk(e.service || e.name, filters.service) && has(lower(e.reason, e.message, e.kind, e.name, e.service, e.type))),
        (e) => `${e.reason}\u0000${e.kind}\u0000${e.name}\u0000${e.message}`,
        (e) => e.at,
      ).map(({ x: e, n }) => ({ key: `ev:${e.id}`, icon: 'events', title: `${e.reason} · ${e.kind} ${short(e.name)}`, sub: `${n > 1 ? `${n} times · ` : ''}${snippet(e.message, terms)}`, tone: e.type === 'Warning' ? 'orange' : null, at: e.at, r: 0, open: { inspect: ['event', e.id, e] } })),
      { by: 'time', more: { navigate: { to: 'events', q: terms.join(' ') }, label: 'Open in Events' } },
    );
  }

  if (plain && want('pods')) {
    add(
      'pods',
      (d.pods || [])
        .filter((p) => serviceOk(p.service, filters.service) && has(lower(p.name, p.service, p.node, p.state, p.status, p.ip)))
        .map((p) => ({ key: `p:${p.name}`, icon: 'pod', title: p.name, sub: [p.status, p.node].filter(Boolean).join(' · '), podState: p.state, r: rank(p.name, terms), open: { inspect: ['pod', p.name] } })),
    );
  }

  if (plain && !filters.service && want('nodes')) {
    add(
      'nodes',
      (d.nodes || [])
        .filter((n) => has(lower(n.name, n.pool, n.zone, n.machineType, n.ready === false ? 'not ready' : 'ready')))
        .map((n) => ({ key: `n:${n.name}`, icon: 'infrastructure', title: n.name, sub: [n.machineType, n.zone, n.ready === false ? 'not ready' : null].filter(Boolean).join(' · '), tone: n.ready === false ? 'red' : null, r: rank(n.name, terms), open: { navigate: { to: 'infrastructure' } } })),
    );
  }

  if (plain && !filters.service && want('endpoints')) {
    add(
      'endpoints',
      (d.uptime || [])
        .filter((u) => has(lower(u.name, u.url, u.group, u.state, u.error, u.fromPages)))
        .map((u) => ({ key: `u:${u.id}`, icon: 'globe', title: u.name, sub: `${u.url}${u.state === 'down' ? ` · ${u.error || `HTTP ${u.status}`}` : ''}`, tone: u.state === 'down' ? 'red' : u.state === 'slow' ? 'orange' : null, r: rank(u.name, terms), open: { navigate: { to: u.group === 'frontend' ? 'frontends' : 'infrastructure' } } })),
    );
  }

  if (plain && !filters.service && want('pages')) {
    add(
      'pages',
      (d.pages || [])
        .filter((p) => has(lower(p.name, (p.domains || []).join(' '), p.latest?.branch, p.latest?.commit, p.latest?.message, p.latest?.status)))
        .map((p) => ({ key: `pg:${p.name}`, icon: 'rocket', title: p.name, sub: [(p.domains || [])[0], p.latest?.message].filter(Boolean).join(' · '), tone: p.latest?.status === 'failure' ? 'red' : null, at: p.latest?.createdAt, r: rank(p.name, terms), open: { navigate: { to: 'frontends' } } })),
    );
  }

  if (!onlyStatus && want('logs')) {
    const logs = d.logs || [];
    const found = [];
    // Newest first, and every line held in memory, not just what a page shows.
    for (let i = logs.length - 1; i >= 0; i--) {
      const l = logs[i];
      if (filters.level && String(l.level || '').toLowerCase() !== filters.level) continue;
      if (!serviceOk(l.service, filters.service)) continue;
      if (terms.length && !has(lower(l.text, l.service, l.pod, l.level))) continue;
      found.push(l);
    }
    const oldest = logs[0]?.ts;
    add(
      'logs',
      found.map((l) => ({ key: `l:${l.id}`, icon: 'logs', title: snippet(l.text, terms, 90), sub: short(l.service), tone: l.level === 'ERROR' ? 'red' : l.level === 'WARN' ? 'orange' : null, mono: true, at: l.ts, open: { inspect: ['log', l.id, l] } })),
      { by: 'time', note: oldest ? { since: oldest } : undefined, more: { navigate: { to: 'logs', q: terms.join(' '), ...(filters.service && { service: serviceName(d.services, filters.service) }), ...(filters.level && { level: filters.level.toUpperCase() }) }, label: 'Open in Logs' } },
    );
  }

  if (!onlyLevel && want('requests')) {
    const traffic = d.traffic || [];
    const found = [];
    for (let i = traffic.length - 1; i >= 0; i--) {
      const r = traffic[i];
      if (!statusOk(r.status, filters.status)) continue;
      if (!serviceOk(r.service, filters.service)) continue;
      if (terms.length && !has(lower(r.method, r.host, r.path, r.status, r.ip, r.ua, r.service, r.referer))) continue;
      found.push(r);
    }
    const oldest = traffic[0]?.ts;
    add(
      'requests',
      found.map((r) => ({ key: `r:${r.id}`, icon: 'traffic', title: `${r.method} ${r.host}${r.path}`, sub: [r.status || 'no response', short(r.service), r.latencyMs != null ? `${Math.round(r.latencyMs)} ms` : null, r.ip].filter(Boolean).join(' · '), tone: !r.status || r.status >= 500 ? 'red' : r.status >= 400 ? 'orange' : null, mono: true, at: r.ts, open: { inspect: ['request', r.id, r] } })),
      { by: 'time', note: oldest ? { since: oldest } : undefined, more: { navigate: { to: 'traffic', filter: { q: terms.join(' '), ...(/^\dxx$/.test(filters.status || '') && { status: filters.status }), ...(filters.service && { service: serviceName(d.services, filters.service) }) } }, label: 'Open in Live Traffic' } },
    );
  }

  return { terms, filters, groups };
}

/** The workload a service filter means ("brand" → "flobi-brand"), for the pages that filter by it. */
function serviceName(services = [], want) {
  const s = services.find((x) => serviceOk(x.name, want));
  return s ? s.name : want;
}
