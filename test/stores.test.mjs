import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStore, SecureStore, writeJsonAtomic, shallowMerge } from '../electron/core/stores.mjs';

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pulse-stores-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const tmpFiles = async (dir) => (await fs.readdir(dir)).filter((n) => n.endsWith('.tmp'));
const readFile = async (file) => JSON.parse(await fs.readFile(file, 'utf8'));

test('settings store: updates deep-merge into the saved groups', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'settings.json');
  const defaults = { notifications: { sound: true, volume: 0.8 }, overrides: { sentry: null } };
  const s = new JsonStore(file, defaults);
  await s.load();
  await s.update({ notifications: { sound: false } });
  await s.update({ overrides: { sentry: { host: 'sentry.io' } } });
  assert.deepEqual(s.get(), { notifications: { sound: false, volume: 0.8 }, overrides: { sentry: { host: 'sentry.io' } } });
  // A setting added in a later version gets its default next to the saved ones.
  const again = new JsonStore(file, { ...defaults, general: { keepRunningInTray: true } });
  await again.load();
  assert.deepEqual(again.get(), { notifications: { sound: false, volume: 0.8 }, overrides: { sentry: { host: 'sentry.io' } }, general: { keepRunningInTray: true } });
  assert.deepEqual(defaults.notifications, { sound: true, volume: 0.8 }, 'defaults stay untouched');
});

test('state store: updates replace whole top-level keys, so saved maps can shrink', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'state.json');
  const s = new JsonStore(file, { lastSeenAt: null }, { shallow: true });
  await s.load();
  await s.update({ lastSeenAt: 1, knownErrorsV2: { a: 1, b: 2 }, restartSnapshot: { at: 1, pods: { 'x-1': { restarts: 0 }, 'y-1': { restarts: 2 } } } });
  // A heartbeat saves the maps as they are now: keys that are gone must go.
  await s.update({ lastSeenAt: 2, knownErrorsV2: { c: 3 }, restartSnapshot: { at: 2, pods: { 'y-2': { restarts: 0 } } } });
  await s.update({ alertHistory: [{ id: 'a@1' }] });
  const want = { lastSeenAt: 2, knownErrorsV2: { c: 3 }, restartSnapshot: { at: 2, pods: { 'y-2': { restarts: 0 } } }, alertHistory: [{ id: 'a@1' }] };
  assert.deepEqual(s.get(), want);
  assert.deepEqual(await readFile(file), want);
  // undefined removes a key, from memory and from the file.
  await s.update({ alertHistory: undefined });
  assert.equal('alertHistory' in s.get(), false);
  assert.equal('alertHistory' in (await readFile(file)), false);
  // Reloading gives back exactly what was saved (plus defaults for missing keys).
  const again = new JsonStore(file, { lastSeenAt: null, versionsViewedAt: 0 }, { shallow: true });
  await again.load();
  assert.deepEqual(again.get(), { lastSeenAt: 2, versionsViewedAt: 0, knownErrorsV2: { c: 3 }, restartSnapshot: { at: 2, pods: { 'y-2': { restarts: 0 } } } });
});

test('state store: the file stays the same size when the same state is saved every minute', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'state.json');
  const s = new JsonStore(file, { lastSeenAt: null }, { shallow: true });
  await s.load();
  const sizes = [];
  for (let minute = 0; minute < 5; minute++) {
    // Pods come and go between heartbeats; only the current ones are saved.
    const pods = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`svc-${minute}-${i}`, { restarts: 0 }]));
    await s.update({ lastSeenAt: 1_000_000 + minute, restartSnapshot: { at: minute, pods } });
    sizes.push((await fs.stat(file)).size);
  }
  assert.equal(new Set(sizes).size, 1, `sizes: ${sizes.join(', ')}`);
});

test('shallowMerge: replaces, keeps the rest, drops undefined', () => {
  const base = { a: { x: 1, y: 2 }, b: 1, c: [1] };
  assert.deepEqual(shallowMerge(base, { a: { x: 3 }, c: undefined }), { a: { x: 3 }, b: 1 });
  assert.deepEqual(base, { a: { x: 1, y: 2 }, b: 1, c: [1] }, 'the base is not changed');
  assert.deepEqual(shallowMerge(base, null), base);
});

test('atomic write: the file is replaced whole and no temp file is left, even when it fails', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'state.json');
  await writeJsonAtomic(file, { a: 1 });
  await writeJsonAtomic(file, { b: 2 });
  assert.deepEqual(await readFile(file), { b: 2 });
  assert.deepEqual(await tmpFiles(dir), []);

  // The rename fails (a folder is in the way): the temp file is cleaned up.
  const blocked = path.join(dir, 'blocked.json');
  await fs.mkdir(blocked);
  await assert.rejects(writeJsonAtomic(blocked, { c: 3 }));
  assert.deepEqual(await tmpFiles(dir), []);

  // Stores log a failed write and keep going; still no temp file.
  const warn = t.mock.method(console, 'warn', () => {});
  const s = new JsonStore(blocked, {}, { shallow: true });
  await s.update({ c: 3 });
  assert.equal(warn.mock.callCount(), 1);
  assert.deepEqual(s.get(), { c: 3 });
  assert.deepEqual(await tmpFiles(dir), []);
  // …and the next write goes through once the way is clear.
  await fs.rmdir(blocked);
  await s.update({ d: 4 });
  assert.deepEqual(await readFile(blocked), { c: 3, d: 4 });
});

test('writes land in the order they were made', async (t) => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'state.json');
  const s = new JsonStore(file, {}, { shallow: true });
  await Promise.all(Array.from({ length: 25 }, (_, i) => s.update({ lastSeenAt: i })));
  assert.deepEqual(await readFile(file), { lastSeenAt: 24 });
  assert.deepEqual(await tmpFiles(dir), []);
});

test('a corrupt or non-object file falls back to the defaults', async (t) => {
  const dir = await tempDir(t);
  const warn = t.mock.method(console, 'warn', () => {});
  const cases = ['{"lastSeenAt": 12', '', 'null', '[1, 2]', '"text"', '42'];
  for (const [i, text] of cases.entries()) {
    const file = path.join(dir, `state-${i}.json`);
    await fs.writeFile(file, text);
    for (const shallow of [true, false]) {
      const s = new JsonStore(file, { lastSeenAt: null, general: { tray: true } }, { shallow });
      await s.load();
      assert.deepEqual(s.get(), { lastSeenAt: null, general: { tray: true } }, `${JSON.stringify(text)} (shallow: ${shallow})`);
    }
  }
  assert.equal(warn.mock.callCount(), cases.length * 2);
  // A missing file is normal (first run): defaults, and no warning.
  const fresh = new JsonStore(path.join(dir, 'missing.json'), { lastSeenAt: null }, { shallow: true });
  await fresh.load();
  assert.deepEqual(fresh.get(), { lastSeenAt: null });
  assert.equal(warn.mock.callCount(), cases.length * 2);
  // The next save replaces the broken file with a good one.
  const file = path.join(dir, 'state-0.json');
  const s = new JsonStore(file, { lastSeenAt: null }, { shallow: true });
  await s.load();
  await s.update({ lastSeenAt: 5 });
  assert.deepEqual(await readFile(file), { lastSeenAt: 5 });
});

test('secrets: saved in order, readable again, private to the user, no temp files', async (t) => {
  const dir = await tempDir(t);
  const safeStorage = { isEncryptionAvailable: () => false };
  const s = new SecureStore({ dir, safeStorage });
  await s.load();
  // Two saves at once (e.g. two settings saved together): both must survive.
  await Promise.all([s.set('sentryToken', 'a'), s.set('githubToken', 'b')]);
  await s.clear(['sentryToken']);
  const again = new SecureStore({ dir, safeStorage });
  await again.load();
  assert.deepEqual(again.data, { githubToken: 'b' });
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(dir, 'secrets.bin'))).mode & 0o777, 0o600);
  assert.deepEqual(await tmpFiles(dir), []);
});

test('secrets: a failed save fails for its caller, and the next one still works', async (t) => {
  const dir = await tempDir(t);
  await fs.mkdir(path.join(dir, 'secrets.bin')); // a folder in the way
  const s = new SecureStore({ dir, safeStorage: { isEncryptionAvailable: () => false } });
  await assert.rejects(s.set('githubToken', 'x'));
  assert.deepEqual(await tmpFiles(dir), []);
  await fs.rmdir(path.join(dir, 'secrets.bin'));
  await s.set('githubToken', 'y');
  const again = new SecureStore({ dir, safeStorage: { isEncryptionAvailable: () => false } });
  await again.load();
  assert.deepEqual(again.data, { githubToken: 'y' });
});
