// TTL GC (T37, architecture decision 10's soft backstop): time answers the
// one question events cannot — "when do I give up on an action nobody
// answered" — because the dominant failure (silence) produces no event. The
// sweep is a scheduled workflow on the T23 pattern: the scheduled time is a
// workflow INPUT (the body never reads the clock), each overdue action's
// notice is enqueued on the SAME conversation lane as everything else, and
// the firing id anchors idempotency end to end — a replayed sweep or a
// racing cron tick collapses onto the same enqueue workflowID and inbox
// message_id, and markExpired's pending-only guard flips at most once.
//
// Ordering is enqueue-then-mark, exactly like the reminder sweep: a crash
// between the two replays into the same deduped enqueue, then marks — the
// gentle notice is at-least-once enqueued, the expiry exactly-once.

import { DBOS } from '@dbos-inc/dbos-sdk';
import { toolCallSchema } from '../agent/context.js';
import { renderExpiryNotice } from '../agent/prompts.js';
import type { ConversationEnqueue } from '../orchestration/queue.js';
import type { PendingAction } from '../memory/store.js';

/**
 * An overdue action as the sweep consumes it. Plain JSON on purpose: step
 * outputs round-trip through the journal on replay (see DueReminder).
 */
export interface OverdueAction {
  readonly actionId: string;
  readonly conversationId: string;
  readonly toolName: string;
  /** Digest-shaped proposal line (tool args JSON; malformed rows degrade). */
  readonly summary: string;
}

/** Rows → sweep input. Pure; callers run it inside their journaled read. */
export function toOverdueActions(actions: readonly PendingAction[]): OverdueAction[] {
  return actions.map((action) => {
    const parsed = toolCallSchema.safeParse(action.toolCall);
    return {
      actionId: action.actionId,
      conversationId: action.conversationId,
      toolName: parsed.success ? parsed.data.name : 'unknown',
      summary: JSON.stringify(parsed.success ? parsed.data.args : action.toolCall),
    };
  });
}

/**
 * Identity of the expiry FIRING. The action id alone suffices — expiry is a
 * terminal pending-only transition, so an action expires at most once ever.
 */
export function expiryFiringId(actionId: string): string {
  return `expire-${actionId}`;
}

export function toExpiryItem(action: OverdueAction): ConversationEnqueue {
  return {
    conversationId: action.conversationId,
    kind: 'proactive',
    // system:hitl, like resolver outcomes: the stable prompt already teaches
    // the model to relay these in the user's language and never re-run them.
    senderId: 'system:hitl',
    messageId: expiryFiringId(action.actionId),
    // actionUpdate, not text: invisible to the relatedness classifier and
    // the quoted-reply binder by payload shape (context.ts, T37 note).
    payload: { actionUpdate: renderExpiryNotice(action) },
  };
}

export interface ExpirySweepDeps {
  /** Registered datasource transaction (journaled). Epoch ms, see OverdueAction. */
  readonly getOverdue: (asOfMs: number) => Promise<OverdueAction[]>;
  /** pending→expired guard: true only for the call that flipped it. */
  readonly markExpired: (actionId: string) => Promise<boolean>;
  /** The registered conversation-enqueue workflow (T21). */
  readonly enqueueWorkflow: (item: ConversationEnqueue) => Promise<void>;
}

/**
 * Sweep workflow body, signature matching DBOS's ScheduledArgs so the same
 * factory output registers as a scheduled workflow or runs directly.
 */
export function makeExpirySweepWorkflow(
  deps: ExpirySweepDeps,
): (scheduledTime: Date, actualTime: Date) => Promise<number> {
  return async function expirySweep(scheduledTime: Date, _actualTime: Date): Promise<number> {
    const overdue = await deps.getOverdue(scheduledTime.getTime());
    for (const action of overdue) {
      const handle = await DBOS.startWorkflow(deps.enqueueWorkflow, {
        workflowID: expiryFiringId(action.actionId),
      })(toExpiryItem(action));
      await handle.getResult();
      await deps.markExpired(action.actionId);
    }
    return overdue.length;
  };
}
