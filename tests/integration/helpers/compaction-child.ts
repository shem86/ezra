// Child entry for the T29 kill drill: runs one over-threshold turn and
// blocks; the parent SIGKILLs us inside the compacted-persist sleep — after
// the semantic write committed, before the truncation did.
// The hooks import must stay first, and everything else loads dynamically:
// static imports would resolve src's `.js` specifiers before the hook exists.
import './ts-ext-hooks.ts';

// Own executor ID: the parent's DBOS.launch() must NOT auto-recover this
// child's pending workflow — 4.19.8 launch-time recovery races datasource
// initialization (see dbos.md). The parent resumes it explicitly instead.
process.env.DBOS__VMID = 'hh-compaction-child';

const { compactingTurnWorkflow, launchCompactionRuntime } = await import(
  './compaction-fixture.ts'
);
const { DBOS } = await import('@dbos-inc/dbos-sdk');

const [, , workflowId, conversationId] = process.argv;
if (!workflowId || !conversationId) {
  throw new Error('usage: compaction-child.ts <workflowId> <conversationId>');
}

await launchCompactionRuntime();
const handle = await DBOS.startWorkflow(compactingTurnWorkflow, { workflowID: workflowId })(
  conversationId,
  [{ senderId: 'wife', payload: { text: 'one more message' } }],
);
await handle.getResult(); // never reached — parent kills us mid-persist-sleep
