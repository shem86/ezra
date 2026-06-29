// Compaction summary-quality eval (docs/compaction-eval-spec.md). Drives each
// fixture head through the REAL summarizer (Haiku-class by default, the
// production compaction path) and scores the result with a Sonnet-class judge
// on the rubric drawn from summarySystemPrompt. Costs money — `pnpm eval`,
// never CI (testing.md); the pure scoring logic is unit-tested separately.
//
// Decision #2 (the spec): start REPORT-ONLY to calibrate. The quality
// dimensions (commitment, faithfulness, boundary) are printed, not asserted;
// only the mechanical hard checks (language preservation, conciseness) fail the
// eval today. Set quality thresholds here once a run or two has calibrated them.
//
// Knob: COMPACTION_SUMMARIZER_MODEL overrides the summarizer model id, so the
// same fixtures can be run through Haiku vs Sonnet and the reports compared
// (answers "is the cheap model good enough for compaction?"). The judge stays
// the reasoning model regardless.

import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAnthropic } from '@ai-sdk/anthropic';
import { loadConfig } from '../src/ops/config.ts';
import { makeSummarize, renderForSummary } from '../src/agent/compaction.ts';
import type { TurnMessage } from '../src/agent/context.ts';
import { compactionScenarios } from './fixtures/compaction.ts';
import { makeCompactionJudge, type JudgeInput } from './harness/judge.ts';
import {
  formatReport,
  scoreScenario,
  type JudgeVerdict,
  type ScenarioScore,
} from './harness/compaction-score.ts';

let summarize: (head: readonly TurnMessage[]) => Promise<string>;
let judge: (input: JudgeInput) => Promise<JudgeVerdict>;
let summarizerModel = '';
const scores: ScenarioScore[] = [];

describe('compaction summary quality (eval)', () => {
  beforeAll(() => {
    // Config is read here, not at collection time, so importing this file
    // (e.g. `vitest list`) needs no env (same contract as harness/runner.ts).
    const config = loadConfig();
    const anthropic = createAnthropic({ apiKey: config.anthropicApiKey });
    summarizerModel = process.env.COMPACTION_SUMMARIZER_MODEL ?? config.cheapModelId;
    summarize = makeSummarize({ model: anthropic(summarizerModel) });
    judge = makeCompactionJudge({ model: anthropic(config.reasoningModelId) });
  });

  afterAll(() => {
    // One table for the whole run — the point of the eval is the report. The
    // vitest run reporter swallows console.log, so also write it to a file when
    // COMPACTION_EVAL_REPORT is set (one artifact per model — compare runs).
    const report = formatReport(scores, summarizerModel);
    const path = process.env.COMPACTION_EVAL_REPORT;
    if (path !== undefined && path.length > 0) writeFileSync(path, report);
    console.log('\n' + report);
  });

  for (const scenario of compactionScenarios) {
    it(`preserves commitments and language: ${scenario.name}`, async () => {
      const summary = await summarize(scenario.head);
      const verdict = await judge({
        head: scenario.head,
        summary,
        mustPreserve: scenario.mustPreserve,
        mustNotInvent: scenario.mustNotInvent,
      });
      const score = scoreScenario(scenario, summary, verdict, renderForSummary(scenario.head));
      scores.push(score);

      // Report-only first pass (decision #2): EVERY dimension is measured and
      // printed (the report is the deliverable), and the test stays green so a
      // calibration run produces a full table instead of failing fast. The only
      // assert is a sanity floor — a non-empty summary — so an outright broken
      // summarizer still fails loud. Promote language (a real contract) to a
      // hard gate, and redefine conciseness for production-sized heads, once the
      // numbers are calibrated.
      expect(summary.trim().length, `${scenario.name}: empty summary`).toBeGreaterThan(0);
    }, 60_000);
  }
});
