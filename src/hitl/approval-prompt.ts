// T34: send the approval prompt(s) a parked turn produced and persist each
// send receipt as the action's prompt_message_id — the id a quoted reply
// carries back (T35's binding). Driven by the composer AFTER the turn
// workflow completes: sends are transport effects, not workflow steps, and
// "unstamped pending row" is the durable to-send marker, so a crash between
// turn and send is retried by the next call rather than lost. The rendered
// text matches the closing transcript message byte-for-byte (same renderer,
// same journaled values).

import { renderApprovalPrompt } from '../agent/prompts.js';
import { getPendingActionsForConversation, setPromptMessageId, type Queryable } from '../memory/store.js';
import type { Transport } from '../transport/types.js';
import { toDigestEntries } from './digest.js';

/** Returns the action ids prompted this call, in row (created_at) order. */
export async function sendApprovalPrompts(
  db: Queryable,
  transport: Pick<Transport, 'send'>,
  conversationId: string,
): Promise<string[]> {
  const pending = await getPendingActionsForConversation(db, conversationId);
  const unstamped = pending.filter((action) => action.promptMessageId === null);

  const prompted: string[] = [];
  for (const action of unstamped) {
    const [entry] = toDigestEntries([action]);
    const receipt = await transport.send({ conversationId, text: renderApprovalPrompt(entry!) });
    await setPromptMessageId(db, action.actionId, receipt.messageId);
    prompted.push(action.actionId);
  }
  return prompted;
}
