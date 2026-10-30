// STATUS item 14 follow-up: reply language under the REAL model after a run of
// turns in the other language (production prompt, real Sonnet, Postgres, the
// real fact tools). Costs money — `pnpm eval`, never CI (testing.md). Fixture
// shape and the language detector are held in CI by
// tests/unit/language-scenarios.test.ts.
//
// Each scenario seeds a fact whose value is in the OTHER language, so the tool
// output pulls the same way as the conversation — the prod shape, where Hebrew
// fact values followed three Hebrew turns. Assertion is on the opening line's
// language only, never on wording; the full reply rides in the failure message.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { languageScenarios, openingLanguage } from './fixtures/language.ts';
import { composeEvalHarness, type EvalHarness } from './harness/runner.ts';

let h: EvalHarness;
const run = Date.now() % 1_000_000;

beforeAll(async () => {
  h = await composeEvalHarness();
  await h.db.query(
    `INSERT INTO household_facts (key, value) VALUES ($1, $2), ($3, $4)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()`,
    [
      `plant-care-ficus-${run}`,
      'להעביר לעציץ חדש, ליד חלון בלי שמש ישירה, להשקות רק כשהאדמה יבשה',
      `wifi-password-${run}`,
      `BlueHouse-${run}`,
    ],
  );
}, 120_000);

afterAll(async () => {
  await h.shutdown();
});

describe('reply language follows the message, not the conversation (STATUS item 14)', () => {
  for (const s of languageScenarios) {
    it(`${s.name}: the reply to the switching message opens in ${s.expected}`, async () => {
      const conv = h.conversationIdFor(s);
      for (const message of s.messages) {
        const result = await h.runTurn(conv, message);
        expect(result.status).toBe('completed');
      }

      const transcript = await h.transcript(conv);
      const reply =
        transcript.filter((m) => m.role === 'assistant' && m.content.length > 0).at(-1)?.content ?? '';
      expect(openingLanguage(reply), `final reply:\n${reply}`).toBe(s.expected);
    }, 300_000);
  }
});
