import { describe, expect, it } from 'vitest';
import { makeCostClient, PRICE_PER_TOKEN } from '../../../src/backoffice/cost.js';
import type { Observation, ObservationsSource } from '../../../src/backoffice/observations.js';

// now fixed at 2026-06-24 → month = June (start 06-01), prev = May.
const NOW = Date.UTC(2026, 5, 24, 12, 0, 0);

function gen(startTime: string, usage: Observation['usage']): Observation {
  return { traceId: 'turn-x', startTime, usage, tier: null, tool: null };
}

const USAGE = { input: 1000, output: 50, cacheRead: 4000, cacheWrite: 200 };

function sourceOf(records: Observation[], counter?: { n: number }): ObservationsSource {
  return {
    recent: async () => {
      if (counter) counter.n += 1;
      return records;
    },
  };
}

const RECORDS: Observation[] = [
  gen('2026-06-20T10:00:00.000Z', USAGE),
  gen('2026-06-20T11:00:00.000Z', USAGE),
  gen('2026-05-15T10:00:00.000Z', { input: 5000, output: 100, cacheRead: 0, cacheWrite: 0 }),
  // A tool span carries no usage and must not perturb any total.
  { traceId: 'turn-x', startTime: '2026-06-20T10:00:01.000Z', usage: null, tier: 'confirm', tool: 'lists.add' },
];

describe('makeCostClient', () => {
  const client = makeCostClient({ observations: sourceOf(RECORDS), budgetUsd: 50, now: () => NOW });

  it('estimates spend from tokens × the price table (cost/model absent from Langfuse)', async () => {
    const c = await client.getCosts();
    expect(c.estimated).toBe(true);
    expect(c.budgetUsd).toBe(50);
    expect(c.monthCostUsd).toBeGreaterThan(0); // June days priced
    expect(c.lastMonthCostUsd).toBeGreaterThan(0); // May day priced
    expect(c.tokensMonth).toBe(10500); // 2 × (1000+50+4000+200)
  });

  it('derives the cache-read split from the month it is reporting', async () => {
    const c = await client.getCosts();
    // cacheRead 8000 of inputSide 10400 ≈ 77%
    expect(c.cacheReadPct).toBe(77);
    expect(c.tokenSplit.map((s) => s.label)).toEqual(['Cache read', 'Fresh input', 'Cache write', 'Output']);
    const sum = c.tokenSplit.reduce((a, s) => a + s.pct, 0);
    expect(sum).toBeCloseTo(1, 5);
  });

  it('returns a 30-day daily cost array and per-usage-type rows', async () => {
    const c = await client.getCosts();
    expect(c.dailyCost).toHaveLength(30);
    expect(c.dailyCost.some((v) => v > 0)).toBe(true); // the 06-20 day
    expect(c.byUsage.map((r) => r.name)).toContain('Cache read');
    const shareSum = c.byUsage.reduce((a, r) => a + r.share, 0);
    expect(shareSum).toBeCloseTo(1, 5);
  });

  it('prices each day from its OWN cache split, not one sampled ratio', async () => {
    // Two days, identical token volume, opposite cache mixes: an all-cache-read
    // day must price far below an all-fresh day. The old metrics/daily path
    // could not see this — it applied one sampled ratio to every day.
    const c = await makeCostClient({
      observations: sourceOf([
        gen('2026-06-22T10:00:00.000Z', { input: 10000, output: 0, cacheRead: 0, cacheWrite: 0 }),
        gen('2026-06-23T10:00:00.000Z', { input: 0, output: 0, cacheRead: 10000, cacheWrite: 0 }),
      ]),
      budgetUsd: 50,
      now: () => NOW,
    }).getCosts();

    const fresh = c.dailyCost[27]!; // 06-22
    const cached = c.dailyCost[28]!; // 06-23
    expect(fresh).toBeCloseTo(10000 * PRICE_PER_TOKEN.freshInput, 6);
    expect(cached).toBeCloseTo(10000 * PRICE_PER_TOKEN.cacheRead, 6);
    expect(fresh).toBeGreaterThan(cached * 5);
  });

  it('falls back to the whole read window before the month has any traffic', async () => {
    // First of the month, nothing billed yet: the donut must still show the
    // recent mix rather than four zero slices.
    const c = await makeCostClient({
      observations: sourceOf([gen('2026-05-15T10:00:00.000Z', USAGE)]),
      budgetUsd: 50,
      now: () => Date.UTC(2026, 5, 1, 0, 30, 0),
    }).getCosts();

    expect(c.tokensMonth).toBe(0);
    expect(c.monthCostUsd).toBe(0);
    expect(c.cacheReadPct).toBe(77); // from the May record
    expect(c.tokenSplit.reduce((a, s) => a + s.pct, 0)).toBeCloseTo(1, 5);
  });

  it('reads the shared source once per call and holds no cache of its own', async () => {
    // Caching belongs to the source (shared with Logs); a second cost client
    // must not add a second layer that can serve staler numbers.
    const counter = { n: 0 };
    const c = makeCostClient({ observations: sourceOf(RECORDS, counter), budgetUsd: 50, now: () => NOW });
    await c.getCosts();
    await c.getCosts();
    expect(counter.n).toBe(2);
  });

  it('prices output the highest per token', () => {
    expect(PRICE_PER_TOKEN.output).toBeGreaterThan(PRICE_PER_TOKEN.freshInput);
    expect(PRICE_PER_TOKEN.freshInput).toBeGreaterThan(PRICE_PER_TOKEN.cacheRead);
  });
});
