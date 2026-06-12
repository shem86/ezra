import { describe, expect, it } from 'vitest';
import {
  extractMessageText,
  extractQuotedReply,
  parseTurnMessages,
  toModelMessages,
  turnMessageSchema,
} from '../../src/agent/context.ts';

describe('turn message schema (T22)', () => {
  it('accepts the three persisted message shapes', () => {
    expect(
      turnMessageSchema.safeParse({ role: 'user', senderId: 'wife', content: 'תוסיף חלב' }).success,
    ).toBe(true);
    expect(
      turnMessageSchema.safeParse({
        role: 'assistant',
        content: 'on it',
        toolCalls: [{ id: 'tu-1', name: 'add_item', args: { item: 'milk' } }],
      }).success,
    ).toBe(true);
    expect(
      turnMessageSchema.safeParse({ role: 'tool', toolUseId: 'tu-1', content: 'added' }).success,
    ).toBe(true);
  });

  it('rejects messages without a known role', () => {
    expect(turnMessageSchema.safeParse({ role: 'system', content: 'x' }).success).toBe(false);
    expect(turnMessageSchema.safeParse({ content: 'no role' }).success).toBe(false);
  });

  it('parseTurnMessages round-trips a persisted transcript and fails loud on corruption', () => {
    const transcript = [
      { role: 'user', senderId: 'wife', content: 'add milk' },
      { role: 'assistant', content: 'added', toolCalls: [] },
    ];
    expect(parseTurnMessages(transcript)).toEqual(transcript);
    expect(() => parseTurnMessages([{ role: 'user' }])).toThrow();
  });
});

describe('toModelMessages (T22)', () => {
  it('turns human inbox payloads into user messages, preserving order and sender', () => {
    const msgs = toModelMessages([
      { senderId: 'wife', payload: { text: 'תוסיף חלב לרשימה' } },
      { senderId: 'shem', payload: { text: 'and olive oil' } },
    ]);
    expect(msgs).toEqual([
      { role: 'user', senderId: 'wife', content: 'תוסיף חלב לרשימה' },
      { role: 'user', senderId: 'shem', content: 'and olive oil' },
    ]);
  });

  it('renders a proactive reminder payload as a reminder message', () => {
    const msgs = toModelMessages([{ senderId: 'system', payload: { reminder: 'trash night' } }]);
    expect(msgs).toEqual([{ role: 'user', senderId: 'system', content: '[reminder] trash night' }]);
  });

  it('falls back to JSON for unrecognized payloads instead of dropping them', () => {
    const msgs = toModelMessages([{ senderId: 'system', payload: { weird: true } }]);
    expect(msgs[0]?.content).toBe(JSON.stringify({ weird: true }));
  });
});

describe('extractQuotedReply (T35)', () => {
  it('extracts text + quotedMessageId from a quoting human payload', () => {
    const item = { senderId: 'wife', payload: { text: 'yes', quotedMessageId: 'wa-7' } };
    expect(extractQuotedReply(item)).toEqual({ text: 'yes', quotedMessageId: 'wa-7' });
  });

  it('a non-quoting message (null or absent quotedMessageId) is not a quoted reply', () => {
    expect(
      extractQuotedReply({ senderId: 'wife', payload: { text: 'hi', quotedMessageId: null } }),
    ).toBeNull();
    expect(extractQuotedReply({ senderId: 'wife', payload: { text: 'hi' } })).toBeNull();
  });

  it('proactive and malformed payloads are never quoted replies', () => {
    expect(extractQuotedReply({ senderId: 'system', payload: { reminder: 'pills' } })).toBeNull();
    expect(extractQuotedReply({ senderId: 'wife', payload: 'just a string' })).toBeNull();
  });
});

describe('extractMessageText (T36)', () => {
  it('returns the text of a human payload, quoted or not', () => {
    expect(extractMessageText({ senderId: 'wife', payload: { text: 'make it 4pm' } })).toBe(
      'make it 4pm',
    );
    expect(
      extractMessageText({
        senderId: 'wife',
        payload: { text: 'yes', quotedMessageId: 'wa-123' },
      }),
    ).toBe('yes');
  });

  it('returns null for proactive and malformed payloads — only utterances classify', () => {
    expect(extractMessageText({ senderId: 'system', payload: { reminder: 'take out trash' } })).toBe(
      null,
    );
    expect(extractMessageText({ senderId: 'wife', payload: 42 })).toBe(null);
    expect(extractMessageText({ senderId: 'wife', payload: null })).toBe(null);
  });
});

describe('action-update payload (T37)', () => {
  const item = {
    senderId: 'system:hitl',
    payload: { actionUpdate: '[action update] act-1 (propose_event) expired — nothing was executed.' },
  };

  it('toModelMessages renders the update text verbatim as a user message', () => {
    expect(toModelMessages([item])).toEqual([
      {
        role: 'user',
        senderId: 'system:hitl',
        content: '[action update] act-1 (propose_event) expired — nothing was executed.',
      },
    ]);
  });

  it('is invisible to the classifier and the quoted-reply binder — only utterances route', () => {
    expect(extractMessageText(item)).toBeNull();
    expect(extractQuotedReply(item)).toBeNull();
  });
});
