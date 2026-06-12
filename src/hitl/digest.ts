// T34: pending_actions rows → the system-prompt digest slot (SPEC "one
// lane": turn assembly injects outstanding actions every turn so the model
// knows what is in flight). Pure mapping — callers read the rows inside a
// journaled step and render via renderPendingActionsDigest.

import { toolCallSchema } from '../agent/context.js';
import type { PendingActionDigestEntry } from '../agent/prompts.js';
import type { PendingAction } from '../memory/store.js';
import type { ToolRegistry } from '../tools/registry.js';

/**
 * With a registry, a tool's `summarize` hook renders the proposal line
 * humanly (T40, deferred from T34). Every degradation — no registry, unknown
 * tool, no hook, stored args drifted off the schema, a throwing hook — falls
 * back to the raw-args JSON: the digest renders something for every row,
 * never throws. Summaries stay deterministic (pure hook, journaled args).
 */
export function toDigestEntries<TDeps>(
  actions: readonly PendingAction[],
  registry?: ToolRegistry<TDeps>,
): PendingActionDigestEntry[] {
  return actions.map((action) => {
    const parsed = toolCallSchema.safeParse(action.toolCall);
    let summary = JSON.stringify(parsed.success ? parsed.data.args : action.toolCall);
    if (parsed.success && registry !== undefined) {
      const def = registry.get(parsed.data.name);
      const args = def?.summarize === undefined ? undefined : def.schema.safeParse(parsed.data.args);
      if (def?.summarize !== undefined && args?.success === true) {
        try {
          summary = def.summarize(args.data);
        } catch {
          // keep the JSON fallback
        }
      }
    }
    return {
      actionId: action.actionId,
      toolName: parsed.success ? parsed.data.name : 'unknown',
      summary,
      expiresAt: action.expiresAt,
    };
  });
}
