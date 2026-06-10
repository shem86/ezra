// Stub transport (T20): the M3 stand-in for Baileys that HONORS the
// durable-enqueue-before-ack contract — un-acked messages are redelivered
// on every (re)connect, exactly the recovery path the real server provides.
// Tests and `pnpm dev` drive it via `deliver()`.

import type {
  InboundMessage,
  MessageAck,
  OutboundMessage,
  SendReceipt,
  Transport,
  TransportState,
} from './types.js';

export interface StubTransport extends Transport {
  /** Inject an inbound message as if the server delivered it. */
  deliver(message: InboundMessage): void;
  /** Ids delivered but not yet acked — redelivered on the next connect. */
  unackedIds(): string[];
  /** Everything sent through this transport, in order. */
  readonly sent: readonly OutboundMessage[];
}

export function createStubTransport(): StubTransport {
  let state: TransportState = 'closed';
  let sendCounter = 0;
  const sent: OutboundMessage[] = [];
  // Insertion-ordered: redelivery must preserve original delivery order.
  const unacked = new Map<string, InboundMessage>();
  const messageHandlers: Array<(m: InboundMessage, ack: MessageAck) => void> = [];
  const stateHandlers: Array<(s: TransportState) => void> = [];

  function setState(next: TransportState): void {
    state = next;
    for (const handler of [...stateHandlers]) handler(next);
  }

  function dispatch(message: InboundMessage): void {
    const ack: MessageAck = async () => {
      unacked.delete(message.id);
    };
    for (const handler of [...messageHandlers]) handler(message, ack);
  }

  function open(): void {
    setState('connecting');
    setState('open');
    // The redelivery contract: whatever was never acked comes back.
    for (const message of [...unacked.values()]) dispatch(message);
  }

  return {
    async connect(): Promise<void> {
      open();
    },

    async send(message: OutboundMessage): Promise<SendReceipt> {
      if (state !== 'open') throw new Error('transport not connected');
      sent.push(message);
      sendCounter += 1;
      return { messageId: `stub-sent-${sendCounter}` };
    },

    onMessage(handler: (message: InboundMessage, ack: MessageAck) => void): void {
      messageHandlers.push(handler);
    },

    onStateChange(handler: (s: TransportState) => void): void {
      stateHandlers.push(handler);
    },

    async forceReconnect(): Promise<void> {
      open();
    },

    async disconnect(): Promise<void> {
      setState('closed');
    },

    deliver(message: InboundMessage): void {
      unacked.set(message.id, message);
      if (state === 'open') dispatch(message);
    },

    unackedIds(): string[] {
      return [...unacked.keys()];
    },

    sent,
  };
}
