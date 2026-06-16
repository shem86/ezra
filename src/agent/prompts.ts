// System prompts (T32/T42). Each prompt is a prompt-cache prefix (T25
// attaches cacheControl to it; one turn model, one cache — ADR-0003), so it
// must be byte-stable across calls: no dates, no per-turn state. The
// production prompt is built from Config ONCE at startup — config is
// constant for the process lifetime, so the prefix stays byte-stable where
// it matters (within a process; a restart re-primes the cache regardless).
// Anything per-turn goes through the digest slot, appended strictly AFTER
// the prefix so cache reads survive digest changes.

import type { ApprovalOutcome } from '../hitl/resolve-approval.js';

// Household invariants shared verbatim by the dev and production prompts —
// extracted so the two can never drift apart on the rules that are
// test-locked and eval-proven (language, tz, tools-are-truth, approvals).
const sharedSections = `## Language
The household mixes Hebrew and English, often inside one sentence. Reply in the language of the message you are answering — Hebrew to Hebrew, English to English — and keep code-switched words exactly as the user wrote them.

## Time
All times are US Eastern wall time. When a user names a time ("7am", "בשבע בבוקר"), pass it to tools as Eastern wall-clock fields exactly as said — never convert it yourself.

## Tools are the truth
Lists, reminders, and household facts live in the database, not in this chat. Read them through tools at the moment of use; never answer from memory of an earlier turn. When acting on an existing item, use the id a tool result gave you. For questions about older conversations, use recall_history.

## Approvals
Proposed actions sometimes wait for a yes/no (listed under "Awaiting approval"). When a message looks like it answers one of them but does not quote a specific approval prompt and more than one action is waiting, never pick one yourself — ask the user to reply directly to the prompt message they mean.

## Style
This is WhatsApp: answer short and direct, one message, no headers or bullet lists unless listing items. Confirm what you did, including the relevant ids only when the user will need them.`;

export const stableSystemPrompt: string = `You are the household assistant for a two-person household, reachable over WhatsApp.

## Senders
Every user message is prefixed with the sender's id, like "wife@wa: the message". There are exactly two members and every sender is one of them. Use the id to attribute actions — pass it as addedBy/createdBy when a tool asks who acted — and to keep the two members' items straight. All household data — lists, reminders, facts — is shared between both members: answer either member's question about any stored item, including codes and other sensitive-looking facts (there is no secrecy between them). Messages from system:compaction are summaries of older conversation, not a person. Messages from system:hitl report what happened to a previously proposed action ([action update]); relay that outcome to the user in their language — the action already happened or didn't, so never call a tool to redo it.

${sharedSections}`;

export interface ProductionPromptOptions {
  /** Sender JID(s) per member (ledger #12) — a member may appear under
   * several forms (phone-shaped and @lid; docs/pairing.md). */
  readonly memberJids: {
    readonly husband: readonly string[];
    readonly wife: readonly string[];
  };
}

/**
 * The production stable prefix (T42): persona (SPEC Q4: Ezra — builder pick
 * 2026-06-12), the real-JID→member mapping (ledger #12: phone-shaped JIDs
 * carry no member semantics and T32 proved id semantics steer the model),
 * and the recurrence honesty rule (ledger #4: cut for v1). Pure function of
 * start-time config — same config, same bytes.
 */
export function makeProductionSystemPrompt(options: ProductionPromptOptions): string {
  const husband = options.memberJids.husband.join(', ');
  const wife = options.memberJids.wife.join(', ');
  return `You are Ezra (עזרא), the household assistant for a two-person household, living in their WhatsApp chat.

## Senders
Every user message is prefixed with the sender's WhatsApp id, like "15550001111@s.whatsapp.net: the message". There are exactly two household members, and a member may appear under more than one id:
- husband: ${husband}
- wife: ${wife}
Match the id prefix to the member. When a tool asks who acted (addedBy/createdBy) or whose calendar (owner), pass the member label (husband or wife), never the raw id. All household data — lists, reminders, facts — is shared between both members: answer either member's question about any stored item, including codes and other sensitive-looking facts (there is no secrecy between them). Messages from system:compaction are summaries of older conversation, not a person. Messages from system:hitl report what happened to a previously proposed action ([action update]); relay that outcome to the user in their language — the action already happened or didn't, so never call a tool to redo it.

## Reminders are one-time
You cannot create repeating reminders ("every Tuesday", "כל יום שלישי") in this version — be honest about that when asked. Offer to set the next occurrence instead, and when a reminder fires, the household can ask you right there to set the next one.

${sharedSections}`;
}

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
  /**
   * Raw args as JSON — what the relatedness classifier reads to build a refine
   * patch (it needs the field names, which the human summary hides). Absent ⇒
   * the classifier falls back to the human summary. Never rendered into the
   * system-prompt digest, which shows `summary` only.
   */
  readonly argsJson?: string;
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

const currentTimeFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'long',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * The per-turn current-time block (decision: PUSH the clock, never a pull
 * tool). The turn model's training anchor makes it feel like "today" is
 * mid-2025, so without this every relative time ("today", "tomorrow", "in 5
 * minutes") lands ~11 months in the past. Mirrors Claude's own system prompt,
 * which injects {{currentDateTime}} paired with a knowledge-cutoff line so the
 * model distrusts its internal date sense. Rides the post-prefix dynamic slot
 * (no cacheControl), so it never disturbs the cached prefix.
 */
export function renderCurrentTimePrompt(now: Date): string {
  const parts: Record<string, string> = {};
  for (const part of currentTimeFormat.formatToParts(now)) parts[part.type] = part.value;
  const stamp = `${parts.weekday} ${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  return [
    `## Current time`,
    `The current date and time is ${stamp} (US Eastern). Your training data is frozen around early 2025, so do NOT trust your own sense of today's date — always use the value above. Resolve every relative time ("today", "tonight", "tomorrow", "in 5 minutes", "next week") against it, and always pass a full year, month, and day to tools.`,
  ].join('\n');
}

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

/**
 * The user-facing message that closes a parked turn (T34). Deterministic
 * given its inputs — the workflow appends it during replay, so no clock, no
 * randomness. The send receipt of THIS message becomes prompt_message_id,
 * which is what a quoted reply approves (T35) even with several outstanding.
 */
export function renderApprovalPrompt(entry: {
  readonly actionId: string;
  readonly toolName: string;
  readonly summary: string;
}): string {
  return `Approval needed: ${entry.toolName} ${entry.summary}\nReply to this message to approve or decline. [${entry.actionId}]`;
}

/**
 * The new context message that carries a settled approval's real outcome
 * into the fresh turn (T35; decision 10's transcript note — never a second
 * tool_result). Deterministic: rendered in the workflow from the journaled
 * resolver outcome, so replay regenerates identical bytes. Null for
 * outcomes that change nothing (unbound/unclear) — those stay normal turns.
 */
export function renderApprovalOutcome(
  outcome: ApprovalOutcome,
  approverId: string,
): string | null {
  switch (outcome.kind) {
    case 'unbound':
    case 'unclear':
      return null;
    case 'executed':
      return `[action update] ${outcome.actionId} (${outcome.toolName}) approved by ${approverId} and done: ${outcome.result}`;
    case 'denied':
      return `[action update] ${outcome.actionId} (${outcome.toolName}) declined by ${approverId} — nothing was executed.`;
    case 'stale':
      return `[action update] ${outcome.actionId} (${outcome.toolName}) was approved by ${approverId} but failed its revalidation check — it is no longer valid and was NOT executed.`;
    case 'failed':
      return `[action update] ${outcome.actionId} (${outcome.toolName}) was approved by ${approverId} but the action could not be completed (${outcome.message}) — it is STILL PENDING and was not executed; approving it again will retry.`;
    case 'already-resolved':
      return `[action update] ${approverId} answered the prompt for ${outcome.actionId}, but it was already ${outcome.status} — nothing changed.`;
  }
}

/**
 * The proactive context message for an action nobody answered before its TTL
 * (T37). Deterministic — the sweep enqueues it and replay must regenerate
 * identical bytes. Gentle by content (nothing failed, no blame, an easy path
 * back); the model relays it in the user's language per the system:hitl rule.
 */
export function renderExpiryNotice(entry: {
  readonly actionId: string;
  readonly toolName: string;
  readonly summary: string;
}): string {
  return `[action update] the proposed ${entry.toolName} (${entry.summary}) [${entry.actionId}] was not approved in time and has quietly expired — nothing was executed. If it is still wanted, just ask again.`;
}

/** Stable prefix first, digest strictly after — the cache-prefix discipline. */
export function composeSystemPrompt(digest: string | null): string {
  if (digest === null) return stableSystemPrompt;
  return `${stableSystemPrompt}\n\n${digest}`;
}
