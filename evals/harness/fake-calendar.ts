// T38: the in-memory calendar behind the eval-only propose_event tool. The
// decision-9 scenarios need a confirm-before effect they can count and a
// revalidation check they can flip (stale-action-at-execution); the real
// calendar client is M5.5's, and reaching for the DB here would be a schema
// change for a test double. Single eval process — in-memory is exact enough.

export interface CalendarEvent {
  readonly externalId: string;
  readonly title: string;
  readonly date: string;
  readonly time: string;
}

export interface FakeCalendar {
  /** Every event ever created, in creation order — the effect count. */
  readonly entries: readonly CalendarEvent[];
  isFree(date: string, time: string): boolean;
  /** Idempotent on externalId (decision 10): false ⇒ already existed, no-op. */
  create(event: CalendarEvent): boolean;
  /** Occupy a slot externally — the stale scenario's manufactured conflict. */
  setBusy(date: string, time: string): void;
}

function slotKey(date: string, time: string): string {
  return `${date} ${time}`;
}

export function makeFakeCalendar(): FakeCalendar {
  const entries: CalendarEvent[] = [];
  const busy = new Set<string>();

  return {
    entries,
    isFree(date, time) {
      if (busy.has(slotKey(date, time))) return false;
      return !entries.some((e) => e.date === date && e.time === time);
    },
    create(event) {
      if (entries.some((e) => e.externalId === event.externalId)) return false;
      entries.push(event);
      return true;
    },
    setBusy(date, time) {
      busy.add(slotKey(date, time));
    },
  };
}
