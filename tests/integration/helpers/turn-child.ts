// Child entry for the T22 recovery drill: starts the kill-drill turn and
// blocks on it; the parent SIGKILLs us mid-slow_add, then recovers.
// The hooks import must stay first, and everything else loads dynamically:
// static imports would resolve src's `.js` specifiers before the hook exists.
import './ts-ext-hooks.ts';

// Own executor ID: the parent's DBOS.launch() must NOT auto-recover this
// child's pending workflow — 4.19.8 launch-time recovery races datasource
// initialization (see dbos.md). The parent resumes it explicitly instead.
process.env.DBOS__VMID = 'hh-turn-child';

const { handleTurnWorkflow, launchTurnRuntime } = await import('./turn-fixture.ts');
const { DBOS } = await import('@dbos-inc/dbos-sdk');

const [, , workflowId, conversationId] = process.argv;
if (!workflowId || !conversationId) {
  throw new Error('usage: turn-child.ts <workflowId> <conversationId>');
}

await launchTurnRuntime();
const handle = await DBOS.startWorkflow(handleTurnWorkflow, { workflowID: workflowId })(
  conversationId,
  [{ senderId: 'wife', payload: { text: 'script:kill-drill' } }],
);
await handle.getResult(); // never reached — parent kills us mid-slow_add
