// BO-10: the Logs turn list reads dbos.workflow_status. DBOS creates that table
// at launch; to stay independent of suite ordering, this test ensures a
// compatible table exists (CREATE IF NOT EXISTS is a no-op against the real one)
// and asserts getLogs lists a seeded handleTurn row with the right shape.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { getLogs } from '../../../src/backoffice/journal.ts';

const databaseUrl = process.env.DATABASE_URL!;
const uuid = `turn-itest-${Date.now()}`;
let db: Client;

beforeAll(async () => {
  db = new Client({ connectionString: databaseUrl });
  await db.connect();
  await db.query('CREATE SCHEMA IF NOT EXISTS dbos');
  // Subset of the real dbos.workflow_status columns this reader uses.
  await db.query(`CREATE TABLE IF NOT EXISTS dbos.workflow_status (
    workflow_uuid text PRIMARY KEY,
    status text,
    name text,
    created_at bigint NOT NULL DEFAULT (EXTRACT(epoch FROM now()) * 1000)::bigint,
    updated_at bigint NOT NULL DEFAULT (EXTRACT(epoch FROM now()) * 1000)::bigint,
    completed_at bigint,
    recovery_attempts bigint DEFAULT 0
  )`);
  const created = Date.now();
  await db.query(
    `INSERT INTO dbos.workflow_status (workflow_uuid, status, name, created_at, completed_at, recovery_attempts)
     VALUES ($1, 'SUCCESS', 'handleTurn', $2, $3, 1)
     ON CONFLICT (workflow_uuid) DO NOTHING`,
    [uuid, created, created + 1850],
  );
});

afterAll(async () => {
  await db?.query('DELETE FROM dbos.workflow_status WHERE workflow_uuid = $1', [uuid]).catch(() => {});
  await db?.end();
});

describe('getLogs against the DBOS journal', () => {
  it('lists the seeded handleTurn row with computed duration and committed status', async () => {
    const logs = await getLogs({ query: (sql, params) => db.query(sql, params as unknown[]) }, undefined, {
      limit: 200,
    });
    const mine = logs.turns.find((t) => t.id === uuid);
    expect(mine).toBeDefined();
    expect(mine).toMatchObject({ st: 'committed', level: 'info', ms: 1850 });
    expect(mine!.tokens).toBeNull(); // no enricher → graceful —
    expect(typeof mine!.ts).toBe('string');
  });
});
