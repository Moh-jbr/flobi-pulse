import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appName, appOf, refererHost } from '../src/lib/apps.js';

test('a request names the Flobi app whose page made it', () => {
  assert.equal(appName('https://docs.flobi.ai/'), 'Notes');
  assert.equal(appName('https://notes.flobi.ai/p/123?x=1'), 'Notes');
  assert.equal(appName('https://app.flobi.ai/'), 'Home');
  assert.equal(appName('https://canvas.flobi.ai/'), 'Flow');
  assert.equal(appName('https://handoff.zip/t/abc'), 'Handoff');
  assert.equal(appName('https://MOOD.flobi.ai/'), 'Moodboard');
});

test('published pages, previews and local builds are named for what they are', () => {
  assert.equal(appName('https://acme.docs.flobi.ai/'), 'Published notes');
  assert.equal(appName('https://tarek.flobi.ai/launch'), 'Published site');
  assert.equal(appName('https://3f2a1c.flobi-notes.pages.dev/'), 'Preview · flobi-notes');
  assert.equal(appName('http://localhost:5173/'), 'Local dev');
});

test('the Drive and Handoff phone apps are named, not taken for a local build', () => {
  const android = 'Mozilla/5.0 (Linux; Android 15; Pixel 9; wv) AppleWebKit/537.36 Chrome/139.0 Mobile Safari/537.36';
  assert.equal(appName('https://localhost/', android), 'Phone app');
  assert.equal(appName('capacitor://localhost/', 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X)'), 'Phone app');
  assert.equal(appName('https://localhost:5173/', 'Mozilla/5.0 (Macintosh) Chrome/139.0'), 'Local dev');
  assert.equal(appOf({ referer: 'https://localhost/', ua: android }), 'Phone app');
});

test('Flobi’s own service hosts are not called published sites', () => {
  assert.equal(appName('https://api.flobi.ai/docs'), 'api.flobi.ai');
  assert.equal(appName('https://storage.flobi.ai/x.png'), 'storage.flobi.ai');
  assert.equal(appName('https://a.b.flobi.ai/'), 'a.b.flobi.ai');
});

test('any other site is shown by its host, and no Referer means no app', () => {
  assert.equal(appName('https://www.google.com/'), 'www.google.com');
  assert.equal(appName(''), null);
  assert.equal(appName(undefined), null);
  assert.equal(appName('not a url'), null);
  assert.equal(refererHost('android-app://com.flobi.drive/'), null);
});

test('appOf reads a request’s Referer', () => {
  assert.equal(appOf({ referer: 'https://drive.flobi.ai/' }), 'Drive');
  assert.equal(appOf({ referer: '' }), null);
  assert.equal(appOf(null), null);
});
