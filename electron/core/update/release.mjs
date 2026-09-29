// Reading a GitHub release for app updates. Plain functions (no Electron, no Node
// APIs: engine/versions.mjs imports parseVersion from here and runs in the browser
// preview too), so they're covered by tests. The file names are set in package.json → build.

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Temp folders downloads go to: `${os.tmpdir()}/flobi-pulse-update-XXXXXX`. */
export const UPDATE_DIR_PREFIX = 'flobi-pulse-update-';

/** "v1.2.3" or "1.2.3" → [1, 2, 3]; null for anything else (pre-releases are never offered). */
export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? '').trim());
  return m ? m.slice(1).map(Number) : null;
}

/** True when `latest` is a higher version than `current`. */
export function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** The release file each platform updates itself from. */
export const UPDATE_ASSET = {
  win32: /^Flobi-Pulse-Setup-\d+\.\d+\.\d+\.exe$/,
  darwin: /^Flobi-Pulse-\d+\.\d+\.\d+-mac\.zip$/,
  linux: /^Flobi-Pulse-\d+\.\d+\.\d+\.AppImage$/,
};

export function pickAsset(release, platform) {
  const re = UPDATE_ASSET[platform];
  return (re && (release?.assets || []).find((a) => re.test(a.name))) || null;
}

/** `sha256sum` output ("<hex>  <name>" per line) → Map(name → hex). */
export function parseSums(text) {
  const out = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m) out.set(m[2].trim(), m[1].toLowerCase());
  }
  return out;
}

/** The SHA-256 GitHub reports for an asset ("sha256:<hex>"), if it has one. */
export function assetDigest(asset) {
  const m = /^sha256:([a-f0-9]{64})$/i.exec(String(asset?.digest || ''));
  return m ? m[1].toLowerCase() : null;
}

/** GitHub turned the check away for its rate limit (403 or 429 with the limit's headers). */
export function isRateLimited(e) {
  const h = e?.headers || {};
  return (e?.status === 403 || e?.status === 429) && (h['x-ratelimit-remaining'] === '0' || h['retry-after'] !== undefined || e.status === 429);
}

/**
 * How long to wait before checking for updates again after check number
 * `failures + 1` failed. Unauthenticated checks get 60 an hour per IP address,
 * shared by everyone behind an office NAT, so a rate-limited check waits for
 * GitHub's own reset (Retry-After or X-RateLimit-Reset, kept between 2 min and
 * 1 h); anything else backs off 2, 4, 8… up to 60 min.
 */
export function checkRetryDelay(e, failures = 0, now = Date.now()) {
  if (e?.status === 403 || e?.status === 429) {
    const h = e.headers || {};
    const after = h['retry-after'];
    let at = null;
    if (after !== undefined && /^\d+$/.test(String(after).trim())) at = now + Number(after) * 1000;
    else if (after !== undefined && Number.isFinite(Date.parse(after))) at = Date.parse(after);
    else if (/^\d+$/.test(String(h['x-ratelimit-reset'] ?? ''))) at = Number(h['x-ratelimit-reset']) * 1000;
    if (at !== null) return Math.min(HOUR, Math.max(2 * MIN, at - now));
  }
  return Math.min(HOUR, 2 * MIN * 2 ** Math.max(0, failures));
}
