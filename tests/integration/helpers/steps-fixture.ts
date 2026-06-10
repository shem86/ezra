// Shared by the integration test (vitest) and the kill-test child (plain
// node): workflow and transaction registrations must carry identical names
// in every process that may recover them, so they live in one module.
// Module-level singletons are banned in src/ but fine in test fixtures
// (same exemption as spikes).
import './pin-appversion.ts'; // must precede the SDK import
import { DBOS } from '@dbos-inc/dbos-sdk';
import { NodePostgresDataSource } from '@dbos-inc/node-pg-datasource';
import {
  deriveIdempotencyKey,
  registerTransactionalStep,
} from '../../../src/orchestration/steps.ts';
import { addListItem, recordSend } from '../../../src/memory/store.ts';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required for the steps integration fixture');
}
export const stepsConnectionString: string = connectionString;

export const dataSource = new NodePostgresDataSource('steps-db', { connectionString });

// Structured-state writes go through the T19 helper — the thing under test.
const addItemStep = registerTransactionalStep(dataSource, 'addItemStep', addListItem);
const recordSendStep = registerTransactionalStep(dataSource, 'recordSendStep', recordSend);

// Kill target: write, a durable sleep wide enough to SIGKILL into, write.
async function killableWriteWorkflowFn(list: string): Promise<string> {
  await addItemStep({ list, item: 'before-kill', addedBy: 'steps-test' });
  await DBOS.sleep(3000);
  await addItemStep({ list, item: 'after-kill', addedBy: 'steps-test' });
  return `completed-${list}`;
}
export const killableWriteWorkflow = DBOS.registerWorkflow(killableWriteWorkflowFn);

async function singleWriteWorkflowFn(list: string): Promise<string> {
  await addItemStep({ list, item: 'once', addedBy: 'steps-test' });
  return `done-${list}`;
}
export const singleWriteWorkflow = DBOS.registerWorkflow(singleWriteWorkflowFn);

// External effect guarded by a (workflowID, stepNumber)-derived key: a
// replay regenerates the same key and the effect log dedupes it.
async function guardedSendWorkflowFn(conversationId: string): Promise<boolean> {
  const key = deriveIdempotencyKey(DBOS.workflowID ?? '', 1);
  return recordSendStep({
    idempotencyKey: key,
    conversationId,
    deliveryClass: 'at-least-once',
    body: { text: 'steps-test effect' },
  });
}
export const guardedSendWorkflow = DBOS.registerWorkflow(guardedSendWorkflowFn);

export async function launchStepsRuntime(): Promise<void> {
  // Idempotent: installs dbos.transaction_completion, the checkpoint table
  // that makes a transactional step's write atomic with its step record.
  await NodePostgresDataSource.initializeDBOSSchema({ connectionString });
  // Journal deliberately co-located with app state (one Postgres) — the
  // co-commit is the exactly-once guarantee.
  DBOS.setConfig({ name: 'hh-steps-test', systemDatabaseUrl: connectionString });
  await DBOS.launch();
}
