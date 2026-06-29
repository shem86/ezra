// The compaction-summary judge (docs/compaction-eval-spec.md). A Sonnet-class
// model reads the original head and the summary under evaluation and returns a
// structured verdict on the QUALITY dimensions — commitment preservation,
// faithfulness, boundary discipline — which need reading comprehension. The
// mechanical hard checks (language, conciseness) live in compaction-score.ts.
//
// AI SDK v6: generateObject is deprecated; structured output is generateText
// with output: Output.object({ schema }), read from result.output.

import { generateText, Output, type LanguageModel } from 'ai';
import { z } from 'zod';
import { renderForSummary } from '../../src/agent/compaction.ts';
import type { TurnMessage } from '../../src/agent/context.ts';
import type { JudgeVerdict } from './compaction-score.ts';

const verdictSchema = z.object({
  commitments: z.array(
    z.object({
      claim: z.string().describe('the planted commitment being checked'),
      preserved: z.boolean().describe('is this commitment present in the summary at all'),
      correctlyAttributed: z
        .boolean()
        .describe('is it attributed to the same person who made it in the original'),
      evidence: z.string().describe('a quote from the summary, or "absent"'),
    }),
  ),
  faithfulness: z.object({
    score: z.number().describe('0..1 — 1 means nothing in the summary is unsupported by the head'),
    inventedClaims: z.array(z.string()).describe('claims in the summary not supported by the head'),
  }),
  boundaryDiscipline: z.object({
    score: z.number().describe('0..1 — 1 means DB-owned facts are context only, not restated as authority'),
    issues: z.array(z.string()).describe('lists/reminders/schedule facts the summary restated as authoritative'),
  }),
  languageNotes: z.string().describe('note any translation away from the original language'),
});

const judgeSystemPrompt = `You are a strict evaluator of summaries of a household WhatsApp conversation between two people (Shem and Reut) and their assistant. You are given the ORIGINAL conversation and a SUMMARY that is meant to replace the older messages so the chat can continue.

Grade ONLY against the original — never reward fluent writing that drifts from what was actually said. The summary's contract:
- Every open commitment, promise, or unresolved question must survive, attributed to who said it. For each planted claim, decide if it is present and attributed to the correct person.
- Each language must stay as written: Hebrew stays Hebrew, English stays English. Note any translation.
- The database owns lists, reminders, schedules, and stored facts — the summary may mention them as context but must NOT restate them as authoritative, and must NOT invent facts.

Be conservative: if a commitment is vague, misattributed, or only implied, it is NOT preserved. Output the structured verdict.`;

export interface JudgeInput {
  readonly head: readonly TurnMessage[];
  readonly summary: string;
  readonly mustPreserve: readonly string[];
  readonly mustNotInvent?: readonly string[];
}

export function makeCompactionJudge(deps: {
  readonly model: LanguageModel;
}): (input: JudgeInput) => Promise<JudgeVerdict> {
  return async function judge(input) {
    const sections = [
      'ORIGINAL CONVERSATION (the head that was summarized):',
      renderForSummary(input.head),
      '',
      'SUMMARY UNDER EVALUATION:',
      input.summary,
      '',
      'CLAIMS THAT MUST BE PRESERVED (check each: present in the summary AND attributed to the right person):',
      ...input.mustPreserve.map((c, i) => `${i + 1}. ${c}`),
    ];
    if (input.mustNotInvent !== undefined && input.mustNotInvent.length > 0) {
      sections.push('', 'MUST NOT INVENT OR RESTATE AS AUTHORITATIVE:');
      sections.push(...input.mustNotInvent.map((c, i) => `${i + 1}. ${c}`));
    }

    const result = await generateText({
      model: deps.model,
      system: judgeSystemPrompt,
      prompt: sections.join('\n'),
      output: Output.object({ schema: verdictSchema }),
    });
    return result.output;
  };
}
