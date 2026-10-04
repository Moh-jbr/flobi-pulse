import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pagesUptimeTargets, pagesTitle } from '../electron/core/engine/pages-uptime.mjs';

const configured = [
  { id: 'u1', name: 'Flow', url: 'https://flow.flobi.ai/', group: 'frontend' },
  { id: 'u2', name: 'Notes', url: 'https://docs.flobi.ai/', group: 'frontend' },
  { id: 'u3', name: 'API gateway', url: 'https://api.flobi.ai/health', group: 'backend' },
];

test('every Pages project the uptime list leaves out gets a check of its own', () => {
  const pages = [
    { name: 'flobi-flow', domains: ['flow.flobi.ai'], subdomain: 'flobi-flow.pages.dev' },
    { name: 'flobi-sites', domains: ['sites.flobi.ai', 'www.sites.flobi.ai'], subdomain: 'flobi-sites.pages.dev' },
    { name: 'flobi-market-web', domains: [], subdomain: 'flobi-market-web.pages.dev' },
  ];
  assert.deepEqual(pagesUptimeTargets(pages, configured), [
    { id: 'pages:flobi-sites', name: 'Sites', url: 'https://sites.flobi.ai/', group: 'frontend', fromPages: 'flobi-sites' },
    { id: 'pages:flobi-market-web', name: 'Market web', url: 'https://flobi-market-web.pages.dev/', group: 'frontend', fromPages: 'flobi-market-web' },
  ]);
});

test('a project is covered when any of its domains is already checked', () => {
  // Notes is checked on docs.flobi.ai; its Pages project also answers on notes.flobi.ai.
  const pages = [{ name: 'flobi-notes', domains: ['notes.flobi.ai', 'docs.flobi.ai'], subdomain: 'flobi-notes.pages.dev' }];
  assert.deepEqual(pagesUptimeTargets(pages, configured), []);
});

test('the pages.dev address is used only when a project has no domain of its own', () => {
  const [t] = pagesUptimeTargets([{ name: 'x', domains: ['x.pages.dev', 'x.flobi.ai'], subdomain: 'x.pages.dev' }], []);
  assert.equal(t.url, 'https://x.flobi.ai/');
});

test('nothing odd turns into a check', () => {
  assert.deepEqual(pagesUptimeTargets(null, configured), []);
  assert.deepEqual(pagesUptimeTargets([{ domains: ['a.flobi.ai'] }, { name: 'b', domains: ['evil.com/path?x'] }, { name: 'c', domains: [] }], []), []);
});

test('Pages project names read as titles', () => {
  assert.equal(pagesTitle('flobi-market-web'), 'Market web');
  assert.equal(pagesTitle('flobi_lumens'), 'Lumens');
  assert.equal(pagesTitle('flobi'), 'Flobi');
  assert.equal(pagesTitle('landing'), 'Landing');
});

test('a check whose title is already taken is named by its address', () => {
  const [t] = pagesUptimeTargets([{ name: 'flobi-notes', domains: ['notes.flobi.ai'] }], configured);
  assert.equal(t.name, 'notes.flobi.ai', 'Notes is already the card for docs.flobi.ai');
});
