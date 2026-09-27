// Service-account login: sign a JWT with the key's private key (node:crypto) and
// exchange it for a short-lived access token. No Google client library needed.
import { createSign, createPrivateKey } from 'node:crypto';
import { form } from '../net/http.mjs';
import { READ_SCOPES, PLATFORM_SCOPES } from './scopes.mjs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** Validates a service-account key file and returns the fields we need. */
export function parseServiceAccountKey(text) {
  let j;
  try {
    j = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    throw new Error('That file is not valid JSON. Pick the .json key you downloaded from Google Cloud.');
  }
  if (j?.type !== 'service_account') {
    throw new Error('That JSON is not a service-account key (its "type" must be "service_account").');
  }
  for (const k of ['client_email', 'private_key', 'project_id']) {
    if (!j[k]) throw new Error(`The key file is missing "${k}".`);
  }
  try {
    createPrivateKey(j.private_key);
  } catch {
    throw new Error('The private key inside the file could not be read.');
  }
  return {
    clientEmail: j.client_email,
    privateKey: j.private_key,
    privateKeyId: j.private_key_id || undefined,
    projectId: j.project_id,
    tokenUri: TOKEN_URL, // always Google's endpoint, never a URL taken from the file
  };
}

export function signJwt({ clientEmail, privateKey, privateKeyId, scopes, now = Math.floor(Date.now() / 1000) }) {
  const header = { alg: 'RS256', typ: 'JWT', ...(privateKeyId ? { kid: privateKeyId } : {}) };
  const claims = {
    iss: clientEmail,
    scope: scopes.join(' '),
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(privateKey).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${unsigned}.${signature}`;
}

export class ServiceAccountAuth {
  constructor(keyText) {
    this.key = parseServiceAccountKey(keyText);
    this.kind = 'service-account';
    this.cache = new Map(); // purpose -> { token, expiresAt }
  }

  get identity() {
    return {
      kind: 'service-account',
      email: this.key.clientEmail,
      name: this.key.clientEmail.split('@')[0],
      projectId: this.key.projectId,
    };
  }

  /** @param {'read'|'platform'} purpose */
  async getToken(purpose = 'read') {
    const cached = this.cache.get(purpose);
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
    let scopes = purpose === 'platform' ? PLATFORM_SCOPES : READ_SCOPES;
    if (this.withoutRunScope) scopes = scopes.filter((s) => !s.endsWith('/run.readonly'));
    let res;
    try {
      res = await form(TOKEN_URL, { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signJwt({ ...this.key, scopes }) });
    } catch (e) {
      // If Google ever rejects the Cloud Run read-only scope, carry on without it
      // (Cloud Run status then shows as unavailable instead of blocking sign-in).
      if (!this.withoutRunScope && /invalid_scope/i.test(`${e.message} ${e.body || ''}`)) {
        this.withoutRunScope = true;
        return this.getToken(purpose);
      }
      throw e;
    }
    if (!res?.access_token) throw new Error('Google did not return an access token for the service account.');
    const entry = { token: res.access_token, expiresAt: Date.now() + (res.expires_in || 3600) * 1000 };
    this.cache.set(purpose, entry);
    return entry.token;
  }

  invalidate() {
    this.cache.clear();
  }

  async signOut() {
    this.cache.clear();
  }
}
