import { describe, expect, it } from 'vitest';
import { getLogs, makeTurnEnricher, type TurnEnricher } from '../../../src/backoffice/journal.js';
import type { ObservationsSource } from '../../../src/backoffice/observations.js';
import type { Queryable } from '../../../src/backoffice/queries.js';

const base = Date.UTC(2026, 5, 24, 12, 0, 0);

function fakeDb(rows: Record<string, unknown>[]): Queryable {
  return { query: async () => ({ rows }) };
}

const journalRows = [
  { id: 'turn-1', status: 'SUCCESS', recovery_attempts: 1, created_at: base, finished_at: base + 2300 },
  { id: 'turn-2', status: 'ERROR', recovery_attempts: 1, created_at: base - 1000, finished_at: base - 100 },
  { id: 'turn-3', status: 'SUCCESS', recovery_attempts: 3, created_at: base - 2000, finished_at: base - 1000 },
];

describe('getLogs', () => {
  it('maps journal status → level/st and computes duration', async () => {
    const logs = await getLogs(fakeDb(journalRows), undefined);
    expect(logs.enriched).toBe(false);
    const [a, b, c] = logs.turns;
    expect(a).toMatchObject({ id: 'turn-1', st: 'committed', level: 'info', ms: 2300 });
    expect(b).toMatchObject({ st: 'error', level: 'error' });
    expect(c).toMatchObject({ st: 'recovered', level: 'warn' }); // recovery_attempts > 1
    // no enricher → enrichment columns are null
    expect(a.tokens).toBeNull();
    expect(a.tier).toBeNull();
  });

  it('merges Langfuse enrichment by trace id (= workflow_uuid)', async () => {
    const enricher: TurnEnricher = {
      byTrace: async () =>
        new Map([['turn-1', { tokens: 8000, cache: 80, cost: 0.012, tier: 'autonomous', tool: 'reminder.add' }]]),
    };
    const logs = await getLogs(fakeDb(journalRows), enricher);
    expect(logs.enriched).toBe(true);
    expect(logs.turns[0]).toMatchObject({ tokens: 8000, cache: 80, cost: 0.012, tier: 'autonomous', tool: 'reminder.add' });
    expect(logs.turns[1]!.tokens).toBeNull(); // no enrichment for turn-2 → —
  });

  it('degrades gracefully when enrichment throws (turns still list)', async () => {
    const enricher: TurnEnricher = {
      byTrace: async () => {
        throw new Error('langfuse down');
      },
    };
    const logs = await getLogs(fakeDb(journalRows), enricher);
    expect(logs.enriched).toBe(false);
    expect(logs.turns).toHaveLength(3);
    expect(logs.turns[0]!.tokens).toBeNull();
  });
});

describe('makeTurnEnricher', () => {
  it('aggregates usage per trace and reads tier/tool from the tool span', async () => {
    // Usage rides on the generation, tier/tool on the tool span — one turn
    // contributes both records under the same traceId.
    const observations: ObservationsSource = {
      recent: async () => [
        {
          traceId: 'turn-1',
          startTime: '2026-06-24T12:00:00.000Z',
          usage: { input: 1000, output: 50, cacheRead: 4000, cacheWrite: 200 },
          tier: null,
          tool: null,
        },
        {
          traceId: 'turn-1',
          startTime: '2026-06-24T12:00:01.000Z',
          usage: null,
          tier: 'autonomous',
          tool: 'reminder.add',
        },
      ],
    };

    const enricher = makeTurnEnricher({ observations });
    const map = await enricher.byTrace();
    const e = map.get('turn-1');
    expect(e).toBeDefined();
    expect(e!.tokens).toBe(5250); // 1000+50+4000+200
    expect(e!.cache).toBe(77); // 4000 / (1000+4000+200)
    expect(e!.tier).toBe('autonomous');
    expect(e!.tool).toBe('reminder.add');
    expect(e!.cost).toBeGreaterThan(0);
  });

  it('propagates an upstream failure so getLogs can degrade to enriched:false', async () => {
    const observations: ObservationsSource = {
      recent: async () => {
        throw new Error('langfuse v2 observations: HTTP 500');
      },
    };
    const logs = await getLogs(fakeDb(journalRows), makeTurnEnricher({ observations }));
    expect(logs.enriched).toBe(false);
    expect(logs.turns).toHaveLength(3);
  });
});
