// Compaction prod spot-check (docs/compaction-eval-spec.md, Task 5). Scores
// REAL captured summaries from compaction_log with the same judge + scorer as
// the fixture eval — but there is no planted ground truth, so the judge runs in
// EXTRACT mode (it discovers the head's open commitments before checking they
// survived), and the no-translate expectation is derived from the head's own
// scripts.
//
// Read-only and opt-in: the suite is SKIPPED unless a spot-check DB URL is set.
// Point it at the SELECT-only role (decision #4 — reuse BACKOFFICE_DATABASE_URL)
// to score prod, or at the dev DB to score local runs. It never auto-hits prod.
//
//   COMPACTION_SPOTCHECK_DATABASE_URL=... pnpm eval -t "compaction prod spot-check"
//   # falls back to BACKOFFICE_DATABASE_URL; limit via COMPACTION_SPOTCHECK_LIMIT

import { writeFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAnthropic } from '@ai-sdk/anthropic';
import { loadConfig } from '../src/ops/config.ts';
import { renderForSummary } from '../src/agent/compaction.ts';
import { readRecentCompactions } from '../src/memory/compaction-log.ts';
import { makeCompactionJudge, type JudgeInput } from './harness/judge.ts';
import {
  detectLanguages,
  formatReport,
  scoreScenario,
  type JudgeVerdict,
  type ScenarioScore,
} from './harness/compaction-score.ts';

const SPOTCHECK_URL =
  process.env.COMPACTION_SPOTCHECK_DATABASE_URL ?? process.env.BACKOFFICE_DATABASE_URL;
const LIMIT = Number.parseInt(process.env.COMPACTION_SPOTCHECK_LIMIT ?? '20', 10);

describe.skipIf(SPOTCHECK_URL === undefined)('compaction prod spot-check (eval)', () => {
  let db: Client;
  let judge: (input: JudgeInput) => Promise<JudgeVerdict>;
  const scores: ScenarioScore[] = [];

  beforeAll(async () => {
    const config = loadConfig();
    judge = makeCompactionJudge({
      model: createAnthropic({ apiKey: config.anthropicApiKey })(config.reasoningModelId),
    });
    db = new Client({ connectionString: SPOTCHECK_URL });
    await db.connect();
  });

  afterAll(async () => {
    if (scores.length > 0) {
      const report = formatReport(scores, `prod spot-check (${SPOTCHECK_URL?.split('@').pop()})`);
      const path = process.env.COMPACTION_EVAL_REPORT;
      if (path !== undefined && path.length > 0) writeFileSync(path, report);
      console.log('\n' + report);
    }
    if (db !== undefined) await db.end();
  });

  it('scores recent real compactions in extract mode', async () => {
    const rows = await readRecentCompactions(db, { limit: Number.isFinite(LIMIT) ? LIMIT : 20 });
    if (rows.length === 0) {
      console.log('compaction prod spot-check: no compaction_log rows to score yet.');
      return; // nothing captured yet — a pass, not a failure (prod is near-empty)
    }

    for (const row of rows) {
      const headText = renderForSummary(row.head);
      const verdict = await judge({ head: row.head, summary: row.summary });
      // No declared languages here — derive the no-translate expectation from
      // what the head actually used.
      scores.push(
        scoreScenario(
          { name: `${row.sourceKey} (${row.summarizerModel})`, languages: detectLanguages(headText) },
          row.summary,
          verdict,
          headText,
        ),
      );
    }

    // Sanity floor only (report-only, decision #2): every row produced a score.
    expect(scores.length).toBe(rows.length);
  }, 120_000);
});
