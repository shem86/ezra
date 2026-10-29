// Child entry for the routed recovery drill (turn-routing plan Phase 3):
// starts a routed kill-drill turn and blocks on it; the parent SIGKILLs us
// mid-slow_add — AFTER the routeTurn step has journaled its tier — then
// resumes and asserts the replay reuses that tier without asking Jev again.
// Same shape as turn-child.ts: hooks first, everything else dynamic.
import './ts-ext-hooks.ts';

// Own executor ID so the parent's launch never auto-recovers this workflow
// (4.19.8 launch-time recovery races datasource init — see dbos.md).
process.env.DBOS__VMID = 'hh-turn-route-child';

const { routedTurnWorkflow, launchTurnRuntime } = await import('./turn-fixture.ts');
const { DBOS } = await import('@dbos-inc/dbos-sdk');

const [, , workflowId, conversationId, text] = process.argv;
if (!workflowId || !conversationId || !text) {
  throw new Error('usage: turn-route-child.ts <workflowId> <conversationId> <text>');
}

await launchTurnRuntime();
const handle = await DBOS.startWorkflow(routedTurnWorkflow, { workflowID: workflowId })(
  conversationId,
  [{ senderId: 'wife', payload: { text } }],
);
await handle.getResult(); // never reached — parent kills us mid-slow_add
