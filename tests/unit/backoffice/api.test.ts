import { describe, expect, it } from 'vitest';
import { createApiRouter } from '../../../src/backoffice/api.js';
import type { Queryable } from '../../../src/backoffice/queries.js';

function fakeDb(rows: Record<string, unknown>[]): Queryable & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    query: async (sql: string) => {
      calls.push(sql);
      return { rows };
    },
  };
}

const url = (p: string): URL => new URL(p, 'http://localhost');

describe('createApiRouter', () => {
  it('GET /api/db returns the table catalogue', async () => {
    const api = createApiRouter({ db: fakeDb([]) });
    const res = await api.handle('GET', url('/api/db'));
    expect(res?.status).toBe(200);
    const body = res!.body as { tables: { table: string }[] };
    expect(body.tables.map((t) => t.table)).toContain('reminders');
  });

  it('GET /api/db/:table returns Zod-parsed rows', async () => {
    const db = fakeDb([
      { id: '1', list: 'groceries', item: 'Oat milk', added_by: 'Amir', done: false, created_at: '2026-06-24T00:00:00+00' },
    ]);
    const api = createApiRouter({ db });
    const res = await api.handle('GET', url('/api/db/lists?limit=50'));
    expect(res?.status).toBe(200);
    const body = res!.body as { table: string; rows: unknown[] };
    expect(body.table).toBe('lists');
    expect(body.rows).toHaveLength(1);
    // limit threaded into the parameterized query
    expect(db.calls[0]).toContain('FROM lists');
  });

  it('404s an unknown table (never interpolated into SQL)', async () => {
    const db = fakeDb([]);
    const api = createApiRouter({ db });
    const res = await api.handle('GET', url('/api/db/pg_user'));
    expect(res?.status).toBe(404);
    expect(db.calls).toHaveLength(0); // no query issued for an unknown name
  });

  it('returns undefined for a non-/api/db path', async () => {
    const api = createApiRouter({ db: fakeDb([]) });
    expect(await api.handle('GET', url('/api/nope'))).toBeUndefined();
  });
});
