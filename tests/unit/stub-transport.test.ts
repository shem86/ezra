import { describe, expect, it } from 'vitest';
import { createStubTransport } from '../../src/transport/stub.ts';
import type { InboundMessage, MessageAck, TransportState } from '../../src/transport/types.ts';

function makeMessage(id: string, overrides?: Partial<InboundMessage>): InboundMessage {
  return {
    id,
    conversationId: 'group-1@g.us',
    senderId: 'wife@s.whatsapp.net',
    senderName: 'Wife',
    fromMe: false,
    text: `message ${id}`,
    quotedMessageId: null,
    timestamp: 1_765_000_000,
    ...overrides,
  };
}

describe('createStubTransport', () => {
  it('delivers an injected message to the handler with an ack callback', async () => {
    const transport = createStubTransport();
    const seen: { message: InboundMessage; ack: MessageAck }[] = [];
    transport.onMessage((message, ack) => {
      seen.push({ message, ack });
    });
    await transport.connect();

    transport.deliver(makeMessage('m1'));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.message.id).toBe('m1');
    expect(typeof seen[0]?.ack).toBe('function');
  });

  it('holds messages delivered before connect and dispatches them on connect', async () => {
    const transport = createStubTransport();
    const seen: string[] = [];
    transport.onMessage((message) => {
      seen.push(message.id);
    });

    transport.deliver(makeMessage('early'));
    expect(seen).toEqual([]);

    await transport.connect();
    expect(seen).toEqual(['early']);
  });

  it('redelivers un-acked messages on reconnect, in delivery order', async () => {
    const transport = createStubTransport();
    const seen: string[] = [];
    transport.onMessage((message) => {
      seen.push(message.id); // never acks
    });
    await transport.connect();

    transport.deliver(makeMessage('m1'));
    transport.deliver(makeMessage('m2'));
    await transport.forceReconnect();

    expect(seen).toEqual(['m1', 'm2', 'm1', 'm2']);
    expect(transport.unackedIds()).toEqual(['m1', 'm2']);
  });

  it('does not redeliver acked messages', async () => {
    const transport = createStubTransport();
    const seen: string[] = [];
    transport.onMessage((message, ack) => {
      seen.push(message.id);
      if (message.id === 'acked') void ack();
    });
    await transport.connect();

    transport.deliver(makeMessage('acked'));
    transport.deliver(makeMessage('unacked'));
    await transport.forceReconnect();

    expect(seen).toEqual(['acked', 'unacked', 'unacked']);
    expect(transport.unackedIds()).toEqual(['unacked']);
  });

  it('ack is idempotent', async () => {
    const transport = createStubTransport();
    let savedAck: MessageAck | undefined;
    transport.onMessage((_message, ack) => {
      savedAck = ack;
    });
    await transport.connect();
    transport.deliver(makeMessage('m1'));

    await savedAck?.();
    await savedAck?.();
    expect(transport.unackedIds()).toEqual([]);
  });

  it('send while open records the message and returns a deterministic receipt', async () => {
    const transport = createStubTransport();
    await transport.connect();

    const first = await transport.send({ conversationId: 'group-1@g.us', text: 'תזכורת!' });
    const second = await transport.send({ conversationId: 'group-1@g.us', text: 'again' });

    expect(first.messageId).toBe('stub-sent-1');
    expect(second.messageId).toBe('stub-sent-2');
    expect(transport.sent.map((m) => m.text)).toEqual(['תזכורת!', 'again']);
  });

  it('send while not connected throws', async () => {
    const transport = createStubTransport();
    await expect(transport.send({ conversationId: 'c', text: 'x' })).rejects.toThrow(
      /not connected/,
    );
  });

  it('emits state transitions to subscribers', async () => {
    const transport = createStubTransport();
    const states: TransportState[] = [];
    transport.onStateChange((s) => states.push(s));

    await transport.connect();
    await transport.forceReconnect();
    await transport.disconnect();

    expect(states).toEqual(['connecting', 'open', 'connecting', 'open', 'closed']);
  });
});
