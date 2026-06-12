// Production park (T34, architecture decision 10 fire-and-fold): a
// confirm-before tool call never executes at propose time — it becomes a
// pending_actions row plus a synthetic "pending approval" tool_result, and
// the turn ends. Runs on the runTool step's transaction-scoped client, so
// the row co-commits with the step checkpoint: a replayed step that never
// committed re-inserts cleanly, a committed one is never re-run.

import type { ToolResult } from '../agent/context.js';
import type { RunToolDeps } from '../tools/registry.js';
import { createPendingAction } from '../memory/store.js';

export interface ParkOptions {
  /** Approval TTL written into expires_at at park time (Open Q1: default 12). */
  readonly ttlHours: number;
}

export function makePark(options: ParkOptions): RunToolDeps<unknown>['park'] {
  return async function park(db, request): Promise<ToolResult> {
    const expiresAt = new Date(Date.now() + options.ttlHours * 3_600_000);
    await createPendingAction(db, {
      actionId: request.actionId,
      conversationId: request.conversationId,
      toolCall: request.call,
      expiresAt,
    });
    return {
      toolUseId: request.call.id,
      // The model must treat the action as proposed, not done — this wording
      // is the seam's contract the T32 stub promised.
      content: `pending approval, action_id=${request.actionId}: waiting for a household member to confirm — not done yet`,
      parked: true,
    };
  };
}
