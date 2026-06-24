import { describe, expect, it } from 'vitest';
import { makeCalendarReader } from '../../../src/backoffice/calendar.js';
import { createApiRouter } from '../../../src/backoffice/api.js';
import type { CalendarClient, CalendarEventSummary } from '../../../src/tools/calendar-client.js';
import type { Queryable } from '../../../src/backoffice/queries.js';

function fakeCalendar(events: Record<string, CalendarEventSummary[]>): CalendarClient {
  return {
    listEvents: async (owner) => events[owner] ?? [],
    createEvent: async () => 'created',
    isFree: async () => true,
  };
}

const ev = (id: string, title: string, allDay = false): CalendarEventSummary => ({
  eventId: id,
  title,
  start: new Date('2026-06-26T19:00:00Z'),
  end: new Date('2026-06-26T20:00:00Z'),
  allDay,
});

const emptyDb: Queryable = { query: async () => ({ rows: [] }) };

describe('makeCalendarReader', () => {
  it('merges both owners into read-only rows with the household timezone', async () => {
    const reader = makeCalendarReader(
      fakeCalendar({ husband: [ev('g_1', 'Dentist')], wife: [ev('g_2', 'Soccer')] }),
    );
    const { columns, rows } = await reader.list();
    expect(columns).toEqual(['id', 'title', 'owner', 'start', 'end', 'all_day']);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r['title']).sort()).toEqual(['Dentist', 'Soccer']);
    expect(rows.find((r) => r['id'] === 'g_1')!['owner']).toBe('husband');
    expect(typeof rows[0]!['start']).toBe('string');
  });
});

describe('api router — calendar_events virtual table', () => {
  it('appears in the catalogue and serves rows when a reader is present', async () => {
    const reader = makeCalendarReader(fakeCalendar({ husband: [ev('g_1', 'Dentist')], wife: [] }));
    const api = createApiRouter({ db: emptyDb, calendar: reader });

    const cat = await api.handle('GET', new URL('http://x/api/db'));
    const tables = (cat!.body as { tables: { table: string }[] }).tables.map((t) => t.table);
    expect(tables).toContain('calendar_events');

    const res = await api.handle('GET', new URL('http://x/api/db/calendar_events'));
    const body = res!.body as { table: string; rows: unknown[] };
    expect(body.table).toBe('calendar_events');
    expect(body.rows).toHaveLength(1);
  });

  it('omits calendar_events and 503s the endpoint when no reader is wired', async () => {
    const api = createApiRouter({ db: emptyDb });
    const cat = await api.handle('GET', new URL('http://x/api/db'));
    const tables = (cat!.body as { tables: { table: string }[] }).tables.map((t) => t.table);
    expect(tables).not.toContain('calendar_events');
    const res = await api.handle('GET', new URL('http://x/api/db/calendar_events'));
    expect(res!.status).toBe(503);
  });
});
