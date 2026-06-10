// Fixture for the T24 HITL execute-once gate. Module-level singletons are
// banned in src/ but fine in test fixtures (same exemption as spikes).
import './pin-appversion-recovery.ts'; // must precede the SDK import
import { DBOS } from '@dbos-inc/dbos-sdk';
import { NodePostgresDataSource } from '@dbos-inc/node-pg-datasource';
import { registerTransactionalStep } from '../../../src/orchestration/steps.ts';
import { claimForExecution, markApproved } from '../../../src/hitl/pending-actions.ts';
import { addListItem } from '../../../src/memory/store.ts';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required for the recovery integration fixture');
}
export const recoveryConnectionString: string = connectionString;

export const dataSource = new NodePostgresDataSource('recovery-db', { connectionString });

const markApprovedStep = registerTransactionalStep(dataSource, 'markApproved', markApproved);

// The execute-once core: the approved→executed claim and the effect commit
// in ONE transaction — whichever duplicate loses the claim writes nothing.
const claimAndExecuteStep = registerTransactionalStep(
  dataSource,
  'claimAndExecute',
  async (db, actionId: string, list: string): Promise<boolean> => {
    const claimed = await claimForExecution(db, actionId);
    if (claimed === null) return false;
    await addListItem(db, { list, item: 'executed', addedBy: 'hitl' });
    return true;
  },
);

// One approval event end-to-end. Duplicate approvals are duplicate EVENTS —
// distinct workflowIDs — so workflow-level dedupe cannot help; only the
// status-transition guard in the database can.
async function approvalFn(actionId: string, list: string): Promise<boolean> {
  // Guarded pending→approved; a duplicate finding it already approved (or
  // executed) proceeds — the claim below is the single arbiter.
  await markApprovedStep(actionId);
  return claimAndExecuteStep(actionId, list);
}
export const approvalWorkflow = DBOS.registerWorkflow(approvalFn, { name: 'approvalWorkflow' });

export async function launchRecoveryRuntime(): Promise<void> {
  await NodePostgresDataSource.initializeDBOSSchema({ connectionString });
  DBOS.setConfig({ name: 'hh-recovery-test', systemDatabaseUrl: connectionString });
  await DBOS.launch();
}
