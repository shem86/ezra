// Google Calendar client (T40, ADR-0004): the spike's service-account auth
// path graduated to src. Zero-dep on the ADR-0002 rationale — RS256 JWT via
// node:crypto, plain fetch against two Google hosts. Constructed from Config
// by the composer; tools receive THIS through deps and never see the key
// (SPEC: credentials never enter prompts, traces, or the semantic store).

import { createHash, createSign } from 'node:crypto';
import { z } from 'zod';
import { householdTimeZone } from '../orchestration/tz.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const API = 'https://www.googleapis.com/calendar/v3';
const requestTimeoutMs = 30_000;
/** Refresh the cached token this long before Google's stated expiry. */
const tokenSlackMs = 60_000;

export type CalendarOwner = 'husband' | 'wife';

/**
 * Google event ids must be base32hex (a-v 0-9, length 5–1024). SHA-256 hex is
 * a subset of that alphabet, and hashing the action id keeps the derivation
 * deterministic from journaled values — a recovery replay re-derives the same
 * id, the re-create 409s, and the effect stays exactly-once (decision 10).
 */
export function deriveCalendarEventId(actionId: string): string {
  return `hh${createHash('sha256').update(actionId).digest('hex')}`;
}

export class CalendarRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'CalendarRequestError';
    this.status = status;
  }
}

export interface CalendarEventInput {
  readonly eventId: string;
  readonly owner: CalendarOwner;
  readonly title: string;
  readonly start: Date;
  readonly end: Date;
}

export interface CalendarEventSummary {
  readonly eventId: string;
  readonly title: string;
  readonly start: Date;
  readonly end: Date;
  readonly allDay: boolean;
}

export interface CalendarWindow {
  readonly start: Date;
  readonly end: Date;
}

/** 'already-exists' is the folded 409 — the recovery-replay no-op, not an error. */
export type CreateEventResult = 'created' | 'already-exists';

export interface CalendarClient {
  createEvent(input: CalendarEventInput): Promise<CreateEventResult>;
  listEvents(owner: CalendarOwner, window: CalendarWindow): Promise<CalendarEventSummary[]>;
  /**
   * Busy means a TIMED event intersects the window; all-day entries
   * (birthdays, school holidays) never block a slot. ignoreEventId exempts
   * our own deterministic id so a replay after a landed-but-uncommitted POST
   * does not call its own event a conflict and wrongly stale the action.
   */
  isFree(
    owner: CalendarOwner,
    window: CalendarWindow,
    options?: { readonly ignoreEventId?: string },
  ): Promise<boolean>;
}

export interface GoogleCalendarClientOptions {
  /** From Config (src/ops/config.ts) — never read env here. */
  readonly clientEmail: string;
  readonly privateKey: string;
  readonly calendarIds: Readonly<Record<CalendarOwner, string>>;
  /** Injectable for unit tests; defaults to global fetch. */
  readonly fetchFn?: typeof fetch;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number(),
});

const eventsListSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        summary: z.string().optional(),
        start: z.object({ dateTime: z.string().optional(), date: z.string().optional() }),
        end: z.object({ dateTime: z.string().optional(), date: z.string().optional() }),
      }),
    )
    .optional(),
});

function b64url(input: string): string {
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

export function makeGoogleCalendarClient(options: GoogleCalendarClientOptions): CalendarClient {
  const fetchFn = options.fetchFn ?? fetch;
  let cached: { token: string; expiresAtMs: number } | undefined;

  async function accessToken(): Promise<string> {
    if (cached !== undefined && Date.now() < cached.expiresAtMs - tokenSlackMs) {
      return cached.token;
    }
    const response = await fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signJwt(options.clientEmail, options.privateKey),
      }).toString(),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new CalendarRequestError(
        `calendar token endpoint: HTTP ${response.status} — ${body.slice(0, 200)}`,
        response.status,
      );
    }
    const parsed = tokenResponseSchema.parse(await response.json());
    cached = { token: parsed.access_token, expiresAtMs: Date.now() + parsed.expires_in * 1000 };
    return cached.token;
  }

  function eventsUrl(owner: CalendarOwner): string {
    return `${API}/calendars/${encodeURIComponent(options.calendarIds[owner])}/events`;
  }

  async function listEvents(
    owner: CalendarOwner,
    window: CalendarWindow,
  ): Promise<CalendarEventSummary[]> {
    const url = new URL(eventsUrl(owner));
    url.searchParams.set('timeMin', window.start.toISOString());
    url.searchParams.set('timeMax', window.end.toISOString());
    // Expand recurrences — a weekly recurring event must occupy its slots.
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    const response = await fetchFn(url, {
      headers: { authorization: `Bearer ${await accessToken()}` },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new CalendarRequestError(
        `calendar list (${owner}): HTTP ${response.status} — ${body.slice(0, 200)}`,
        response.status,
      );
    }
    const parsed = eventsListSchema.parse(await response.json());
    return (parsed.items ?? []).map((item) => {
      const allDay = item.start.dateTime === undefined;
      return {
        eventId: item.id,
        title: item.summary ?? '(untitled)',
        start: new Date(item.start.dateTime ?? `${item.start.date!}T00:00:00Z`),
        end: new Date(item.end.dateTime ?? `${item.end.date!}T00:00:00Z`),
        allDay,
      };
    });
  }

  return {
    listEvents,

    async createEvent(input) {
      const response = await fetchFn(eventsUrl(input.owner), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await accessToken()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          id: input.eventId,
          summary: input.title,
          start: { dateTime: input.start.toISOString(), timeZone: householdTimeZone },
          end: { dateTime: input.end.toISOString(), timeZone: householdTimeZone },
        }),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      // The deterministic-id idempotency contract the T39 spike proved:
      // a replayed create finds its own id and must read as success.
      if (response.status === 409) return 'already-exists';
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new CalendarRequestError(
          `calendar create (${input.owner}): HTTP ${response.status} — ${body.slice(0, 200)}`,
          response.status,
        );
      }
      return 'created';
    },

    async isFree(owner, window, isFreeOptions) {
      const events = await listEvents(owner, window);
      return !events.some(
        (event) => !event.allDay && event.eventId !== isFreeOptions?.ignoreEventId,
      );
    },
  };
}
