import { describe, expect, it } from 'vitest';
import { ingestWorkflowId, inboundMessageSchema } from '../../src/orchestration/ingest.ts';

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
