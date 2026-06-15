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
  /**
   * Total time to keep retrying a transient failure before giving up, ms. The
   * budget — not an attempt count — because the thing we wait on is a
   * wall-clock reconnect, and on this host a throttled WhatsApp reconnect (rapid
   * restart → server-side backoff) was measured at ~84s, well past a naive
   * few-attempts budget. Sized with margin so a realistic slow reconnect still
   * delivers the reminder rather than dropping it.
   */
  readonly maxElapsedMs: number;
  /** First backoff, ms; multiplied by `backoffRate` each retry up to `maxDelayMs`. */
  readonly baseDelayMs: number;
  readonly backoffRate: number;
  /**
   * Cap on a single backoff. Without it the delay grows to 32s+ and a retry can
   * sleep clean past the moment the transport comes back (observed: transport
   * opened 10s after the last 32s sleep started). Capping keeps the loop polling
   * every few seconds near the reconnect, so delivery lands promptly once open.
   */
  readonly maxDelayMs: number;
}

/**
 * 5-minute budget, 5s delay cap. Covers the measured ~84s throttled reconnect
 * with ~3.5× margin while staying bounded — a transport down past 5 minutes is
 * a genuine outage the health monitor and dead-man ping (T12) surface, and the
 * send then errors the turn (accepted residual). Delays ramp 0.5/1/2/4s then
 * hold at 5s. The lane is concurrency-1 and the transport is down for everyone
 * while this waits, so blocking it costs nothing — inbound stays durably queued.
 */
export const defaultResilientSendConfig: ResilientSendConfig = {
  maxElapsedMs: 300_000,
  baseDelayMs: 500,
  backoffRate: 2,
  maxDelayMs: 5_000,
};

type SendFn = (message: { conversationId: string; text: string }) => Promise<{ messageId: string }>;

/**
 * Wrap a transport send so a transient `transport not connected` is retried
 * with capped exponential backoff until the reconnect budget is spent. Retrying
 * a thrown send is safe for BOTH classes — no message left the wire — so no
 * duplicate risk; this only ever turns a drop into a delayed delivery. Elapsed
 * is tracked as the sum of slept delays (no clock read), so the loop is
 * deterministic and unit-testable with an injected `sleep`. `onRetry` fires
 * before each backoff so a transient stall is observable in production (the lane
 * is blocked while it retries — a silent multi-minute hold would be bad ops);
 * default is a no-op.
 */
export function makeResilientSend(
  send: SendFn,
  config: ResilientSendConfig = defaultResilientSendConfig,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onRetry: (info: { attempt: number; delayMs: number; elapsedMs: number; error: unknown }) => void =
    () => {},
): SendFn {
  return async (message) => {
    let delay = config.baseDelayMs;
    let elapsedMs = 0;
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await send(message);
      } catch (error) {
        if (!isTransientSendError(error) || elapsedMs >= config.maxElapsedMs) throw error;
        onRetry({ attempt, delayMs: delay, elapsedMs, error });
        await sleep(delay);
        elapsedMs += delay;
        delay = Math.min(delay * config.backoffRate, config.maxDelayMs);
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
