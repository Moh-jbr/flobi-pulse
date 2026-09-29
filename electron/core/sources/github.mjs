// GitHub releases of the team's repos (the Versions page). Read-only: the list of
// repos from the release manifest (flobi-release/repos.json) and each repo's
// releases. Every answer is cached with its ETag, so an unchanged answer comes back
// as "304 Not Modified", which GitHub doesn't count against the rate limit.
import { request, HttpError, errorMessage, redact } from '../net/http.mjs';

const API = 'https://api.github.com';

const isObject = (x) => !!x && typeof x === 'object' && !Array.isArray(x);

export class GitHubClient {
  /** @param {{ token: string, owner: string, request?: Function }} o `request` is only replaced by tests. */
  constructor({ token, owner, request: send = request }) {
    this.token = String(token || '').trim();
    this.owner = owner;
    this.send = send;
    this.cache = new Map(); // url → { etag, data }
  }

  get configured() {
    return !!(this.token && this.owner);
  }

  /** @param {string} moved what to say when GitHub answers with a redirect (the repo moved) */
  async _get(path, moved) {
    const url = `${API}${path}`;
    const hit = this.cache.get(url);
    let res;
    try {
      res = await this.send({
        url,
        headers: { authorization: `Bearer ${this.token}`, accept: 'application/vnd.github+json', ...(hit?.etag ? { 'if-none-match': hit.etag } : {}) },
        timeoutMs: 20_000,
      });
    } catch (e) {
      if (e && typeof e.message === 'string') e.message = redact(e.message, this.token);
      throw e;
    }
    if (res.status === 304 && hit) return hit.data;
    const text = res.body.toString('utf8');
    if (res.status >= 400) throw new HttpError(res.status, redact(explain(res.status, text, res.headers, this.owner), this.token), text);
    // A renamed or moved repo answers 301 with a small JSON body of its own; parsed as
    // data, it surfaced as "list.filter is not a function".
    if (res.status >= 300) throw new HttpError(res.status, res.status === 304 ? 'GitHub said “not modified” to a fresh request. Try again.' : moved, text);
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new HttpError(res.status, 'GitHub sent an answer that isn’t JSON. Try again later.', text);
    }
    if (res.headers.etag) this.cache.set(url, { etag: res.headers.etag, data });
    return data;
  }

  /** The release manifest: { owner, repos: { name: { live, product, audience, skip? } } }. */
  async manifest(repo, path) {
    const file = await this._get(
      `/repos/${this.owner}/${repo}/contents/${path}`,
      `GitHub says the release manifest’s repository (${this.owner}/${repo}) moved or was renamed. Update versions.manifest in the team config.`,
    );
    if (Array.isArray(file)) throw new Error(`The release manifest (${repo}/${path}) is a folder on GitHub, not a file.`);
    if (!isObject(file) || typeof file.content !== 'string') throw new Error(`GitHub didn’t send the contents of the release manifest (${repo}/${path}).`);
    let manifest;
    try {
      manifest = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
    } catch (e) {
      throw new Error(`The release manifest (${repo}/${path}) isn’t valid JSON: ${e.message}`);
    }
    if (!isObject(manifest) || (manifest.repos !== undefined && !isObject(manifest.repos))) {
      throw new Error(`The release manifest (${repo}/${path}) should be a JSON object with a “repos” object in it.`);
    }
    return manifest;
  }

  /** Newest releases of one repo (drafts are never returned to read-only tokens). */
  async releases(repo, perPage = 15) {
    const list = await this._get(
      `/repos/${this.owner}/${repo}/releases?per_page=${perPage}`,
      `GitHub says ${this.owner}/${repo} moved or was renamed. Fix its name in the release manifest (flobi-release/repos.json).`,
    );
    if (!Array.isArray(list)) throw new Error(`GitHub didn’t send a list of releases for ${this.owner}/${repo}.`);
    return list
      .filter((r) => isObject(r) && !r.draft)
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
