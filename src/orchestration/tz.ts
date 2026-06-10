// Household timezone conversion (T23): reminder times anchor to Eastern
// wall time, never server time (CLAUDE.md / architecture scheduling rule).
// Pure Intl-based conversion — no timezone dependency, no process locale.

/** The household's timezone. Reminder wall times mean THIS zone, always. */
export const householdTimeZone = 'America/New_York';

export interface WallTime {
  readonly year: number;
  /** 1-12, human convention (not Date's 0-11). */
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

/**
 * Zone offset (ms) at a given instant: what you add to the instant to get
 * its wall-clock digits read as UTC. Negative west of Greenwich.
 */
function offsetAt(instantMs: number, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(new Date(instantMs))) {
    parts[part.type] = part.value;
  }
  const wallAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return wallAsUtc - instantMs;
}

/**
 * Convert a wall-clock time in `timeZone` to the UTC instant it names.
 * Two-pass offset correction (the date-fns-tz recipe): exact for all real
 * wall times; DST-gap times resolve to the pre-transition reading and
 * DST-ambiguous times to their first occurrence — both deterministic.
 */
export function wallTimeToInstant(wall: WallTime, timeZone: string = householdTimeZone): Date {
  const wallAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  let instant = wallAsUtc;
  for (let i = 0; i < 2; i++) {
    instant = wallAsUtc - offsetAt(instant, timeZone);
  }
  return new Date(instant);
}
