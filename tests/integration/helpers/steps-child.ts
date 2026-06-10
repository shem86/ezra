// Child-process entry for the exactly-once kill test: starts the killable
// write workflow and waits on it; the parent SIGKILLs this process between
// the two transactional writes. Runs under plain `node` (type stripping),
// so everything it imports must be erasable-syntax only.
import { killableWriteWorkflow, launchStepsRuntime } from './steps-fixture.ts';
import { DBOS } from '@dbos-inc/dbos-sdk';

const workflowId = process.argv[2];
const list = process.argv[3];
if (!workflowId || !list) {
  throw new Error('usage: node tests/integration/helpers/steps-child.ts <workflowId> <list>');
}

await launchStepsRuntime();
const handle = await DBOS.startWorkflow(killableWriteWorkflow, { workflowID: workflowId })(list);
await handle.getResult(); // never reached — parent kills us mid-sleep
await DBOS.shutdown();
