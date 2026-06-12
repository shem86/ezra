// T38: the decision-9 scenario scripts, in T32's scripted-day format
// (sender ids are unambiguous household members — the builder@wa lesson).
// These are the GATE scripts: `pnpm eval` drives each through the real
// handleTurn composition with real models and asserts on STATE — row
// status, effect counts, the new context message — never reply wording.
//
// "approve-after-delay" is the park itself: fire-and-fold frees the slot at
// propose time, so the approval inherently arrives in a later turn. Dates
// are explicit (no "tomorrow") so assertions don't depend on the run date.

import type { ScriptedMessage } from '../../src/dev/scripted-day.ts';

export interface EvalScenarioMessage extends ScriptedMessage {
  /**
   * Send as a quoted reply to the scenario's CURRENT approval prompt: the
   * driver reads the pending action's prompt_message_id stamp and attaches
   * it as quotedMessageId (T35 binding). After a refine re-stamps, this
   * quotes the NEW stamp — which is exactly what a phone user would quote.
   */
  readonly quotesPrompt?: boolean;
}

export interface EvalScenario {
  readonly name: string;
  /** Suffixed with a run id by the driver so reruns never share state. */
  readonly conversationKey: string;
  readonly messages: readonly EvalScenarioMessage[];
  /** Tool names the scenario is expected to exercise. */
  readonly covers: readonly string[];
}

const HUSBAND = 'husband@wa';
const WIFE = 'wife@wa';

export const evalScenarios: readonly EvalScenario[] = [
  {
    name: 'approve-after-delay',
    conversationKey: 'approve',
    messages: [
      { senderId: WIFE, text: 'תקבע תור לרופא שיניים ב-19 ביוני 2026 בשעה 15:00' },
      { senderId: HUSBAND, text: 'yes', quotesPrompt: true },
    ],
    covers: ['propose_event'],
  },
  {
    name: 'deny',
    conversationKey: 'deny',
    messages: [
      {
        senderId: HUSBAND,
        text: 'can you put a date night dinner on the calendar for June 20 2026 at 19:00?',
      },
      // Non-quoted with exactly one pending — the T36 classified path.
      { senderId: WIFE, text: 'לא, אל תקבע את זה' },
    ],
    covers: ['propose_event'],
  },
  {
    name: 'abandon-by-unrelated-message',
    conversationKey: 'abandon',
    messages: [
      { senderId: WIFE, text: 'תקבע חוג שחייה לילדים ב-21 ביוני 2026 בשעה 10:00' },
      // Unrelated while one action pends: classifier must leave it alone —
      // normal turn, action untouched, never silently auto-denied.
      { senderId: HUSBAND, text: 'מה יש לנו ברשימת הקניות?' },
    ],
    covers: ['propose_event'],
  },
  {
    name: 'refine-the-pending-action',
    conversationKey: 'refine',
    messages: [
      { senderId: HUSBAND, text: 'schedule a haircut for me on June 22 2026 at 15:00' },
      // Code-switched refine — Haiku must return COMPLETE updated args.
      { senderId: WIFE, text: 'actually תזיז את זה ל-16:00' },
      // Quoted approve binds to the RE-STAMPED prompt the refine re-sent.
      { senderId: HUSBAND, text: 'כן', quotesPrompt: true },
    ],
    covers: ['propose_event'],
  },
  {
    name: 'stale-action-at-execution',
    conversationKey: 'stale',
    messages: [
      { senderId: WIFE, text: 'תקבע צביעת הגדר ל-23 ביוני 2026 בשעה 09:00' },
      // The driver occupies the slot between these turns (manufactured
      // conflict) — approval then fails revalidation at execute time.
      { senderId: HUSBAND, text: 'ok', quotesPrompt: true },
    ],
    covers: ['propose_event'],
  },
  {
    name: 'execute-once-double-approval',
    conversationKey: 'double',
    messages: [
      { senderId: HUSBAND, text: 'book a babysitter for June 24 2026 at 18:00 please' },
      // Both spouses answer back-to-back; the guard must let exactly one win.
      { senderId: HUSBAND, text: 'yes', quotesPrompt: true },
      { senderId: WIFE, text: 'כן', quotesPrompt: true },
    ],
    covers: ['propose_event'],
  },
  {
    name: 'sender-attribution',
    conversationKey: 'attribution',
    messages: [
      // The T27 contract: the model reads who asked from the sender-attributed
      // user message and passes it as addedBy/createdBy. The item is a
      // distinctive literal so the assertion can find the row regardless of
      // which list name the model picks.
      { senderId: WIFE, text: 'תוסיף pomegranate juice לרשימת הקניות' },
      { senderId: HUSBAND, text: 'remind me on June 25 2026 at 8am to renew the car insurance' },
    ],
    covers: ['add_list_item', 'create_reminder'],
  },
];
