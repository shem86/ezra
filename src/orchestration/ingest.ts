// Ingestion seam (T20): durable-enqueue-before-ack. The ack point is the
// loss-prevention lever — WhatsApp redelivers un-acked messages on
// reconnect, so a crash before the durable enqueue leaves the message
// un-acked and it comes back; an acked-but-unenqueued message would vanish
// silently (architecture decision: ingestion durability).

import { z } from 'zod';
import type { MessageAck } from '../transport/types.js';

/**
 * Wire contract for an inbound message (Zod at the boundary). Mirrors
 * `Transport`'s `InboundMessage`; strict so transport drift surfaces as a
 * validation failure here instead of corrupt state downstream.
 */
export const inboundMessageSchema = z.strictObject({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  senderId: z.string().min(1),
  senderName: z.string().nullable(),
  fromMe: z.boolean(),
  text: z.string(),
  quotedMessageId: z.string().nullable(),
  timestamp: z.number().int().nonnegative(),
});

export type ParsedInboundMessage = z.infer<typeof inboundMessageSchema>;

/**
 * Workflow id for processing one inbound message. The WhatsApp message id
 * is the idempotency anchor for ingestion: a redelivery (crash after
 * enqueue, before ack) starts a workflow with the same id, and DBOS
 * dedupes instead of double-processing.
 */
export function ingestWorkflowId(messageId: string): string {
  if (messageId.length === 0) {
    throw new Error('ingestWorkflowId: message id must be non-empty');
  }
  return `ingest-${messageId}`;
}

export type IngestOutcome =
  | { readonly outcome: 'enqueued' }
  | { readonly outcome: 'self-echo' }
  | { readonly outcome: 'ignored-conversation' }
  | { readonly outcome: 'invalid'; readonly detail: string }
  | { readonly outcome: 'enqueue-failed'; readonly error: unknown };

export interface IngestionDeps {
  /** Must be durable (persisted, crash-survivable) before it resolves. */
  readonly enqueueDurably: (message: ParsedInboundMessage) => Promise<void>;
  /**
   * Echo check keyed on sent message ids, NOT on `fromMe`: on the
   * personal-number deployment the builder's own messages are `fromMe` and
   * must be processed — only ids the bot itself sent are echoes.
   */
  readonly wasSentByBot: (messageId: string) => boolean;
  /**
   * Conversation allowlist (T42). The bot runs on a PERSONAL number, so
   * without this every chat on the account would flow into ingestion,
   * prompts, and traces — a hard privacy boundary, not an optimization.
   * Absent ⇒ serve everything (dev/stub compositions).
   */
  readonly isHouseholdConversation?: (conversationId: string) => boolean;
}

/**
 * The ingestion seam: validate → filter echoes → enqueue durably → ack.
 * Ack-ordering rules, each load-bearing:
 * - never ack before `enqueueDurably` resolves (crash here ⇒ un-acked ⇒
 *   the transport redelivers — the message survives);
 * - on enqueue failure, return without acking — redelivery IS the retry;
 * - echoes and malformed payloads are acked immediately, else they
 *   redeliver forever as poison messages.
 */
export function createIngestion(
  deps: IngestionDeps,
): (raw: unknown, ack: MessageAck) => Promise<IngestOutcome> {
  return async (raw, ack) => {
    const parsed = inboundMessageSchema.safeParse(raw);
    if (!parsed.success) {
      await ack();
      return { outcome: 'invalid', detail: parsed.error.message };
    }
    if (deps.isHouseholdConversation?.(parsed.data.conversationId) === false) {
      await ack();
      return { outcome: 'ignored-conversation' };
    }
    if (deps.wasSentByBot(parsed.data.id)) {
      await ack();
      return { outcome: 'self-echo' };
    }
    try {
      await deps.enqueueDurably(parsed.data);
    } catch (error) {
      return { outcome: 'enqueue-failed', error };
    }
    await ack();
    return { outcome: 'enqueued' };
  };
}
