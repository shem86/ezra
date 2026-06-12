// Relatedness classifier (T36, architecture decision 10): when a NON-quoted
// message arrives while exactly one action is pending, Haiku-class decides
// what the message MEANS for it — approve, deny, refine (with full updated
// args), or unrelated. It never decides how anything executes: approve/deny
// route into the T35 settle core's guarded transitions, refine goes through
// the schema-validated refine transaction, and every malformed or hedged
// verdict degrades to 'unrelated' — a normal turn with the action untouched,
// never a silent auto-deny. Misjudging refine-vs-unrelated is an accepted v1
// error mode; T38's fixture report (evals/fixtures/relatedness.ts) is the
// guardrail, not CI.

import { generateText, type LanguageModel } from 'ai';
import { z } from 'zod';

export type RelatednessVerdict =
  | { readonly kind: 'approve' }
  | { readonly kind: 'deny' }
  | { readonly kind: 'refine'; readonly updatedArgs: unknown }
  | { readonly kind: 'unrelated' };

export interface ClassifyInput {
  readonly senderId: string;
  readonly message: string;
  /** The one pending action, in its digest shape (tool name + raw-args JSON). */
  readonly action: { readonly toolName: string; readonly summary: string };
  /** Rendered tail of the conversation — disambiguates a bare "yes". May be empty. */
  readonly recentContext: string;
}

export const classifierSystemPrompt = `You classify one WhatsApp message from a two-person household (mixed Hebrew and English, often code-switched) against ONE action their assistant proposed and is waiting on approval for.

Output ONLY a JSON object, nothing else:
- {"kind":"approve"} — the message plainly consents to the proposed action as it stands.
- {"kind":"deny"} — the message plainly rejects or cancels the proposed action.
- {"kind":"refine","updatedArgs":{...}} — the message asks to change the proposal. updatedArgs must be the COMPLETE arguments object: start from the current proposed arguments and apply only the requested change. Keep values in the language the proposal used unless the message changes them.
- {"kind":"unrelated"} — anything else.

Be conservative: a hedged or conditional answer ("yes but only if the morning is free"), a message that might be answering something other than the proposal, or a change you cannot express in the arguments is "unrelated" — the assistant will handle it as normal conversation. A wrong "approve" performs a real action; a wrong "unrelated" merely asks again.`;

export function renderClassifierPrompt(input: ClassifyInput): string {
  return [
    `Proposed action awaiting approval: tool ${input.action.toolName}, arguments ${input.action.summary}`,
    '',
    'Recent conversation:',
    input.recentContext === '' ? '(none)' : input.recentContext,
    '',
    `New message from ${input.senderId}: ${input.message}`,
  ].join('\n');
}

const verdictSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('approve') }),
  z.object({ kind: z.literal('deny') }),
  z.object({ kind: z.literal('refine'), updatedArgs: z.looseObject({}) }),
  z.object({ kind: z.literal('unrelated') }),
]);

/**
 * Model output → verdict, fail-safe: anything that doesn't parse into the
 * contract is 'unrelated' (action untouched, normal turn) — this function
 * must never throw inside the turn workflow.
 */
export function parseClassifierVerdict(text: string): RelatednessVerdict {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return { kind: 'unrelated' };
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { kind: 'unrelated' };
  }
  const verdict = verdictSchema.safeParse(raw);
  return verdict.success ? verdict.data : { kind: 'unrelated' };
}

export interface ClassifyRelatednessDeps {
  /** Haiku-class — cheap classification per ADR-0003 (instantiated by the composer). */
  readonly model: LanguageModel;
}

/** The real classifier behind the workflow's classify seam (CI scripts the seam). */
export function makeClassifyRelatedness(
  deps: ClassifyRelatednessDeps,
): (input: ClassifyInput) => Promise<RelatednessVerdict> {
  return async function classifyRelatedness(input) {
    const result = await generateText({
      model: deps.model,
      system: classifierSystemPrompt,
      prompt: renderClassifierPrompt(input),
    });
    return parseClassifierVerdict(result.text);
  };
}
