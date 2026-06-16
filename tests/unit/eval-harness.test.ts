// T46 eval substrate: the fake CalendarClient that backs the REAL
// create_calendar_event tool in the eval registry (T40 swapped the eval-only
// propose_event for the production tool shape — evals never touch Google, so
// the in-memory fake stands in for makeGoogleCalendarClient). Deterministic,
// CI-safe; the model-in-the-loop behavior these enable is measured by
// `pnpm eval`.

import { describe, expect, it } from 'vitest';
import { makeFakeCalendar } from '../../evals/harness/fake-calendar.ts';
import { createCalendarEventTool } from '../../src/tools/calendar.ts';
import { deriveCalendarEventId } from '../../src/tools/calendar-client.ts';
import type { CalendarToolDeps } from '../../src/tools/calendar.ts';
import { makeV1ToolRegistry } from '../../src/tools/index.ts';
import { wallTimeToInstant } from '../../src/orchestration/tz.ts';
import type { Queryable } from '../../src/memory/store.ts';
import type { ToolContext } from '../../src/tools/define-tool.ts';

// The calendar tools never touch the db — a throwing stub proves it.
const noDb: Queryable = {
  query: async () => {
    throw new Error('create_calendar_event must not touch the database');
  },
};

function ctxFor(actionId: string): ToolContext {
  return {
    actionId,
    conversationId: 'conv-eval-unit',
    toolUseId: 'tu-eval-unit',
    db: noDb,
    externalId: deriveCalendarEventId(actionId),
  };
}

function depsWith(calendar: ReturnType<typeof makeFakeCalendar>): CalendarToolDeps {
  return {
    calendarClient: calendar,
    embedder: {
      dimension: 0,
      embedQuery: async () => [],
      embedDocuments: async () => [],
    },
  };
}

// June 19 2026 15:00 Eastern (EDT, UTC-4) → 19:00Z, +60 min.
const validArgs = { title: 'dentist', date: '2026-06-19', time: '15:00', durationMin: 60, owner: 'wife' as const };
const window = (() => {
  const start = wallTimeToInstant({ year: 2026, month: 6, day: 19, hour: 15, minute: 0 });
  return { start, end: new Date(start.getTime() + 60 * 60_000) };
})();

describe('fake calendar (CalendarClient stand-in)', () => {
  it('slots start free and setBusy occupies one (owner-scoped)', async () => {
    const calendar = makeFakeCalendar();
    expect(await calendar.isFree('wife', window)).toBe(true);
    calendar.setBusy('wife', window);
    expect(await calendar.isFree('wife', window)).toBe(false);
    // A different owner's calendar is untouched.
    expect(await calendar.isFree('husband', window)).toBe(true);
  });

  it('createEvent is idempotent on eventId — the decision-10 no-op re-execute', async () => {
    const calendar = makeFakeCalendar();
    const input = { eventId: 'hh-1', owner: 'wife' as const, title: 'dentist', start: window.start, end: window.end };
    expect(await calendar.createEvent(input)).toBe('created');
    expect(await calendar.createEvent(input)).toBe('already-exists');
    expect(calendar.entries).toHaveLength(1);
  });

  it('a created event occupies its slot and lists for its owner', async () => {
    const calendar = makeFakeCalendar();
    await calendar.createEvent({ eventId: 'hh-1', owner: 'wife', title: 'dentist', start: window.start, end: window.end });
    expect(await calendar.isFree('wife', window)).toBe(false);
    const listed = await calendar.listEvents('wife', window);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.eventId).toBe('hh-1');
    // It is the wife's event, not the husband's.
    expect(await calendar.listEvents('husband', window)).toHaveLength(0);
  });

  it('isFree exempts our own deterministic id (replay after an uncommitted POST)', async () => {
    const calendar = makeFakeCalendar();
    await calendar.createEvent({ eventId: 'hh-own', owner: 'wife', title: 'dentist', start: window.start, end: window.end });
    expect(await calendar.isFree('wife', window)).toBe(false);
    expect(await calendar.isFree('wife', window, { ignoreEventId: 'hh-own' })).toBe(true);
  });
});

describe('create_calendar_event against the fake (the real v1 tool)', () => {
  it('is confirm-before with a revalidation check (SPEC boundary)', () => {
    expect(createCalendarEventTool.riskTier).toBe('confirm-before');
    expect(createCalendarEventTool.revalidate).toBeDefined();
  });

  it('schema pins date to YYYY-MM-DD and time to 24h HH:MM — refine args are checkable', () => {
    expect(createCalendarEventTool.schema.safeParse(validArgs).success).toBe(true);
    expect(createCalendarEventTool.schema.safeParse({ ...validArgs, time: '4pm' }).success).toBe(false);
    expect(createCalendarEventTool.schema.safeParse({ ...validArgs, date: '19/06/2026' }).success).toBe(false);
    // owner is required — the model fills it from sender attribution.
    expect(createCalendarEventTool.schema.safeParse({ title: 'x', date: '2026-06-19', time: '15:00' }).success).toBe(false);
  });

  it('derives a deterministic external id from the action id', () => {
    const ctx = { actionId: 'act-a', conversationId: 'c', toolUseId: 't' };
    const id = createCalendarEventTool.externalId?.(ctx);
    expect(id).toBe(deriveCalendarEventId('act-a'));
    expect(createCalendarEventTool.externalId?.(ctx)).toBe(id);
  });

  it('revalidate consults the target owner slot', async () => {
    const calendar = makeFakeCalendar();
    const deps = depsWith(calendar);
    expect(await createCalendarEventTool.revalidate?.(validArgs, deps, ctxFor('act-a'))).toBe(true);
    calendar.setBusy('wife', window);
    expect(await createCalendarEventTool.revalidate?.(validArgs, deps, ctxFor('act-a'))).toBe(false);
  });

  it('execute creates exactly one event keyed by the derived id; re-execute no-ops', async () => {
    const calendar = makeFakeCalendar();
    const deps = depsWith(calendar);
    await createCalendarEventTool.execute(validArgs, deps, ctxFor('act-a'));
    await createCalendarEventTool.execute(validArgs, deps, ctxFor('act-a'));
    expect(calendar.entries).toHaveLength(1);
    expect(calendar.entries[0]?.eventId).toBe(deriveCalendarEventId('act-a'));
    expect(calendar.entries[0]?.owner).toBe('wife');
    expect(calendar.entries[0]?.start.toISOString()).toBe('2026-06-19T19:00:00.000Z');
  });
});

describe('eval tool registry', () => {
  it('is the full v1 surface — household tools plus the real calendar tools', () => {
    const names = [...makeV1ToolRegistry().keys()];
    expect(names).toContain('create_calendar_event');
    expect(names).toContain('list_calendar_events');
    // No eval-only stand-in lingers.
    expect(names).not.toContain('propose_event');
  });
});
