// Child-process entry for the kill-mid-flight test: starts killableWorkflow
// and waits on it; the parent SIGKILLs this process between effect A and B.
import { DBOS } from '@dbos-inc/dbos-sdk';
import { killableWorkflow, launchSpikeRuntime, setupSpikeTables } from './spike.ts';

const workflowId = process.argv[2];
if (!workflowId) {
  throw new Error('usage: node spikes/dbos/child.ts <workflowId>');
}

await setupSpikeTables();
await launchSpikeRuntime();
const handle = await DBOS.startWorkflow(killableWorkflow, { workflowID: workflowId })(workflowId);
await handle.getResult(); // never reached — parent kills us mid-sleep
await DBOS.shutdown();
