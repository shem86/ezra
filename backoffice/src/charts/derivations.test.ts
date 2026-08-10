// Unit tests for the pure derivations behind the charts. These are the parts
// that can be wrong silently — a chart still renders beautifully with the wrong
// dates on the axis or a percentile off by one.
import { describe, expect, it } from 'vitest';
import { budgetPacePerDay, toSpendSeries } from './spend-chart';
import { bucketTurns, chooseBucketMs, percentile } from './turn-charts';
import { projectMonthEnd } from '../screens/costs';
import type { TurnRow } from '../api/types';

describe('toSpendSeries', () => {
  it('anchors the last value to today and walks backwards one day per index', () => {
    const rows = toSpendSeries([1, 2, 3], new Date(2026, 7, 10, 13, 45));
    expect(rows.map((r) => r.usd)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.date.getDate())).toEqual([8, 9, 10]);
  });

  it('gives every point a stable key, since motion depends on keyed reconciliation', () => {
    const rows = toSpendSeries([1, 2, 3], new Date(2026, 7, 10));
    const keys = rows.map((r) => r.day);
    expect(new Set(keys).size).toBe(3);
    expect(keys.every((k) => /^\d{4}-\d{2}-\d{2}$/.test(k))).toBe(true);
  });

  it('handles an empty series without inventing a point', () => {
    expect(toSpendSeries([], new Date(2026, 7, 10))).toEqual([]);
  });
});

describe('budgetPacePerDay', () => {
  it('divides by the real length of the month, not a nominal 30', () => {
    // February 2026 has 28 days.
    expect(budgetPacePerDay(28, new Date(2026, 1, 10))).toBeCloseTo(1, 10);
    // August has 31.
    expect(budgetPacePerDay(31, new Date(2026, 7, 10))).toBeCloseTo(1, 10);
  });
});

describe('projectMonthEnd', () => {
  it('extrapolates month-to-date spend across the full month', () => {
    // $10 by the 10th of a 31-day month → $31 projected.
    expect(projectMonthEnd(10, new Date(2026, 7, 10))).toBeCloseTo(31, 10);
  });

  it('is a no-op rather than a division blow-up at the very start of a month', () => {
    expect(projectMonthEnd(0.5, new Date(2026, 7, 1))).toBeCloseTo(15.5, 10);
  });
});

const turn = (ts: string, level: TurnRow['level'], ms: number | null = 100): TurnRow => ({
  id: `turn-${ts}-${level}`,
  ts,
  level,
  st: level === 'error' ? 'error' : 'committed',
  ms,
  tool: null,
  tier: null,
  tokens: null,
  cache: null,
  cost: null,
});

describe('chooseBucketMs', () => {
  it('scales the bucket to the span instead of always using an hour', () => {
    const MIN = 60_000;
    expect(chooseBucketMs(10 * MIN)).toBe(MIN); // ten minutes of traffic
    expect(chooseBucketMs(12 * 60 * MIN)).toBe(60 * MIN); // half a day
    expect(chooseBucketMs(30 * 24 * 60 * MIN)).toBe(24 * 60 * MIN); // a month
  });
});

describe('bucketTurns', () => {
  it('counts turns into buckets split by outcome', () => {
    const rows = bucketTurns([
      turn('2026-08-10T09:05:00.000Z', 'info'),
      turn('2026-08-10T15:47:00.000Z', 'info'),
      turn('2026-08-10T15:50:00.000Z', 'error'),
    ]);
    const at15 = rows.filter((r) => r.hour === '2026-08-10T15:00:00.000Z');
    expect(at15.find((r) => r.level === 'info')?.count).toBe(1);
    expect(at15.find((r) => r.level === 'error')?.count).toBe(1);
    expect(at15.find((r) => r.level === 'warn')?.count).toBe(0);
  });

  it('emits empty buckets inside the span so a quiet night reads as quiet, not missing', () => {
    const rows = bucketTurns([
      turn('2026-08-10T00:00:00.000Z', 'info'),
      turn('2026-08-10T12:00:00.000Z', 'info'),
    ]);
    const buckets = [...new Set(rows.map((r) => r.hour))];
    expect(buckets).toHaveLength(13); // 00:00 through 12:00 inclusive
    const quiet = rows.filter((r) => r.hour === '2026-08-10T06:00:00.000Z');
    expect(quiet.every((r) => r.count === 0)).toBe(true);
  });

  it('widens a single-bucket window rather than drawing one full-width slab', () => {
    // Every turn in the same minute — the shape that made the first render of
    // this chart look broken.
    const rows = bucketTurns([
      turn('2026-08-10T10:32:00.000Z', 'info'),
      turn('2026-08-10T10:32:30.000Z', 'info'),
    ]);
    const buckets = [...new Set(rows.map((r) => r.hour))];
    expect(buckets.length).toBeGreaterThanOrEqual(8);
    // ...and the real data still lands in exactly one of them.
    const populated = rows.filter((r) => r.count > 0);
    expect(populated).toHaveLength(1);
    expect(populated[0]?.count).toBe(2);
  });

  it('returns nothing for no turns', () => {
    expect(bucketTurns([])).toEqual([]);
  });
});

describe('percentile', () => {
  it('uses nearest-rank and stays inside the sample', () => {
    const sample = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(sample, 50)).toBe(50);
    expect(percentile(sample, 95)).toBe(100);
    expect(percentile(sample, 100)).toBe(100);
  });

  it('handles a single value and an empty sample', () => {
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([], 95)).toBeNull();
  });
});
