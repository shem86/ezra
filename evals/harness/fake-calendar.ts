// T46: the in-memory CalendarClient behind the eval registry's REAL
// create_calendar_event tool (T40 swapped the eval-only propose_event for the
// production tool shape). evals never touch Google — this fake implements the
// same CalendarClient interface makeGoogleCalendarClient does, so the eval
// drives the production tool's execute/revalidate unchanged. The decision-9
// scenarios need a confirm-before effect they can count (entries) and a
// revalidation check they can flip (setBusy — the stale scenario). Single
// eval process — in-memory is exact enough; reaching for the DB would be a
// schema change for a test double.

import type {
  CalendarClient,
  CalendarEventInput,
  CalendarEventSummary,
  CalendarOwner,
  CalendarWindow,
  CreateEventResult,
} from '../../src/tools/calendar-client.ts';

export interface FakeCalendarEvent {
  readonly eventId: string;
  readonly owner: CalendarOwner;
  readonly title: string;
  readonly start: Date;
  readonly end: Date;
}

export interface FakeCalendarClient extends CalendarClient {
  /** Every event ever created, in creation order — the effect count. */
  readonly entries: readonly FakeCalendarEvent[];
  /**
   * Occupy a window on an owner's calendar — the stale scenario's manufactured
   * conflict. A busy marker is not a created event (it never enters `entries`),
   * so it blocks revalidation without polluting the effect count.
   */
  setBusy(owner: CalendarOwner, window: CalendarWindow): void;
}

/** Half-open overlap: [start, end) intervals intersect. */
function intersects(a: CalendarWindow, b: CalendarWindow): boolean {
  return a.start < b.end && b.start < a.end;
}

export function makeFakeCalendar(): FakeCalendarClient {
  const entries: FakeCalendarEvent[] = [];
  const busy: { owner: CalendarOwner; window: CalendarWindow }[] = [];

  return {
    entries,

    async createEvent(input: CalendarEventInput): Promise<CreateEventResult> {
      // Idempotent on eventId (decision 10): a replayed create finds its own
      // deterministic id and reads as success — the recovery no-op.
      if (entries.some((e) => e.eventId === input.eventId)) return 'already-exists';
      entries.push({
        eventId: input.eventId,
        owner: input.owner,
        title: input.title,
        start: input.start,
        end: input.end,
      });
      return 'created';
    },

    async listEvents(owner: CalendarOwner, window: CalendarWindow): Promise<CalendarEventSummary[]> {
      return entries
        .filter((e) => e.owner === owner && intersects(e, window))
        .map((e) => ({
          eventId: e.eventId,
          title: e.title,
          start: e.start,
          end: e.end,
          allDay: false,
        }));
    },

    async isFree(owner, window, options): Promise<boolean> {
      const ignore = options?.ignoreEventId;
      const conflictingEvent = entries.some(
        (e) => e.owner === owner && e.eventId !== ignore && intersects(e, window),
      );
      const conflictingBusy = busy.some((b) => b.owner === owner && intersects(b.window, window));
      return !conflictingEvent && !conflictingBusy;
    },

    setBusy(owner, window) {
      busy.push({ owner, window });
    },
  };
}
