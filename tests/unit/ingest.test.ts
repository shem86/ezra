import { describe, expect, it } from 'vitest';
import {
  createIngestion,
  ingestWorkflowId,
  inboundMessageSchema,
} from '../../src/orchestration/ingest.ts';

const validMessage = {
  id: '3EB0A9C7D2F1',
  conversationId: '123456789@g.us',
  senderId: '15551234567@s.whatsapp.net',
  senderName: 'Shem',
  fromMe: false,
  text: 'add milk to the groceries list',
  quotedMessageId: null,
  timestamp: 1_765_000_000,
};

describe('inboundMessageSchema', () => {
  it('accepts a well-formed inbound message', () => {
    const parsed = inboundMessageSchema.parse(validMessage);
    expect(parsed).toEqual(validMessage);
  });

  it('accepts mixed Hebrew/English text and a null senderName', () => {
    const parsed = inboundMessageSchema.parse({
      ...validMessage,
      senderName: null,
      text: 'תוסיף milk לרשימת קניות',
    });
    expect(parsed.text).toBe('תוסיף milk לרשימת קניות');
    expect(parsed.senderName).toBeNull();
  });

  it('accepts a quoted-message reference', () => {
    const parsed = inboundMessageSchema.parse({ ...validMessage, quotedMessageId: '3EB0FFAA' });
    expect(parsed.quotedMessageId).toBe('3EB0FFAA');
  });

  it('rejects an empty message id', () => {
    expect(inboundMessageSchema.safeParse({ ...validMessage, id: '' }).success).toBe(false);
  });

  it('rejects a missing conversationId', () => {
    const { conversationId: _omitted, ...rest } = validMessage;
    expect(inboundMessageSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects a non-boolean fromMe', () => {
    expect(inboundMessageSchema.safeParse({ ...validMessage, fromMe: 'yes' }).success).toBe(false);
  });

  it('rejects fractional or negative timestamps', () => {
    expect(inboundMessageSchema.safeParse({ ...validMessage, timestamp: 1.5 }).success).toBe(false);
    expect(inboundMessageSchema.safeParse({ ...validMessage, timestamp: -1 }).success).toBe(false);
  });

  it('rejects unknown extra fields (boundary stays closed)', () => {
    expect(
      inboundMessageSchema.safeParse({ ...validMessage, mediaUrl: 'http://x' }).success,
    ).toBe(false);
  });
});

describe('createIngestion', () => {
  function harness(opts?: { sentByBot?: string[]; failEnqueue?: boolean }) {
    const events: string[] = [];
    const enqueued: { id: string }[] = [];
    const sentByBot = new Set(opts?.sentByBot ?? []);
    const ingest = createIngestion({
      enqueueDurably: async (message) => {
        if (opts?.failEnqueue) throw new Error('db down');
        events.push('enqueue');
        enqueued.push({ id: message.id });
      },
      wasSentByBot: (id) => sentByBot.has(id),
    });
    const ack = async () => {
      events.push('ack');
    };
    return { ingest, ack, events, enqueued };
  }

  it('enqueues durably BEFORE acking and reports enqueued', async () => {
    const { ingest, ack, events, enqueued } = harness();

    const result = await ingest(validMessage, ack);

    expect(result.outcome).toBe('enqueued');
    expect(events).toEqual(['enqueue', 'ack']); // order is the whole point
    expect(enqueued).toEqual([{ id: validMessage.id }]);
  });

  it("acks the bot's own echoed send without enqueuing it", async () => {
    const { ingest, ack, events, enqueued } = harness({ sentByBot: [validMessage.id] });

    const result = await ingest({ ...validMessage, fromMe: true }, ack);

    expect(result.outcome).toBe('self-echo');
    expect(enqueued).toEqual([]);
    expect(events).toEqual(['ack']); // acked so the echo is not redelivered forever
  });

  it('enqueues a fromMe message that the bot did NOT send (builder on his personal number)', async () => {
    const { ingest, ack, enqueued } = harness({ sentByBot: ['some-other-id'] });

    const result = await ingest({ ...validMessage, fromMe: true }, ack);

    expect(result.outcome).toBe('enqueued');
    expect(enqueued).toEqual([{ id: validMessage.id }]);
  });

  it('acks a malformed payload without enqueuing (poison message must not redeliver forever)', async () => {
    const { ingest, ack, events, enqueued } = harness();

    const result = await ingest({ garbage: true }, ack);

    expect(result.outcome).toBe('invalid');
    expect(enqueued).toEqual([]);
    expect(events).toEqual(['ack']);
  });

  it('does NOT ack when the durable enqueue fails — redelivery is the recovery path', async () => {
    const { ingest, ack, events } = harness({ failEnqueue: true });

    const result = await ingest(validMessage, ack);

    expect(result.outcome).toBe('enqueue-failed');
    expect(events).toEqual([]); // no enqueue recorded, and crucially no ack
  });
});

describe('createIngestion conversation allowlist (T42)', () => {
  function harness(allowed: string[]) {
    const enqueued: string[] = [];
    const events: string[] = [];
    const ingest = createIngestion({
      enqueueDurably: async (message) => {
        enqueued.push(message.conversationId);
      },
      wasSentByBot: () => false,
      isHouseholdConversation: (conversationId) => allowed.includes(conversationId),
    });
    const ack = async () => {
      events.push('ack');
    };
    return { ingest, ack, enqueued, events };
  }

  it('enqueues messages from an allowlisted conversation', async () => {
    const { ingest, ack, enqueued } = harness([validMessage.conversationId]);
    const result = await ingest(validMessage, ack);
    expect(result.outcome).toBe('enqueued');
    expect(enqueued).toEqual([validMessage.conversationId]);
  });

  it('ignores (acks, never enqueues) a conversation outside the household — the personal-number privacy boundary', async () => {
    const { ingest, ack, enqueued, events } = harness(['other@g.us']);
    const result = await ingest(validMessage, ack);
    expect(result.outcome).toBe('ignored-conversation');
    expect(enqueued).toEqual([]);
    expect(events).toEqual(['ack']); // acked so it never redelivers as poison
  });

  it('without the filter, every conversation is served (dev/stub compatibility)', async () => {
    const enqueued: string[] = [];
    const ingest = createIngestion({
      enqueueDurably: async (m) => {
        enqueued.push(m.conversationId);
      },
      wasSentByBot: () => false,
    });
    const result = await ingest(validMessage, async () => {});
    expect(result.outcome).toBe('enqueued');
    expect(enqueued.length).toBe(1);
  });
});

describe('ingestWorkflowId', () => {
  it('derives a stable workflow id from the WhatsApp message id', () => {
    expect(ingestWorkflowId('3EB0A9C7D2F1')).toBe(ingestWorkflowId('3EB0A9C7D2F1'));
  });

  it('distinct message ids get distinct workflow ids', () => {
    expect(ingestWorkflowId('msg-a')).not.toBe(ingestWorkflowId('msg-b'));
  });

  it('rejects an empty message id', () => {
    expect(() => ingestWorkflowId('')).toThrow(/message id/i);
  });
});
