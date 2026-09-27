// Gathers one platform's build output for the GitHub release (run by the Release
// workflow after electron-builder):
//   • the files installed apps update themselves from (see electron/updater.mjs)
//   • the "downloader" zip people download by hand: the installer plus a
//     READ ME FIRST.txt (and on Linux an install script and the icon)
// Usage: node scripts/package-downloader.mjs win|mac|linux   → everything lands in upload/
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const target = process.argv[2];
const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const PLATFORMS = {
  win: { updates: [`Flobi-Pulse-Setup-${version}.exe`], installer: `Flobi-Pulse-Setup-${version}.exe`, zip: 'Flobi-Pulse-Windows.zip', readme: 'windows.txt' },
  mac: { updates: [`Flobi-Pulse-${version}-mac.zip`, `Flobi-Pulse-${version}.dmg`], installer: `Flobi-Pulse-${version}.dmg`, zip: 'Flobi-Pulse-macOS.zip', readme: 'macos.txt' },
  linux: { updates: [`Flobi-Pulse-${version}.AppImage`], installer: `Flobi-Pulse-${version}.AppImage`, zip: 'Flobi-Pulse-Linux.zip', readme: 'linux.txt', extras: [['scripts/downloader/install.sh', 'install.sh'], ['build/icon.png', 'flobi-pulse.png']] },
};
const p = PLATFORMS[target];
if (!p) throw new Error(`Usage: node scripts/package-downloader.mjs ${Object.keys(PLATFORMS).join('|')}`);

const upload = path.resolve('upload');
const work = path.resolve('release', 'downloader');
const folder = path.join(work, 'Flobi Pulse Installer');
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(folder, { recursive: true });
fs.mkdirSync(upload, { recursive: true });

for (const name of p.updates) fs.copyFileSync(path.join('release', name), path.join(upload, name));

fs.copyFileSync(path.join('release', p.installer), path.join(folder, p.installer));
const readme = fs.readFileSync(path.join('scripts', 'downloader', p.readme), 'utf8').replaceAll('{version}', version);
fs.writeFileSync(path.join(folder, 'READ ME FIRST.txt'), target === 'win' ? readme.replace(/\r?\n/g, '\r\n') : readme);
for (const [from, to] of p.extras || []) fs.copyFileSync(from, path.join(folder, to));
if (target === 'linux') {
  fs.chmodSync(path.join(folder, p.installer), 0o755);
  fs.chmodSync(path.join(folder, 'install.sh'), 0o755);
}

const zip = path.join(upload, p.zip);
if (target === 'win') {
  execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${folder}' -DestinationPath '${zip}' -Force`], { stdio: 'inherit' });
} else {
  // zip keeps the executable bits, so install.sh and the AppImage run straight after unzipping.
  execFileSync('zip', ['-r', '-X', '-q', zip, path.basename(folder)], { cwd: work, stdio: 'inherit' });
}
console.log(`upload/ ← ${[...p.updates, p.zip].join(', ')}`);
