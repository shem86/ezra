// Calendar tools (T40, ADR-0004). create_calendar_event is the v1 surface's
// first real confirm-before tool (d10: third-party-visible); the model fills
// `owner` from sender attribution, requester's calendar unless asked
// otherwise. Wall times mean the HOUSEHOLD timezone, never server time —
// same date/time formats the T38 eval proved the model handles, conversion
// through T23's wallTimeToInstant. The client arrives authenticated via deps;
// the key never gets near a tool.

import { z } from 'zod';
import { defineTool } from './define-tool.js';
import type { HouseholdToolDeps } from './deps.js';
import { deriveCalendarEventId, type CalendarClient, type CalendarWindow } from './calendar-client.js';
import { householdTimeZone, wallTimeToInstant } from '../orchestration/tz.js';

export interface CalendarToolDeps extends HouseholdToolDeps {
  readonly calendarClient: CalendarClient;
}

const dateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('Date as YYYY-MM-DD');
const ownerField = z
  .enum(['husband', 'wife'])
  .describe("Whose calendar: the requester's own unless they explicitly ask for the other one");

function parseDate(date: string): { year: number; month: number; day: number } {
  const [year, month, day] = date.split('-').map(Number);
  return { year: year!, month: month!, day: day! };
}

/** [start of date+time, +durationMin) as instants, Eastern wall time in. */
function eventWindow(date: string, time: string, durationMin: number): CalendarWindow {
  const [hour, minute] = time.split(':').map(Number);
  const start = wallTimeToInstant({ ...parseDate(date), hour: hour!, minute: minute! });
  return { start, end: new Date(start.getTime() + durationMin * 60_000) };
}

/** The calendar day after `date`, via UTC arithmetic (no DST involvement). */
function nextDay(date: string): { year: number; month: number; day: number } {
  const { year, month, day } = parseDate(date);
  const next = new Date(Date.UTC(year, month - 1, day) + 86_400_000);
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function daysBetween(fromDate: string, toDate: string): number {
  const from = parseDate(fromDate);
  const to = parseDate(toDate);
  return (
    (Date.UTC(to.year, to.month - 1, to.day) - Date.UTC(from.year, from.month - 1, from.day)) /
    86_400_000
  );
}

/** Render a stored instant as household wall time (step context — Intl is fine here). */
function instantLabel(instant: Date): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: householdTimeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  return formatter.format(instant).replace(',', '');
}

const createCalendarEventSchema = z.object({
  title: z.string().min(1).describe('Event title, in the language it was asked in'),
  date: dateField.describe('Event date as YYYY-MM-DD'),
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .describe('Event start time as 24-hour HH:MM, household (Eastern) wall time'),
  durationMin: z.number().int().positive().max(1440).default(60),
  owner: ownerField,
});

export const createCalendarEventTool = defineTool<CalendarToolDeps, typeof createCalendarEventSchema>({
  name: 'create_calendar_event',
  description:
    "Create an event on a household member's Google Calendar. This only PROPOSES the event: " +
    'a household member must approve before anything is created, so never report the event ' +
    'as booked after calling it.',
  schema: createCalendarEventSchema,
  riskTier: 'confirm-before',
  externalId: (ctx) => deriveCalendarEventId(ctx.actionId),
  summarize: (args) =>
    `"${args.title}" on ${args.date} at ${args.time} (${args.durationMin} min, ${args.owner}'s calendar)`,
  // Slot still free on the TARGET calendar at execute time — ignoring our own
  // deterministic id, so a replay after a landed-but-uncommitted create does
  // not read its own event as a conflict.
  revalidate: async (args, deps, ctx) =>
    deps.calendarClient.isFree(args.owner, eventWindow(args.date, args.time, args.durationMin), {
      ignoreEventId: ctx.externalId ?? deriveCalendarEventId(ctx.actionId),
    }),
  execute: async (args, deps, ctx) => {
    const eventId = ctx.externalId ?? deriveCalendarEventId(ctx.actionId);
    const window = eventWindow(args.date, args.time, args.durationMin);
    const outcome = await deps.calendarClient.createEvent({
      eventId,
      owner: args.owner,
      title: args.title,
      start: window.start,
      end: window.end,
    });
    const placed = `"${args.title}" on ${args.date} at ${args.time} (${args.durationMin} min) on the ${args.owner}'s calendar`;
    return outcome === 'already-exists'
      ? `event ${placed} was already created by an earlier attempt — nothing was duplicated`
      : `event created: ${placed}`;
  },
});

const listCalendarEventsSchema = z
  .object({
    owner: ownerField,
    fromDate: dateField.describe('First day of the range (inclusive), YYYY-MM-DD'),
    toDate: dateField.describe('Last day of the range (inclusive), YYYY-MM-DD'),
  })
  .refine((args) => daysBetween(args.fromDate, args.toDate) >= 0, {
    message: 'toDate must not be before fromDate',
  })
  .refine((args) => daysBetween(args.fromDate, args.toDate) <= 35, {
    message: 'range too large — ask for at most 35 days at a time',
  });

export const listCalendarEventsTool = defineTool<CalendarToolDeps, typeof listCalendarEventsSchema>({
  name: 'list_calendar_events',
  description:
    "List events on a household member's Google Calendar for a date range (household timezone). " +
    'Call once per member to see both calendars.',
  schema: listCalendarEventsSchema,
  riskTier: 'autonomous',
  execute: async (args, deps) => {
    const window: CalendarWindow = {
      start: wallTimeToInstant({ ...parseDate(args.fromDate), hour: 0, minute: 0 }),
      end: wallTimeToInstant({ ...nextDay(args.toDate), hour: 0, minute: 0 }),
    };
    // Ledger #5: a read failure folds into an error tool_result — the model
    // tells the household the calendar is unreachable; the turn survives.
    // Safe to fold here precisely because a read writes no state.
    let events;
    try {
      events = await deps.calendarClient.listEvents(args.owner, window);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `calendar read failed for the ${args.owner}'s calendar — ${message.slice(0, 200)}. Try again later.`;
    }
    if (events.length === 0) {
      return `no events on the ${args.owner}'s calendar from ${args.fromDate} to ${args.toDate}`;
    }
    const lines = events.map((event) =>
      event.allDay
        ? `- ${event.start.toISOString().slice(0, 10)} (all day): ${event.title}`
        : `- ${instantLabel(event.start)}–${instantLabel(event.end).slice(-5)} (household time): ${event.title}`,
    );
    return `events on the ${args.owner}'s calendar (${args.fromDate} to ${args.toDate}):\n${lines.join('\n')}`;
  },
});
