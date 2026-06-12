// Child entry for the T34 kill-mid-park drill: starts the parking turn and
// blocks on it; the parent SIGKILLs us inside slowPark's pre-write sleep,
// then recovers. The hooks import must stay first, and everything else loads
// dynamically: static imports would resolve src's `.js` specifiers before
// the hook exists.
import './ts-ext-hooks.ts';

// Own executor ID: the parent's DBOS.launch() must NOT auto-recover this
// child's pending workflow — 4.19.8 launch-time recovery races datasource
// initialization (see dbos.md). The parent resumes it explicitly instead.
process.env.DBOS__VMID = 'hh-park-child';

const { parkTurnWorkflow, launchParkRuntime } = await import('./park-fixture.ts');
const { DBOS } = await import('@dbos-inc/dbos-sdk');

const [, , workflowId, conversationId] = process.argv;
if (!workflowId || !conversationId) {
  throw new Error('usage: park-child.ts <workflowId> <conversationId>');
}

await launchParkRuntime();
const handle = await DBOS.startWorkflow(parkTurnWorkflow, { workflowID: workflowId })(
  conversationId,
  [{ senderId: 'wife', payload: { text: 'propose the dentist event' } }],
);
await handle.getResult(); // never reached — parent kills us mid-park
