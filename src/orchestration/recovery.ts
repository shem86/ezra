// Launch-recovery pass (T42, ledger #1). DBOS 4.19.x launch-time recovery
// races datasource initialization: a recovered workflow's first un-journaled
// transaction can throw "DataSource <name> is not initialized" and error the
// workflow PERMANENTLY (dbos.md ⚠). Production therefore scopes each process
// generation to its own executor id (src/start.ts sets DBOS__VMID before the
// SDK loads), which makes launch-time auto-recovery a no-op — and this pass,
// called explicitly AFTER launch (datasources initialized), is what actually
// rescues work stranded by the previous generation's crash.

import { DBOS } from '@dbos-inc/dbos-sdk';

/**
 * Resume every root workflow left PENDING by a prior process generation.
 * Children replay through their parents, so only roots are resumed; the
 * current generation's in-flight work is skipped (it is running, not
 * stranded), as are other application versions (resuming them would enqueue
 * work no executor here can ever run — a deploy-time concern, not a crash;
 * see the T45 runbook note). Returns the resumed workflow ids.
 */
export async function resumeStrandedWorkflows(): Promise<string[]> {
  const pending = await DBOS.listWorkflows({ status: 'PENDING', hasParent: false });
  const stranded = pending.filter(
    (workflow) =>
      workflow.executorId !== DBOS.executorID &&
      (workflow.applicationVersion === undefined ||
        workflow.applicationVersion === DBOS.applicationVersion),
  );
  for (const workflow of stranded) {
    // Re-enqueues the non-terminal workflow; replay skips journaled steps.
    await DBOS.resumeWorkflow(workflow.workflowID);
  }
  return stranded.map((workflow) => workflow.workflowID);
}
