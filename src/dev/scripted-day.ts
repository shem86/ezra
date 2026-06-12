// Scripted day (T32): mixed Hebrew/English conversations covering the whole
// v1 tool surface. Consumed by the pnpm dev stub loop, reused by T33's cost
// measurements and T38's evals. `covers` is the declared tool surface per
// conversation — a unit test holds the union equal to the registry, so a new
// tool cannot land without a scripted exercise of it.

export interface ScriptedMessage {
  readonly senderId: string;
  readonly text: string;
}

export interface ScriptedConversation {
  readonly name: string;
  /** Suffixed with a run id by the dev loop so reruns never share state. */
  readonly conversationKey: string;
  readonly messages: readonly ScriptedMessage[];
  /** Tool names this conversation is expected to exercise. */
  readonly covers: readonly string[];
}

// 'husband@wa', not 'builder@wa': the model read "builder" semantically — a
// contractor at the house — and refused to hand the parking-gate code to an
// "outside party" (observed twice on claude-sonnet-4-6, 2026-06-11). Fixture
// ids must read as unambiguous household members; production JIDs are
// phone-number-shaped and carry no such semantics (prompt mapping is a T42
// concern).
const BUILDER = 'husband@wa';
const WIFE = 'wife@wa';

export const scriptedDay: readonly ScriptedConversation[] = [
  {
    name: 'groceries — code-switched list flow',
    conversationKey: 'groceries',
    messages: [
      { senderId: WIFE, text: 'תוסיף חלב ולחם לרשימת הקניות' },
      { senderId: BUILDER, text: "what's on the shopping list?" },
      { senderId: WIFE, text: 'קניתי את החלב, אפשר לסמן שזה נעשה' },
    ],
    covers: ['add_list_item', 'get_list', 'mark_item_done'],
  },
  {
    name: 'reminders — Eastern wall-time round trip',
    conversationKey: 'reminders',
    messages: [
      { senderId: BUILDER, text: 'remind me tomorrow at 7am to take out the trash' },
      { senderId: WIFE, text: 'אילו תזכורות קיימות עכשיו?' },
      { senderId: BUILDER, text: 'actually, cancel the trash reminder' },
    ],
    covers: ['create_reminder', 'list_reminders', 'cancel_reminder'],
  },
  {
    name: 'household facts — set then read back',
    conversationKey: 'facts',
    messages: [
      { senderId: WIFE, text: 'תשמור שהקוד לשער של החניה הוא 4321' },
      { senderId: BUILDER, text: 'what is the parking gate code?' },
    ],
    covers: ['set_fact', 'get_fact'],
  },
  {
    name: 'recall — pull-only semantic memory',
    conversationKey: 'recall',
    messages: [
      { senderId: BUILDER, text: 'מה דיברנו על קניות בשיחות קודמות?' },
    ],
    covers: ['recall_history'],
  },
];
