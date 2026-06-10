// Ingestion seam (T20): durable-enqueue-before-ack. The ack point is the
// loss-prevention lever — WhatsApp redelivers un-acked messages on
// reconnect, so a crash before the durable enqueue leaves the message
// un-acked and it comes back; an acked-but-unenqueued message would vanish
// silently (architecture decision: ingestion durability).

import { z } from 'zod';

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
