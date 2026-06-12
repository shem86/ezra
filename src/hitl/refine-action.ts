// Refine (T36, architecture decision 10): "make it 4pm" updates the pending
// row's serialized tool_call while status STAYS 'pending' — refinement is
// pre-execution, so there is no idempotency hazard, and the T24/T35 guards
// still arbitrate the eventual approve. Clearing prompt_message_id re-arms
// the T34 composer marker: an unstamped pending row is "approval prompt needs
// sending", so the updated proposal goes out and re-stamps through the exact
// path the original prompt used. The composer wraps this body in
// registerTransactionalStep like the resolver.

import { toolCallSchema } from '../agent/context.js';
import { getPendingAction, type PendingActionStatus, type Queryable } from '../memory/store.js';
import type { ToolRegistry } from '../tools/registry.js';

export interface RefineActionInput {
  readonly conversationId: string;
  readonly actionId: string;
  /** The FULL replacement args object (not a patch) — validated against the tool's schema. */
  readonly updatedArgs: unknown;
}

export type RefineOutcome =
  /** Unknown or cross-conversation action id — a normal turn. */
  | { readonly kind: 'unbound' }
  /** Args fail the tool's schema (or the stored call is unusable) — action untouched. */
  | { readonly kind: 'invalid'; readonly actionId: string; readonly toolName: string }
  | {
      readonly kind: 'refined';
      readonly actionId: string;
      readonly toolName: string;
      /** Deterministic proposal line for the re-prompt — same shape as the digest. */
      readonly summary: string;
    }
  /** The action settled before the refinement landed. */
  | {
      readonly kind: 'already-resolved';
      readonly actionId: string;
      readonly status: PendingActionStatus;
    };

export function makeRefineAction<TDeps>(
  registry: ToolRegistry<TDeps>,
): (db: Queryable, input: RefineActionInput) => Promise<RefineOutcome> {
  return async function refineAction(db, input) {
    const action = await getPendingAction(db, input.actionId);
    if (action === null || action.conversationId !== input.conversationId) {
      return { kind: 'unbound' };
    }

    // A stored call that no longer parses or names a missing tool can't be
    // refined; leave it alone (never auto-deny) — it goes stale at approval.
    const call = toolCallSchema.safeParse(action.toolCall);
    const def = call.success ? registry.get(call.data.name) : undefined;
    if (!call.success || def === undefined) {
      return {
        kind: 'invalid',
        actionId: action.actionId,
        toolName: call.success ? call.data.name : 'unknown',
      };
    }

    // Zod at the boundary: classifier output never reaches the row unchecked.
    const args = def.schema.safeParse(input.updatedArgs);
    if (!args.success) {
      return { kind: 'invalid', actionId: action.actionId, toolName: call.data.name };
    }

    // Same tool_use id and name — the action keeps its identity (actionId
    // derives from the id); only the args change. Guarded on 'pending' so a
    // concurrent settle wins and the refinement reports already-resolved.
    const updatedCall = { id: call.data.id, name: call.data.name, args: args.data };
    const res = await db.query(
      `UPDATE pending_actions SET tool_call = $2::jsonb, prompt_message_id = NULL
       WHERE action_id = $1 AND status = 'pending' RETURNING action_id`,
      [action.actionId, JSON.stringify(updatedCall)],
    );
    if (res.rows.length === 0) {
      const statusRes = await db.query('SELECT status FROM pending_actions WHERE action_id = $1', [
        action.actionId,
      ]);
      return {
        kind: 'already-resolved',
        actionId: action.actionId,
        status: statusRes.rows[0]!.status as PendingActionStatus,
      };
    }

    return {
      kind: 'refined',
      actionId: action.actionId,
      toolName: call.data.name,
      summary: JSON.stringify(args.data),
    };
  };
}
