// Calendar client contract (T40): JWT/token handling, request shapes, the
// 409-fold, and the busy-window logic against a stubbed fetch — the real
// wire was proven once by spikes/calendar-sa.ts and is re-proven by T41's
// round-trip gate (never real calendar calls in CI). The signing path is
// verified for real: a locally generated RSA keypair signs, node:crypto
// verifies — no live key anywhere near the suite.

import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CalendarRequestError,
  deriveCalendarEventId,
  makeGoogleCalendarClient,
  type CalendarClient,
} from '../../src/tools/calendar-client.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const calendarIds = { husband: 'h@example.com', wife: 'w@example.com' } as const;

interface CapturedRequest {
  readonly url: string;
  readonly init: RequestInit;
}

/** Routes token POSTs and Calendar API calls; records everything it sees. */
function makeStubbedClient(
  handle: (url: string, init: RequestInit) => Response | undefined,
  options: { expiresIn?: number } = {},
): { client: CalendarClient; requests: CapturedRequest[]; tokenRequests: () => CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  const client = makeGoogleCalendarClient({
    clientEmail: 'hh-agent@test.iam.gserviceaccount.com',
    privateKey,
    calendarIds,
    fetchFn: async (url, init) => {
      const request = { url: String(url), init: init ?? {} };
      requests.push(request);
      if (request.url === 'https://oauth2.googleapis.com/token') {
        return new Response(
          JSON.stringify({ access_token: 'at-test', expires_in: options.expiresIn ?? 3600 }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      const handled = handle(request.url, request.init);
      if (handled === undefined) throw new Error(`unexpected request: ${request.url}`);
      return handled;
    },
  });
  return {
    client,
    requests,
    tokenRequests: () =>
      requests.filter((r) => r.url === 'https://oauth2.googleapis.com/token'),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function eventsListResponse(
  items: Array<{ id: string; summary: string; start?: string; end?: string; allDayDate?: string }>,
): Response {
  return jsonResponse({
    items: items.map((item) =>
      item.allDayDate !== undefined
        ? { id: item.id, summary: item.summary, start: { date: item.allDayDate }, end: { date: item.allDayDate } }
        : {
            id: item.id,
            summary: item.summary,
            start: { dateTime: item.start },
            end: { dateTime: item.end },
          },
    ),
  });
}

const window = {
  start: new Date('2026-06-25T20:00:00.000Z'),
  end: new Date('2026-06-25T21:00:00.000Z'),
};

describe('deriveCalendarEventId', () => {
  it('is deterministic and emits only the base32hex alphabet Google accepts', () => {
    const actionId = 'act-conv-1-toolu_abc';
    const id = deriveCalendarEventId(actionId);
    expect(id).toBe(deriveCalendarEventId(actionId));
    // hex ⊂ base32hex (a-v 0-9); 'hh' prefix keeps it ours and >= 5 chars.
    expect(id).toMatch(/^hh[0-9a-f]{64}$/);
  });

  it('derives distinct ids for distinct action ids', () => {
    expect(deriveCalendarEventId('act-a')).not.toBe(deriveCalendarEventId('act-b'));
  });
});

describe('makeGoogleCalendarClient — token handling', () => {
  it('exchanges a verifiable RS256 JWT with the documented claims', async () => {
    const { client, tokenRequests } = makeStubbedClient((url) =>
      url.includes('/events') ? eventsListResponse([]) : undefined,
    );

    await client.listEvents('husband', window);

    const [tokenRequest] = tokenRequests();
    const body = new URLSearchParams(tokenRequest!.init.body as string);
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');

    const assertion = body.get('assertion')!;
    const [header, claims, signature] = assertion.split('.');
    const verified = createVerify('RSA-SHA256')
      .update(`${header}.${claims}`)
      .verify(publicKey, signature!, 'base64url');
    expect(verified).toBe(true);

    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    const parsedClaims = JSON.parse(Buffer.from(claims!, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    expect(parsedClaims.iss).toBe('hh-agent@test.iam.gserviceaccount.com');
    expect(parsedClaims.scope).toBe('https://www.googleapis.com/auth/calendar.events');
    expect(parsedClaims.aud).toBe('https://oauth2.googleapis.com/token');
  });

  it('caches the access token across calls and refreshes an expired one', async () => {
    const fresh = makeStubbedClient((url) =>
      url.includes('/events') ? eventsListResponse([]) : undefined,
    );
    await fresh.client.listEvents('husband', window);
    await fresh.client.listEvents('wife', window);
    expect(fresh.tokenRequests()).toHaveLength(1);

    const expiring = makeStubbedClient(
      (url) => (url.includes('/events') ? eventsListResponse([]) : undefined),
      { expiresIn: 0 },
    );
    await expiring.client.listEvents('husband', window);
    await expiring.client.listEvents('husband', window);
    expect(expiring.tokenRequests()).toHaveLength(2);
  });
});

describe('makeGoogleCalendarClient — createEvent', () => {
  const input = {
    eventId: deriveCalendarEventId('act-conv-1-toolu_abc'),
    owner: 'wife' as const,
    title: 'תור לרופא שיניים',
    start: window.start,
    end: window.end,
  };

  it("posts the event to the owner's calendar with household-timezone dateTimes", async () => {
    let captured: CapturedRequest | undefined;
    const { client } = makeStubbedClient((url, init) => {
      if (init.method === 'POST' && url.includes('/events')) {
        captured = { url, init };
        return jsonResponse({ id: input.eventId }, 200);
      }
      return undefined;
    });

    expect(await client.createEvent(input)).toBe('created');
    expect(captured!.url).toContain(`/calendars/${encodeURIComponent(calendarIds.wife)}/events`);
    const body = JSON.parse(captured!.init.body as string) as {
      id: string;
      summary: string;
      start: { dateTime: string; timeZone: string };
      end: { dateTime: string; timeZone: string };
    };
    expect(body.id).toBe(input.eventId);
    expect(body.summary).toBe('תור לרופא שיניים');
    expect(new Date(body.start.dateTime).toISOString()).toBe('2026-06-25T20:00:00.000Z');
    expect(new Date(body.end.dateTime).toISOString()).toBe('2026-06-25T21:00:00.000Z');
    expect(body.start.timeZone).toBe('America/New_York');
    expect((captured!.init.headers as Record<string, string>).authorization).toBe(
      'Bearer at-test',
    );
  });

  it('folds a 409 re-create into already-exists — the recovery-replay no-op', async () => {
    const { client } = makeStubbedClient((url, init) =>
      init.method === 'POST' && url.includes('/events')
        ? jsonResponse({ error: { code: 409 } }, 409)
        : undefined,
    );
    expect(await client.createEvent(input)).toBe('already-exists');
  });

  it('throws CalendarRequestError with the status for other failures (404 = no access)', async () => {
    const { client } = makeStubbedClient((url, init) =>
      init.method === 'POST' && url.includes('/events')
        ? jsonResponse({ error: { code: 404 } }, 404)
        : undefined,
    );
    await expect(client.createEvent(input)).rejects.toThrowError(CalendarRequestError);
    await expect(client.createEvent(input)).rejects.toMatchObject({ status: 404 });
  });
});

describe('makeGoogleCalendarClient — listEvents / isFree', () => {
  it('lists the window with singleEvents=true and maps timed and all-day events', async () => {
    let captured: string | undefined;
    const { client } = makeStubbedClient((url) => {
      captured = url;
      return eventsListResponse([
        {
          id: 'evt1',
          summary: 'חוג ג׳ודו',
          start: '2026-06-25T20:00:00Z',
          end: '2026-06-25T21:00:00Z',
        },
        { id: 'evt2', summary: 'Birthday', allDayDate: '2026-06-25' },
      ]);
    });

    const events = await client.listEvents('husband', window);

    const url = new URL(captured!);
    expect(url.pathname).toContain(`/calendars/${encodeURIComponent(calendarIds.husband)}/events`);
    expect(url.searchParams.get('singleEvents')).toBe('true');
    expect(url.searchParams.get('timeMin')).toBe(window.start.toISOString());
    expect(url.searchParams.get('timeMax')).toBe(window.end.toISOString());

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ eventId: 'evt1', title: 'חוג ג׳ודו', allDay: false });
    expect(events[0]!.start.toISOString()).toBe('2026-06-25T20:00:00.000Z');
    expect(events[1]).toMatchObject({ eventId: 'evt2', title: 'Birthday', allDay: true });
  });

  it('is busy when a timed event occupies the window', async () => {
    const { client } = makeStubbedClient(() =>
      eventsListResponse([
        { id: 'evt1', summary: 'taken', start: '2026-06-25T20:30:00Z', end: '2026-06-25T21:30:00Z' },
      ]),
    );
    expect(await client.isFree('husband', window)).toBe(false);
  });

  it('stays free when the only occupant is our own event id (replay after a landed POST)', async () => {
    const ourId = deriveCalendarEventId('act-conv-1-toolu_abc');
    const { client } = makeStubbedClient(() =>
      eventsListResponse([
        { id: ourId, summary: 'ours', start: '2026-06-25T20:00:00Z', end: '2026-06-25T21:00:00Z' },
      ]),
    );
    expect(await client.isFree('husband', window, { ignoreEventId: ourId })).toBe(true);
    expect(await client.isFree('husband', window)).toBe(false);
  });

  it('ignores all-day events — a birthday does not block a one-hour slot', async () => {
    const { client } = makeStubbedClient(() =>
      eventsListResponse([{ id: 'evt2', summary: 'Birthday', allDayDate: '2026-06-25' }]),
    );
    expect(await client.isFree('husband', window)).toBe(true);
  });
});
