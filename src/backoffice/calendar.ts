// Calendar rows for the Database screen — read LIVE from Google Calendar
// (events.list, read-only) via the existing service-account client. There is
// no calendar_events table (design→reality map); this is sourced from the API
// and surfaced as a virtual, read-only "table" the Database browser renders
// like any other. Respects the egress allowlist (googleapis.com).

import type { CalendarClient, CalendarOwner } from '../tools/calendar-client.js';
import type { BackofficeRow } from './queries.js';

export interface CalendarReader {
  list(): Promise<{ columns: string[]; rows: BackofficeRow[] }>;
}

const COLUMNS = ['id', 'title', 'owner', 'start', 'end', 'all_day'];
const TZ = 'America/New_York'; // household timezone (Eastern), never server time

function fmt(d: Date, allDay: boolean): string {
  return d.toLocaleString('en-US', {
    timeZone: TZ,
    month: 'short',
    day: 'numeric',
    ...(allDay ? {} : { hour: 'numeric', minute: '2-digit' }),
  });
}

export function makeCalendarReader(
  client: CalendarClient,
  owners: readonly CalendarOwner[] = ['husband', 'wife'],
): CalendarReader {
  return {
    async list() {
      // A useful browsing window: the recent past through the next month.
      const window = {
        start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      };
      const perOwner = await Promise.all(
        owners.map(async (owner) => {
          const events = await client.listEvents(owner, window);
          return events.map((e) => ({
            startMs: e.start.getTime(),
            row: {
              id: e.eventId,
              title: e.title,
              owner,
              start: fmt(e.start, e.allDay),
              end: fmt(e.end, e.allDay),
              all_day: e.allDay,
            } satisfies BackofficeRow,
          }));
        }),
      );
      // Sort by the real instant, not the formatted string (which misorders
      // across months).
      const rows = perOwner
        .flat()
        .sort((a, b) => a.startMs - b.startMs)
        .map((x) => x.row);
      return { columns: COLUMNS, rows };
    },
  };
}
