// Child-process entry for the send-class kill gate: starts a deliverReply
// workflow and waits on it; the parent SIGKILLs this process mid-send. Runs
// under plain `node` (type stripping) — erasable syntax only.
//
// Own executor id so the parent's DBOS.launch() does NOT auto-recover this
// pending workflow (the 4.19.x launch-recovery race, dbos.md) — the parent
// resumes it explicitly. The env must be set before the SDK loads, hence
// dynamic imports.
process.env.DBOS__VMID = 'hh-sendclass-child';

const { deliverReplyWorkflow, launchSendClassRuntime } = await import('./send-class-fixture.ts');
const { DBOS } = await import('@dbos-inc/dbos-sdk');

const [workflowId, sendClass, idempotencyKey, conversationId, text] = process.argv.slice(2);
if (!workflowId || !sendClass || !idempotencyKey || !conversationId || !text) {
  throw new Error(
    'usage: node send-class-child.ts <workflowId> <sendClass> <idempotencyKey> <conversationId> <text>',
  );
}

await launchSendClassRuntime();
const handle = await DBOS.startWorkflow(deliverReplyWorkflow, { workflowID: workflowId })({
  sendClass: sendClass as 'at-least-once' | 'at-most-once',
  idempotencyKey,
  conversationId,
  text,
});
await handle.getResult(); // never reached — parent kills us mid-send
await DBOS.shutdown();
