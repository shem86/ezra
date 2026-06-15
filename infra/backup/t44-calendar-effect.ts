// T44 reconciliation drill — the calendar leg, on the REAL Google wire.
//
// Driven by t44-reconcile-drill.sh. Exercises runbook §4b end to end: a real
// event created post-base with the PRODUCTION deterministic id derived from an
// action_id, then — after the DB is restored to a point BEHIND that effect —
// re-created from the action_id read back out of the restored row. The second
// create re-derives the SAME id, Google returns 409, the production client
// folds it to 'already-exists', and the window still holds exactly ONE event.
// That is the "no duplicate on replay after a rewind" guarantee, on real wire.
//
// Run (via the drill): node --env-file=.env infra/backup/t44-calendar-effect.ts <cmd> ...
//   precheck <actionId> <isoStart>   abort unless the far-future slot is empty
//   create   <actionId> <isoStart>   create through the production client
//   recreate <actionId> <isoStart>   re-create; MUST fold 409 → already-exists
//   count    <isoStart> <isoEnd>     print "<n> <id,id,...>" for the window
//   delete   <eventId>               raw cleanup (client has no delete — T41)
//
// Real calendar writes (husband's calendar, far-future slot, self-cleaning) —
// never CI. Spikes/ops scripts are exempt from the deps-object rule.

// src VALUE-imports use `.js` specifiers, which bare node does not remap
// (conventions.md) — register the resolve hook before loading any of it.
import '../../tests/integration/helpers/ts-ext-hooks.ts';
import { createSign } from 'node:crypto';
import type { CalendarOwner } from '../../src/tools/calendar-client.ts';

const { loadConfig } = await import('../../src/ops/config.ts');
const { makeGoogleCalendarClient, deriveCalendarEventId } = await import(
  '../../src/tools/calendar-client.ts'
);

const OWNER: CalendarOwner = 'husband';
const TITLE = 'hh-assistant T44 reconcile drill';
const DURATION_MS = 60 * 60_000;

const config = loadConfig();
const { clientEmail, privateKey } = config.googleServiceAccount;
const client = makeGoogleCalendarClient({ clientEmail, privateKey, calendarIds: config.calendarIds });

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function windowFor(isoStart: string): { start: Date; end: Date } {
  const start = new Date(isoStart);
  if (Number.isNaN(start.getTime())) fail(`bad isoStart: ${isoStart}`);
  return { start, end: new Date(start.getTime() + DURATION_MS) };
}

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case 'precheck': {
    const [actionId, isoStart] = rest;
    if (!actionId || !isoStart) fail('precheck <actionId> <isoStart>');
    const win = windowFor(isoStart);
    // A DIFFERENT id must see the slot as free, or we'd be touching someone
    // else's event — abort, never clean up what this run didn't create (T41).
    const free = await client.isFree(OWNER, win, { ignoreEventId: deriveCalendarEventId('unused') });
    if (!free) fail(`slot ${isoStart} on the ${OWNER}'s calendar is NOT empty — rerun later`);
    console.log(`ok: far-future slot ${isoStart} is empty`);
    break;
  }
  case 'create':
  case 'recreate': {
    const [actionId, isoStart] = rest;
    if (!actionId || !isoStart) fail(`${cmd} <actionId> <isoStart>`);
    const win = windowFor(isoStart);
    const eventId = deriveCalendarEventId(actionId);
    const result = await client.createEvent({
      eventId,
      owner: OWNER,
      title: TITLE,
      start: win.start,
      end: win.end,
    });
    if (cmd === 'recreate' && result !== 'already-exists') {
      fail(`re-create MUST fold to already-exists (409), got: ${result}`);
    }
    console.log(`${result} ${eventId}`);
    break;
  }
  case 'count': {
    const [isoStart, isoEnd] = rest;
    if (!isoStart || !isoEnd) fail('count <isoStart> <isoEnd>');
    const events = await client.listEvents(OWNER, {
      start: new Date(isoStart),
      end: new Date(isoEnd),
    });
    console.log(`${events.length} ${events.map((e) => e.eventId).join(',')}`);
    break;
  }
  case 'delete': {
    const [eventId] = rest;
    if (!eventId) fail('delete <eventId>');
    // The production client has no delete (the agent surface gets none); mint a
    // raw token for cleanup only, exactly as the T41 gate does.
    const now = Math.floor(Date.now() / 1000);
    const b64 = (s: string): string => Buffer.from(s).toString('base64url');
    const header = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64(
      JSON.stringify({
        iss: clientEmail,
        scope: 'https://www.googleapis.com/auth/calendar.events',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
      }),
    );
    const sig = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(privateKey, 'base64url');
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${header}.${claims}.${sig}`,
      }),
    });
    if (!tokenRes.ok) fail(`token endpoint ${tokenRes.status}`);
    const token = ((await tokenRes.json()) as { access_token: string }).access_token;
    const calId = encodeURIComponent(config.calendarIds[OWNER]);
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${calId}/events/${eventId}`,
      { method: 'DELETE', headers: { authorization: `Bearer ${token}` } },
    );
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      console.warn(`cleanup: delete ${eventId} returned ${res.status} — remove it manually`);
    } else {
      console.log(`deleted ${eventId}`);
    }
    break;
  }
  default:
    fail('usage: <precheck|create|recreate|count|delete> ...');
}
