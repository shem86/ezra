// T34: pending_actions rows → the system-prompt digest slot (SPEC "one
// lane": turn assembly injects outstanding actions every turn so the model
// knows what is in flight). Pure mapping — callers read the rows inside a
// journaled step and render via renderPendingActionsDigest.

import { toolCallSchema } from '../agent/context.js';
import type { PendingActionDigestEntry } from '../agent/prompts.js';
import type { PendingAction } from '../memory/store.js';

export function toDigestEntries(
  actions: readonly PendingAction[],
): PendingActionDigestEntry[] {
  return actions.map((action) => {
    const parsed = toolCallSchema.safeParse(action.toolCall);
    return {
      actionId: action.actionId,
      toolName: parsed.success ? parsed.data.name : 'unknown',
      // Raw args as the proposal line: model-facing and deterministic. A
      // per-tool human renderer can land with the first real confirm-before
      // tool (T40); a malformed row degrades to its JSON, never throws.
      summary: JSON.stringify(parsed.success ? parsed.data.args : action.toolCall),
      expiresAt: action.expiresAt,
    };
  });
}
