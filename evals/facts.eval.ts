// STATUS item 11: the fact-key matching paths under the REAL model (production
// prompt, real Sonnet, Postgres, the real fact tools). Costs money — `pnpm
// eval`, never CI (testing.md). Fixture shape is held in CI by
// tests/unit/fact-scenarios.test.ts.
//
// Assertions are on STATE (the fact rows) for the save path and on the reply
// carrying the stored value for the read path — never on wording. The
// transcript's tool calls ride along in failure messages so a red run shows
// which path the model actually took.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeFactScenarios } from './fixtures/facts.ts';
import { composeEvalHarness, type EvalHarness } from './harness/runner.ts';
import type { EvalScenario } from './fixtures/decision9.ts';
import type { TurnMessage } from '../src/agent/context.ts';

let h: EvalHarness;
const set = makeFactScenarios(Date.now() % 1_000_000);

beforeAll(async () => {
  h = await composeEvalHarness();
}, 120_000);

afterAll(async () => {
  await h.shutdown();
});

function scenario(name: string): EvalScenario {
  const found = set.scenarios.find((s) => s.name === name);
  if (found === undefined) throw new Error(`unknown scenario ${name}`);
  return found;
}

async function seedFact(key: string, value: string): Promise<void> {
  await h.db.query(
    `INSERT INTO household_facts (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
    [key, value],
  );
}

/**
 * Every fact row carrying this run's tag as a whole key word — stale runs
 * carry other tags, and a bare substring match could hit a timestamp inside
 * an integration-test key.
 */
async function factsTagged(tag: string): Promise<{ key: string; value: string }[]> {
  const res = await h.db.query(
    `SELECT key, value FROM household_facts WHERE key ~ $1 ORDER BY key`,
    [`(^|[^0-9])${tag}([^0-9]|$)`],
  );
  return res.rows as { key: string; value: string }[];
}

/** The tool path the model took, for failure messages. */
function toolTrail(transcript: TurnMessage[]): string {
  return transcript
    .flatMap((m) => (m.role === 'assistant' ? m.toolCalls : []))
    .map((c) => `${c.name}(${JSON.stringify(c.args)})`)
    .join(' → ');
}

describe('fact-key lookup under the real model (STATUS item 11)', () => {
  it('a near-duplicate save updates the existing fact instead of adding a second', async () => {
    const s = scenario('fact-dedup-on-save');
    const conv = h.conversationIdFor(s);
    await seedFact(set.save.key, set.save.oldValue);

    const result = await h.runTurn(conv, s.messages[0]!);
    expect(result.status).toBe('completed');

    const trail = toolTrail(await h.transcript(conv));
    expect(await factsTagged(set.save.tag), `tool path: ${trail}`).toEqual([
      { key: set.save.key, value: expect.stringContaining(set.save.newValue) },
    ]);
  }, 300_000);

  it('a question whose natural key misses is answered from the search fallback', async () => {
    const s = scenario('fact-search-on-read');
    const conv = h.conversationIdFor(s);
    await seedFact(set.read.key, set.read.value);

    const result = await h.runTurn(conv, s.messages[0]!);
    expect(result.status).toBe('completed');

    const transcript = await h.transcript(conv);
    const replies = transcript.filter((m) => m.role === 'assistant' && m.content.length > 0);
    const finalReply = replies.at(-1)?.content ?? '';
    expect(finalReply, `tool path: ${toolTrail(transcript)}`).toContain(set.read.value);
    // Reading must not have written anything under this run's tag.
    expect(await factsTagged(set.read.tag)).toEqual([{ key: set.read.key, value: set.read.value }]);
  }, 300_000);
});
