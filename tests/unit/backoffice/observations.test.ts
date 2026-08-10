import { describe, expect, it, vi } from 'vitest';
import { makeObservationsSource } from '../../../src/backoffice/observations.js';

const NOW = Date.UTC(2026, 7, 10, 12, 0, 0);

function page(records: unknown[], cursor?: string): Response {
  return new Response(JSON.stringify({ data: records, meta: cursor === undefined ? {} : { cursor } }), {
    status: 200,
  });
}

const GEN = {
  id: 'o1',
  traceId: 'turn-1',
  type: 'GENERATION',
  startTime: '2026-08-10T11:00:00.000Z',
  usageDetails: { input: 1000, output: 50, cache_read_input_tokens: 4000, cache_creation_input_tokens: 200 },
};
const SPAN = {
  id: 'o2',
  traceId: 'turn-1',
  type: 'SPAN',
  startTime: '2026-08-10T11:00:01.000Z',
  metadata: { tool: 'reminder.add', riskTier: 'autonomous', parked: false },
};

function source(fetchFn: typeof fetch, overrides: Record<string, unknown> = {}) {
  return makeObservationsSource({
    baseUrl: 'https://us.cloud.langfuse.com/',
    publicKey: 'pk',
    secretKey: 'sk',
    fetchFn,
    now: () => NOW,
    ...overrides,
  });
}

describe('makeObservationsSource', () => {
  it('calls the v2 endpoint with explicit field selection and a time window', async () => {
    const urls: string[] = [];
    const fetchFn = (async (input: string | URL) => {
      urls.push(String(input));
      return page([GEN]);
    }) as unknown as typeof fetch;

    await source(fetchFn, { lookbackDays: 90 }).recent();

    expect(urls).toHaveLength(1);
    const url = new URL(urls[0]!);
    // v2 — the legacy /api/public/observations endpoint server-side times out.
    expect(url.pathname).toBe('/api/public/v2/observations');
    // Without `fields` the v2 list omits usageDetails AND metadata entirely.
    expect(url.searchParams.get('fields')).toBe('core,basic,usage,metadata');
    expect(url.searchParams.get('limit')).toBe('1000');
    const from = new Date(url.searchParams.get('fromStartTime')!).getTime();
    expect(NOW - from).toBe(90 * 24 * 60 * 60 * 1000);
  });

  it('normalises usage and metadata off the raw records', async () => {
    const fetchFn = (async () => page([GEN, SPAN])) as unknown as typeof fetch;
    const rows = await source(fetchFn).recent();

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      traceId: 'turn-1',
      usage: { input: 1000, output: 50, cacheRead: 4000, cacheWrite: 200 },
      tier: null,
      tool: null,
    });
    expect(rows[1]).toMatchObject({ traceId: 'turn-1', usage: null, tier: 'autonomous', tool: 'reminder.add' });
  });

  it('follows the cursor across pages', async () => {
    const cursors: (string | null)[] = [];
    let call = 0;
    const fetchFn = (async (input: string | URL) => {
      cursors.push(new URL(String(input)).searchParams.get('cursor'));
      call += 1;
      return call === 1 ? page([GEN], 'CURSOR-2') : page([SPAN]);
    }) as unknown as typeof fetch;

    const rows = await source(fetchFn).recent();

    expect(cursors).toEqual([null, 'CURSOR-2']);
    expect(rows).toHaveLength(2);
  });

  it('stops at maxPages and reports the truncation rather than silently capping', async () => {
    const logger = vi.fn();
    const fetchFn = (async () => page([GEN], 'ALWAYS-MORE')) as unknown as typeof fetch;

    const rows = await source(fetchFn, { maxPages: 2, logger }).recent();

    expect(rows).toHaveLength(2);
    expect(logger).toHaveBeenCalledTimes(1);
    expect(String(logger.mock.calls[0]![0])).toMatch(/truncat/i);
  });

  it('memoises success for the TTL and serves one shared in-flight promise', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return page([GEN]);
    }) as unknown as typeof fetch;
    const s = source(fetchFn);

    // Concurrent callers (the Costs and Logs endpoints hitting a cold cache at
    // the same time) must collapse to ONE upstream fetch, not stampede.
    const [a, b] = await Promise.all([s.recent(), s.recent()]);
    expect(calls).toBe(1);
    expect(a).toEqual(b);

    await s.recent();
    expect(calls).toBe(1); // still inside the TTL
  });

  it('re-fetches once the TTL expires', async () => {
    let calls = 0;
    let clock = NOW;
    const fetchFn = (async () => {
      calls += 1;
      return page([GEN]);
    }) as unknown as typeof fetch;
    const s = source(fetchFn, { now: () => clock, ttlMs: 60_000 });

    await s.recent();
    clock += 60_001;
    await s.recent();
    expect(calls).toBe(2);
  });

  it('caches failure briefly so a broken upstream cannot cost a full timeout per request', async () => {
    let calls = 0;
    let clock = NOW;
    const fetchFn = (async () => {
      calls += 1;
      return new Response('nope', { status: 500 });
    }) as unknown as typeof fetch;
    const s = source(fetchFn, { now: () => clock, failureTtlMs: 30_000 });

    await expect(s.recent()).rejects.toThrow(/500/);
    await expect(s.recent()).rejects.toThrow(/500/);
    expect(calls).toBe(1); // second call served from the negative cache

    clock += 30_001;
    await expect(s.recent()).rejects.toThrow(/500/);
    expect(calls).toBe(2);
  });
});
