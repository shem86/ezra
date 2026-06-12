// T23 gate: scheduled reminders become proactive turns in the SAME lane as
// human messages — FIFO behind an in-flight turn, exactly-once under any
// interleaving of cron ticks and direct sweeps. The fixture import MUST stay
// first: it pins this file's DBOS__APPVERSION before the SDK loads.
import {
  batchLog,
  completedLog,
  enqueueWorkflow,
  expirySweepWorkflow,
  launchSchedRuntime,
  schedConnectionString,
  schedRunId,
  startedLog,
  sweepWorkflow,
} from './helpers/sched-fixture.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { runMigrations } from '../../src/memory/migrate.ts';
import {
  createPendingAction,
  createReminder,
  getPendingActionsForConversation,
} from '../../src/memory/store.ts';
import { reminderFiringId } from '../../src/orchestration/scheduled.ts';
import { expiryFiringId } from '../../src/hitl/expiry.ts';
import { toDigestEntries } from '../../src/hitl/digest.ts';

let db: Client;

// NOTE: the fixture's every-second cron sweep runs concurrently with these
// tests and is scoped to this run's conversations. Every assertion below is
// interleaving-invariant: it checks outcomes (fired exactly once, one inbox
// row, ordering), never WHICH sweep got there first.

async function runSweep(label: string): Promise<void> {
  const handle = await DBOS.startWorkflow(sweepWorkflow, {
    workflowID: `sweep-${schedRunId}-${label}`,
  })(new Date(), new Date());
  await handle.getResult();
}

async function inboxCount(messageId: string): Promise<number> {
  const res = await db.query(
    'SELECT count(*)::int AS n FROM conversation_inbox WHERE message_id = $1',
    [messageId],
  );
  return (res.rows[0] as { n: number }).n;
}

async function reminderStatus(id: string): Promise<string> {
  const res = await db.query('SELECT status FROM reminders WHERE id = $1', [id]);
  return (res.rows[0] as { status: string }).status;
}

async function waitFor(probe: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

beforeAll(async () => {
  await runMigrations({ databaseUrl: schedConnectionString });
  db = new Client({ connectionString: schedConnectionString });
  await db.connect();
  await launchSchedRuntime();
}, 30_000);

afterAll(async () => {
  // Grace period: 4.19.x runtime registration can race shutdown's pool
  // teardown (see dbos-spike.test.ts).
  await new Promise((r) => setTimeout(r, 1500));
  await DBOS.shutdown();
  await db.end();
});

describe('scheduled reminders → proactive turns (T23)', () => {
  it('a due reminder becomes exactly one proactive turn, even when swept repeatedly', async () => {
    const conversationId = `conv-${schedRunId}-direct`;
    const reminder = await createReminder(db, {
      conversationId,
      body: 'הוציאו את הזבל',
      dueAt: new Date(Date.now() - 1000),
      createdBy: 'shem',
    });
    const firingId = reminderFiringId({ id: reminder.id, dueAtIso: reminder.dueAt.toISOString() });

    await runSweep('first');
    await runSweep('second'); // a second sweep (or any cron tick) must add nothing

    expect(await reminderStatus(reminder.id)).toBe('fired');
    expect(await inboxCount(firingId)).toBe(1);

    // The lane delivers it as a proactive batch carrying the reminder body.
    await waitFor(
      () =>
        batchLog.some(
          (batch) =>
            batch[0]?.conversationId === conversationId &&
            batch[0]?.kind === 'proactive' &&
            (batch[0]?.payload as { reminder?: string }).reminder === 'הוציאו את הזבל',
        ),
      20_000,
    );
    const deliveries = batchLog.filter((b) => b[0]?.conversationId === conversationId);
    expect(deliveries).toHaveLength(1);
  }, 30_000);

  it('a scheduled firing waits behind an in-flight turn (FIFO in the lane)', async () => {
    const conversationId = `conv-${schedRunId}-busy`;
    const humanKey = `human:${conversationId}`;
    const proactiveKey = `proactive:${conversationId}`;

    // Occupy the conversation's lane with a slow human turn.
    const handle = await DBOS.startWorkflow(enqueueWorkflow, {
      workflowID: `enq-${schedRunId}-slow`,
    })({
      conversationId,
      kind: 'human',
      senderId: 'wife',
      messageId: `m-${schedRunId}-slow`,
      payload: { text: 'slow' },
    });
    await handle.getResult();
    await waitFor(() => startedLog.includes(humanKey), 20_000);

    // The reminder fires while that turn is mid-flight.
    await createReminder(db, {
      conversationId,
      body: 'while busy',
      dueAt: new Date(Date.now() - 1000),
      createdBy: 'shem',
    });
    await runSweep('busy');
    expect(completedLog.includes(humanKey)).toBe(false); // still in flight

    await waitFor(() => completedLog.includes(proactiveKey), 30_000);
    // The proactive turn completed only after the in-flight human turn.
    expect(completedLog.indexOf(humanKey)).toBeGreaterThanOrEqual(0);
    expect(completedLog.indexOf(proactiveKey)).toBeGreaterThan(completedLog.indexOf(humanKey));
  }, 60_000);

  it('the cron schedule fires the sweep with no manual trigger', async () => {
    const conversationId = `conv-${schedRunId}-cron`;
    const reminder = await createReminder(db, {
      conversationId,
      body: 'cron finds me',
      dueAt: new Date(Date.now() - 1000),
      createdBy: 'wife',
    });

    // No runSweep here: only the every-second scheduled workflow can do it.
    await waitFor(async () => (await reminderStatus(reminder.id)) === 'fired', 30_000);
    await waitFor(
      () => batchLog.some((batch) => batch[0]?.conversationId === conversationId),
      20_000,
    );
    const deliveries = batchLog.filter((b) => b[0]?.conversationId === conversationId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.[0]?.kind).toBe('proactive');
  }, 60_000);
});

// NOTE: same interleaving-invariance rule as above — the fixture's
// every-second expiry cron runs concurrently with these tests, so every
// assertion checks outcomes (expired exactly once, one inbox row), never
// which sweep got there first.
describe('TTL expiry sweep (T37)', () => {
  async function seedAction(
    key: string,
    expiresAt: Date,
    conversationId = `conv-${schedRunId}-${key}`,
  ): Promise<{ conversationId: string; actionId: string }> {
    const actionId = `act-${schedRunId}-${key}`;
    await createPendingAction(db, {
      actionId,
      conversationId,
      toolCall: { id: `tu-${key}`, name: 'propose_event', args: { title: 'תור לרופא' } },
      expiresAt,
    });
    return { conversationId, actionId };
  }

  async function runExpirySweep(label: string): Promise<void> {
    const handle = await DBOS.startWorkflow(expirySweepWorkflow, {
      workflowID: `expsweep-${schedRunId}-${label}`,
    })(new Date(), new Date());
    await handle.getResult();
  }

  async function actionStatus(actionId: string): Promise<string> {
    const res = await db.query('SELECT status FROM pending_actions WHERE action_id = $1', [
      actionId,
    ]);
    return (res.rows[0] as { status: string }).status;
  }

  it('an overdue action expires exactly once and the gentle notice rides its own lane', async () => {
    const { conversationId, actionId } = await seedAction('overdue', new Date(Date.now() - 1000));

    await runExpirySweep('first');
    await runExpirySweep('second'); // a second sweep (or any cron tick) must add nothing

    expect(await actionStatus(actionId)).toBe('expired');
    expect(await inboxCount(expiryFiringId(actionId))).toBe(1);

    await waitFor(
      () =>
        batchLog.some(
          (batch) =>
            batch[0]?.conversationId === conversationId &&
            batch[0]?.kind === 'proactive' &&
            ((batch[0]?.payload as { actionUpdate?: string }).actionUpdate ?? '').includes(
              actionId,
            ),
        ),
      20_000,
    );
    const deliveries = batchLog.filter((b) => b[0]?.conversationId === conversationId);
    expect(deliveries).toHaveLength(1);
    const payload = deliveries[0]?.[0]?.payload as { actionUpdate: string };
    expect(payload.actionUpdate).toMatch(/nothing was executed/i);
    expect(deliveries[0]?.[0]?.senderId).toBe('system:hitl');
  }, 30_000);

  it('future actions are untouched, and expired ones drop out of the digest', async () => {
    const conversationId = `conv-${schedRunId}-digest`;
    const { actionId: overdueId } = await seedAction(
      'dig-overdue',
      new Date(Date.now() - 1000),
      conversationId,
    );
    const { actionId: futureId } = await seedAction(
      'dig-future',
      new Date(Date.now() + 12 * 3_600_000),
      conversationId,
    );

    await runExpirySweep('digest');

    expect(await actionStatus(overdueId)).toBe('expired');
    expect(await actionStatus(futureId)).toBe('pending');
    const digest = toDigestEntries(await getPendingActionsForConversation(db, conversationId));
    expect(digest.map((e) => e.actionId)).toEqual([futureId]);
  }, 30_000);

  it('the cron schedule expires overdue actions with no manual trigger', async () => {
    const { conversationId, actionId } = await seedAction('cron', new Date(Date.now() - 1000));

    // No runExpirySweep here: only the every-second scheduled workflow can do it.
    await waitFor(async () => (await actionStatus(actionId)) === 'expired', 30_000);
    await waitFor(
      () => batchLog.some((batch) => batch[0]?.conversationId === conversationId),
      20_000,
    );
    const deliveries = batchLog.filter((b) => b[0]?.conversationId === conversationId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.[0]?.kind).toBe('proactive');
  }, 60_000);
});
