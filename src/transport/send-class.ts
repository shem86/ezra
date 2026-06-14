// T43: send classes for the production reply path (architecture decision 10).
// Every outbound text — human reply, reminder firing, expiry notice — leaves
// through ONE step (main.ts `sendReply`), because reminders enter the same
// conversation lane as proactive items and the model's answer is the delivery.
// So the delivery class is chosen here from the lead inbox item, and the send
// id is derived deterministically so a workflow replay lands on the same
// sent_log row instead of a second, undeduped send.

import type { DeliveryClass } from '../memory/store.js';

/** The fields of the lead inbox item that pick the send class. */
export interface SendClassSubject {
  readonly kind: 'human' | 'proactive';
  readonly senderId: string;
}

/**
 * Reminders and proactive nags are **at-least-once**: a missed reminder is the
 * exact blast-radius failure this project defends against, so a rare duplicate
 * on crash-between is the acceptable trade. Their producer is the scheduled
 * sweep, which enqueues with senderId `'system'` (scheduled.ts) — any future
 * at-least-once producer (nags) MUST reuse that sender or extend this rule.
 *
 * Everything else is **at-most-once**: human replies and the low-stakes
 * `system:hitl` action updates (expiry notices) — for these a duplicate to the
 * user is the failure we refuse, and a dropped low-stakes line is acceptable.
 * The default is deliberately at-most-once: an unrecognized sender never earns
 * the right to spam a duplicate.
 */
export function selectSendClass(subject: SendClassSubject): DeliveryClass {
  return subject.kind === 'proactive' && subject.senderId === 'system'
    ? 'at-least-once'
    : 'at-most-once';
}

/**
 * Deterministic send id for a turn's reply. The lead message id is itself
 * workflow-id-derived (the turn runs as `turn-${messageId}`), so this is
 * stable across replay and unique per firing — a reminder's next occurrence
 * carries a fresh due instant in its firing id, hence a fresh send id.
 */
export function replySendId(lead: { readonly messageId: string }): string {
  return `send-${lead.messageId}`;
}

/**
 * The sent_log primitives + transport send, injected (no module singletons —
 * conventions.md). `recordSend` is insert-if-absent on the idempotency key:
 * true only when THIS call wrote the row. Bound to the plain reply client in
 * the composer, so the claim commits independently of the DBOS step journal —
 * that independence is what lets the row survive a crash and gate the replay.
 */
export interface DeliverReplyDeps {
  readonly recordSend: (input: {
    idempotencyKey: string;
    conversationId: string;
    deliveryClass: DeliveryClass;
    body: unknown;
  }) => Promise<boolean>;
  readonly getSentEntry: (idempotencyKey: string) => Promise<unknown | null>;
  readonly send: (message: {
    conversationId: string;
    text: string;
  }) => Promise<{ messageId: string }>;
}

export interface DeliverReplyArgs {
  readonly sendClass: DeliveryClass;
  readonly idempotencyKey: string;
  readonly conversationId: string;
  readonly text: string;
}

/**
 * Deliver one reply under its declared class.
 *
 * **at-most-once = log-then-send:** claim the row first; only the winner sends.
 * A crash after the claim drops the send, and a replay (claim already taken)
 * skips it — never a duplicate.
 *
 * **at-least-once = send-then-log:** a best-effort `getSentEntry` skips an
 * obvious re-send, then send, then log. A crash between send and log leaves the
 * log absent, so a replay re-sends — the duplicate the class accepts in
 * exchange for never dropping a reminder.
 */
export async function deliverReply(
  deps: DeliverReplyDeps,
  args: DeliverReplyArgs,
): Promise<{ sent: boolean }> {
  const { sendClass, idempotencyKey, conversationId, text } = args;

  if (sendClass === 'at-most-once') {
    const won = await deps.recordSend({
      idempotencyKey,
      conversationId,
      deliveryClass: sendClass,
      body: { text },
    });
    if (!won) return { sent: false };
    await deps.send({ conversationId, text });
    return { sent: true };
  }

  if (await deps.getSentEntry(idempotencyKey)) return { sent: false };
  await deps.send({ conversationId, text });
  await deps.recordSend({
    idempotencyKey,
    conversationId,
    deliveryClass: sendClass,
    body: { text },
  });
  return { sent: true };
}
