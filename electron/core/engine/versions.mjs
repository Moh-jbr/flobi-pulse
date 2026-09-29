// The Versions page: every repo in the release manifest (flobi-release/repos.json),
// its GitHub releases, and which releases are new. Pure functions plus a small
// poller; the GitHub client is passed in, so tests can fake it.
import { parseVersion } from '../update/release.mjs';

const MIN = 60_000;
/** Releases read per repo: enough history for the page, one request per repo. */
export const RELEASES_PER_REPO = 15;

/**
 * How big a step `tag` is from `prevTag`, the latest stable version before it:
 * 'major' | 'minor' | 'patch' | 'first' | 'other'. Only no previous version at all is 'first';
 * a step from a release candidate or a non-semver tag can't be told ('other').
 */
export function bump(prevTag, tag) {
  const a = parseVersion(prevTag);
  const b = parseVersion(tag);
  if (!b) return 'other';
  if (!a) return prevTag ? 'other' : 'first';
  if (b[0] !== a[0]) return 'major';
  if (b[1] !== a[1]) return 'minor';
  return 'patch';
}

/** What release notes say at a glance: the first sentence, the sections and the number of changes. */
export function notesSummary(body = '') {
  const text = String(body);
  const firstLine = text.split('\n').find((l) => l.trim() && !/^#{1,6}\s/.test(l)) || '';
  const first = firstLine
    .replace(/\s*·?\s*\[compare\]\([^)]*\)/i, '') // "1 change since v1.1.0 · [compare](…)"
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .trim();
  const sections = [...text.matchAll(/^#{2,4}\s+(.+?)\s*$/gm)].map((m) => m[1]);
  const changes = (text.match(/^\s*[-*]\s+\S/gm) || []).length;
  return { first, sections, changes, breaking: sections.some((s) => /breaking/i.test(s)) || /BREAKING CHANGE/.test(text) };
}

/** Manifest + releases → what the page shows. */
export function buildVersions(manifest, releasesByRepo = {}, errorsByRepo = {}) {
  const repos = Object.entries(manifest?.repos || {}).map(([name, m]) => {
    const list = (releasesByRepo[name] || []).slice().sort((x, y) => (y.publishedAt || 0) - (x.publishedAt || 0));
    // The oldest release is only known to be the repo's first when the whole history fits in one read.
    const complete = list.length < RELEASES_PER_REPO;
    const releases = list.map((r, i) => {
      const oldest = i === list.length - 1;
      // Steps are measured from the latest stable version before this one: release candidates
      // and other tags in between don't count. None in what was read: it's the first only if
      // the whole history was read.
      const prev = list.slice(i + 1).find((x) => parseVersion(x.tag));
      return {
        ...r,
        repo: name,
        product: m.product || name,
        audience: m.audience || 'user',
        bump: prev || complete ? bump(prev?.tag, r.tag) : 'other',
        // The rollout baseline ("Versioning starts here") marks where versioning began; it isn't a change.
        baseline: /^\s*Versioning starts here/i.test(r.body || '') || (oldest && complete),
        notes: notesSummary(r.body),
      };
    });
    return { name, product: m.product || name, audience: m.audience || 'user', live: m.live || null, skip: m.skip || null, releases, latest: releases[0] || null, error: errorsByRepo[name] || null };
  });
  const feed = repos.flatMap((r) => r.releases).sort((x, y) => (y.publishedAt || 0) - (x.publishedAt || 0));
  return { owner: manifest?.owner || null, repos, feed };
}

/** Releases published after `since` that haven't been announced yet. */
export function newReleases(feed, since, announced) {
  if (!since) return [];
  return feed.filter((r) => r.publishedAt > since && !announced.has(`${r.repo}@${r.tag}`));
}

export class VersionsWatcher {
  /**
   * @param {{ client: {manifest: Function, releases: Function}, manifestRepo: string, manifestPath: string,
   *   onChange: (state:object)=>void, onNew?: (releases:object[])=>void,
   *   saved?: {since?: number, announced?: string[]}, onSave?: (saved:object)=>void, now?: ()=>number,
   *   isOffline?: (o:{since:number})=>Promise<boolean> }} o
   * isOffline (net/connectivity.mjs): a look that got no answer while this computer is offline
   * changes nothing on the page (the next one, 5 minutes later, reads again).
   */
  constructor({ client, manifestRepo, manifestPath, onChange, onNew, saved = {}, onSave, now = () => Date.now(), isOffline = null }) {
    Object.assign(this, { client, manifestRepo, manifestPath, onChange, onNew, onSave, now, isOffline });
    this.since = saved.since || null; // releases before this were there when watching began: no notification
    this.announced = new Set(saved.announced || []);
    this.state = { status: 'loading', repos: [], feed: [], checkedAt: null, error: null };
  }

  start(pollMs = 5 * MIN) {
    this.poll();
    this.timer = setInterval(() => this.poll(), pollMs);
  }

  stop() {
    clearInterval(this.timer);
    this.stopped = true;
  }

  async poll() {
    if (this.running || this.stopped) return this.state;
    this.running = true;
    try {
      // After each wait: stopped meanwhile (signed out, switched to demo) means this poll
      // announces, shows and saves nothing.
      if (!this.manifest || this.now() - this.manifestAt > 30 * MIN) {
        const manifest = await this.client.manifest(this.manifestRepo, this.manifestPath);
        if (this.stopped) return this.state;
        this.manifest = manifest;
        this.manifestAt = this.now();
      }
      const names = Object.entries(this.manifest?.repos || {}).filter(([, m]) => !m.skip).map(([name]) => name);
      const releases = {};
      const errors = {};
      const failures = [];
      // A few at a time: quick, without a burst of 60+ requests.
      for (let i = 0; i < names.length; i += 6) {
        await Promise.all(
          names.slice(i, i + 6).map((name) =>
            this.client.releases(name, RELEASES_PER_REPO).then(
              (list) => (releases[name] = list),
              (e) => ((errors[name] = e.message), failures.push(e)),
            ),
          ),
        );
        if (this.stopped) return this.state;
      }
      // Some got no answer because this computer is offline: what's shown stays as it was.
      if (await this.offline(failures)) return this.state;
      const built = buildVersions(this.manifest, releases, errors);
      if (!this.since) this.since = this.now(); // first successful look: everything so far is the baseline
      const fresh = newReleases(built.feed, this.since, this.announced);
      for (const r of fresh) this.announced.add(`${r.repo}@${r.tag}`);
      if (this.announced.size > 1000) this.announced = new Set([...this.announced].slice(-1000));
      this.state = { status: 'ok', ...built, checkedAt: this.now(), error: null };
      this.onChange(this.state);
      if (fresh.length) this.onNew?.(fresh);
      this.onSave?.({ since: this.since, announced: [...this.announced] });
    } catch (e) {
      if (this.stopped || (await this.offline([e])) || this.stopped) return this.state;
      this.state = { ...this.state, status: 'error', error: e.message, checkedAt: this.now() };
      this.onChange(this.state);
    } finally {
      this.running = false;
    }
    return this.state;
  }

  /** Some reads failed: did any get no answer at all while this computer is offline? */
  async offline(failures) {
    if (!this.isOffline || !failures.some((e) => e?.status == null)) return false;
    try {
      return !!(await this.isOffline({ since: Date.now() }));
    } catch {
      return false;
    }
  }
}
