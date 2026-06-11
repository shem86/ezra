// Compaction (T29): summarize-and-truncate when the transcript crosses a
// threshold, folding the head into the semantic store. Lossy by design —
// truth lives in the structured store (SPEC "Truth vs continuity"); what the
// summary must carry is continuity, and open commitments verbatim (Open Q3,
// resolved 2026-06-11: threshold 60 messages, keep 20). The split logic is
// pure so the corruption risk — orphaning a tool_result from its tool_use —
// is unit-testable without a database.

import { generateText, type LanguageModel } from 'ai';
import type { TurnMessage } from './context.js';

export interface CompactionConfig {
  /** Compact when the transcript exceeds this many messages. */
  readonly thresholdMessages: number;
  /** Minimum recent messages kept live (the cut lands at or before this). */
  readonly keepMessages: number;
}

/** Open Q3 resolution: ~30 turns ≈ 60 messages, with a generous recent window. */
export const defaultCompactionConfig: CompactionConfig = {
  thresholdMessages: 60,
  keepMessages: 20,
};

/** Reserved senderId: the summary travels as a user message (no schema change). */
export const compactionSenderId = 'system:compaction';

export function shouldCompact(
  msgs: readonly TurnMessage[],
  config: CompactionConfig,
): boolean {
  return msgs.length > config.thresholdMessages;
}

/**
 * The split index: head = msgs[0..cut), tail = msgs[cut..]. The cut MUST land
 * on a user message — a turn's tool_results always follow their tool_use with
 * no user message between (loop construction), so a user-boundary cut can
 * never orphan a result. Returns the largest user index that still keeps
 * keepMessages live, or null when no such boundary exists (then skip — never
 * corrupt to proceed).
 */
export function findCompactionCut(
  msgs: readonly TurnMessage[],
  config: CompactionConfig,
): number | null {
  const maxCut = msgs.length - config.keepMessages;
  for (let i = Math.min(maxCut, msgs.length - 1); i >= 1; i--) {
    if (msgs[i]!.role === 'user') return i;
  }
  return null;
}

export function buildCompactedTranscript(
  summary: string,
  tail: readonly TurnMessage[],
): TurnMessage[] {
  return [
    {
      role: 'user',
      senderId: compactionSenderId,
      content: `Summary of the earlier conversation (fuller detail may be recallable via recall_history):\n${summary}`,
    },
    ...tail,
  ];
}

// What the summary must and must not do: open commitments are the one thing
// that exists nowhere else (facts live in the structured store; parked
// approvals re-enter via the pending-actions digest), so they survive
// verbatim. Quality beyond these instructions is M5 eval territory.
export const summarySystemPrompt = `You summarize the older part of a household WhatsApp conversation between two people and their assistant, so the conversation can continue with the summary in place of the original messages.

Rules:
- Keep every open commitment, promise, or unresolved question VERBATIM, attributed to who said it (e.g. who is picking up, who said they would confirm, what is still undecided).
- Preserve names, and keep each language as written: Hebrew stays Hebrew, English stays English — do not translate.
- A message from "${compactionSenderId}" is a previous summary — fold its content in; do not summarize it away.
- Do not restate lists, reminders, schedules, or stored facts as authoritative — the database owns those; mention them only as conversational context.
- Be concise. Plain text, no headings.`;

export function renderForSummary(msgs: readonly TurnMessage[]): string {
  return msgs
    .map((m) => {
      switch (m.role) {
        case 'user':
          return `${m.senderId}: ${m.content}`;
        case 'assistant':
          return `assistant: ${m.content}`;
        case 'tool':
          return `[tool result] ${m.content}`;
      }
    })
    .join('\n');
}

export interface SummarizeDeps {
  /** Haiku-class — summarization is routing-tier work (instantiated by the composer). */
  readonly model: LanguageModel;
}

/** The real summarizer behind the workflow's summarize seam (CI scripts it). */
export function makeSummarize(
  deps: SummarizeDeps,
): (head: readonly TurnMessage[]) => Promise<string> {
  return async function summarize(head) {
    const result = await generateText({
      model: deps.model,
      system: summarySystemPrompt,
      prompt: renderForSummary(head),
    });
    return result.text;
  };
}
