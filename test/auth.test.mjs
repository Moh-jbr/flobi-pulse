import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createPublicKey, createVerify } from 'node:crypto';
import { parseServiceAccountKey, signJwt } from '../electron/core/auth/service-account.mjs';
import { READ_SCOPES, PLATFORM_SCOPES } from '../electron/core/auth/scopes.mjs';
import { sentryTokenProblem, explainSentryError, cleanSentryToken } from '../electron/core/sources/sentry.mjs';

// Throwaway key generated only for these tests.
const pem = fs.readFileSync(new URL('./fixtures/sa-test-key.pem', import.meta.url), 'utf8');
const keyJson = JSON.stringify({
  type: 'service_account',
  project_id: 'flobi-prod-2026',
  private_key_id: 'kid123',
  private_key: pem,
  client_email: 'flobi-pulse@flobi-prod-2026.iam.gserviceaccount.com',
  token_uri: 'https://evil.example.com/token',
});

test('parses a service-account key and ignores the token_uri inside it', () => {
  const k = parseServiceAccountKey(keyJson);
  assert.equal(k.clientEmail, 'flobi-pulse@flobi-prod-2026.iam.gserviceaccount.com');
  assert.equal(k.projectId, 'flobi-prod-2026');
  assert.equal(k.tokenUri, 'https://oauth2.googleapis.com/token');
});

test('rejects files that are not service-account keys', () => {
  assert.throws(() => parseServiceAccountKey('not json'), /not valid JSON/);
  assert.throws(() => parseServiceAccountKey('{"type":"authorized_user"}'), /service-account key/);
  assert.throws(() => parseServiceAccountKey(JSON.stringify({ type: 'service_account', client_email: 'a', project_id: 'b', private_key: 'nope' })), /could not be read/);
});

test('signs a valid RS256 JWT with read-only scopes', () => {
  const k = parseServiceAccountKey(keyJson);
  const jwt = signJwt({ ...k, scopes: READ_SCOPES, now: 1_700_000_000 });
  const [h, c, s] = jwt.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT', kid: 'kid123' });
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(claims.exp - claims.iat, 3600);
  assert.ok(!claims.scope.includes('auth/cloud-platform'));
  assert.ok(claims.scope.includes('logging.read'));
  const verify = createVerify('RSA-SHA256');
  verify.update(`${h}.${c}`);
  assert.ok(verify.verify(createPublicKey(pem), Buffer.from(s, 'base64url')));
});

test('the Kubernetes API gets the same scopes kubectl uses; everything else stays narrow', () => {
  // GKE answers 401 to tokens that only carry narrow scopes.
  assert.deepEqual(PLATFORM_SCOPES.map((x) => x.split('/').pop()).sort(), ['cloud-platform', 'userinfo.email']);
  assert.ok(!READ_SCOPES.some((x) => x.endsWith('/cloud-platform')));
  assert.ok(!READ_SCOPES.some((x) => /monitoring/.test(x)));
});

test('Sentry: catches the wrong things to paste and explains API errors', () => {
  assert.equal(cleanSentryToken('  Bearer abc123  '), 'abc123');
  assert.match(sentryTokenProblem('https://0123456789abcdef@o123.ingest.sentry.io/456'), /DSN/);
  assert.match(sentryTokenProblem('sntrys_eyJpYXQiOjE3MDAwMDAwMDB9'), /Organization Auth Token/);
  assert.match(sentryTokenProblem('abc'), /too short/);
  assert.equal(sentryTokenProblem('a'.repeat(64)), null);
  assert.equal(sentryTokenProblem('sntryu_' + 'a'.repeat(64)), null);
  assert.match(explainSentryError({ status: 401 }), /Client Secret/);
  assert.match(explainSentryError({ status: 403 }, 'flobi'), /Organization: Read/);
  assert.match(explainSentryError({ status: 404 }, 'flobii'), /no organization called “flobii”/);
});
