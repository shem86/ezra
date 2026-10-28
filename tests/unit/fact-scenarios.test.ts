// STATUS item 11: CI holds the fact-lookup eval fixtures to their contract —
// the behavioral pass/fail is `pnpm eval`'s job (evals/facts.eval.ts), but the
// shape that makes each scenario MEAN something is checked here with no model
// calls: run-unique tags, and seeded keys the model's natural guess misses.

import { describe, expect, it } from 'vitest';
import { makeFactScenarios } from '../../evals/fixtures/facts.ts';
import { factTerms, normalizeFactKey } from '../../src/tools/facts.ts';

const set = makeFactScenarios(424242);

describe('fact-lookup eval fixtures (STATUS item 11)', () => {
  it('defines the save and read scenarios over the two fact tools', () => {
    expect(set.scenarios.map((s) => s.name).sort()).toEqual([
      'fact-dedup-on-save',
      'fact-search-on-read',
    ]);
    expect(new Set(set.scenarios.flatMap((s) => s.covers))).toEqual(new Set(['set_fact', 'get_fact']));
  });

  it('member messages use only household ids and name their run tag', () => {
    const [save, read] = set.scenarios;
    for (const message of set.scenarios.flatMap((s) => s.messages)) {
      expect(['husband@wa', 'wife@wa']).toContain(message.senderId);
    }
    expect(save!.messages[0]!.text).toContain(set.save.tag);
    expect(read!.messages[0]!.text).toContain(set.read.tag);
  });

  it('tags are distinct, so one scenario can never satisfy the other', () => {
    expect(set.save.tag).not.toBe(set.read.tag);
    expect(set.save.key).not.toContain(set.read.tag);
    expect(set.read.key).not.toContain(set.save.tag);
  });

  it('seeded keys are already canonical, so the eval stores exactly what the tool would', () => {
    expect(normalizeFactKey(set.save.key)).toBe(set.save.key);
    expect(normalizeFactKey(set.read.key)).toBe(set.read.key);
  });

  it("the save key is a word-superset of the message's likely key, so the guard engages", () => {
    const likelyGuess = factTerms(`locker ${set.save.tag} code`);
    const stored = factTerms(set.save.key);
    expect(likelyGuess.every((t) => stored.includes(t))).toBe(true);
    expect(set.scenarios[0]!.messages[0]!.text).not.toContain('gym');
  });

  it('the read key carries a word the question never uses, forcing the search path', () => {
    expect(set.scenarios[1]!.messages[0]!.text).not.toContain('combination');
  });
});
