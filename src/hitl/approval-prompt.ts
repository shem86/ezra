// T34: send the approval prompt(s) a parked turn produced and persist each
// send receipt as the action's prompt_message_id — the id a quoted reply
// carries back (T35's binding). Driven by the composer AFTER the turn
// workflow completes: sends are transport effects, not workflow steps, and
// "unstamped pending row" is the durable to-send marker, so a crash between
// turn and send is retried by the next call rather than lost. The rendered
// text matches the closing transcript message byte-for-byte (same renderer,
// same journaled values); the transport prepends the agent marker on the wire
// only (src/transport/agent-marker.ts) — the reply binding keys on the sent
// message id, not the text, so the marker does not affect it.

import { renderApprovalPrompt } from '../agent/prompts.js';
import { getPendingActionsForConversation, setPromptMessageId, type Queryable } from '../memory/store.js';
import type { Transport } from '../transport/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import { toDigestEntries } from './digest.js';

/**
 * Returns the action ids prompted this call, in row (created_at) order.
 * With a registry, the prompt line uses the tool's summarize() rendering
 * (T40); without one it stays the raw-args JSON.
 */
export async function sendApprovalPrompts<TDeps>(
  db: Queryable,
  transport: Pick<Transport, 'send'>,
  conversationId: string,
  registry?: ToolRegistry<TDeps>,
): Promise<string[]> {
  const pending = await getPendingActionsForConversation(db, conversationId);
  const unstamped = pending.filter((action) => action.promptMessageId === null);

  const prompted: string[] = [];
  for (const action of unstamped) {
    const [entry] = toDigestEntries([action], registry);
    const receipt = await transport.send({ conversationId, text: renderApprovalPrompt(entry!) });
    await setPromptMessageId(db, action.actionId, receipt.messageId);
    prompted.push(action.actionId);
  }
  return prompted;
}
