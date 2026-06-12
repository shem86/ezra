import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { runMigrations } from '../../src/memory/migrate.ts';
import {
  addListItem,
  createPendingAction,
  createReminder,
  getActionByPromptMessageId,
  getDueReminders,
  getFact,
  getOpenItems,
  getPendingAction,
  getPendingActionsForConversation,
  getPendingInbox,
  getSentEntry,
  insertInboxItem,
  loadContext,
  markInboxProcessed,
  markItemDone,
  markReminderFired,
  recordSend,
  saveContext,
  setPromptMessageId,
  upsertFact,
} from '../../src/memory/store.ts';
import { markApproved, markDenied } from '../../src/hitl/pending-actions.ts';

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

  it('marking a reminder fired removes it from the due view, idempotently', async () => {
    const created = await createReminder(db, {
      conversationId: `conv-fired-${runId}`,
      body: 'one-shot',
      dueAt: new Date(Date.now() - 60_000),
      createdBy: 'shem',
    });

    expect(await markReminderFired(db, created.id)).toBe(true);
    expect(await markReminderFired(db, created.id)).toBe(false); // already fired
    expect((await getDueReminders(db, new Date())).map((r) => r.id)).not.toContain(created.id);
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
  it('round-trips a fact', async () => {
    const key = `wifi-network-${runId}`;
    await upsertFact(db, { key, value: 'HHNet' });

    const fact = await getFact(db, key);
    expect(fact?.value).toBe('HHNet');
  });

  it('upsert overwrites the value in place', async () => {
    const key = `wifi-password-${runId}`;
    await upsertFact(db, { key, value: 'first' });
    await upsertFact(db, { key, value: 'hunter2' });

    const fact = await getFact(db, key);
    expect(fact?.value).toBe('hunter2');
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

  it('a fresh park has no prompt message id; stamping persists it (T34 quoted-reply anchor)', async () => {
    const actionId = `act-stamp-${runId}`;
    const created = await createPendingAction(db, {
      actionId,
      conversationId: `conv-${runId}`,
      toolCall: { name: 'create_calendar_event', args: {} },
      expiresAt: new Date(Date.now() + 12 * 3_600_000),
    });
    expect(created.promptMessageId).toBeNull();

    expect(await setPromptMessageId(db, actionId, 'wa-msg-77')).toBe(true);
    const stamped = await getPendingAction(db, actionId);
    expect(stamped?.promptMessageId).toBe('wa-msg-77');
  });

  it('stamping an unknown action returns false', async () => {
    expect(await setPromptMessageId(db, `act-missing-${runId}`, 'wa-msg-1')).toBe(false);
  });

  it('lists only still-pending actions for one conversation, oldest first', async () => {
    const conversationId = `conv-digest-${runId}`;
    const base = {
      conversationId,
      toolCall: { name: 'create_calendar_event', args: {} },
      expiresAt: new Date(Date.now() + 12 * 3_600_000),
    };
    await createPendingAction(db, { ...base, actionId: `act-digest-1-${runId}` });
    await createPendingAction(db, { ...base, actionId: `act-digest-2-${runId}` });
    await createPendingAction(db, { ...base, actionId: `act-digest-gone-${runId}` });
    await markApproved(db, `act-digest-gone-${runId}`);
    await createPendingAction(db, {
      ...base,
      conversationId: `conv-other-${runId}`,
      actionId: `act-digest-other-${runId}`,
    });

    const pending = await getPendingActionsForConversation(db, conversationId);
    expect(pending.map((a) => a.actionId)).toEqual([
      `act-digest-1-${runId}`,
      `act-digest-2-${runId}`,
    ]);
  });

  it('resolves an action by its prompt message id, scoped to the conversation (T35 binding)', async () => {
    const conversationId = `conv-bind-${runId}`;
    const actionId = `act-bind-${runId}`;
    await createPendingAction(db, {
      actionId,
      conversationId,
      toolCall: { name: 'create_calendar_event', args: {} },
      expiresAt: new Date(Date.now() + 12 * 3_600_000),
    });
    await setPromptMessageId(db, actionId, `wa-prompt-${runId}`);

    const bound = await getActionByPromptMessageId(db, conversationId, `wa-prompt-${runId}`);
    expect(bound?.actionId).toBe(actionId);

    // A quote of anything that is not an approval prompt resolves to nothing.
    expect(await getActionByPromptMessageId(db, conversationId, `wa-unrelated-${runId}`)).toBeNull();
    // The same prompt id quoted from another conversation must not bind.
    expect(await getActionByPromptMessageId(db, `conv-other-${runId}`, `wa-prompt-${runId}`)).toBeNull();
  });

  it('binding still resolves after the action leaves pending — resolver reports, guards refuse', async () => {
    const conversationId = `conv-bind2-${runId}`;
    const actionId = `act-bind2-${runId}`;
    await createPendingAction(db, {
      actionId,
      conversationId,
      toolCall: { name: 'create_calendar_event', args: {} },
      expiresAt: new Date(Date.now() + 12 * 3_600_000),
    });
    await setPromptMessageId(db, actionId, `wa-prompt2-${runId}`);
    await markDenied(db, actionId);

    const bound = await getActionByPromptMessageId(db, conversationId, `wa-prompt2-${runId}`);
    expect(bound?.actionId).toBe(actionId);
    expect(bound?.status).toBe('denied');
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

describe('conversation inbox (T21)', () => {
  const conversationId = `conv-inbox-${runId}`;

  it('inserts items and reads pending ones back in enqueue (seq) order', async () => {
    expect(
      await insertInboxItem(db, {
        conversationId,
        kind: 'human',
        senderId: 'wife@s.whatsapp.net',
        messageId: `inbox-${runId}-1`,
        payload: { text: 'תוסיף חלב' },
      }),
    ).toBe(true);
    expect(
      await insertInboxItem(db, {
        conversationId,
        kind: 'proactive',
        senderId: 'system',
        messageId: `inbox-${runId}-2`,
        payload: { reminder: 'trash night' },
      }),
    ).toBe(true);

    const pending = await getPendingInbox(db, conversationId);
    expect(pending.map((i) => i.messageId)).toEqual([`inbox-${runId}-1`, `inbox-${runId}-2`]);
    expect(pending[0]?.kind).toBe('human');
    expect(pending[0]?.payload).toEqual({ text: 'תוסיף חלב' });
    expect(pending[1]?.kind).toBe('proactive');
    expect(pending[1]!.seq).toBeGreaterThan(pending[0]!.seq);
    expect(pending[0]?.processedAt).toBeNull();
  });

  it('dedupes on message id — a redelivered duplicate inserts nothing', async () => {
    const duplicate = {
      conversationId,
      kind: 'human' as const,
      senderId: 'wife@s.whatsapp.net',
      messageId: `inbox-${runId}-1`,
      payload: { text: 'redelivered copy' },
    };
    expect(await insertInboxItem(db, duplicate)).toBe(false);

    const pending = await getPendingInbox(db, conversationId);
    // Original payload survives; the duplicate neither replaced nor appended.
    expect(pending.filter((i) => i.messageId === `inbox-${runId}-1`)).toHaveLength(1);
    expect(pending[0]?.payload).toEqual({ text: 'תוסיף חלב' });
  });

  it('marking processed removes items from the pending view', async () => {
    const pending = await getPendingInbox(db, conversationId);
    await markInboxProcessed(
      db,
      pending.map((i) => i.seq),
    );

    expect(await getPendingInbox(db, conversationId)).toEqual([]);
  });

  it('does not leak pending items across conversations', async () => {
    await insertInboxItem(db, {
      conversationId: `other-${conversationId}`,
      kind: 'human',
      senderId: 'shem@s.whatsapp.net',
      messageId: `inbox-${runId}-other`,
      payload: { text: 'unrelated' },
    });

    expect(await getPendingInbox(db, conversationId)).toEqual([]);
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
