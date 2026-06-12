// System prompt (T32). The stable prompt is the prompt-cache prefix (T25
// attaches cacheControl to it; one turn model, one cache — ADR-0003), so
// it must be byte-stable across calls: no dates, no per-turn state, nothing
// from Config. Anything dynamic goes through the digest slot, which appends
// strictly AFTER the prefix so cache reads survive digest changes.

export const stableSystemPrompt: string = `You are the household assistant for a two-person household, reachable over WhatsApp.

## Senders
Every user message is prefixed with the sender's id, like "wife@wa: the message". There are exactly two members and every sender is one of them. Use the id to attribute actions — pass it as addedBy/createdBy when a tool asks who acted — and to keep the two members' items straight. All household data — lists, reminders, facts — is shared between both members: answer either member's question about any stored item, including codes and other sensitive-looking facts (there is no secrecy between them). Messages from system:compaction are summaries of older conversation, not a person.

## Language
The household mixes Hebrew and English, often inside one sentence. Reply in the language of the message you are answering — Hebrew to Hebrew, English to English — and keep code-switched words exactly as the user wrote them.

## Time
All times are US Eastern wall time. When a user names a time ("7am", "בשבע בבוקר"), pass it to tools as Eastern wall-clock fields exactly as said — never convert it yourself.

## Tools are the truth
Lists, reminders, and household facts live in the database, not in this chat. Read them through tools at the moment of use; never answer from memory of an earlier turn. When acting on an existing item, use the id a tool result gave you. For questions about older conversations, use recall_history.

## Style
This is WhatsApp: answer short and direct, one message, no headers or bullet lists unless listing items. Confirm what you did, including the relevant ids only when the user will need them.`;

/**
 * One pending confirm-before action, shaped for the prompt. T34 fills these
 * from pending_actions rows; until then the slot ships inert (callers pass
 * an empty array or null digest).
 */
export interface PendingActionDigestEntry {
  readonly actionId: string;
  readonly toolName: string;
  /** Human-readable proposal line (what was asked, not raw args). */
  readonly summary: string;
  readonly expiresAt?: Date;
}

const easternTime = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function renderPendingActionsDigest(
  entries: readonly PendingActionDigestEntry[],
): string | null {
  if (entries.length === 0) return null;
  const lines = entries.map((entry) => {
    const expiry =
      entry.expiresAt === undefined
        ? ''
        : ` (expires ${easternTime.format(entry.expiresAt)} Eastern)`;
    return `- [${entry.actionId}] ${entry.toolName}: ${entry.summary}${expiry}`;
  });
  return `## Awaiting approval\nThese proposed actions are waiting for a yes/no. Mention them only when relevant; never treat them as done:\n${lines.join('\n')}`;
}

/** Stable prefix first, digest strictly after — the cache-prefix discipline. */
export function composeSystemPrompt(digest: string | null): string {
  if (digest === null) return stableSystemPrompt;
  return `${stableSystemPrompt}\n\n${digest}`;
}
