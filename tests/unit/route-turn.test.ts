// routeTurn (docs/specs/jev-turn-routing-plan.md §3a/§5/§6, Phase 3): the
// body of the journaled `routeTurn` step. It must NEVER throw — a throw would
// retry or fail the turn over what is only an optimization — so every Jev
// failure becomes a recorded standard-tier fallback. Fake Jev client; no
// network.

import { describe, expect, it } from 'vitest';
import { makeRouteTurn, type RouteTurnInput } from '../../src/agent/route-turn.js';
import { routeQuestionsVersion, type Tier } from '../../src/agent/turn-route.js';
import {
  JevError,
  type JevAnswer,
  type JevClient,
  type JevQuestions,
} from '../../src/agent/jev-client.js';

const labels: Record<string, string> = { 'husband@wa': 'husband', 'wife@wa': 'wife' };
const labelFor = (senderId: string): string => labels[senderId] ?? 'member';

function wire(overrides: Record<string, number | string> = {}): Record<string, JevAnswer> {
  const v = {
    asks_anything: 0.95,
    intent: 'reminder',
    several_requests: 0.05,
    refers_back: 0.05,
    weighs_options: 0.05,
    schedule_reasoning: 0.05,
    corrects_previous: 0.05,
    ...overrides,
  };
  const out: Record<string, JevAnswer> = {};
  for (const [id, value] of Object.entries(v)) {
    out[id] =
      typeof value === 'string'
        ? { type: 'choice', choice: value, confidence: 0.9, probabilities: { [value]: 0.95 } }
        : { type: 'noul', noul: value };
  }
  return out;
}

function fakeJev(
  respond: () => Record<string, JevAnswer> | Error,
): JevClient & { calls: Array<{ state: unknown; questions: JevQuestions }> } {
  const calls: Array<{ state: unknown; questions: JevQuestions }> = [];
  return {
    calls,
    async ask(state, questions) {
      calls.push({ state, questions });
      const result = respond();
      if (result instanceof Error) throw result;
      return { model: 'jev-1.14.0', answers: result, inputTokens: 1200 };
    },
  };
}

const allTiers = new Set<Tier>(['fast', 'standard', 'deep']);

function input(overrides: Partial<RouteTurnInput> = {}): RouteTurnInput {
  return {
    prior: [],
    latest: [{ senderId: 'wife@wa', text: 'should we visit on friday or saturday?' }],
    hasPendingActions: false,
    hasQuotedReply: false,
    ...overrides,
  };
}

describe('makeRouteTurn', () => {
  it('routes on Jev answers in on mode', async () => {
    const jev = fakeJev(() => wire({ weighs_options: 0.93, intent: 'planning_or_advice' }));
    const routeTurn = makeRouteTurn({ jev, mode: 'on', enabledTiers: allTiers, labelFor });

    const decision = await routeTurn(input());

    expect(decision).toMatchObject({
      tier: 'deep',
      proposed: 'deep',
      source: 'jev',
      mode: 'on',
      jevModel: 'jev-1.14.0',
      inputTokens: 1200,
      questionsVersion: routeQuestionsVersion,
    });
    expect(decision.answers?.weighsOptions).toBe(0.93);
    expect(decision.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('runs standard in shadow mode but records what it would have chosen', async () => {
    const jev = fakeJev(() => wire({ weighs_options: 0.93 }));
    const routeTurn = makeRouteTurn({ jev, mode: 'shadow', enabledTiers: allTiers, labelFor });

    const decision = await routeTurn(input());

    expect(decision).toMatchObject({ tier: 'standard', proposed: 'deep', source: 'jev', mode: 'shadow' });
  });

  it('clamps a tier the staged rollout has not enabled', async () => {
    const jev = fakeJev(() => wire({ intent: 'list_edit' }));
    const routeTurn = makeRouteTurn({
      jev,
      mode: 'on',
      enabledTiers: new Set<Tier>(['standard', 'deep']),
      labelFor,
    });

    const decision = await routeTurn(input({ latest: [{ senderId: 'wife@wa', text: 'add milk' }] }));

    expect(decision).toMatchObject({ tier: 'standard', proposed: 'fast' });
  });

  it.each([
    ['pending-actions', { hasPendingActions: true }],
    ['quoted-reply', { hasQuotedReply: true }],
    ['no-text', { latest: [] }],
  ] as const)('pre-rule %s routes standard without asking Jev', async (rule, overrides) => {
    const jev = fakeJev(() => wire());
    const routeTurn = makeRouteTurn({ jev, mode: 'on', enabledTiers: allTiers, labelFor });

    const decision = await routeTurn(input(overrides));

    expect(decision).toMatchObject({ tier: 'standard', proposed: 'standard', source: `pre-rule:${rule}` });
    expect(jev.calls).toHaveLength(0);
  });

  it.each(['timeout', 'network', 'http', 'malformed'] as const)(
    'a Jev %s falls back to standard, recorded as an error — never thrown',
    async (kind) => {
      const jev = fakeJev(() => new JevError(kind, 'boom'));
      const routeTurn = makeRouteTurn({ jev, mode: 'on', enabledTiers: allTiers, labelFor });

      const decision = await routeTurn(input());

      expect(decision).toMatchObject({
        tier: 'standard',
        proposed: 'standard',
        source: `fallback-error:${kind}`,
      });
      expect(decision.answers).toBeUndefined();
    },
  );

  it('an unexpected failure is a fallback too, not a thrown step', async () => {
    const jev = fakeJev(() => new RangeError('something else entirely'));
    const routeTurn = makeRouteTurn({ jev, mode: 'on', enabledTiers: allTiers, labelFor });

    const decision = await routeTurn(input());

    expect(decision).toMatchObject({ tier: 'standard', source: 'fallback-error:internal' });
  });

  it('sends member labels and the conversational tail — never JIDs, tool results, or hitl lines', async () => {
    const jev = fakeJev(() => wire());
    const routeTurn = makeRouteTurn({ jev, mode: 'on', enabledTiers: allTiers, labelFor });

    await routeTurn(
      input({
        prior: [
          { role: 'user', senderId: 'husband@wa', content: 'remind me thursday 5pm' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'tu1', name: 'create_reminder', args: { when: 'thu 17:00' } }],
          },
          { role: 'tool', toolUseId: 'tu1', content: '{"reminderId":42}' },
          { role: 'assistant', content: 'Done — Thursday 5:00 PM.', toolCalls: [] },
          { role: 'user', senderId: 'system:hitl', content: 'Action act-1 was approved by wife.' },
        ],
        latest: [{ senderId: 'husband@wa', text: 'move it to friday' }],
      }),
    );

    const state = jev.calls[0]!.state as Record<string, unknown>;
    expect(state.recent_conversation).toBe(
      'husband: remind me thursday 5pm\nassistant: Done — Thursday 5:00 PM.',
    );
    expect(state.latest_messages).toEqual([{ from: 'husband', text: 'move it to friday' }]);
    expect(JSON.stringify(state)).not.toContain('@wa');
  });
});
