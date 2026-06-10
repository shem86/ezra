import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { runMigrations } from '../../src/memory/migrate.ts';
import {
  addListItem,
  createPendingAction,
  createReminder,
  getDueReminders,
  getFact,
  getOpenItems,
  getPendingAction,
  getSentEntry,
  loadContext,
  markItemDone,
  recordSend,
  saveContext,
  upsertFact,
} from '../../src/memory/store.ts';

const connectionString = process.env.DATABASE_URL ?? '';
// Unique per run: the dev DB is shared and migrations are forward-only, so
// stale rows from earlier runs must never collide with this one.
const runId = `run-${Date.now()}`;
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

describe('lists store', () => {
  const list = `groceries-${runId}`;

  it('adds items and reads open ones back in insertion order', async () => {
    await addListItem(db, { list, item: 'milk', addedBy: 'shem' });
    await addListItem(db, { list, item: 'חלב שקדים', addedBy: 'wife' });

    const open = await getOpenItems(db, list);
    expect(open.map((i) => i.item)).toEqual(['milk', 'חלב שקדים']);
    expect(open[0]?.done).toBe(false);
    expect(open[0]?.addedBy).toBe('shem');
  });

  it('marking an item done removes it from the open view and stamps doneAt', async () => {
    const [first] = await getOpenItems(db, list);
    const done = await markItemDone(db, first!.id);

    expect(done?.done).toBe(true);
    expect(done?.doneAt).toBeInstanceOf(Date);
    expect((await getOpenItems(db, list)).map((i) => i.item)).toEqual(['חלב שקדים']);
  });
});

describe('reminders store', () => {
  it('creates a scheduled reminder and surfaces it once due', async () => {
    const dueAt = new Date(Date.now() - 60_000);
    const created = await createReminder(db, {
      conversationId: `conv-${runId}`,
      body: 'תזכורת: take out the trash',
      dueAt,
      createdBy: 'shem',
    });

    expect(created.status).toBe('scheduled');
    expect(created.recurrence).toBeNull();
    expect(created.dueAt.getTime()).toBe(dueAt.getTime());

    const due = await getDueReminders(db, new Date());
    expect(due.map((r) => r.id)).toContain(created.id);
  });

  it('does not surface reminders that are not due yet', async () => {
    const future = await createReminder(db, {
      conversationId: `conv-${runId}`,
      body: 'future',
      dueAt: new Date(Date.now() + 3_600_000),
      createdBy: 'wife',
    });

    const due = await getDueReminders(db, new Date());
    expect(due.map((r) => r.id)).not.toContain(future.id);
  });
});

describe('household facts store', () => {
  it('round-trips a fact, defaulting to non-secret', async () => {
    const key = `wifi-network-${runId}`;
    await upsertFact(db, { key, value: 'HHNet' });

    const fact = await getFact(db, key);
    expect(fact?.value).toBe('HHNet');
    expect(fact?.isSecret).toBe(false);
  });

  it('upsert overwrites the value and can flag a fact secret-class', async () => {
    const key = `wifi-password-${runId}`;
    await upsertFact(db, { key, value: 'first' });
    await upsertFact(db, { key, value: 'hunter2', isSecret: true });

    const fact = await getFact(db, key);
    expect(fact?.value).toBe('hunter2');
    expect(fact?.isSecret).toBe(true);
  });

  it('returns null for an unknown fact', async () => {
    expect(await getFact(db, `missing-${runId}`)).toBeNull();
  });
});

describe('pending actions store', () => {
  it('parks a serialized tool call and reads it back intact', async () => {
    const toolCall = {
      name: 'create_calendar_event',
      args: { title: 'תור לרופא', startsAt: '2026-06-15T10:00:00-04:00', durationMin: 30 },
    };
    const expiresAt = new Date(Date.now() + 12 * 3_600_000);
    await createPendingAction(db, {
      actionId: `act-${runId}`,
      conversationId: `conv-${runId}`,
      toolCall,
      expiresAt,
    });

    const parked = await getPendingAction(db, `act-${runId}`);
    expect(parked?.status).toBe('pending');
    expect(parked?.toolCall).toEqual(toolCall);
    expect(parked?.expiresAt.getTime()).toBe(expiresAt.getTime());
  });

  it('returns null for an unknown action id', async () => {
    expect(await getPendingAction(db, `act-missing-${runId}`)).toBeNull();
  });
});

describe('sent log', () => {
  it('records a send once and refuses the same idempotency key twice', async () => {
    const entry = {
      idempotencyKey: `wf-${runId}:3`,
      conversationId: `conv-${runId}`,
      deliveryClass: 'at-least-once' as const,
      body: { text: 'Reminder: trash night' },
    };

    expect(await recordSend(db, entry)).toBe(true);
    expect(await recordSend(db, entry)).toBe(false);

    const logged = await getSentEntry(db, entry.idempotencyKey);
    expect(logged?.deliveryClass).toBe('at-least-once');
    expect(logged?.body).toEqual(entry.body);
  });
});

describe('conversation context', () => {
  const conversationId = `conv-ctx-${runId}`;

  it('loads an empty transcript for a new conversation', async () => {
    expect(await loadContext(db, conversationId)).toEqual([]);
  });

  it('persists and replaces the transcript wholesale', async () => {
    const first = [{ role: 'user', content: 'add milk to the list' }];
    await saveContext(db, conversationId, first);
    expect(await loadContext(db, conversationId)).toEqual(first);

    const second = [...first, { role: 'assistant', content: 'הוספתי חלב לרשימה' }];
    await saveContext(db, conversationId, second);
    expect(await loadContext(db, conversationId)).toEqual(second);
  });
});
