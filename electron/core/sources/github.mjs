// GitHub releases of the team's repos (the Versions page). Read-only: the list of
// repos from the release manifest (flobi-release/repos.json) and each repo's
// releases. Every answer is cached with its ETag, so an unchanged answer comes back
// as "304 Not Modified", which GitHub doesn't count against the rate limit.
import { request, HttpError, errorMessage } from '../net/http.mjs';

const API = 'https://api.github.com';

export class GitHubClient {
  /** @param {{ token: string, owner: string }} o */
  constructor({ token, owner }) {
    this.token = String(token || '').trim();
    this.owner = owner;
    this.cache = new Map(); // url → { etag, data }
  }

  get configured() {
    return !!(this.token && this.owner);
  }

  async _get(path) {
    const url = `${API}${path}`;
    const hit = this.cache.get(url);
    const res = await request({
      url,
      headers: { authorization: `Bearer ${this.token}`, accept: 'application/vnd.github+json', ...(hit?.etag ? { 'if-none-match': hit.etag } : {}) },
      timeoutMs: 20_000,
    });
    if (res.status === 304 && hit) return hit.data;
    const text = res.body.toString('utf8');
    if (res.status >= 400) throw new HttpError(res.status, explain(res.status, text, res.headers, this.owner), text);
    const data = text ? JSON.parse(text) : null;
    if (res.headers.etag) this.cache.set(url, { etag: res.headers.etag, data });
    return data;
  }

  /** The release manifest: { owner, repos: { name: { live, product, audience, skip? } } }. */
  async manifest(repo, path) {
    const file = await this._get(`/repos/${this.owner}/${repo}/contents/${path}`);
    return JSON.parse(Buffer.from(file.content || '', 'base64').toString('utf8'));
  }

  /** Newest releases of one repo (drafts are never returned to read-only tokens). */
  async releases(repo, perPage = 15) {
    const list = await this._get(`/repos/${this.owner}/${repo}/releases?per_page=${perPage}`);
    return (list || [])
      .filter((r) => !r.draft)
      .map((r) => ({
        id: r.id,
        tag: r.tag_name,
        name: r.name || r.tag_name,
        body: String(r.body || '').slice(0, 20_000),
        url: r.html_url,
        prerelease: !!r.prerelease,
        publishedAt: Date.parse(r.published_at || r.created_at) || null,
        author: r.author?.login?.replace(/\[bot\]$/, ' (bot)') || null,
      }));
  }
}

function explain(status, text, headers, owner) {
  if (status === 401) return 'GitHub rejected the token (expired or revoked). Create a new one in Settings → Integrations → GitHub.';
  if (status === 403 && headers?.['x-ratelimit-remaining'] === '0') return 'GitHub’s hourly limit for this token is used up; it resets within the hour.';
  if (status === 403) return `The token can’t read these repositories. It needs Contents: Read-only on the ${owner} repositories, and an organization owner may need to approve it.`;
  if (status === 404) return 'GitHub says this repository doesn’t exist, or the token can’t see it.';
  return errorMessage(status, text);
}
