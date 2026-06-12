// Fixture for the T23 scheduled-reminder sweep: real DBOS scheduler + the
// T21 conversation lane against Postgres. Module-level singletons are banned
// in src/ but fine in test fixtures (same exemption as spikes).
import './pin-appversion-sched.ts'; // must precede the SDK import
import { DBOS, SchedulerMode } from '@dbos-inc/dbos-sdk';
import { NodePostgresDataSource } from '@dbos-inc/node-pg-datasource';
import { registerTransactionalStep } from '../../../src/orchestration/steps.ts';
import {
  makeConversationEnqueueWorkflow,
  makeDrainWorkflow,
  registerConversationQueue,
} from '../../../src/orchestration/queue.ts';
import { makeReminderSweepWorkflow, type DueReminder } from '../../../src/orchestration/scheduled.ts';
import {
  makeExpirySweepWorkflow,
  toOverdueActions,
  type OverdueAction,
} from '../../../src/hitl/expiry.ts';
import { markExpired } from '../../../src/hitl/pending-actions.ts';
import {
  getOverduePendingActions,
  getPendingInbox,
  insertInboxItem,
  markInboxProcessed,
  markReminderFired,
  type InboxItem,
} from '../../../src/memory/store.ts';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required for the scheduled integration fixture');
}
export const schedConnectionString: string = connectionString;

// All conversations (and so all reminders) this file touches share this
// prefix; the sweep's getDue is scoped to it so the every-second cron here
// can never fire reminders seeded by OTHER test files on the shared dev DB.
export const schedRunId = `sched-${Date.now()}`;

export const dataSource = new NodePostgresDataSource('sched-db', { connectionString });

const insertItemStep = registerTransactionalStep(dataSource, 'insertInboxItem', insertInboxItem);
const readPendingStep = registerTransactionalStep(dataSource, 'getPendingInbox', getPendingInbox);
const markProcessedStep = registerTransactionalStep(
  dataSource,
  'markInboxProcessed',
  markInboxProcessed,
);

const getDueScopedStep = registerTransactionalStep(
  dataSource,
  'getDueScoped',
  async (db, asOfMs: number): Promise<DueReminder[]> => {
    const res = await db.query(
      `SELECT id, conversation_id, body, due_at FROM reminders
       WHERE status = 'scheduled' AND due_at <= $1 AND conversation_id LIKE $2
       ORDER BY due_at, id`,
      [new Date(asOfMs), `conv-${schedRunId}%`],
    );
    return res.rows.map((row) => ({
      id: row.id as string,
      conversationId: row.conversation_id as string,
      body: row.body as string,
      dueAtIso: (row.due_at as Date).toISOString(),
    }));
  },
);

const markFiredStep = registerTransactionalStep(dataSource, 'markReminderFired', markReminderFired);

// Batch observability: arrival order of starts and completions, keyed by
// kind + conversation. The 'slow' human payload holds its drain (and so the
// conversation partition) long enough for a proactive item to queue behind.
export const startedLog: string[] = [];
export const completedLog: string[] = [];
export const batchLog: InboxItem[][] = [];

function batchKey(batch: InboxItem[]): string {
  return `${batch[0]?.kind}:${batch[0]?.conversationId}`;
}

const processBatchStep = DBOS.registerStep(
  async function processBatch(batch: InboxItem[]): Promise<void> {
    startedLog.push(batchKey(batch));
    const text = (batch[0]?.payload as { text?: string } | null)?.text;
    if (batch[0]?.kind === 'human' && text === 'slow') {
      await new Promise((r) => setTimeout(r, 4000));
    }
    batchLog.push(batch);
    completedLog.push(batchKey(batch));
  },
  { name: 'processBatch' },
);

export const drainWorkflow = DBOS.registerWorkflow(
  makeDrainWorkflow({
    readPending: readPendingStep,
    processBatch: processBatchStep,
    markProcessed: markProcessedStep,
    silenceWindowMs: 1000,
    maxQuietWaitMs: 8000,
  }),
);

export const enqueueWorkflow = DBOS.registerWorkflow(
  makeConversationEnqueueWorkflow({
    insertItem: insertItemStep,
    drainWorkflow,
  }),
);

const sweepDeps = {
  getDue: getDueScopedStep,
  markFired: markFiredStep,
  enqueueWorkflow,
};

export const sweepWorkflow = DBOS.registerWorkflow(makeReminderSweepWorkflow(sweepDeps), {
  name: 'reminderSweep',
});

// The cron registration drives the same sweep logic on an every-second
// schedule. WhenActive: no make-up backfill from scheduler state left by
// earlier test runs. Scheduled workflows register BEFORE launch (dbos.md),
// and the function handed to registerScheduled must ALREADY be a registered
// workflow — a raw function logs "@scheduled but not a workflow" every tick
// and never runs.
const sweepCronWorkflow = DBOS.registerWorkflow(makeReminderSweepWorkflow(sweepDeps), {
  name: 'reminderSweepCron',
});
DBOS.registerScheduled(sweepCronWorkflow, {
  crontab: '* * * * * *',
  mode: SchedulerMode.ExactlyOncePerIntervalWhenActive,
  name: 'reminderSweepCron',
});

// --- T37 expiry sweep: same lane, same fixture discipline ------------------

// Scoped like getDueScoped: the every-second cron here must never expire
// pending actions seeded by OTHER test files on the shared dev DB.
const getOverdueScopedStep = registerTransactionalStep(
  dataSource,
  'getOverdueScoped',
  async (db, asOfMs: number): Promise<OverdueAction[]> =>
    toOverdueActions(await getOverduePendingActions(db, asOfMs)).filter((action) =>
      action.conversationId.startsWith(`conv-${schedRunId}`),
    ),
);

const markExpiredStep = registerTransactionalStep(dataSource, 'markExpired', markExpired);

const expiryDeps = {
  getOverdue: getOverdueScopedStep,
  markExpired: markExpiredStep,
  enqueueWorkflow,
};

export const expirySweepWorkflow = DBOS.registerWorkflow(makeExpirySweepWorkflow(expiryDeps), {
  name: 'expirySweep',
});

const expirySweepCronWorkflow = DBOS.registerWorkflow(makeExpirySweepWorkflow(expiryDeps), {
  name: 'expirySweepCron',
});
DBOS.registerScheduled(expirySweepCronWorkflow, {
  crontab: '* * * * * *',
  mode: SchedulerMode.ExactlyOncePerIntervalWhenActive,
  name: 'expirySweepCron',
});

export async function launchSchedRuntime(): Promise<void> {
  await NodePostgresDataSource.initializeDBOSSchema({ connectionString });
  DBOS.setConfig({ name: 'hh-sched-test', systemDatabaseUrl: connectionString });
  await DBOS.launch();
  // Queue registration must follow launch on 4.19.x (throws before).
  await registerConversationQueue();
}
