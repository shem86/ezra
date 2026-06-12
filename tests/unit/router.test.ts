// T30: Haiku router — cheap-vs-reasoning model selection.
// Tests run against MockLanguageModelV3; no real model calls in CI.

import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { defaultRouterPolicy, makeRoutedCallModel, type ModelTier } from '../../src/agent/router.js';
import type { ModelCallOptions } from '../../src/agent/handle-turn.js';
import type { TurnMessage } from '../../src/agent/context.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type DoGenerateResult = Awaited<
  ReturnType<NonNullable<ConstructorParameters<typeof MockLanguageModelV3>[0]['doGenerate']>>
>;

const usage: DoGenerateResult['usage'] = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function trackedModel(label: string, calls: string[]) {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      calls.push(label);
      return {
        content: [{ type: 'text', text: `[${label}]` }],
        finishReason: { unified: 'stop', raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
}

const SYSTEM = 'You are the household assistant.';

const userMsg: readonly TurnMessage[] = [
  { role: 'user', senderId: 'builder@wa', content: 'add milk' },
];

const withToolHistory: readonly TurnMessage[] = [
  { role: 'user', senderId: 'builder@wa', content: 'add milk' },
  {
    role: 'assistant',
    content: 'Adding.',
    toolCalls: [{ id: 'tu_1', name: 'add_list_item', args: { item: 'milk' } }],
  },
  { role: 'tool', toolUseId: 'tu_1', content: 'added' },
];

const withTwoToolRounds: readonly TurnMessage[] = [
  ...withToolHistory,
  {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'tu_2', name: 'add_list_item', args: { item: 'bread' } }],
  },
  { role: 'tool', toolUseId: 'tu_2', content: 'added' },
];

// A PREVIOUS turn's chained tool work, completed, followed by a fresh user
// message — the production shape of every ongoing conversation. The prior
// turn's tool messages must not leak into the current turn's routing signal.
const freshTurnAfterToolHeavyHistory: readonly TurnMessage[] = [
  ...withTwoToolRounds,
  { role: 'assistant', content: 'Added both.', toolCalls: [] },
  { role: 'user', senderId: 'wife@wa', content: 'מה יש ברשימה?' },
];

// ONE round answering with two parallel tool calls ("add milk and eggs") —
// two tool messages, but a single round. Must not count as two rounds.
const oneParallelRound: readonly TurnMessage[] = [
  { role: 'user', senderId: 'builder@wa', content: 'add milk and eggs' },
  {
    role: 'assistant',
    content: 'Adding both.',
    toolCalls: [
      { id: 'tu_a', name: 'add_list_item', args: { item: 'milk' } },
      { id: 'tu_b', name: 'add_list_item', args: { item: 'eggs' } },
    ],
  },
  { role: 'tool', toolUseId: 'tu_a', content: 'added' },
  { role: 'tool', toolUseId: 'tu_b', content: 'added' },
];

// ---------------------------------------------------------------------------
// defaultRouterPolicy
// ---------------------------------------------------------------------------

describe('defaultRouterPolicy', () => {
  const forceFinal: ModelCallOptions = { forceFinal: true };
  const normal: ModelCallOptions = { forceFinal: false };

  it('returns cheap when forceFinal is true', () => {
    expect(defaultRouterPolicy.select(userMsg, forceFinal)).toBe<ModelTier>('cheap');
  });

  it('returns cheap for a fresh turn with no tool history', () => {
    expect(defaultRouterPolicy.select(userMsg, normal)).toBe<ModelTier>('cheap');
  });

  it('returns cheap after exactly one tool-result round (simple task)', () => {
    expect(defaultRouterPolicy.select(withToolHistory, normal)).toBe<ModelTier>('cheap');
  });

  it('returns reasoning after two or more tool-result rounds (complex chain)', () => {
    expect(defaultRouterPolicy.select(withTwoToolRounds, normal)).toBe<ModelTier>('reasoning');
  });

  it('returns cheap for a fresh turn after a tool-heavy PREVIOUS turn (history must not leak)', () => {
    expect(defaultRouterPolicy.select(freshTurnAfterToolHeavyHistory, normal)).toBe<ModelTier>(
      'cheap',
    );
  });

  it('returns cheap after one round of PARALLEL tool calls (rounds, not tool messages)', () => {
    expect(defaultRouterPolicy.select(oneParallelRound, normal)).toBe<ModelTier>('cheap');
  });
});

// ---------------------------------------------------------------------------
// makeRoutedCallModel — routes to the correct model instance
// ---------------------------------------------------------------------------

describe('makeRoutedCallModel', () => {
  it('uses the cheap model on a fresh turn (no tool history)', async () => {
    const calls: string[] = [];
    const callModel = makeRoutedCallModel({
      cheap: trackedModel('haiku', calls),
      reasoning: trackedModel('sonnet', calls),
      systemPrompt: SYSTEM,
    });

    await callModel(userMsg, { forceFinal: false });

    expect(calls).toEqual(['haiku']);
  });

  it('uses the cheap model when forceFinal is true', async () => {
    const calls: string[] = [];
    const callModel = makeRoutedCallModel({
      cheap: trackedModel('haiku', calls),
      reasoning: trackedModel('sonnet', calls),
      systemPrompt: SYSTEM,
    });

    await callModel(userMsg, { forceFinal: true });

    expect(calls).toEqual(['haiku']);
  });

  it('uses the cheap model after one tool-result round', async () => {
    const calls: string[] = [];
    const callModel = makeRoutedCallModel({
      cheap: trackedModel('haiku', calls),
      reasoning: trackedModel('sonnet', calls),
      systemPrompt: SYSTEM,
    });

    await callModel(withToolHistory, { forceFinal: false });

    expect(calls).toEqual(['haiku']);
  });

  it('uses the reasoning model after two tool-result rounds', async () => {
    const calls: string[] = [];
    const callModel = makeRoutedCallModel({
      cheap: trackedModel('haiku', calls),
      reasoning: trackedModel('sonnet', calls),
      systemPrompt: SYSTEM,
    });

    await callModel(withTwoToolRounds, { forceFinal: false });

    expect(calls).toEqual(['sonnet']);
  });

  it('passes the tier to onUsage alongside the model usage', async () => {
    const seen: Array<{ tier: ModelTier; inputTokens: number | undefined }> = [];
    const callModel = makeRoutedCallModel({
      cheap: trackedModel('haiku', []),
      reasoning: trackedModel('sonnet', []),
      systemPrompt: SYSTEM,
      onUsage: (u, tier) => seen.push({ tier, inputTokens: u.inputTokens }),
    });

    await callModel(userMsg, { forceFinal: false });
    await callModel(withTwoToolRounds, { forceFinal: false });

    expect(seen).toEqual([
      { tier: 'cheap', inputTokens: 10 },
      { tier: 'reasoning', inputTokens: 10 },
    ]);
  });

  it('accepts a custom policy override', async () => {
    const calls: string[] = [];
    const callModel = makeRoutedCallModel({
      cheap: trackedModel('haiku', calls),
      reasoning: trackedModel('sonnet', calls),
      systemPrompt: SYSTEM,
      // Force reasoning on every call regardless of context
      policy: { select: () => 'reasoning' },
    });

    await callModel(userMsg, { forceFinal: false });

    expect(calls).toEqual(['sonnet']);
  });

  it('returns the assistant message from the selected model', async () => {
    const callModel = makeRoutedCallModel({
      cheap: trackedModel('haiku', []),
      reasoning: trackedModel('sonnet', []),
      systemPrompt: SYSTEM,
    });

    const result = await callModel(userMsg, { forceFinal: false });

    expect(result).toEqual({ role: 'assistant', content: '[haiku]', toolCalls: [] });
  });

  it('uses the cheap model on a fresh turn even when prior turns used tools', async () => {
    const calls: string[] = [];
    const callModel = makeRoutedCallModel({
      cheap: trackedModel('haiku', calls),
      reasoning: trackedModel('sonnet', calls),
      systemPrompt: SYSTEM,
    });

    await callModel(freshTurnAfterToolHeavyHistory, { forceFinal: false });

    expect(calls).toEqual(['haiku']);
  });

  it('mixed-language context routes consistently', async () => {
    const calls: string[] = [];
    const hebrewMsg: readonly TurnMessage[] = [
      { role: 'user', senderId: 'wife@wa', content: 'תוסיף חלב לרשימה' },
    ];
    const callModel = makeRoutedCallModel({
      cheap: trackedModel('haiku', calls),
      reasoning: trackedModel('sonnet', calls),
      systemPrompt: SYSTEM,
    });

    await callModel(hebrewMsg, { forceFinal: false });

    expect(calls).toEqual(['haiku']);
  });
});
