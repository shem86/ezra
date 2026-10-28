// The [inbound] log line. It is written for EVERY message the socket sees —
// before ingestion's allowlist drops non-household chats — and on a personal
// number that is every DM and group the owner is in. Those chats get their id
// only (enough to allowlist one); their sender and text never reach a log.

import type { InboundMessage } from './types.js';

const PREVIEW_CHARS = 80;

export function formatInboundLog(
  message: Pick<InboundMessage, 'conversationId' | 'senderId' | 'senderName' | 'text'>,
  isHousehold: boolean,
): string {
  if (!isHousehold) {
    return `[inbound] chat=${message.conversationId} (not a household conversation; content not logged)`;
  }
  // senderId shown raw on purpose: it is the exact value WA_JID_* in .env
  // must contain for member attribution (prompts.ts) — names hide it, and
  // the group can deliver a JID form (@lid vs @s.whatsapp.net) that differs
  // from what's configured.
  const sender =
    message.senderName === null
      ? message.senderId
      : `${message.senderId} (${message.senderName})`;
  const preview =
    message.text.length > PREVIEW_CHARS
      ? `${message.text.slice(0, PREVIEW_CHARS)}…`
      : message.text;
  return `[inbound] chat=${message.conversationId} sender=${sender}: ${preview}`;
}
