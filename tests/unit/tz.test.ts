import { describe, expect, it } from 'vitest';
import { householdTimeZone, wallTimeToInstant } from '../../src/orchestration/tz.ts';

describe('household wall time → instant (T23)', () => {
  it('anchors to Eastern by default', () => {
    expect(householdTimeZone).toBe('America/New_York');
  });

  it('converts a winter wall time at EST (UTC-5)', () => {
    const instant = wallTimeToInstant({ year: 2026, month: 1, day: 15, hour: 7, minute: 30 });
    expect(instant.toISOString()).toBe('2026-01-15T12:30:00.000Z');
  });

  it('converts a summer wall time at EDT (UTC-4)', () => {
    const instant = wallTimeToInstant({ year: 2026, month: 7, day: 15, hour: 7, minute: 30 });
    expect(instant.toISOString()).toBe('2026-07-15T11:30:00.000Z');
  });

  it('is explicitly NOT the server timezone: a different zone parameter changes the result', () => {
    const eastern = wallTimeToInstant({ year: 2026, month: 1, day: 15, hour: 7, minute: 30 });
    const jerusalem = wallTimeToInstant(
      { year: 2026, month: 1, day: 15, hour: 7, minute: 30 },
      'Asia/Jerusalem',
    );
    expect(jerusalem.toISOString()).toBe('2026-01-15T05:30:00.000Z'); // UTC+2 in winter
    expect(jerusalem.getTime()).not.toBe(eastern.getTime());
  });

  it('resolves the nonexistent spring-forward hour deterministically', () => {
    // 2026-03-08 02:30 Eastern does not exist (02:00 EST jumps to 03:00 EDT).
    // The two-pass correction lands on the pre-transition reading (01:30 EST)
    // — deterministic, and a 2-3 AM reminder is not a household scenario.
    const instant = wallTimeToInstant({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 });
    expect(instant.toISOString()).toBe('2026-03-08T06:30:00.000Z');
  });

  it('resolves the ambiguous fall-back hour to the first (EDT) occurrence', () => {
    // 2026-11-01 01:30 Eastern happens twice; the first pass sees EDT and
    // sticks — deterministic first-occurrence semantics.
    const instant = wallTimeToInstant({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 });
    expect(instant.toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('round-trips midnight and end-of-day edges', () => {
    expect(
      wallTimeToInstant({ year: 2026, month: 6, day: 10, hour: 0, minute: 0 }).toISOString(),
    ).toBe('2026-06-10T04:00:00.000Z');
    expect(
      wallTimeToInstant({ year: 2026, month: 6, day: 10, hour: 23, minute: 59 }).toISOString(),
    ).toBe('2026-06-11T03:59:00.000Z');
  });
});
