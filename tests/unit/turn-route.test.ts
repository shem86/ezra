// Turn routing core (docs/specs/jev-turn-routing-plan.md §3–§4, Phase 2):
// the §3c truth table, the §3a pre-rules, the staged-rollout clamp, and the
// §4 state. Pure — no network, no DB. The live behavior of the questions is
// pnpm eval:route's job; here the Phase 1 recorded Jev answers are REPLAYED
// through decideTier so a table edit that would have misrouted real answers
// fails in CI.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applyRollout,
  decideTier,
  preRouteTier,
  renderRouteState,
  routeQuestionsVersion,
  routeThresholds,
  toRouteAnswers,
  turnRouteQuestions,
  type RouteAnswers,
  type Tier,
} from '../../src/agent/turn-route.js';
import type { JevAnswer } from '../../src/agent/jev-client.js';

const YES = 0.9;
const UNSETTLED = 0.5;
const NO = 0.1;

function answers(overrides: Partial<RouteAnswers> = {}): RouteAnswers {
  return {
    asksAnything: YES,
    intent: 'reminder',
    severalRequests: NO,
    refersBack: NO,
    weighsOptions: NO,
    scheduleReasoning: NO,
    correctsPrevious: NO,
    ...overrides,
  };
}

describe('decideTier (§3c)', () => {
  it.each<[string, Partial<RouteAnswers>, Tier]>([
    ['a plan or recommendation goes deep', { weighsOptions: YES, intent: 'planning_or_advice' }, 'deep'],
    ['schedule reasoning across several requests goes deep', { scheduleReasoning: YES, severalRequests: YES, intent: 'calendar' }, 'deep'],
    ['schedule reasoning alone stays standard', { scheduleReasoning: YES, intent: 'calendar' }, 'standard'],
    ['a pure acknowledgement goes fast', { asksAnything: NO, intent: 'social' }, 'fast'],
    ['a single self-contained list edit goes fast', { intent: 'list_edit' }, 'fast'],
    ['a list edit that refers back stays standard', { intent: 'list_edit', refersBack: YES }, 'standard'],
    ['a list edit bundled with another request stays standard', { intent: 'list_edit', severalRequests: YES }, 'standard'],
    ['a reminder stays standard', { intent: 'reminder' }, 'standard'],
    ['a fact lookup stays standard', { intent: 'household_fact' }, 'standard'],
    ['deep wins over fast when both could fire', { intent: 'list_edit', weighsOptions: YES }, 'deep'],
  ])('%s', (_label, overrides, tier) => {
    expect(decideTier(answers(overrides))).toBe(tier);
  });

  it('never reads corrects_previous (monitoring only, §3b)', () => {
    for (const correctsPrevious of [YES, UNSETTLED, NO]) {
      expect(decideTier(answers({ intent: 'list_edit', correctsPrevious }))).toBe('fast');
    }
  });

  it('treats the thresholds as strict — exactly 0.7 is not yes, exactly 0.3 is not no', () => {
    expect(decideTier(answers({ weighsOptions: routeThresholds.yes }))).toBe('standard');
    expect(decideTier(answers({ intent: 'list_edit', refersBack: routeThresholds.no }))).toBe(
      'standard',
    );
  });

  // Exhaustive over every noul at yes / unsettled / no × every intent: each
  // combination has an outcome, and the two non-default tiers fire ONLY on
  // settled answers — an unsettled band can never buy fast or deep.
  it('routes every combination, and fast/deep only on settled answers', () => {
    const levels = [YES, UNSETTLED, NO];
    const intents = Object.keys(turnRouteQuestions.intent.criteria) as Array<RouteAnswers['intent']>;
    let combos = 0;
    for (const intent of intents)
      for (const asksAnything of levels)
        for (const severalRequests of levels)
          for (const refersBack of levels)
            for (const weighsOptions of levels)
              for (const scheduleReasoning of levels) {
                const a = answers({ intent, asksAnything, severalRequests, refersBack, weighsOptions, scheduleReasoning });
                const tier = decideTier(a);
                combos++;
                expect(['fast', 'standard', 'deep']).toContain(tier);
                if (tier === 'deep') {
                  expect(weighsOptions === YES || (scheduleReasoning === YES && severalRequests === YES)).toBe(true);
                }
                if (tier === 'fast') {
                  expect(weighsOptions).not.toBe(YES);
                  const acknowledgement = asksAnything === NO && intent === 'social';
                  const simpleEdit =
                    (intent === 'list_edit' || intent === 'social') &&
                    severalRequests === NO && refersBack === NO && scheduleReasoning === NO;
                  expect(acknowledgement || simpleEdit).toBe(true);
                }
              }
    expect(combos).toBe(intents.length * 3 ** 5);
  });
});

describe('Phase 1 replay — recorded jev-1.14.0 answers through decideTier', () => {
  interface RecordedRow {
    readonly id: string;
    readonly label: Tier;
    readonly answers: Record<string, JevAnswer>;
  }
  const rows: RecordedRow[] = ['tune', 'holdout'].flatMap(
    (split) =>
      (
        JSON.parse(
          readFileSync(
            new URL(`../../evals/fixtures/turn-route/phase1-results-${split}.json`, import.meta.url),
            'utf8',
          ),
        ) as { rows: RecordedRow[] }
      ).rows,
  );

  it('covers all 45 recorded cases', () => {
    expect(rows).toHaveLength(45);
  });

  // The spike asked v1 and v2 of weighs_options side by side; src ships v2
  // under the plain name, so the replay reads the v2 answer.
  it.each(rows.map((r) => [r.id, r] as const))('%s routes to its label', (_id, row) => {
    const { weighs_options_v2: v2, ...rest } = row.answers;
    const routed = decideTier(toRouteAnswers({ ...rest, weighs_options: v2! }));
    expect(routed).toBe(row.label);
  });
});

describe('preRouteTier (§3a) — facts code already knows; Jev is not asked', () => {
  const base = { hasPendingActions: false, hasQuotedReply: false, hasText: true };

  it('returns null for an ordinary text turn', () => {
    expect(preRouteTier(base)).toBeNull();
  });

  it.each([
    ['pending-actions', { hasPendingActions: true }],
    ['quoted-reply', { hasQuotedReply: true }],
    ['no-text', { hasText: false }],
  ] as const)('forces standard for %s', (rule, overrides) => {
    expect(preRouteTier({ ...base, ...overrides })).toEqual({ tier: 'standard', rule });
  });
});

describe('applyRollout (§7b staged rollout)', () => {
  it('passes an enabled tier through', () => {
    expect(applyRollout('deep', new Set<Tier>(['standard', 'deep']))).toBe('deep');
  });

  it('clamps a tier not yet enabled to standard', () => {
    expect(applyRollout('fast', new Set<Tier>(['standard', 'deep']))).toBe('standard');
    expect(applyRollout('deep', new Set<Tier>(['standard']))).toBe('standard');
  });
});

describe('toRouteAnswers', () => {
  it('maps the wire ids to RouteAnswers', () => {
    const wire: Record<string, JevAnswer> = {
      asks_anything: { type: 'noul', noul: 0.95 },
      intent: { type: 'choice', choice: 'list_edit', confidence: 0.8, probabilities: { list_edit: 0.9 } },
      several_requests: { type: 'noul', noul: 0.05 },
      refers_back: { type: 'noul', noul: 0.1 },
      weighs_options: { type: 'noul', noul: 0.02 },
      schedule_reasoning: { type: 'noul', noul: 0.03 },
      corrects_previous: { type: 'noul', noul: 0.04 },
    };
    expect(toRouteAnswers(wire)).toEqual({
      asksAnything: 0.95,
      intent: 'list_edit',
      severalRequests: 0.05,
      refersBack: 0.1,
      weighsOptions: 0.02,
      scheduleReasoning: 0.03,
      correctsPrevious: 0.04,
    });
  });

  it('throws on a missing answer rather than defaulting it', () => {
    expect(() => toRouteAnswers({ asks_anything: { type: 'noul', noul: 0.9 } })).toThrow();
  });
});

describe('renderRouteState (§4)', () => {
  it('carries member labels, the batch in order, and only the planned fields', () => {
    const state = renderRouteState({
      recent: [
        { from: 'husband', text: 'remind me thursday 5pm' },
        { from: 'assistant', text: 'Done — Thursday 5:00 PM.' },
      ],
      latest: [
        { from: 'husband', text: 'תעביר את זה לשישי' },
        { from: 'husband', text: 'and add milk' },
      ],
    });

    expect(Object.keys(state).sort()).toEqual(
      ['assistant_can', 'household', 'latest_messages', 'recent_conversation'].sort(),
    );
    expect(state.recent_conversation).toBe(
      'husband: remind me thursday 5pm\nassistant: Done — Thursday 5:00 PM.',
    );
    expect(state.latest_messages).toEqual([
      { from: 'husband', text: 'תעביר את זה לשישי' },
      { from: 'husband', text: 'and add milk' },
    ]);
  });

  it('keeps only the last four recent messages', () => {
    const recent = Array.from({ length: 7 }, (_, i) => ({ from: 'wife', text: `m${i}` }));
    const state = renderRouteState({ recent, latest: [{ from: 'wife', text: 'x' }] });
    expect(state.recent_conversation).toBe('wife: m3\nwife: m4\nwife: m5\nwife: m6');
  });

  it('renders an empty history as an explicit (none), not an empty string', () => {
    const state = renderRouteState({ recent: [], latest: [{ from: 'wife', text: 'x' }] });
    expect(state.recent_conversation).toBe('(none)');
  });
});

describe('turnRouteQuestions', () => {
  it('gives every noul a concrete true and false criterion', () => {
    for (const [id, q] of Object.entries(turnRouteQuestions)) {
      if (q.type !== 'noul') continue;
      expect(q.criteria?.true, id).toBeTruthy();
      expect(q.criteria?.false, id).toBeTruthy();
    }
  });

  it('has a stable version hash that is attributable in traces', () => {
    expect(routeQuestionsVersion).toMatch(/^[0-9a-f]{12}$/);
  });
});
