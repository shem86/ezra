// Structure of the `pnpm eval:route` cases (docs/specs/jev-turn-routing-plan.md
// §8a). CI checks COVERAGE only — accuracy needs live Jev and is the eval's
// job. A gate that reads an empty holdout slice passes vacuously, so every
// tier × language must keep holdout cases, and every label must name a real
// question or option (a renamed option would otherwise silently score 0).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { turnRouteQuestions, type Tier } from '../../src/agent/turn-route.js';

interface Case {
  readonly id: string;
  readonly lang: string;
  readonly tier: Tier;
  readonly latest: readonly unknown[];
  readonly expect: Readonly<Record<string, boolean | string | null>>;
}

const cases: Case[] = (
  JSON.parse(
    readFileSync(
      new URL('../../evals/fixtures/turn-route/phase1-cases.json', import.meta.url),
      'utf8',
    ),
  ) as { cases: Case[] }
).cases;
const isHoldout = (c: Case): boolean => Number(c.id.split('-')[1]) % 3 === 0;

describe('turn-route eval fixtures', () => {
  it('has unique ids of the form <lang>-<n>', () => {
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of cases) expect(c.id).toMatch(/^(en|he|mx)-\d+$/);
  });

  it.each(['en', 'he', 'mixed'])('%s: every tier the table can produce has holdout cases', (lang) => {
    for (const tier of ['fast', 'standard', 'deep'] as const) {
      const holdout = cases.filter((c) => c.lang === lang && c.tier === tier && isHoldout(c));
      expect(holdout.length, `${lang} ${tier}`).toBeGreaterThan(0);
    }
  });

  it('labels only real questions, and intent labels only real options', () => {
    const questionIds = Object.keys(turnRouteQuestions);
    const intents = Object.keys(turnRouteQuestions.intent.criteria);
    for (const c of cases) {
      for (const [id, want] of Object.entries(c.expect)) {
        expect(questionIds, `${c.id} labels unknown question ${id}`).toContain(id);
        if (id === 'intent' && want !== null) expect(intents, c.id).toContain(want);
      }
      expect(c.latest.length, `${c.id} has no latest message`).toBeGreaterThan(0);
    }
  });
});
