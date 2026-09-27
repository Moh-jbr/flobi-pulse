// Reading a GitHub release for app updates. Plain functions (no Electron), so
// they're covered by tests. The file names are set in package.json → build.

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
