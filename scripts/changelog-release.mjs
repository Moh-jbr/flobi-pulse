// npm version runs this after the bump and before the version commit (package.json "version"):
// CHANGELOG.md's "## Unreleased" becomes the new version and today's date, in the same commit.
import fs from 'node:fs';
import { releaseChangelog } from '../src/lib/changelog.js';

const file = new URL('../CHANGELOG.md', import.meta.url);
const version = process.env.npm_package_version || JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const text = fs.readFileSync(file, 'utf8');
const today = new Date();
const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
try {
  fs.writeFileSync(file, releaseChangelog(text, version, date));
  console.log(`CHANGELOG.md: released as ${version} · ${date}`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
