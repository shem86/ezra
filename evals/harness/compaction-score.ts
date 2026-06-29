// Pure scoring for the compaction quality eval (docs/compaction-eval-spec.md).
// No model and no `ai` import — so the aggregation + mechanical checks are
// unit-testable in CI (tests/unit/compaction-score.test.ts), while the judge
// (harness/judge.ts) and the driver (compaction.eval.ts) stay eval-only.
//
// Split of labour: the LLM judge supplies the QUALITY dimensions (commitment
// preservation, faithfulness, boundary discipline — they need reading
// comprehension); this module supplies the MECHANICAL hard checks (language
// preservation, conciseness) and folds everything into one per-scenario score.

import type { CompactionScenario } from '../fixtures/compaction.ts';

const HEBREW = /[֐-׿]/;
const LATIN = /[A-Za-z]/;

/** The judge's structured verdict for one (head → summary) pair. */
export interface JudgeVerdict {
  readonly commitments: readonly {
    readonly claim: string;
    readonly preserved: boolean;
    readonly correctlyAttributed: boolean;
    readonly evidence: string;
  }[];
  readonly faithfulness: { readonly score: number; readonly inventedClaims: readonly string[] };
  readonly boundaryDiscipline: { readonly score: number; readonly issues: readonly string[] };
  readonly languageNotes: string;
}

export interface ScenarioScore {
  readonly name: string;
  readonly summary: string;
  /** Fraction of planted commitments present AND correctly attributed (0..1). */
  readonly commitment: number;
  readonly missing: readonly string[];
  readonly faithfulness: number;
  readonly invented: readonly string[];
  readonly boundary: number;
  readonly boundaryIssues: readonly string[];
  /** Hard checks. */
  readonly languageOk: boolean;
  readonly concise: boolean;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

export function containsLanguage(text: string, lang: 'he' | 'en'): boolean {
  return (lang === 'he' ? HEBREW : LATIN).test(text);
}

/** Which scripts a head actually uses — the prod spot-check has no declared
 *  languages, so it derives the no-translate expectation from the head text. */
export function detectLanguages(text: string): ('he' | 'en')[] {
  const langs: ('he' | 'en')[] = [];
  if (containsLanguage(text, 'he')) langs.push('he');
  if (containsLanguage(text, 'en')) langs.push('en');
  return langs;
}

/** Every language present in the head must still appear in the summary — the
 *  bite against "translated everything to one language" (the prompt forbids it). */
export function languagePreserved(
  headText: string,
  summary: string,
  languages: readonly ('he' | 'en')[],
): boolean {
  return languages.every((l) => !containsLanguage(headText, l) || containsLanguage(summary, l));
}

/** A summary must be materially shorter than the head it replaces. */
export function isConcise(headChars: number, summaryChars: number): boolean {
  return summaryChars < headChars;
}

/** Fraction preserved AND correctly attributed; an empty list scores 1. */
export function commitmentScore(commitments: JudgeVerdict['commitments']): number {
  if (commitments.length === 0) return 1;
  const ok = commitments.filter((c) => c.preserved && c.correctlyAttributed).length;
  return ok / commitments.length;
}

export function scoreScenario(
  scenario: Pick<CompactionScenario, 'name' | 'languages'>,
  summary: string,
  verdict: JudgeVerdict,
  headText: string,
): ScenarioScore {
  return {
    name: scenario.name,
    summary,
    commitment: commitmentScore(verdict.commitments),
    missing: verdict.commitments
      .filter((c) => !(c.preserved && c.correctlyAttributed))
      .map((c) => c.claim),
    faithfulness: clamp01(verdict.faithfulness.score),
    invented: verdict.faithfulness.inventedClaims,
    boundary: clamp01(verdict.boundaryDiscipline.score),
    boundaryIssues: verdict.boundaryDiscipline.issues,
    languageOk: languagePreserved(headText, summary, scenario.languages),
    concise: isConcise(headText.length, summary.length),
  };
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

function mean(scores: readonly ScenarioScore[], f: (s: ScenarioScore) => number): number {
  return scores.length === 0 ? 0 : scores.reduce((a, s) => a + f(s), 0) / scores.length;
}

/** Human-readable per-dimension table + aggregate, printed once after the run. */
export function formatReport(scores: readonly ScenarioScore[], model: string): string {
  const lines: string[] = [`=== Compaction summary quality — summarizer: ${model} ===`];
  for (const s of scores) {
    lines.push(`\n• ${s.name}`);
    lines.push(`    commitment   ${pct(s.commitment)}${s.missing.length ? `  MISSING: ${s.missing.join(' | ')}` : ''}`);
    lines.push(`    faithfulness ${pct(s.faithfulness)}${s.invented.length ? `  INVENTED: ${s.invented.join(' | ')}` : ''}`);
    lines.push(`    boundary     ${pct(s.boundary)}${s.boundaryIssues.length ? `  ISSUES: ${s.boundaryIssues.join(' | ')}` : ''}`);
    lines.push(`    language ${s.languageOk ? 'ok' : 'FAIL'} · concise ${s.concise ? 'ok' : 'FAIL'}`);
  }
  lines.push(`\n--- aggregate (${scores.length} scenarios, report-only until calibrated) ---`);
  lines.push(
    `commitment ${pct(mean(scores, (s) => s.commitment))} · ` +
      `faithfulness ${pct(mean(scores, (s) => s.faithfulness))} · ` +
      `boundary ${pct(mean(scores, (s) => s.boundary))}`,
  );
  lines.push(
    `hard checks — language failures: ${scores.filter((s) => !s.languageOk).length} · ` +
      `conciseness failures: ${scores.filter((s) => !s.concise).length}`,
  );
  return lines.join('\n');
}
