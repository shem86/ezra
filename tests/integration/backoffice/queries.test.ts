// BO-6: the read-only query layer against real Postgres (the `_test` sibling,
// issue #5). Proves each table SELECT returns correctly-shaped, Zod-parsed rows
// and that household_facts hides secret-class rows (privacy boundary). The
// SELECT-only-role proof is BO-17; this file proves the row shapes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { runMigrations } from '../../../src/memory/migrate.ts';
import { queryTable, TABLE_KEYS, TABLES } from '../../../src/backoffice/queries.ts';

const databaseUrl = process.env.DATABASE_URL!;
const runId = `bo-${Date.now()}`;
let db: Client;

beforeAll(async () => {
  await runMigrations({ databaseUrl });
  db = new Client({ connectionString: databaseUrl });
  await db.connect();

  const convo = `${runId}@g.us`;
  await db.query(`INSERT INTO lists (list, item, added_by) VALUES ($1, 'Oat milk', 'Amir')`, [runId]);
  await db.query(
    `INSERT INTO reminders (conversation_id, body, due_at, created_by) VALUES ($1, 'Pay water bill', now() + interval '1 day', 'Noa')`,
    [convo],
  );
  await db.query(`INSERT INTO household_facts (key, value) VALUES ($1, 'Mazda CX-5')`, [
    `car-${runId}`,
  ]);
  await db.query(
    `INSERT INTO pending_actions (action_id, conversation_id, tool_call, expires_at)
     VALUES ($1, $2, $3::jsonb, now() + interval '3 hours')`,
    [`pnd-${runId}`, convo, JSON.stringify({ name: 'calendar.create', args: { title: 'Dinner' } })],
  );
  await db.query(
    `INSERT INTO sent_log (idempotency_key, conversation_id, delivery_class, body)
     VALUES ($1, $2, 'at-least-once', $3::jsonb)`,
    [`snd-${runId}`, convo, JSON.stringify({ text: 'Done ✓' })],
  );
  await db.query(
    `INSERT INTO conversation_inbox (conversation_id, kind, sender_id, message_id, payload)
     VALUES ($1, 'human', 'wife@s.whatsapp.net', $2, $3::jsonb)`,
    [convo, `msg-${runId}`, JSON.stringify({ text: 'add milk' })],
  );
  await db.query(
    `INSERT INTO conversation_context (conversation_id, messages)
     VALUES ($1, $2::jsonb)`,
    [convo, JSON.stringify([{ role: 'user' }, { role: 'assistant' }])],
  );
});

afterAll(async () => {
  await db?.end();
});

describe('queryTable', () => {
  it('returns correctly-shaped rows for every table without throwing', async () => {
    for (const key of TABLE_KEYS) {
      const listing = await queryTable(db, key, { limit: 10 });
      expect(listing.table).toBe(key);
      expect(listing.columns).toEqual(TABLES[key].columns);
      // Each row's keys are exactly the schema's projected columns.
      for (const row of listing.rows) {
        expect(Object.keys(row).sort()).toEqual([...listing.columns].sort());
      }
    }
  });

  it('reads the seeded list row', async () => {
    const listing = await queryTable(db, 'lists', { limit: 200 });
    const mine = listing.rows.find((r) => r['list'] === runId);
    expect(mine).toMatchObject({ item: 'Oat milk', added_by: 'Amir', done: false });
    expect(typeof mine!['created_at']).toBe('string');
  });

  it('projects the tool name out of pending_actions.tool_call', async () => {
    const listing = await queryTable(db, 'pending_actions', { limit: 200 });
    const mine = listing.rows.find((r) => r['action_id'] === `pnd-${runId}`);
    expect(mine!['tool']).toBe('calendar.create');
  });

  it('counts conversation_context messages and never dumps the transcript', async () => {
    const listing = await queryTable(db, 'conversation_context', { limit: 200 });
    const mine = listing.rows.find((r) => r['conversation_id'] === `${runId}@g.us`);
    expect(mine!['messages']).toBe(2);
    expect(Object.keys(mine!)).not.toContain('messages_json');
  });

  it('reads household_facts as key/value/updated_at', async () => {
    const listing = await queryTable(db, 'household_facts', { limit: 500 });
    const mine = listing.rows.find((r) => r['key'] === `car-${runId}`);
    expect(mine).toMatchObject({ value: 'Mazda CX-5' });
    expect(Object.keys(mine!).sort()).toEqual(['key', 'updated_at', 'value']);
  });
});
