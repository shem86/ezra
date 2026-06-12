// T41 round-trip gate: the PRODUCTION calendar stack against the REAL
// Google API — makeGoogleCalendarClient + the real tool execute/revalidate.
// T40 proved the machinery around fakes; the T39 spike proved the wire with
// spike code (and a different event-id derivation). This is the seam: the
// first time the production 66-char hh+sha256 id, the production 409 fold,
// and the production list parse touch Google.
//
// Run: node --env-file=.env spikes/calendar-roundtrip.ts
// Real calendar writes (husband's calendar, far-future slot, self-cleaning)
// — never CI. Spikes are exempt from the deps-object rule.

// src VALUE-imports use `.js` specifiers, which bare node does not remap
// (conventions.md) — register the resolve hook before loading any of it.
import '../tests/integration/helpers/ts-ext-hooks.ts';
import { createSign } from 'node:crypto';
import type { CalendarToolDeps } from '../src/tools/calendar.ts';
import type { ToolContext } from '../src/tools/define-tool.ts';
import type { Embedder } from '../src/memory/embedder.ts';

const { loadConfig } = await import('../src/ops/config.ts');
const { makeGoogleCalendarClient, deriveCalendarEventId } = await import(
  '../src/tools/calendar-client.ts'
);
const { createCalendarEventTool, listCalendarEventsTool } = await import(
  '../src/tools/calendar.ts'
);
const { wallTimeToInstant } = await import('../src/orchestration/tz.ts');

function check(cond: boolean, label: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`ok: ${label}`);
}

// --- Script-local token: setup/cleanup only. Delete is deliberately NOT on
// the production client (the agent surface gets no delete; reconciliation is
// T44's), so the gate mints its own token for the raw calls it needs.
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/calendar/v3';

async function fetchRawToken(clientEmail: string, privateKey: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (s: string): string => Buffer.from(s).toString('base64url');
  const header = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64(
    JSON.stringify({
      iss: clientEmail,
      scope: 'https://www.googleapis.com/auth/calendar.events',
      aud: TOKEN_URL,
      iat: now,
      exp: now + 3600,
    }),
  );
  const signature = createSign('RSA-SHA256')
    .update(`${header}.${claims}`)
    .sign(privateKey, 'base64url');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`,
    }),
  });
  if (!res.ok) throw new Error(`token endpoint ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

// --- Setup -----------------------------------------------------------------
const config = loadConfig();
const { clientEmail, privateKey } = config.googleServiceAccount;
const client = makeGoogleCalendarClient({
  clientEmail,
  privateKey,
  calendarIds: config.calendarIds,
});
const neverEmbedder: Embedder = {
  dimension: 1024,
  embedDocuments: async () => {
    throw new Error('unused');
  },
  embedQuery: async () => {
    throw new Error('unused');
  },
};
const deps: CalendarToolDeps = { embedder: neverEmbedder, calendarClient: client };

// ~330 days out: far enough that the slot is realistically empty, near enough
// that the calendar UI can show it if a cleanup ever fails.
const gateDate = new Date(Date.now() + 330 * 86_400_000).toISOString().slice(0, 10);
const [gy, gm, gd] = gateDate.split('-').map(Number);
const actionId = `t41-${Date.now().toString(36)}`;
const eventId = deriveCalendarEventId(actionId);
const args = createCalendarEventTool.schema.parse({
  title: 'hh-assistant T41 gate',
  date: gateDate,
  time: '07:30',
  owner: 'husband',
});
const expectedStart = wallTimeToInstant({ year: gy!, month: gm!, day: gd!, hour: 7, minute: 30 });
const window = { start: expectedStart, end: new Date(expectedStart.getTime() + 60 * 60_000) };

// Calendar tools never touch ctx.db; the gate runs without a database.
const poisonDb = new Proxy(
  {},
  {
    get() {
      throw new Error('gate ran without a DB — calendar tools must not touch ctx.db');
    },
  },
) as ToolContext['db'];
const ownCtx: ToolContext = {
  actionId,
  conversationId: 'gate-t41',
  toolUseId: 'tu-t41',
  db: poisonDb,
  externalId: eventId,
};
const otherActionId = `${actionId}-other`;
const otherCtx: ToolContext = {
  ...ownCtx,
  actionId: otherActionId,
  externalId: deriveCalendarEventId(otherActionId),
};

const allDayId = `hhgate${Date.now().toString(32)}`;
const base = `${API}/calendars/${encodeURIComponent(config.calendarIds.husband)}/events`;
const token = await fetchRawToken(clientEmail, privateKey);
const rawHeaders = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

async function rawDelete(id: string): Promise<void> {
  // Cleanup deletes ONLY ids this run created; 404/410 = already gone, fine.
  const res = await fetch(`${base}/${id}`, { method: 'DELETE', headers: rawHeaders });
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    console.warn(`cleanup: delete ${id} returned ${res.status} — remove it manually`);
  }
}

console.log(`gate slot: ${gateDate} 07:30 Eastern on the husband's calendar`);
console.log(`production event id (${eventId.length} chars): ${eventId}`);

// Precheck BEFORE creating anything: abort, don't clean, if the slot is
// taken — never touch events this run didn't create.
const slotEmpty = await createCalendarEventTool.revalidate!(args, deps, otherCtx);
if (!slotEmpty) {
  console.error(`ABORT: ${gateDate} 07:30 is not empty on the husband's calendar — rerun later`);
  process.exit(1);
}
console.log('ok: precheck — far-future slot is empty');

try {
  // (1) Production id + create through the real execute.
  const created = await createCalendarEventTool.execute(args, deps, ownCtx);
  check(created.startsWith('event created'), `real create through execute: ${created}`);

  // (2) Re-execute, same ctx: real 409 through the production status path.
  const replayed = await createCalendarEventTool.execute(args, deps, ownCtx);
  check(
    replayed.includes('already'),
    `re-execute no-op (real 409 folded to success): ${replayed}`,
  );

  // (3)+(4) Read back through the production parse: id verbatim, instant
  // exactly what wallTimeToInstant produced, durationMin default = 60.
  const events = await client.listEvents('husband', window);
  check(events.length === 1, `exactly one event in the window (got ${events.length})`);
  const event = events[0]!;
  check(event.eventId === eventId, 'Google accepted and returned the 66-char id verbatim');
  check(
    event.start.getTime() === expectedStart.getTime(),
    `Eastern anchoring round-trips (${event.start.toISOString()})`,
  );
  check(
    event.end.getTime() - event.start.getTime() === 60 * 60_000,
    'durationMin default landed as a 60-minute event',
  );
  check(!event.allDay, 'timed event parsed as timed');

  const listed = await listCalendarEventsTool.execute(
    listCalendarEventsTool.schema.parse({ owner: 'husband', fromDate: gateDate, toDate: gateDate }),
    deps,
    ownCtx,
  );
  check(listed.includes('hh-assistant T41 gate'), 'list tool renders the event');
  check(listed.includes('(household time)'), 'list tool renders it as a timed line');

  // (5) Manufactured conflict: a DIFFERENT action sees the slot as busy;
  // the action's own id is exempt (the replay-after-landed-POST guard).
  check(
    (await createCalendarEventTool.revalidate!(args, deps, otherCtx)) === false,
    'manufactured conflict caught: another action revalidates to busy',
  );
  check(
    (await createCalendarEventTool.revalidate!(args, deps, ownCtx)) === true,
    'own-id exemption: the same action still revalidates to free',
  );

  // All-day on the real wire: the parse shape (start.date, no dateTime) and
  // the never-blocks-a-slot rule.
  const allDayRes = await fetch(base, {
    method: 'POST',
    headers: rawHeaders,
    body: JSON.stringify({
      id: allDayId,
      summary: 'hh-assistant T41 all-day',
      start: { date: gateDate },
      end: { date: new Date(Date.parse(gateDate) + 86_400_000).toISOString().slice(0, 10) },
    }),
  });
  if (!allDayRes.ok) throw new Error(`all-day setup create ${allDayRes.status}`);
  const withAllDay = await listCalendarEventsTool.execute(
    listCalendarEventsTool.schema.parse({ owner: 'husband', fromDate: gateDate, toDate: gateDate }),
    deps,
    ownCtx,
  );
  check(withAllDay.includes('(all day)'), 'real all-day response parses and renders as all-day');

  await rawDelete(eventId);
  check(
    (await createCalendarEventTool.revalidate!(args, deps, otherCtx)) === true,
    'all-day event does not block the slot (timed event gone, all-day present)',
  );

  // (6) Clean exit.
  await rawDelete(allDayId);
  const remaining = await client.listEvents('husband', window);
  check(remaining.length === 0, 'window empty after cleanup');

  console.log('\nPASS: production stack round-trips the real Calendar API (T41 gate)');
} catch (err) {
  // Best-effort cleanup on any failure — only the ids this run created.
  await rawDelete(eventId);
  await rawDelete(allDayId);
  throw err;
}
