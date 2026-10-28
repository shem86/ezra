// The [inbound] line runs for EVERY message the WhatsApp socket sees, before
// the allowlist drops non-household chats — so it must not carry their
// content. Household lines keep the raw sender id (the WA_JID_* config value).

import { describe, expect, it } from 'vitest';
import { formatInboundLog } from '../../src/transport/inbound-log.js';

const message = {
  conversationId: '120363000000000000@g.us',
  senderId: '186600000000000@lid',
  senderName: 'Shem',
  text: 'a private message that must never reach a log line',
};

describe('formatInboundLog', () => {
  it('logs only the chat id for a non-household conversation', () => {
    const line = formatInboundLog(message, false);

    expect(line).toContain(message.conversationId);
    expect(line).not.toContain(message.text);
    expect(line).not.toContain(message.senderId);
    expect(line).not.toContain('Shem');
  });

  it('keeps sender id, name and a preview for a household conversation', () => {
    const line = formatInboundLog(message, true);

    expect(line).toBe(
      `[inbound] chat=${message.conversationId} sender=${message.senderId} (Shem): ${message.text}`,
    );
  });

  it('truncates a long household message to an 80-char preview', () => {
    const line = formatInboundLog({ ...message, senderName: null, text: 'x'.repeat(100) }, true);

    expect(line).toBe(`[inbound] chat=${message.conversationId} sender=${message.senderId}: ${'x'.repeat(80)}…`);
  });
});
