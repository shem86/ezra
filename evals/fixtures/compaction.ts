// Compaction quality fixtures (docs/compaction-eval-spec.md). Each scenario is
// a realistic HEAD — the older slice a compaction would summarize — paired with
// planted ground truth: the open commitments that MUST survive (the one thing
// the summary prompt promises verbatim), which languages appear (Hebrew must
// stay Hebrew), and for the fold-in case a prior-summary commitment that must
// carry through. The driver (evals/compaction.eval.ts) runs each head through
// the REAL summarizer and scores the result against this ground truth.
//
// These are hand-built so the ground truth is known exactly — unlike the prod
// spot-check path, where commitments are judge-extracted from real rows. Heads
// are code-switched on purpose (SPEC assumption 1: the household mixes Hebrew
// and English, and the summarizer must not translate either away).

import { compactionSenderId, type CompactionConfig } from '../../src/agent/compaction.ts';
import type { TurnMessage } from '../../src/agent/context.ts';

const SHEM = 'shem';
const REUT = 'reut';

function user(senderId: string, content: string): TurnMessage {
  return { role: 'user', senderId, content };
}
function assistant(content: string): TurnMessage {
  return { role: 'assistant', content, toolCalls: [] };
}
function tool(toolUseId: string, content: string): TurnMessage {
  return { role: 'tool', toolUseId, content };
}

export interface CompactionScenario {
  readonly name: string;
  readonly description: string;
  /** The messages to summarize — a realistic head slice. */
  readonly head: readonly TurnMessage[];
  /**
   * Open commitments / unresolved questions that MUST survive into the summary,
   * each as a natural-language claim the judge verifies (present AND correctly
   * attributed to who said it).
   */
  readonly mustPreserve: readonly string[];
  /** Languages present in the head; the summary must not translate them away. */
  readonly languages: readonly ('he' | 'en')[];
  /** Facts the DB owns — the summary may mention them as context but must NOT
   *  restate as authoritative, and must NOT invent. */
  readonly mustNotInvent?: readonly string[];
  /** Fold-in case: a prior-summary commitment that must carry through unchanged. */
  readonly foldIn?: string;
}

// Lower threshold than production so a readable ~12-message head still triggers;
// the eval calls the summarizer directly, but ships the config for harnesses
// that want to drive the real shouldCompact/findCompactionCut path.
export const evalCompactionConfig: CompactionConfig = {
  thresholdMessages: 10,
  keepMessages: 4,
};

export const compactionScenarios: readonly CompactionScenario[] = [
  {
    name: 'english-pickup-commitment',
    description: 'A single clear English commitment to do school pickup, awaiting confirmation.',
    head: [
      user(REUT, 'who is getting the kids from school tomorrow?'),
      assistant('I can help coordinate. Do you want me to set a reminder once someone decides?'),
      user(SHEM, "I'll do pickup tomorrow at 3:30"),
      user(REUT, 'ok let me check my meetings and confirm tonight'),
      assistant('Got it.'),
      user(SHEM, 'also we are low on coffee'),
      user(REUT, 'noted'),
      assistant('Anything else?'),
      user(SHEM, 'not for now'),
      assistant('Okay.'),
      user(REUT, 'actually what time does school end on fridays?'),
      assistant('School ends at 1:00 on Fridays.'),
    ],
    mustPreserve: [
      'Shem committed to doing school pickup tomorrow at 3:30',
      'Reut said she would confirm tonight after checking her meetings',
    ],
    languages: ['en'],
  },
  {
    name: 'hebrew-plumber-commitment',
    description: 'Hebrew-only: the plumber is coming Thursday morning; Reut to be home.',
    head: [
      user(SHEM, 'דיברתי עם האינסטלטור על הדוד'),
      assistant('בסדר.'),
      user(SHEM, 'הוא אמר שיבוא ביום חמישי בבוקר בין 8 ל-10'),
      user(REUT, 'אני אהיה בבית ואחכה לו'),
      assistant('רשמתי.'),
      user(SHEM, 'כמה זה יעלה?'),
      user(SHEM, 'הוא אמר בערך 1200 שקל אבל צריך לראות'),
      assistant('הבנתי.'),
      user(REUT, 'נצטרך גם לקנות חלב בדרך'),
      assistant('אוקיי.'),
      user(SHEM, 'תזכיר לי להתקשר אליו אם הוא לא מגיע'),
      assistant('בסדר.'),
    ],
    mustPreserve: [
      'The plumber said he will come Thursday morning between 8 and 10',
      'Reut committed to being home to wait for the plumber',
    ],
    languages: ['he'],
    mustNotInvent: ['that the 1200 shekel price is final — it was explicitly tentative'],
  },
  {
    name: 'code-switched-within-messages',
    description: 'Messages mix Hebrew and English mid-sentence; a babysitter commitment.',
    head: [
      user(REUT, 'we need a babysitter ל-שבת בערב'),
      assistant('Want me to remind you to arrange one?'),
      user(SHEM, 'אני אשאל את מאיה if she is free Saturday night'),
      user(REUT, 'great, תעדכן אותי by Thursday'),
      assistant('Noted.'),
      user(SHEM, 'גם צריך להזמין מסעדה'),
      user(REUT, 'I will book the restaurant for 8pm'),
      assistant('Okay.'),
      user(SHEM, 'כמה אנשים?'),
      user(REUT, 'just the two of us'),
      assistant('Got it.'),
      user(SHEM, 'מעולה'),
    ],
    mustPreserve: [
      'Shem committed to asking Maya if she is free Saturday night to babysit',
      'Shem will update Reut by Thursday',
      'Reut committed to booking the restaurant for 8pm for two people',
    ],
    languages: ['he', 'en'],
  },
  {
    name: 'multiple-people-multiple-commitments',
    description: 'Several distinct commitments across both people — attribution must not blur.',
    head: [
      user(SHEM, 'תכנון לשבוע: מי עושה מה'),
      user(SHEM, "I'll take the car for service on Monday"),
      user(REUT, 'אני אקח את נועה לרופא ביום שלישי'),
      assistant('Tracking these.'),
      user(SHEM, 'can you call the gan about the תשלום?'),
      user(REUT, 'כן אני אתקשר לגן מחר בבוקר'),
      assistant('Okay.'),
      user(SHEM, 'ואני אזמין את הכרטיסים להופעה'),
      user(REUT, 'מתי ההופעה?'),
      user(SHEM, 'ב-15 לחודש'),
      assistant('Noted.'),
      user(REUT, 'אל תשכח'),
    ],
    mustPreserve: [
      'Shem will take the car for service on Monday',
      'Reut will take Noa to the doctor on Tuesday',
      'Reut committed to calling the gan tomorrow morning about the payment',
      'Shem will order the concert tickets (the concert is on the 15th)',
    ],
    languages: ['he', 'en'],
  },
  {
    name: 'fold-in-prior-summary',
    description:
      'The head begins with a prior compaction summary; its open commitment must survive the next compaction (chained).',
    head: [
      user(
        compactionSenderId,
        'Summary of the earlier conversation:\nReut and Shem discussed the boiler. OPEN: עדיין מחכים לאינסטלטור שיחזור עם הצעת מחיר — Shem to follow up.',
      ),
      user(REUT, 'מה קורה עם הצהרון של נועה?'),
      assistant('What would you like to do about it?'),
      user(SHEM, 'I will email the afterschool program about switching to Tuesdays'),
      user(REUT, 'תעשה את זה היום אם אפשר'),
      assistant('Okay.'),
      user(SHEM, 'כן אני אשלח אימייל אחר הצהריים'),
      assistant('Noted.'),
      user(REUT, 'תודה'),
      assistant('בכיף.'),
      user(SHEM, 'עוד משהו על הדוד?'),
      assistant('Still waiting on the plumber per the earlier summary.'),
    ],
    mustPreserve: [
      'Shem committed to emailing the afterschool program this afternoon about switching to Tuesdays',
    ],
    languages: ['he', 'en'],
    foldIn: 'The open item from the prior summary — still waiting on the plumber for a price quote, Shem to follow up — must carry through',
  },
  {
    name: 'commitment-with-tool-result',
    description:
      'A calendar lookup tool result sits in the head; the commitment must survive and DB-owned facts must not be restated as authoritative.',
    head: [
      user(REUT, 'are we free saturday afternoon?'),
      assistant('Let me check the calendar.'),
      tool('tu-cal-1', 'calendar: Saturday 2026-07-04 — "kids swim 10:00-11:00", otherwise free after 12:00'),
      assistant('You have swim 10-11, then free after noon.'),
      user(SHEM, 'great, אני אקבע בראנץ עם ההורים שלי ב-1'),
      user(REUT, 'נשמע טוב, תזמין שולחן ל-6'),
      assistant('Okay.'),
      user(SHEM, 'אני אזמין עכשיו'),
      assistant('Noted.'),
      user(REUT, 'ואל תשכח שיש שחייה בבוקר'),
      assistant('Right, swim is at 10.'),
      user(SHEM, 'כן'),
    ],
    mustPreserve: [
      'Shem committed to arranging a brunch with his parents at 1pm on Saturday and booking a table for 6',
    ],
    languages: ['he', 'en'],
    mustNotInvent: [
      'the swim class time as if the summary owns it — the calendar owns schedule facts; the summary may mention swim only as context',
    ],
  },
  {
    name: 'unresolved-question',
    description: 'An open undecided question (not a commitment) that must be preserved as still-open.',
    head: [
      user(REUT, 'where are we going for the summer חופשה?'),
      assistant('Have you decided between options?'),
      user(SHEM, 'עדיין לא החלטנו — או צפון או ים המלח'),
      user(REUT, 'נצטרך להחליט עד סוף החודש כי המחירים עולים'),
      assistant('Understood.'),
      user(SHEM, 'בוא נדבר על זה בסופ"ש'),
      user(REUT, 'okay'),
      assistant('Okay.'),
      user(SHEM, 'בינתיים תבדקי מחירים?'),
      user(REUT, 'כן אני אבדוק מחירים של צימרים בצפון'),
      assistant('Noted.'),
      user(SHEM, 'תודה'),
    ],
    mustPreserve: [
      'It is still undecided where to go for the summer vacation — north or the Dead Sea — and a decision is needed by the end of the month',
      'Reut committed to checking prices of cabins in the north',
    ],
    languages: ['he', 'en'],
  },
  {
    name: 'signal-in-noise',
    description: 'Mostly chit-chat with one real commitment buried in the middle.',
    head: [
      user(SHEM, 'בוקר טוב'),
      assistant('Good morning!'),
      user(REUT, 'ישנת טוב?'),
      user(SHEM, 'לא משהו, הילדים הקפיצו אותי'),
      assistant('Oof.'),
      user(REUT, 'אגב, תזכור שאתה צריך לאסוף את התרופה של נועה מבית המרקחת היום'),
      user(SHEM, 'נכון, אני אעבור אחרי העבודה לאסוף אותה'),
      assistant('Noted.'),
      user(REUT, 'מה רוצה לאכול בערב?'),
      user(SHEM, 'משהו קליל'),
      assistant('Sounds good.'),
      user(REUT, 'אולי סלט'),
    ],
    mustPreserve: [
      "Shem committed to picking up Noa's medicine from the pharmacy after work today",
    ],
    languages: ['he', 'en'],
  },
];
