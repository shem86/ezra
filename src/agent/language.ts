// Reply language, decided in code (STATUS item 14 follow-up). The system
// prompt's "reply in the language of the message" rule loses to a run of
// turns in the other language: in the 2026-10-29 eval, Sonnet 5.5 (low and
// medium effort) and Sonnet 4.6 alike answered an English request in Hebrew
// after three Hebrew turns, 9/9, and a sharper prompt rule moved it 0/3. A
// per-turn note naming the language does what the standing rule could not.

import type { TurnMessage } from './context.js';

export type ReplyLanguage = 'en' | 'he';

/**
 * The majority script of a message — Hebrew and Latin are the only two this
 * household writes in. Null when there are no letters or the split is even,
 * so a truly ambiguous message gets no note and the prompt rule decides.
 */
export function dominantLanguage(text: string): ReplyLanguage | null {
  const he = (text.match(/[א-ת]/g) ?? []).length;
  const en = (text.match(/[A-Za-z]/g) ?? []).length;
  if (he === en) return null;
  return he > en ? 'he' : 'en';
}

/**
 * The language of the latest message a MEMBER wrote. System senders
 * (`system:hitl` updates, `system:compaction` summaries) are skipped: their
 * wording is ours, not the member's.
 */
export function replyLanguageFor(msgs: readonly TurnMessage[]): ReplyLanguage | null {
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const msg = msgs[i]!;
    if (msg.role === 'user' && !msg.senderId.startsWith('system:')) {
      return dominantLanguage(msg.content);
    }
  }
  return null;
}
