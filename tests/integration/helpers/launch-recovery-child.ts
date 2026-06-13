// Child-process entry for the launch-recovery pass test: starts the
// stranded-write workflow and waits on it; the parent SIGKILLs this process
// mid-sleep. Runs under plain `node` (type stripping) — erasable syntax only.
//
// The child runs under its own executor ID so the parent's DBOS.launch()
// does NOT auto-recover its pending workflow (the 4.19.x launch-recovery
// race, dbos.md). In production the same per-generation id is what strands
// the workflow — and src/orchestration/recovery.ts is the cure under test.
// The env must be set before the SDK loads, hence dynamic imports.
process.env.DBOS__VMID = 'hh-launch-child';

const { strandedWriteWorkflow, launchLaunchRecoveryRuntime } = await import(
  './launch-recovery-fixture.ts'
);
const { DBOS } = await import('@dbos-inc/dbos-sdk');

const workflowId = process.argv[2];
const list = process.argv[3];
if (!workflowId || !list) {
  throw new Error(
    'usage: node tests/integration/helpers/launch-recovery-child.ts <workflowId> <list>',
  );
}

await launchLaunchRecoveryRuntime();
const handle = await DBOS.startWorkflow(strandedWriteWorkflow, { workflowID: workflowId })(list);
await handle.getResult(); // never reached — parent kills us mid-sleep
await DBOS.shutdown();
