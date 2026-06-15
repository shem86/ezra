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
 * Deterministic send id for an approval prompt (at-least-once). Keyed on the
 * action id — the action key the architecture names for the sent-log — and
 * namespaced so it can never collide with a reply send id.
 */
export function approvalSendId(actionId: string): string {
  return `approval-${actionId}`;
}

// --- PROX-SEND-001: resilient send across a transient disconnect -------------
// A proactive at-least-once send (reminder/nag/approval prompt) fires from the
// scheduled sweep, which on restart can run BEFORE Baileys finishes
// reconnecting. A bare `transport.send` then throws `transport not connected`
// (baileys.ts) and the throw errors the whole turn workflow terminally — DBOS
// recovers PENDING workflows, never ERROR ones — so the reminder is silently
// dropped, the exact failure the at-least-once class exists to prevent. The
// contract already implies a transient send failure must retry, so the
// production send is wrapped to wait out a transient disconnect with bounded
// backoff. Permanent/unroutable errors (a bad jid — ledger #15) are NOT matched,
// so a poison message propagates immediately instead of spinning the lane.
//
// The wrapper runs INSIDE the send DBOS step (main.ts), so its backoff timers
// are journaled exactly like the existing human jitter — no determinism concern.

/** A send failure worth retrying: a transiently disconnected transport only. */
export function isTransientSendError(error: unknown): boolean {
  return error instanceof Error && error.message === 'transport not connected';
}

export interface ResilientSendConfig {
  /** Max send attempts including the first (>= 1). */
  readonly maxAttempts: number;
  /** Backoff before the first retry, ms; multiplied by `backoffRate` each retry. */
  readonly baseDelayMs: number;
  readonly backoffRate: number;
}

/**
 * ~0.5/1/2/4/8/16/32s ≈ 63s total over 8 attempts — covers a normal
 * seconds-long reconnect window (drill: bot reconnected "seconds later"). A
 * transport down past this budget is the catastrophic case the health monitor
 * and dead-man ping (T12) surface; the send then errors the turn as before.
 */
export const defaultResilientSendConfig: ResilientSendConfig = {
  maxAttempts: 8,
  baseDelayMs: 500,
  backoffRate: 2,
};

type SendFn = (message: { conversationId: string; text: string }) => Promise<{ messageId: string }>;

/**
 * Wrap a transport send so a transient `transport not connected` is retried
 * with bounded exponential backoff before propagating. Retrying a thrown send is
 * safe for BOTH classes — no message left the wire — so no duplicate risk; this
 * only ever turns a drop into a delayed delivery. `sleep` is injectable for
 * tests; the default is a real timer.
 */
export function makeResilientSend(
  send: SendFn,
  config: ResilientSendConfig = defaultResilientSendConfig,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): SendFn {
  return async (message) => {
    let delay = config.baseDelayMs;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await send(message);
      } catch (error) {
        if (attempt >= config.maxAttempts || !isTransientSendError(error)) throw error;
        await sleep(delay);
        delay *= config.backoffRate;
      }
    }
  };
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
