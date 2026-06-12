// T34: pending_actions rows → the system-prompt digest slot (SPEC "one
// lane": turn assembly injects outstanding actions every turn so the model
// knows what is in flight). Pure mapping — callers read the rows inside a
// journaled step and render via renderPendingActionsDigest.

import { toolCallSchema } from '../agent/context.js';
import type { PendingActionDigestEntry } from '../agent/prompts.js';
import type { PendingAction } from '../memory/store.js';
import type { ToolRegistry } from '../tools/registry.js';

/**
 * The ONE proposal-line renderer (T40, deferred from T34): a tool's
 * `summarize` hook when the registry carries it, raw-args JSON otherwise.
 * Used by the digest, by sendApprovalPrompts, AND by handleTurn's closing
 * message — one renderer is what keeps the sent prompt byte-identical to
 * the journaled transcript. Pure function of journaled values (replay-safe);
 * every degradation — no registry, unknown tool, no hook, args drifted off
 * the schema, a throwing hook — falls back to the JSON, never throws.
 */
export function summarizeToolCall<TDeps>(
  registry: ToolRegistry<TDeps> | undefined,
  name: string,
  args: unknown,
): string {
  const def = registry?.get(name);
  if (def?.summarize !== undefined) {
    const parsed = def.schema.safeParse(args);
    if (parsed.success) {
      try {
        return def.summarize(parsed.data);
      } catch {
        // fall through to the JSON fallback
      }
    }
  }
  return JSON.stringify(args);
}

export function toDigestEntries<TDeps>(
  actions: readonly PendingAction[],
  registry?: ToolRegistry<TDeps>,
): PendingActionDigestEntry[] {
  return actions.map((action) => {
    const parsed = toolCallSchema.safeParse(action.toolCall);
    return {
      actionId: action.actionId,
      toolName: parsed.success ? parsed.data.name : 'unknown',
      summary: parsed.success
        ? summarizeToolCall(registry, parsed.data.name, parsed.data.args)
        : JSON.stringify(action.toolCall),
      expiresAt: action.expiresAt,
    };
  });
}
