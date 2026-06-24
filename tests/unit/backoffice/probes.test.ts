import { describe, expect, it } from 'vitest';
import { runProbes, type Ping } from '../../../src/backoffice/probes.js';
import type { Queryable } from '../../../src/backoffice/queries.js';

const NOW = Date.UTC(2026, 5, 24, 12, 0, 0);

function fakeDb(sweepAgeMs: number | null): Queryable {
  return {
    query: async (sql: string) => {
      if (sql.includes('SELECT 1')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('semantic_memories')) return { rows: [{ n: 1234 }] };
      if (sql.includes('reminderSweepCron')) {
        return { rows: [{ last: sweepAgeMs === null ? null : NOW - sweepAgeMs }] };
      }
      if (sql.includes('handleTurn')) return { rows: [{ turns: 42, avg_ms: 1400 }] };
      return { rows: [] };
    },
  };
}

const ok = (ms: number): Ping => async () => ms;
const fail: Ping = async () => {
  throw new Error('auth HTTP 401');
};

describe('runProbes', () => {
  it('reports Postgres, pgvector, and external pings', async () => {
    const status = await runProbes({
      db: fakeDb(30_000), // sweep 30s ago → fresh
      pingAnthropic: ok(120),
      pingVoyage: ok(210),
      pingLangfuse: ok(40),
      pingCalendar: ok(2100),
      now: () => NOW,
    });
    const byName = new Map(status.services.map((s) => [s.name, s]));
    expect(byName.get('Postgres')!.status).toBe('operational');
    expect(byName.get('pgvector memory')!.detail).toContain('1,234 embeddings');
    expect(byName.get('Anthropic API')!.status).toBe('operational');
    expect(byName.get('Anthropic API')!.latency).toBe('120ms');
    expect(byName.get('Google Calendar')!.latency).toBe('2.1s');
    expect(status.edges).toHaveLength(5);
    expect(status.turnsToday).toBe(42);
    expect(status.avgLatency).toBe('1.4s');
  });

  it('derives Baileys liveness from the scheduler heartbeat', async () => {
    const fresh = await runProbes({
      db: fakeDb(30_000),
      pingAnthropic: ok(1), pingVoyage: ok(1), pingLangfuse: ok(1), pingCalendar: ok(1),
      now: () => NOW,
    });
    expect(fresh.services.find((s) => s.name === 'WhatsApp (Baileys)')!.status).toBe('operational');

    const stale = await runProbes({
      db: fakeDb(10 * 60_000), // 10 min ago → stale
      pingAnthropic: ok(1), pingVoyage: ok(1), pingLangfuse: ok(1), pingCalendar: ok(1),
      now: () => NOW,
    });
    expect(stale.services.find((s) => s.name === 'WhatsApp (Baileys)')!.status).toBe('down');
  });

  it('marks a failing external ping as down (no crash)', async () => {
    const status = await runProbes({
      db: fakeDb(30_000),
      pingAnthropic: ok(1),
      pingVoyage: fail,
      pingLangfuse: ok(1),
      pingCalendar: ok(1),
      now: () => NOW,
    });
    expect(status.services.find((s) => s.name === 'Voyage API')!.status).toBe('down');
  });
});
