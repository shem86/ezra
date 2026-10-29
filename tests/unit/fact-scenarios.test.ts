// STATUS item 11: CI holds the fact-lookup eval fixtures to their contract —
// the behavioral pass/fail is `pnpm eval`'s job (evals/facts.eval.ts), but the
// shape that makes each scenario MEAN something is checked here with no model
// calls: run-unique tags, and seeded keys the model's natural guess misses.

import { describe, expect, it } from 'vitest';
import { makeFactScenarios } from '../../evals/fixtures/facts.ts';
import { factTerms, normalizeFactKey } from '../../src/tools/facts.ts';

const set = makeFactScenarios(424242);

describe('fact-lookup eval fixtures (STATUS item 11)', () => {
  it('defines the save, read, list-all and existence scenarios over the fact tools', () => {
    expect(set.scenarios.map((s) => s.name).sort()).toEqual([
      'fact-dedup-on-save',
      'fact-existence-en',
      'fact-existence-he',
      'fact-list-all',
      'fact-search-on-read',
    ]);
    expect(new Set(set.scenarios.flatMap((s) => s.covers))).toEqual(
      new Set(['set_fact', 'get_fact', 'list_facts']),
    );
  });

  it('item 13 scenarios never name a key, so only the store can supply one', () => {
    const item13 = set.scenarios.filter((s) =>
      ['fact-list-all', 'fact-existence-en', 'fact-existence-he'].includes(s.name),
    );
    for (const message of item13.flatMap((s) => s.messages)) {
      expect(message.text).not.toContain(set.listAll.key);
      expect(message.text).not.toMatch(/\d{4,}/);
    }
  });

  it('the existence scenarios are code-switched: one English, one Hebrew', () => {
    const texts = set.scenarios
      .filter((s) => s.name.startsWith('fact-existence-'))
      .map((s) => s.messages[0]!.text);
    expect(texts.some((t) => /[a-z]/i.test(t))).toBe(true);
    expect(texts.some((t) => /[֐-׿]/.test(t))).toBe(true);
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
