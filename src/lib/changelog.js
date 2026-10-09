// CHANGELOG.md, read for Settings → What's new: one entry per "## <version> · <date>" heading,
// with its "- " lines as items. "## Unreleased" is what is not out yet.

/** The entries, newest first: { version, date, unreleased, items }. */
export function parseChangelog(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      const [version, date] = h[1].split(/\s+·\s+/);
      cur = { version: version.trim(), date: date?.trim() || null, unreleased: /^unreleased$/i.test(version.trim()), items: [] };
      out.push(cur);
    } else if (cur && /^\s*-\s+/.test(line)) cur.items.push(line.replace(/^\s*-\s+/, ''));
    else if (cur && cur.items.length && /^\s{2,}\S/.test(line)) cur.items[cur.items.length - 1] += ` ${line.trim()}`;
  }
  return out;
}

/**
 * What a copy of the app shows: everything released up to its own version, and "Unreleased"
 * only when it runs from source (an installed copy never has the next version's notes).
 */
export function changelogFor(entries, { showUnreleased }) {
  return entries.filter((e) => e.items.length && (!e.unreleased || showUnreleased));
}

/**
 * CHANGELOG.md at release: "## Unreleased" becomes "## <version> · <date>". Run by npm's
 * `version` script, after the bump and before the version commit. Throws when there's nothing
 * to release under (no Unreleased and no entry for this version yet).
 */
export function releaseChangelog(text, version, date) {
  const heading = /^##[ \t]+Unreleased[ \t]*(?=\r?$)/im;
  if (heading.test(text)) {
    if (!parseChangelog(text).find((e) => e.unreleased)?.items.length) throw new Error(`CHANGELOG.md's "## Unreleased" is empty: add what changed in ${version} first.`);
    return text.replace(heading, `## ${version} · ${date}`);
  }
  if (parseChangelog(text).some((e) => e.version === version)) return text;
  throw new Error(`CHANGELOG.md has no "## Unreleased" section to release as ${version}: add what changed first.`);
}
