// The Versions page's GitHub client (C11): redirects (a renamed repo) and wrong
// shapes are clear errors, not "list.filter is not a function"; no token in messages (C17).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient } from '../electron/core/sources/github.mjs';
import { configureGuard, checkRequest } from '../electron/core/net/guard.mjs';

const TOKEN = 'github_pat_11ABCDEFG0123456789abcdef';
configureGuard({ github: { owner: '4ow4-Developers', manifestRepo: 'flobi-release', manifestPath: 'repos.json' } });

/** A fake GitHub: answer(path, headers) → { status, body, headers }. Every request passes the real guard. */
function fakeGitHub(answer) {
  const seen = [];
  const request = async ({ url, headers }) => {
    checkRequest({ url, headers });
    const path = url.replace('https://api.github.com', '');
    seen.push({ path, headers });
    const { status = 200, body = '', headers: h = {} } = answer(path, headers, seen.length);
    return { status, headers: h, body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) };
  };
  return { seen, client: new GitHubClient({ token: TOKEN, owner: '4ow4-Developers', request }) };
}

const manifestFile = (obj) => ({ type: 'file', encoding: 'base64', content: Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj)).toString('base64') });

test('a renamed repo (301) is a clear error that says where to fix it', async () => {
  const moved = { message: 'Moved Permanently', url: 'https://api.github.com/repositories/123/releases', documentation_url: 'https://docs.github.com/rest' };
  const { client } = fakeGitHub(() => ({ status: 301, body: moved, headers: { location: 'https://api.github.com/repositories/123/releases' } }));
  await assert.rejects(client.releases('flobi_drive'), (e) => e.status === 301 && /moved or was renamed/.test(e.message) && /flobi-release\/repos\.json/.test(e.message) && /4ow4-Developers\/flobi_drive/.test(e.message));
  await assert.rejects(client.manifest('flobi-release', 'repos.json'), (e) => e.status === 301 && /versions\.manifest/.test(e.message));
});

test('answers of the wrong shape are clear errors', async () => {
  const notList = fakeGitHub(() => ({ body: { message: 'surprise' } }));
  await assert.rejects(notList.client.releases('flobi_drive'), /didn’t send a list of releases for 4ow4-Developers\/flobi_drive/);
  const notJson = fakeGitHub(() => ({ body: '<html>unicorn</html>' }));
  await assert.rejects(notJson.client.releases('flobi_drive'), /isn’t JSON/);
  const folder = fakeGitHub(() => ({ body: [{ name: 'a.json' }] }));
  await assert.rejects(folder.client.manifest('flobi-release', 'repos.json'), /is a folder/);
  const noContent = fakeGitHub(() => ({ body: { type: 'file', encoding: 'none' } }));
  await assert.rejects(noContent.client.manifest('flobi-release', 'repos.json'), /didn’t send the contents/);
  const badJson = fakeGitHub(() => ({ body: manifestFile('{ "repos": ') }));
  await assert.rejects(badJson.client.manifest('flobi-release', 'repos.json'), /isn’t valid JSON/);
  for (const m of [[1, 2], { repos: ['flobi_drive'] }, 'null']) {
    const wrong = fakeGitHub(() => ({ body: manifestFile(m) }));
    await assert.rejects(wrong.client.manifest('flobi-release', 'repos.json'), /should be a JSON object with a “repos” object/);
  }
});

test('good answers, the ETag cache and drafts work as before', async () => {
  const releases = [{ id: 1, tag_name: 'v1.1.0', body: 'x', published_at: '2026-09-25T10:00:00Z', author: { login: 'release-bot[bot]' } }, { id: 2, tag_name: 'v1.2.0', draft: true }, null];
  const { client, seen } = fakeGitHub((path, headers, n) => (n === 1 ? { body: releases, headers: { etag: '"e1"' } } : { status: 304 }));
  const first = await client.releases('flobi_drive');
  assert.deepEqual(first.map((r) => [r.tag, r.author]), [['v1.1.0', 'release-bot (bot)']]);
  assert.deepEqual(await client.releases('flobi_drive'), first);
  assert.equal(seen[1].headers['if-none-match'], '"e1"');

  const m = fakeGitHub(() => ({ body: manifestFile({ owner: '4ow4-Developers', repos: { flobi_drive: { product: 'Drive' } } }) }));
  assert.deepEqual(await m.client.manifest('flobi-release', 'repos.json'), { owner: '4ow4-Developers', repos: { flobi_drive: { product: 'Drive' } } });
});

test('GitHub errors never show the token', async () => {
  const echo = fakeGitHub(() => ({ status: 502, body: { message: `upstream saw Authorization: Bearer ${TOKEN}` } }));
  await assert.rejects(echo.client.releases('flobi_drive'), (e) => e.status === 502 && !e.message.includes(TOKEN));
  const net = new GitHubClient({ token: TOKEN, owner: '4ow4-Developers', request: async () => { throw new Error(`proxy refused token ${TOKEN}`); } });
  await assert.rejects(net.releases('flobi_drive'), (e) => !e.message.includes(TOKEN));
});
