// T36/T38: labeled messages for the relatedness classifier, against one fixed
// pending proposal. CI only checks this set's coverage (every class in
// Hebrew, English, and code-switched form — SPEC assumption 1); ACCURACY is
// measured by the T38 eval report with a real Haiku call, never in CI.
// Labels are conservative on purpose, mirroring the classifier contract:
// hedged or conditional answers are 'unrelated', not 'approve'.

export type RelatednessClass = 'approve' | 'deny' | 'refine' | 'unrelated';

export interface RelatednessFixture {
  readonly message: string;
  readonly expected: RelatednessClass;
  /** For refine: the change the updated args must reflect (T38 report detail). */
  readonly note?: string;
}

/**
 * The one pending action every fixture is classified against. The summary is
 * the raw args JSON — what handleTurn feeds the classifier at runtime (it needs
 * the field names to build a refine patch; the human digest line hides them).
 * T46: the real create_calendar_event arg shape, not the old eval stand-in.
 */
export const relatednessFixtureAction = {
  toolName: 'create_calendar_event',
  summary: '{"title":"dentist","date":"2026-06-19","time":"15:00","durationMin":60,"owner":"wife"}',
} as const;

export const relatednessFixtures: readonly RelatednessFixture[] = [
  // approve
  { message: 'yes, go ahead', expected: 'approve' },
  { message: 'sounds good, book it', expected: 'approve' },
  { message: 'כן, קדימה', expected: 'approve' },
  { message: 'מעולה, תקבע', expected: 'approve' },
  { message: 'sure תקבע את זה', expected: 'approve' },
  { message: 'יאללה book it', expected: 'approve' },

  // deny
  { message: 'no, cancel that', expected: 'deny' },
  { message: "don't book it", expected: 'deny' },
  { message: 'לא, תבטל', expected: 'deny' },
  { message: 'עזוב, לא צריך', expected: 'deny' },
  { message: 'לא, cancel it', expected: 'deny' },
  { message: 'forget it, תבטל את זה', expected: 'deny' },

  // refine
  { message: 'make it 4pm', expected: 'refine', note: 'time → 16:00' },
  { message: 'can you change the title to dentist cleaning?', expected: 'refine', note: 'title → dentist cleaning' },
  { message: 'תזיז את זה לארבע', expected: 'refine', note: 'time → 16:00' },
  { message: 'תשנה את השם לרופא שיניים', expected: 'refine', note: 'title → רופא שיניים' },
  { message: 'תזיז את זה ל-4pm', expected: 'refine', note: 'time → 16:00' },
  { message: 'actually תעשה את זה בשש pm', expected: 'refine', note: 'time → 18:00' },

  // unrelated — incl. the hedged/conditional answers the contract sends here
  { message: "what's for dinner tonight?", expected: 'unrelated' },
  { message: 'yes but only if the morning is free', expected: 'unrelated' },
  { message: 'מה השעה של החוג של הילדים?', expected: 'unrelated' },
  { message: 'תוסיף חלב לרשימה', expected: 'unrelated' },
  { message: 'תוסיף milk לרשימת הקניות', expected: 'unrelated' },
  { message: 'כן אבל רק אם אין traffic', expected: 'unrelated' },
];
