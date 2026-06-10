// Scheduled reminders → proactive turns (T23): the sweep workflow finds due
// reminders and enqueues each as a proactive item in the SAME conversation
// lane as human messages (decision 2: one lane, three event sources), so a
// firing waits behind an in-flight turn instead of racing it. Wall-time →
// instant conversion happens in tz.ts BEFORE rows reach `reminders.due_at`;
// by the time the sweep sees them they are absolute instants.

import { DBOS } from '@dbos-inc/dbos-sdk';
import type { ConversationEnqueue } from './queue.js';

/**
 * A due reminder as the sweep workflow consumes it. Plain JSON on purpose:
 * step outputs round-trip through the journal on replay, where Date fields
 * would degrade to strings — so the boundary carries an ISO string.
 */
export interface DueReminder {
  readonly id: string;
  readonly conversationId: string;
  readonly body: string;
  readonly dueAtIso: string;
}

/**
 * Identity of one reminder FIRING (not the reminder row): id + due instant,
 * so a recurring reminder's next occurrence is a fresh firing while a sweep
 * replay or a racing tick collapses onto the same workflowID and inbox
 * message_id — that pair of anchors is the exactly-once guarantee.
 */
export function reminderFiringId(reminder: Pick<DueReminder, 'id' | 'dueAtIso'>): string {
  return `remind-${reminder.id}-${reminder.dueAtIso}`;
}

export function toProactiveItem(reminder: DueReminder): ConversationEnqueue {
  return {
    conversationId: reminder.conversationId,
    kind: 'proactive',
    senderId: 'system',
    messageId: reminderFiringId(reminder),
    payload: { reminder: reminder.body },
  };
}

export interface ReminderSweepDeps {
  /**
   * Registered datasource transactions (journaled — see dbos.md). `getDue`
   * takes epoch ms, not a Date, for the same replay-serialization reason as
   * `DueReminder.dueAtIso`.
   */
  readonly getDue: (asOfMs: number) => Promise<DueReminder[]>;
  /** scheduled→fired guard: true only for the call that flipped it. */
  readonly markFired: (reminderId: string) => Promise<boolean>;
  /** The registered conversation-enqueue workflow (T21). */
  readonly enqueueWorkflow: (item: ConversationEnqueue) => Promise<void>;
}

/**
 * Sweep workflow body, signature matching DBOS's ScheduledArgs so the same
 * factory output registers as a scheduled workflow or runs directly. The
 * scheduled time is a workflow INPUT — the body never reads the clock.
 * Enqueue-then-mark ordering: a crash between the two replays into the same
 * child workflowID (deduped), then marks — fired exactly once either way.
 */
export function makeReminderSweepWorkflow(
  deps: ReminderSweepDeps,
): (scheduledTime: Date, actualTime: Date) => Promise<number> {
  return async function reminderSweep(scheduledTime: Date, _actualTime: Date): Promise<number> {
    const due = await deps.getDue(scheduledTime.getTime());
    for (const reminder of due) {
      const handle = await DBOS.startWorkflow(deps.enqueueWorkflow, {
        workflowID: reminderFiringId(reminder),
      })(toProactiveItem(reminder));
      await handle.getResult();
      await deps.markFired(reminder.id);
    }
    return due.length;
  };
}
