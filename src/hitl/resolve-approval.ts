// Approval resolution (T35, architecture decision 10 step 5): the body the
// composer wraps in registerTransactionalStep when a turn's batch carries a
// quoted reply. Everything — the guard flip, the revalidation verdict, the
// executed→ claim, and the tool's own writes — happens on one transaction-
// scoped client, so the claim co-commits with the effect: a crash anywhere
// rolls the whole resolution back and recovery replays it from 'pending'.
//
// Single-winner does NOT rely on the conversation queue: markApproved /
// markDenied / claimForExecution are guarded UPDATEs, and Postgres row
// locking serializes concurrent transactions on the row — the loser's flip
// matches zero rows and reports 'already-resolved'.
//
// T36 adds a second entry point: a classified non-quoted message resolves by
// action id (the workflow's journaled digest read supplies it) and runs the
// SAME settle core — the classifier decides what a message means, never how
// an approval executes.

import { toolCallSchema } from '../agent/context.js';
import {
  getActionByPromptMessageId,
  getPendingAction,
  type PendingAction,
  type PendingActionStatus,
  type Queryable,
} from '../memory/store.js';
import type { ToolRegistry } from '../tools/registry.js';
import {
  claimForExecution,
  markApproved,
  markDenied,
  markStale,
  returnToPending,
} from './pending-actions.js';
import { interpretApprovalReply } from './approval-binding.js';

export type ApprovalDecision = 'approve' | 'deny';

export interface ApprovalReplyInput {
  readonly conversationId: string;
  /** The quoted message's id — matched against the stamped prompt_message_id. */
  readonly quotedMessageId: string;
  readonly text: string;
}

/** A classified (non-quoted) approve/deny — T36 routes these by action id. */
export interface ClassifiedDecisionInput {
  readonly conversationId: string;
  readonly actionId: string;
  readonly decision: ApprovalDecision;
}

export type ApprovalOutcome =
  /** The quote doesn't match any approval prompt — a normal turn. */
  | { readonly kind: 'unbound' }
  /** Bound, but the reply is not a clean yes/no — normal turn, action untouched. */
  | { readonly kind: 'unclear'; readonly actionId: string }
  | {
      readonly kind: 'executed';
      readonly actionId: string;
      readonly toolName: string;
      readonly result: string;
    }
  | { readonly kind: 'denied'; readonly actionId: string; readonly toolName: string }
  /** Approved, but revalidation failed (or the stored call no longer parses). */
  | { readonly kind: 'stale'; readonly actionId: string; readonly toolName: string }
  /**
   * The tool's external call failed transiently (T40 ledger #5) — the row is
   * back to pending and a re-approval retries. Distinct from 'stale': the
   * proposal itself is still valid.
   */
  | {
      readonly kind: 'failed';
      readonly actionId: string;
      readonly toolName: string;
      readonly message: string;
    }
  /** The action was already settled when this reply arrived. */
  | {
      readonly kind: 'already-resolved';
      readonly actionId: string;
      readonly status: PendingActionStatus;
    };

export interface ResolveApprovalDeps<TDeps> {
  readonly toolDeps: TDeps;
}

async function currentStatus(db: Queryable, actionId: string): Promise<PendingActionStatus> {
  const res = await db.query('SELECT status FROM pending_actions WHERE action_id = $1', [actionId]);
  return res.rows[0]!.status as PendingActionStatus;
}

/**
 * The shared settle core: every approve/deny — whether it arrived as a
 * quoted reply (T35) or a classified non-quoted message (T36) — runs the
 * SAME guarded transitions, revalidation, and claim+execute co-commit.
 */
async function settleDecision<TDeps>(
  db: Queryable,
  registry: ToolRegistry<TDeps>,
  deps: ResolveApprovalDeps<TDeps>,
  action: PendingAction,
  decision: ApprovalDecision,
): Promise<ApprovalOutcome> {
  if (decision === 'deny') {
    if (!(await markDenied(db, action.actionId))) {
      return {
        kind: 'already-resolved',
        actionId: action.actionId,
        status: await currentStatus(db, action.actionId),
      };
    }
    const call = toolCallSchema.safeParse(action.toolCall);
    return {
      kind: 'denied',
      actionId: action.actionId,
      toolName: call.success ? call.data.name : 'unknown',
    };
  }

  // Approve. The flip is the single-winner gate: a duplicate approval —
  // sequential or concurrent — finds a non-pending row and stops here.
  if (!(await markApproved(db, action.actionId))) {
    return {
      kind: 'already-resolved',
      actionId: action.actionId,
      status: await currentStatus(db, action.actionId),
    };
  }

  // A stored call that no longer parses (tool removed, schema tightened
  // since the park) is by definition no longer valid — same terminal state
  // as a failed revalidation, never a throw that bricks the reply turn.
  const call = toolCallSchema.safeParse(action.toolCall);
  const def = call.success ? registry.get(call.data.name) : undefined;
  const args =
    call.success && def !== undefined ? def.schema.safeParse(call.data.args) : undefined;
  if (!call.success || def === undefined || args === undefined || !args.success) {
    await markStale(db, action.actionId);
    return {
      kind: 'stale',
      actionId: action.actionId,
      toolName: call.success ? call.data.name : 'unknown',
    };
  }

  const idCtx = {
    actionId: action.actionId,
    conversationId: action.conversationId,
    toolUseId: call.data.id,
  };
  const externalId = def.externalId?.(idCtx);

  // From here the tool's own code runs (revalidate, then execute) — for an
  // external tool both can fail transiently (T40 ledger #5). A throw must not
  // abort the reply turn: fold it into a 'failed' outcome and return the row
  // to pending so a re-approval retries. The fold runs inside the same
  // transaction as the flips, so the row never visibly left 'pending'; if
  // the transaction itself is broken, the rollback lands on pending anyway.
  try {
    // Revalidate at execute time, not propose time — the approval window is
    // long (T26 carried the hook; this is its first real call site). The id
    // context rides along so the check can exempt the action's own external id.
    const stillValid =
      def.revalidate === undefined
        ? true
        : await def.revalidate(args.data, deps.toolDeps, {
            ...idCtx,
            ...(externalId === undefined ? {} : { externalId }),
          });
    if (!stillValid) {
      await markStale(db, action.actionId);
      return { kind: 'stale', actionId: action.actionId, toolName: call.data.name };
    }

    const claimed = await claimForExecution(db, action.actionId);
    if (claimed === null) {
      // Unreachable while this transaction holds the row it just flipped to
      // approved — kept as a guard against a future caller splitting the
      // transaction boundary.
      return {
        kind: 'already-resolved',
        actionId: action.actionId,
        status: await currentStatus(db, action.actionId),
      };
    }

    const result = await def.execute(args.data, deps.toolDeps, {
      ...idCtx,
      db,
      ...(externalId === undefined ? {} : { externalId }),
    });
    return { kind: 'executed', actionId: action.actionId, toolName: call.data.name, result };
  } catch (err) {
    await returnToPending(db, action.actionId);
    const message = err instanceof Error ? err.message : String(err);
    return {
      kind: 'failed',
      actionId: action.actionId,
      toolName: call.data.name,
      message: message.slice(0, 200),
    };
  }
}

export function makeResolveApprovalReply<TDeps>(
  registry: ToolRegistry<TDeps>,
  deps: ResolveApprovalDeps<TDeps>,
): (db: Queryable, input: ApprovalReplyInput) => Promise<ApprovalOutcome> {
  return async function resolveApprovalReply(db, input) {
    const action = await getActionByPromptMessageId(db, input.conversationId, input.quotedMessageId);
    if (action === null) return { kind: 'unbound' };

    const reply = interpretApprovalReply(input.text);
    if (reply === 'unclear') return { kind: 'unclear', actionId: action.actionId };

    return settleDecision(db, registry, deps, action, reply);
  };
}

export function makeResolveClassifiedDecision<TDeps>(
  registry: ToolRegistry<TDeps>,
  deps: ResolveApprovalDeps<TDeps>,
): (db: Queryable, input: ClassifiedDecisionInput) => Promise<ApprovalOutcome> {
  return async function resolveClassifiedDecision(db, input) {
    const action = await getPendingAction(db, input.actionId);
    // Conversation-scoped like the quoted path: an action id from anywhere
    // else degrades to a normal turn, never a cross-conversation settle.
    if (action === null || action.conversationId !== input.conversationId) {
      return { kind: 'unbound' };
    }
    return settleDecision(db, registry, deps, action, input.decision);
  };
}
