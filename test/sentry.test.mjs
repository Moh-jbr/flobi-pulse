// Sentry errors end up on screen (Settings, the Errors page): never with the token (C17).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SentryClient, explainSentryError } from '../electron/core/sources/sentry.mjs';
import { HttpError } from '../electron/core/net/http.mjs';

const TOKEN = 'sntryu_0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab';

test('Sentry error messages never contain the token', async () => {
  const client = new SentryClient({
    org: 'flobi',
    token: TOKEN,
    request: async ({ headers }) => {
      assert.equal(headers.authorization, `Bearer ${TOKEN}`);
      throw new HttpError(502, `HTTP 502 – upstream rejected ${TOKEN} (Authorization: Bearer ${TOKEN})`, '');
    },
  });
  await assert.rejects(client.issues(), (e) => e.status === 502 && !e.message.includes(TOKEN) && /upstream rejected \[redacted\]/.test(e.message));
  const shown = await client.verify().catch((e) => explainSentryError(e, 'flobi'));
  assert.ok(!shown.includes(TOKEN), shown);
});

test('Sentry answers still come through', async () => {
  const client = new SentryClient({ org: 'flobi', token: TOKEN, request: async ({ url }) => (url.endsWith('/projects/?all_projects=1') ? [{ id: '1', slug: 'web', name: 'Web', platform: 'javascript-react' }] : null) });
  assert.deepEqual(await client.projects(), [{ id: '1', slug: 'web', name: 'Web', platform: 'javascript-react' }]);
});
