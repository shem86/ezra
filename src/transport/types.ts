// Transport contract (T11): the seam both M3's stub and M6's real Baileys
// adapter implement, so everything above it is transport-agnostic.

export type TransportState = 'connecting' | 'open' | 'closed' | 'logged-out';

export interface InboundMessage {
  /** WhatsApp message id — idempotency anchor for ingestion. */
  readonly id: string;
  /** Chat JID (group or 1:1) — maps to conversation_id. */
  readonly conversationId: string;
  /** Sender JID, device suffix normalized away. */
  readonly senderId: string;
  readonly senderName: string | null;
  /** Raw fromMe flag. On a personal-number deployment the bot's own sends
   * are fromMe too, so echo suppression keys on sent ids, not this flag. */
  readonly fromMe: boolean;
  readonly text: string;
  /** Stanza id of the quoted message, if any — approval binding (M5). */
  readonly quotedMessageId: string | null;
  /** Epoch seconds as reported by WhatsApp. */
  readonly timestamp: number;
}

export interface OutboundMessage {
  readonly conversationId: string;
  readonly text: string;
}

export interface SendReceipt {
  readonly messageId: string;
}

/**
 * Acknowledges one inbound message back to the transport. Ingestion calls
 * this only AFTER the message is durably enqueued: un-acked messages must be
 * redelivered on reconnect (that redelivery is the crash-loss prevention —
 * architecture "ingestion durability"). Idempotent.
 */
export type MessageAck = () => Promise<void>;

export interface Transport {
  connect(): Promise<void>;
  send(message: OutboundMessage): Promise<SendReceipt>;
  onMessage(handler: (message: InboundMessage, ack: MessageAck) => void): void;
  onStateChange(handler: (state: TransportState) => void): void;
  forceReconnect(): Promise<void>;
  disconnect(): Promise<void>;
}
