// Child-process entry for the exactly-once kill test: starts the killable
// write workflow and waits on it; the parent SIGKILLs this process between
// the two transactional writes. Runs under plain `node` (type stripping),
// so everything it imports must be erasable-syntax only.
//
// The child runs under its own executor ID so the parent's DBOS.launch()
// does NOT auto-recover its pending workflow: 4.19.8 launch-time recovery
// races datasource initialization (see dbos.md) and can permanently error
// the workflow with "DataSource ... is not initialized". The parent instead
// resumes it explicitly after launch. The env must be set before the SDK
// loads, hence dynamic imports.
process.env.DBOS__VMID = 'hh-steps-child';

const { killableWriteWorkflow, launchStepsRuntime } = await import('./steps-fixture.ts');
const { DBOS } = await import('@dbos-inc/dbos-sdk');

const workflowId = process.argv[2];
const list = process.argv[3];
if (!workflowId || !list) {
  throw new Error('usage: node tests/integration/helpers/steps-child.ts <workflowId> <list>');
}

await launchStepsRuntime();
const handle = await DBOS.startWorkflow(killableWriteWorkflow, { workflowID: workflowId })(list);
await handle.getResult(); // never reached — parent kills us mid-sleep
await DBOS.shutdown();
