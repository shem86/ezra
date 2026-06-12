// T39 spike (ADR-0004): prove the service-account calendar path end to end —
// key → RS256 JWT (node:crypto, zero-dep) → token endpoint → create + 409 on
// re-create (the deterministic-id idempotency T40 relies on) → read → delete,
// on BOTH spouses' shared calendars. Run: node --env-file=.env spikes/calendar-sa.ts
// Real calendar writes — never CI. Spikes are exempt from the deps-object rule.

import { createSign } from 'node:crypto';
import { loadConfig } from '../src/ops/config.ts';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const API = 'https://www.googleapis.com/calendar/v3';

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function signJwt(clientEmail: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({ iss: clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 }),
  );
  const signature = createSign('RSA-SHA256')
    .update(`${header}.${claims}`)
    .sign(privateKey, 'base64url');
  return `${header}.${claims}.${signature}`;
}

async function fetchAccessToken(jwt: string): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`token endpoint ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { access_token: string };
  return body.access_token;
}

async function roundTrip(token: string, owner: string, calendarId: string): Promise<void> {
  const base = `${API}/calendars/${encodeURIComponent(calendarId)}/events`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  // Calendar event ids must be base32hex (a-v, 0-9); toString(32) emits
  // exactly that alphabet. Same derivation idea T40 will use from action_id.
  const eventId = `hhspike${Date.now().toString(32)}`;
  const start = new Date(Date.now() + 24 * 3_600_000);
  const event = {
    id: eventId,
    summary: `hh-assistant T39 spike (${owner})`,
    start: { dateTime: start.toISOString(), timeZone: 'America/New_York' },
    end: { dateTime: new Date(start.getTime() + 3_600_000).toISOString(), timeZone: 'America/New_York' },
  };

  const create = await fetch(base, { method: 'POST', headers, body: JSON.stringify(event) });
  if (!create.ok) throw new Error(`[${owner}] create ${create.status}: ${await create.text()}`);
  console.log(`[${owner}] create ${eventId}: ${create.status} OK`);

  // The idempotency contract: re-insert with the same id must 409, never duplicate.
  const dup = await fetch(base, { method: 'POST', headers, body: JSON.stringify(event) });
  if (dup.status !== 409) throw new Error(`[${owner}] expected 409 on re-create, got ${dup.status}`);
  console.log(`[${owner}] re-create: 409 as expected (idempotent no-op path)`);

  const read = await fetch(`${base}/${eventId}`, { headers });
  if (!read.ok) throw new Error(`[${owner}] read ${read.status}: ${await read.text()}`);
  const fetched = (await read.json()) as { summary: string };
  if (fetched.summary !== event.summary) {
    throw new Error(`[${owner}] read-back summary mismatch: ${fetched.summary}`);
  }
  console.log(`[${owner}] read-back OK: "${fetched.summary}"`);

  const del = await fetch(`${base}/${eventId}`, { method: 'DELETE', headers });
  if (del.status !== 204 && del.status !== 200) {
    throw new Error(`[${owner}] delete ${del.status}: ${await del.text()}`);
  }
  console.log(`[${owner}] delete: ${del.status} OK`);
}

const config = loadConfig();
const { clientEmail, privateKey } = config.googleServiceAccount;
console.log(`service account: ${clientEmail}`);
const token = await fetchAccessToken(signJwt(clientEmail, privateKey));
console.log('access token acquired (calendar.events scope)');
await roundTrip(token, 'husband', config.calendarIds.husband);
await roundTrip(token, 'wife', config.calendarIds.wife);
console.log('\nPASS: create / idempotent 409 / read / delete on both calendars');
