// Fixture for the T42 launch-recovery pass (ledger #1): workflow
// registrations shared by the vitest process and the kill-test child, so
// both carry identical names (recovery requirement). Module-level singletons
// are banned in src/ but fine in test fixtures (same exemption as spikes).
import './pin-appversion-launch.ts'; // must precede the SDK import
import { DBOS } from '@dbos-inc/dbos-sdk';
import { NodePostgresDataSource } from '@dbos-inc/node-pg-datasource';
import { registerTransactionalStep } from '../../../src/orchestration/steps.ts';
import { addListItem } from '../../../src/memory/store.ts';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required for the launch-recovery fixture');
}
export const launchRecoveryConnectionString: string = connectionString;

export const dataSource = new NodePostgresDataSource('launch-db', { connectionString });

const addItemStep = registerTransactionalStep(dataSource, 'launchAddItem', addListItem);

// Kill target (steps-fixture recipe): write, a durable sleep wide enough to
// SIGKILL into, write. The child dies mid-sleep with the workflow PENDING
// under the child's executor id — exactly the stranded shape the pass hunts.
async function strandedWriteWorkflowFn(list: string): Promise<string> {
  await addItemStep({ list, item: 'before-kill', addedBy: 'launch-test' });
  await DBOS.sleep(3000);
  await addItemStep({ list, item: 'after-kill', addedBy: 'launch-test' });
  return `completed-${list}`;
}
export const strandedWriteWorkflow = DBOS.registerWorkflow(strandedWriteWorkflowFn);

// In-flight bystander for the skip-own check: PENDING in THIS process while
// the pass runs — must never be re-enqueued by it.
async function slowNoopWorkflowFn(label: string): Promise<string> {
  await DBOS.sleep(2500);
  return `slow-${label}`;
}
export const slowNoopWorkflow = DBOS.registerWorkflow(slowNoopWorkflowFn);

export async function launchLaunchRecoveryRuntime(): Promise<void> {
  await NodePostgresDataSource.initializeDBOSSchema({ connectionString });
  DBOS.setConfig({ name: 'hh-launch-test', systemDatabaseUrl: connectionString });
  await DBOS.launch();
}
