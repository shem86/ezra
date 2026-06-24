import { describe, expect, it } from 'vitest';
import { makeCostClient, PRICE_PER_TOKEN } from '../../../src/backoffice/cost.js';

// now fixed at 2026-06-24 → month = June (start 06-01), prev = May.
const NOW = Date.UTC(2026, 5, 24, 12, 0, 0);

function fakeFetch(): typeof fetch {
  return (async (input: string | URL): Promise<Response> => {
    const url = String(input);
    let body: unknown;
    if (url.includes('/metrics/daily')) {
      body = {
        data: [
          { date: '2026-06-20', usage: [{ inputUsage: 10000, outputUsage: 200, totalUsage: 10200 }] },
          { date: '2026-05-15', usage: [{ inputUsage: 5000, outputUsage: 100, totalUsage: 5100 }] },
        ],
      };
    } else if (url.includes('/observations')) {
      body = {
        data: [
          {
            usageDetails: {
              input: 1000,
              output: 50,
              cache_read_input_tokens: 4000,
              cache_creation_input_tokens: 200,
            },
          },
          {
            usageDetails: {
              input: 1000,
              output: 50,
              cache_read_input_tokens: 4000,
              cache_creation_input_tokens: 200,
            },
          },
        ],
      };
    } else {
      body = { data: [] };
    }
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

describe('makeCostClient', () => {
  const client = makeCostClient({
    baseUrl: 'https://cloud.langfuse.com',
    publicKey: 'pk',
    secretKey: 'sk',
    budgetUsd: 50,
    fetchFn: fakeFetch(),
    now: () => NOW,
  });

  it('estimates spend from tokens × the price table (cost/model absent from Langfuse)', async () => {
    const c = await client.getCosts();
    expect(c.estimated).toBe(true);
    expect(c.budgetUsd).toBe(50);
    expect(c.monthCostUsd).toBeGreaterThan(0); // June day priced
    expect(c.lastMonthCostUsd).toBeGreaterThan(0); // May day priced
    expect(c.tokensMonth).toBe(10200);
  });

  it('derives the cache-read split from observation usageDetails', async () => {
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

  it('prices output the highest per token', () => {
    expect(PRICE_PER_TOKEN.output).toBeGreaterThan(PRICE_PER_TOKEN.freshInput);
    expect(PRICE_PER_TOKEN.freshInput).toBeGreaterThan(PRICE_PER_TOKEN.cacheRead);
  });
});
