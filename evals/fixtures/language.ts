// Reply language (STATUS item 14 follow-up): does the REAL model answer in the
// language of the message it is answering, even after a run of turns in the
// other language? On 2026-10-29, Sonnet 5.5 answered prod's English "List all
// of the facts you have saved" in Hebrew after three Hebrew turns; Sonnet 4.6
// had opened the same request in English. The single-message scenarios in the
// other suites start a fresh conversation, so nothing there pulls the other way.
//
// The pass is the language of the reply's OPENING line — the model's own
// framing. Stored values it quotes further down legitimately stay in whatever
// language they were saved in.

import type { EvalScenario } from './decision9.ts';
import { dominantLanguage } from '../../src/agent/language.ts';

const HUSBAND = 'husband@wa';
const WIFE = 'wife@wa';

export type ReplyLanguage = 'en' | 'he' | 'none';

export interface LanguageScenario extends EvalScenario {
  /** The language the reply to the FINAL message must open in. */
  readonly expected: 'en' | 'he';
}

export const languageScenarios: readonly LanguageScenario[] = [
  {
    // Prod 2026-10-29, verbatim lead-in (lightly trimmed) and final message.
    name: 'switch-en-after-he',
    conversationKey: 'lang-en-after-he',
    expected: 'en',
    messages: [
      { senderId: HUSBAND, text: 'עכשיו אתה חכם יותר, מרגיש את זה?' },
      { senderId: HUSBAND, text: 'כבר אמרתי שאתה חכם יותר אז אתה חכם יותר' },
      { senderId: HUSBAND, text: 'שדרגתי את המודל, זה אומר לך משהו?' },
      { senderId: HUSBAND, text: 'List all of the facts you have saved' },
    ],
    covers: ['list_facts'],
  },
  {
    name: 'switch-he-after-en',
    conversationKey: 'lang-he-after-en',
    expected: 'he',
    messages: [
      { senderId: WIFE, text: 'hey, how are you today?' },
      { senderId: WIFE, text: 'we just got back from the store, long day' },
      { senderId: WIFE, text: 'anyway, I need something from you' },
      { senderId: WIFE, text: 'מה הסיסמה של הוויפי?' },
    ],
    covers: ['get_fact', 'list_facts'],
  },
];

/**
 * The language of the first line whose script is decided — the model's own
 * framing, before any quoted stored values.
 */
export function openingLanguage(reply: string): ReplyLanguage {
  for (const line of reply.split('\n')) {
    const language = dominantLanguage(line);
    if (language !== null) return language;
  }
  return 'none';
}
