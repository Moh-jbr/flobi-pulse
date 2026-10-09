import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseChangelog, changelogFor, releaseChangelog } from '../src/lib/changelog.js';

const text = fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('the version being built has its own entry in CHANGELOG.md', () => {
  const entries = parseChangelog(text);
  assert.ok(entries.some((e) => e.version === pkg.version && e.items.length), `CHANGELOG.md has no "## ${pkg.version} · <date>" entry: release with npm version, which renames "Unreleased"`);
});

test('every released entry has a date and something in it', () => {
  for (const e of parseChangelog(text).filter((x) => !x.unreleased)) {
    assert.match(e.date || '', /^\d{4}-\d{2}-\d{2}$/, `${e.version} has no date`);
    assert.ok(e.items.length, `${e.version} is empty`);
  }
});

test('entries are read newest first, with their items', () => {
  const entries = parseChangelog('# Title\n\nintro\n\n## Unreleased\n\n- a\n- b\n  continued\n\n## 1.0.0 · 2026-09-27\r\n- c\r\n');
  assert.deepEqual(entries, [
    { version: 'Unreleased', date: null, unreleased: true, items: ['a', 'b continued'] },
    { version: '1.0.0', date: '2026-09-27', unreleased: false, items: ['c'] },
  ]);
});

test('an installed copy never shows Unreleased', () => {
  const entries = parseChangelog('## Unreleased\n- next\n## 1.0.0 · 2026-09-27\n- c\n## 0.9.0 · 2026-09-01\n');
  assert.deepEqual(changelogFor(entries, { showUnreleased: false }).map((e) => e.version), ['1.0.0']);
  assert.deepEqual(changelogFor(entries, { showUnreleased: true }).map((e) => e.version), ['Unreleased', '1.0.0']);
});

test('releasing turns Unreleased into the new version, in place', () => {
  const before = '# What\'s new\n\n## Unreleased\n\n- next\n\n## 1.0.0 · 2026-09-27\n- c\n';
  const after = releaseChangelog(before, '1.1.0', '2026-10-10');
  assert.equal(after, '# What\'s new\n\n## 1.1.0 · 2026-10-10\n\n- next\n\n## 1.0.0 · 2026-09-27\n- c\n');
  assert.equal(releaseChangelog(after, '1.1.0', '2026-10-11'), after, 'already released: left alone');
  assert.throws(() => releaseChangelog(after, '1.2.0', '2026-10-12'), /no "## Unreleased"/);
});

test('an empty Unreleased stops the release before anything is tagged', () => {
  assert.throws(() => releaseChangelog('## Unreleased\n\n## 1.0.0 · 2026-09-27\n- c\n', '1.0.1', '2026-10-10'), /is empty/);
});

test('a Windows checkout (CRLF) keeps its line endings when released', () => {
  assert.equal(releaseChangelog('## Unreleased\r\n- a\r\n', '2.0.0', '2026-10-10'), '## 2.0.0 · 2026-10-10\r\n- a\r\n');
});
