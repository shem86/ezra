import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { runMigrations } from '../../src/memory/migrate.ts';

const connectionString = process.env.DATABASE_URL ?? '';
let db: Client;

beforeAll(async () => {
  db = new Client({ connectionString });
  await db.connect();
}, 30_000);

afterAll(async () => {
  await db.end();
});

describe('migrations (T18)', () => {
  it('applies cleanly and records each migration once', async () => {
    await runMigrations({ databaseUrl: connectionString });

    const recorded = await db.query('SELECT name FROM schema_migrations ORDER BY name');
    const names = recorded.rows.map((r: { name: string }) => r.name);
    expect(names).toContain('0001-structured-store-v0.sql');
    expect(new Set(names).size).toBe(names.length);
  }, 30_000);

  it('is idempotent — a second run applies nothing', async () => {
    await runMigrations({ databaseUrl: connectionString });
    const secondRun = await runMigrations({ databaseUrl: connectionString });
    expect(secondRun).toEqual([]);
  }, 30_000);

  it('creates all six structured-store tables', async () => {
    await runMigrations({ databaseUrl: connectionString });

    const res = await db.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [
        [
          'lists',
          'reminders',
          'household_facts',
          'pending_actions',
          'sent_log',
          'conversation_context',
        ],
      ],
    );
    expect(res.rows.map((r: { table_name: string }) => r.table_name).sort()).toEqual([
      'conversation_context',
      'household_facts',
      'lists',
      'pending_actions',
      'reminders',
      'sent_log',
    ]);
  }, 30_000);
});
