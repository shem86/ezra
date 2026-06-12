// T38: relatedness-classifier accuracy on the T36 fixture set, with a REAL
// Haiku call per fixture. REPORT-ONLY by design (accepted v1 risk per the
// architecture): the five decision-9 scenarios are the gate, this is the
// dashboard — it prints the table and never fails on accuracy. CI already
// asserts the fixture set's coverage; this measures what CI can't.

import { describe, expect, it } from 'vitest';
import { createAnthropic } from '@ai-sdk/anthropic';
import { loadConfig } from '../src/ops/config.ts';
import { makeClassifyRelatedness } from '../src/agent/relatedness.ts';
import {
  relatednessFixtureAction,
  relatednessFixtures,
  type RelatednessClass,
} from './fixtures/relatedness.ts';

// A plausible conversational tail for the fixed fixture action — every
// fixture classifies against the same context, so per-class numbers compare.
const recentContext = [
  'wife@wa: תקבע תור לרופא שיניים מחר אחר הצהריים',
  'assistant: proposing a dentist appointment at 15:00 — waiting for approval',
].join('\n');

interface FixtureResult {
  readonly message: string;
  readonly expected: RelatednessClass;
  readonly got: string;
  readonly note: string | undefined;
}

describe('relatedness classifier accuracy (report-only)', () => {
  it('classifies every fixture with real Haiku and prints the accuracy table', async () => {
    const config = loadConfig();
    const anthropic = createAnthropic({ apiKey: config.anthropicApiKey });
    const classify = makeClassifyRelatedness({ model: anthropic(config.cheapModelId) });

    const results: FixtureResult[] = [];
    for (const fixture of relatednessFixtures) {
      const verdict = await classify({
        senderId: 'husband@wa',
        message: fixture.message,
        action: relatednessFixtureAction,
        recentContext,
      });
      results.push({
        message: fixture.message,
        expected: fixture.expected,
        got: verdict.kind,
        note: fixture.note,
      });
    }

    const classes: RelatednessClass[] = ['approve', 'deny', 'refine', 'unrelated'];
    const lines: string[] = ['', '=== relatedness classifier accuracy (T38 report) ==='];
    for (const cls of classes) {
      const ofClass = results.filter((r) => r.expected === cls);
      const hits = ofClass.filter((r) => r.got === r.expected).length;
      lines.push(`${cls.padEnd(10)} ${hits}/${ofClass.length}`);
    }
    const totalHits = results.filter((r) => r.got === r.expected).length;
    lines.push(`${'overall'.padEnd(10)} ${totalHits}/${results.length}`);

    const misses = results.filter((r) => r.got !== r.expected);
    if (misses.length > 0) {
      lines.push('', 'misses:');
      for (const miss of misses) {
        const note = miss.note === undefined ? '' : ` [${miss.note}]`;
        lines.push(`  "${miss.message}" expected ${miss.expected}, got ${miss.got}${note}`);
      }
    }
    console.log(lines.join('\n'));

    // Report-only: the assertion is structural (every fixture classified,
    // fail-safe parse means a kind always comes back), never on accuracy.
    expect(results).toHaveLength(relatednessFixtures.length);
    for (const result of results) {
      expect(['approve', 'deny', 'refine', 'unrelated']).toContain(result.got);
    }
  }, 600_000);
});
