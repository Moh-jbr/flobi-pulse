// Sentry (read-only): frontend issues from the React apps.
// Token needs only read scopes: org:read, project:read, event:read.
import { json } from '../net/http.mjs';
import { configureGuard } from '../net/guard.mjs';

export const SENTRY_SAAS_HOSTS = ['sentry.io', 'de.sentry.io', 'us.sentry.io'];

/** Cleans up what people paste ("Bearer …", quotes, spaces). */
export function cleanSentryToken(token) {
  return String(token || '')
    .trim()
    .replace(/^bearer\s+/i, '')
    .replace(/^["']|["']$/g, '')
    .trim();
}

/** Catches the usual wrong things to paste, before asking Sentry. */
export function sentryTokenProblem(token) {
  const t = cleanSentryToken(token);
  if (/^https?:\/\/[^@\s]+@[^/\s]*sentry/i.test(t)) return "That's a DSN (the address the apps send errors to), not an API token. Create a token under Settings → Developer Settings → Custom Integrations in Sentry.";
  if (/^sntrys_/.test(t)) return 'That\'s an Organization Auth Token (starts with sntrys_). Sentry only lets those upload source maps, not read issues. Use an Internal Integration token or a Personal Token (starts with sntryu_) instead.';
  if (/\s/.test(t)) return 'The token has spaces or line breaks in it. Copy it again as one piece.';
  if (t.length < 32) return 'That token looks too short. Copy the whole token.';
  return null;
}

/** Turns Sentry API errors into what to do about them. */
export function explainSentryError(e, org) {
  if (e?.status === 401)
    return "Sentry didn't recognize this token. Copy the Token from your integration (Settings → Developer Settings → Custom Integrations → Flobi Pulse → Tokens), not the Client Secret. A Personal Token (starts with sntryu_) works too. The token may also have been revoked.";
  if (e?.status === 403) return `The token works but isn't allowed to read ${org ? `“${org}”` : 'this organization'}. Give it Organization: Read, Project: Read and Issue & Event: Read.`;
  if (e?.status === 404) return `Sentry has no organization called “${org}”. Use the slug from your Sentry address: https://<slug>.sentry.io.`;
  return e?.message || String(e);
}

export class SentryClient {
  constructor({ host = 'sentry.io', org, token }) {
    this.host = String(host || 'sentry.io').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    this.org = org;
    this.token = cleanSentryToken(token);
    if (org && !/^[A-Za-z0-9_-]+$/.test(org)) throw new Error('The Sentry organization slug can only contain letters, numbers, - and _.');
    configureGuard({ sentryHost: this.host });
  }

  get configured() {
    return !!(this.org && this.token);
  }

  _get(path) {
    return json({
      url: `https://${this.host}/api/0${path}`,
      headers: { authorization: `Bearer ${this.token}` },
      timeoutMs: 30_000,
    });
  }

  async verify() {
    const org = await this._get(`/organizations/${encodeURIComponent(this.org)}/`);
    return { name: org?.name, slug: org?.slug };
  }

  async projects() {
    const list = await this._get(`/organizations/${encodeURIComponent(this.org)}/projects/?all_projects=1`);
    return (list || []).map((p) => ({ id: p.id, slug: p.slug, name: p.name, platform: p.platform }));
  }

  /** Unresolved issues seen in the last 24h, most recent first. */
  async issues({ query = 'is:unresolved', statsPeriod = '24h', limit = 100 } = {}) {
    // project=-1 → all projects the token can see (otherwise Sentry uses "My Projects").
    const q = new URLSearchParams({ project: '-1', query, statsPeriod, sort: 'date', limit: String(limit) });
    const list = await this._get(`/organizations/${encodeURIComponent(this.org)}/issues/?${q}`);
    return (list || []).map(normalizeIssue);
  }

  /** Issues first seen after a timestamp (used by the recap). */
  async issuesSince(sinceMs) {
    const since = new Date(sinceMs).toISOString().replace(/\.\d{3}Z$/, '');
    return this.issues({ query: `firstSeen:>${since}`, statsPeriod: '14d', limit: 100 });
  }
}

export function normalizeIssue(i) {
  const stats = i.stats?.['24h'] || i.stats?.['14d'] || [];
  return {
    id: String(i.id),
    shortId: i.shortId,
    title: i.title || i.metadata?.value || 'Error',
    culprit: i.culprit || '',
    level: i.level || 'error',
    status: i.status,
    substatus: i.substatus || null, // new | regressed | escalating | ongoing
    count: Number(i.count || 0),
    users: Number(i.userCount || 0),
    firstSeen: Date.parse(i.firstSeen),
    lastSeen: Date.parse(i.lastSeen),
    link: i.permalink,
    project: i.project?.slug || i.project?.name || 'unknown',
    platform: i.project?.platform || i.platform,
    unhandled: !!i.isUnhandled,
    type: i.metadata?.type || '',
    spark: stats.map(([, c]) => Number(c) || 0),
  };
}
