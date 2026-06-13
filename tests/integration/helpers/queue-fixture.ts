// Fixture for the T21 conversation lane: real DBOS queue + drain workflows
// against Postgres. Module-level singletons are banned in src/ but fine in
// test fixtures (same exemption as spikes).
import './pin-appversion-queue.ts'; // must precede the SDK import
import { DBOS } from '@dbos-inc/dbos-sdk';
import { NodePostgresDataSource } from '@dbos-inc/node-pg-datasource';
import { registerTransactionalStep } from '../../../src/orchestration/steps.ts';
import {
  makeConversationEnqueueWorkflow,
  makeDrainWorkflow,
  registerConversationQueue,
} from '../../../src/orchestration/queue.ts';
import {
  getPendingInbox,
  insertInboxItem,
  markInboxProcessed,
  type InboxItem,
} from '../../../src/memory/store.ts';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required for the queue integration fixture');
}
export const queueConnectionString: string = connectionString;

export const dataSource = new NodePostgresDataSource('queue-db', { connectionString });

const insertItemStep = registerTransactionalStep(dataSource, 'insertInboxItem', insertInboxItem);
const readPendingStep = registerTransactionalStep(dataSource, 'getPendingInbox', getPendingInbox);
const markProcessedStep = registerTransactionalStep(
  dataSource,
  'markInboxProcessed',
  markInboxProcessed,
);

// Stand-in for the T22 turn: record each batch the drain hands over, in
// arrival order. In-memory is fine — assertions run in this same process and
// these tests never replay across processes.
export const batchLog: InboxItem[][] = [];
const processBatchStep = DBOS.registerStep(
  async function processBatch(batch: InboxItem[]): Promise<void> {
    batchLog.push(batch);
  },
  { name: 'processBatch' },
);
// Registered as a WORKFLOW (not a bare step) to mirror the production
// composition, where processBatch is the processTurnBatch child workflow —
// the workflow wrapper is the only dep kind that rejects a bound `this`.
const processBatchWorkflow = DBOS.registerWorkflow(
  async function processTurnBatch(batch: InboxItem[]): Promise<void> {
    await processBatchStep(batch);
  },
  { name: 'processTurnBatch' },
);

// Short silence window keeps the suite fast while staying far above the
// few-ms spread of a scripted bubble burst.
export const silenceWindowMs = 1000;

export const drainWorkflow = DBOS.registerWorkflow(
  makeDrainWorkflow({
    readPending: readPendingStep,
    processBatch: processBatchWorkflow,
    markProcessed: markProcessedStep,
    silenceWindowMs,
    maxQuietWaitMs: 8000,
  }),
);

export const enqueueWorkflow = DBOS.registerWorkflow(
  makeConversationEnqueueWorkflow({
    insertItem: insertItemStep,
    drainWorkflow,
  }),
);

export async function launchQueueRuntime(): Promise<void> {
  await NodePostgresDataSource.initializeDBOSSchema({ connectionString });
  DBOS.setConfig({ name: 'hh-queue-test', systemDatabaseUrl: connectionString });
  await DBOS.launch();
  // Queue registration must follow launch on 4.19.x (throws before).
  await registerConversationQueue();
}
