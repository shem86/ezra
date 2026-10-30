// T25: callModel via AI SDK Core. All tests run against MockLanguageModelV3 —
// real model calls never run in CI (SPEC testing strategy).

import { tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { makeCallModel, toSdkMessages, type ModelUsage } from '../../src/agent/call-model.js';
import { renderCurrentTimePrompt, renderReplyLanguagePrompt } from '../../src/agent/prompts.js';
import type { TurnMessage } from '../../src/agent/context.js';

const SYSTEM = 'You are the household assistant.';
const NOW = new Date('2026-06-14T17:45:00Z');

describe('toSdkMessages', () => {
  it('puts the system prompt first with anthropic cacheControl passthrough', () => {
    const sdk = toSdkMessages(SYSTEM, []);

    expect(sdk[0]).toEqual({
      role: 'system',
      content: SYSTEM,
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    });
  });

  it('maps user messages with sender attribution', () => {
    const msgs: TurnMessage[] = [{ role: 'user', senderId: 'wife@wa', content: 'תוסיף חלב לרשימה' }];

    const sdk = toSdkMessages(SYSTEM, msgs);

    expect(sdk[1]).toEqual({ role: 'user', content: 'wife@wa: תוסיף חלב לרשימה' });
  });

  it('maps a text-only assistant message to a text part', () => {
    const msgs: TurnMessage[] = [{ role: 'assistant', content: 'Done!', toolCalls: [] }];

    const sdk = toSdkMessages(SYSTEM, msgs);

    expect(sdk[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'Done!' }] });
  });

  it('maps assistant tool calls to tool-call parts alongside the text', () => {
    const msgs: TurnMessage[] = [
      {
        role: 'assistant',
        content: 'Adding it.',
        toolCalls: [{ id: 'tu_1', name: 'list_add', args: { item: 'milk' } }],
      },
    ];

    const sdk = toSdkMessages(SYSTEM, msgs);

    expect(sdk[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Adding it.' },
        { type: 'tool-call', toolCallId: 'tu_1', toolName: 'list_add', input: { item: 'milk' } },
      ],
    });
  });

  it('omits an empty text part when the assistant only called tools', () => {
    const msgs: TurnMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tu_1', name: 'list_add', args: { item: 'milk' } }],
      },
    ];

    const sdk = toSdkMessages(SYSTEM, msgs);

    expect(sdk[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 'tu_1', toolName: 'list_add', input: { item: 'milk' } },
      ],
    });
  });

  it('maps tool results, resolving toolName from the prior assistant call', () => {
    const msgs: TurnMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tu_1', name: 'list_add', args: { item: 'milk' } }],
      },
      { role: 'tool', toolUseId: 'tu_1', content: 'added' },
    ];

    const sdk = toSdkMessages(SYSTEM, msgs);

    expect(sdk[2]).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'tu_1',
          toolName: 'list_add',
          output: { type: 'text', value: 'added' },
        },
      ],
    });
  });

  it('fails loud on a tool result whose toolUseId matches no assistant call', () => {
    const msgs: TurnMessage[] = [{ role: 'tool', toolUseId: 'tu_ghost', content: 'orphan' }];

    expect(() => toSdkMessages(SYSTEM, msgs)).toThrow(/tu_ghost/);
  });

  it('a digest becomes a second system message WITHOUT cacheControl — the stable block is untouched', () => {
    const msgs: TurnMessage[] = [{ role: 'user', senderId: 'wife@wa', content: 'yes' }];
    const sdk = toSdkMessages(SYSTEM, msgs, '## Awaiting approval\n- [act-1] create_event: dentist');

    // Block 1 byte-identical to the no-digest call: its cache breakpoint
    // survives digest changes (the T32 prefix discipline, now live).
    expect(sdk[0]).toEqual(toSdkMessages(SYSTEM, [])[0]);
    expect(sdk[1]).toEqual({
      role: 'system',
      content: '## Awaiting approval\n- [act-1] create_event: dentist',
    });
    expect(sdk[2]).toEqual({ role: 'user', content: 'wife@wa: yes' });
  });

  it('a null digest adds no second system message', () => {
    expect(toSdkMessages(SYSTEM, [], null)).toEqual(toSdkMessages(SYSTEM, []));
  });

  it('a now value becomes a post-prefix system block WITHOUT cacheControl — stable block untouched', () => {
    const msgs: TurnMessage[] = [{ role: 'user', senderId: 'wife@wa', content: 'remind me tomorrow' }];
    const sdk = toSdkMessages(SYSTEM, msgs, null, NOW);

    // The cached prefix is byte-identical whether or not the clock is pushed.
    expect(sdk[0]).toEqual(toSdkMessages(SYSTEM, [])[0]);
    expect(sdk[1]).toEqual({ role: 'system', content: renderCurrentTimePrompt(NOW) });
    expect(sdk[1]).not.toHaveProperty('providerOptions');
    expect(sdk[2]).toEqual({ role: 'user', content: 'wife@wa: remind me tomorrow' });
  });

  it('orders current-time before the digest, both after the stable prefix', () => {
    const sdk = toSdkMessages(SYSTEM, [], '## Awaiting approval\n- [act-1] x', NOW);
    expect(sdk[0]).toEqual(toSdkMessages(SYSTEM, [])[0]); // stable, cached
    expect(sdk[1]).toEqual({ role: 'system', content: renderCurrentTimePrompt(NOW) });
    expect(sdk[2]).toEqual({ role: 'system', content: '## Awaiting approval\n- [act-1] x' });
  });

  it('omits the current-time block when no now is given (back-compat)', () => {
    expect(toSdkMessages(SYSTEM, [], null)).toEqual(toSdkMessages(SYSTEM, [], null, undefined));
  });

  it('a reply language becomes the LAST system block, after clock and digest — stable block untouched', () => {
    const msgs: TurnMessage[] = [{ role: 'user', senderId: 'wife@wa', content: 'מה הסיסמה?' }];
    const sdk = toSdkMessages(SYSTEM, msgs, '## Awaiting approval\n- [act-1] x', NOW, 'he');

    expect(sdk[0]).toEqual(toSdkMessages(SYSTEM, [])[0]);
    expect(sdk[1]).toEqual({ role: 'system', content: renderCurrentTimePrompt(NOW) });
    expect(sdk[2]).toEqual({ role: 'system', content: '## Awaiting approval\n- [act-1] x' });
    expect(sdk[3]).toEqual({ role: 'system', content: renderReplyLanguagePrompt('he') });
    expect(sdk[3]).not.toHaveProperty('providerOptions');
    expect(sdk[4]).toEqual({ role: 'user', content: 'wife@wa: מה הסיסמה?' });
  });

  it('no reply language adds no block', () => {
    expect(toSdkMessages(SYSTEM, [], null, NOW, null)).toEqual(toSdkMessages(SYSTEM, [], null, NOW));
  });
});

type DoGenerateOptions = Parameters<
  NonNullable<ConstructorParameters<typeof MockLanguageModelV3>[0]['doGenerate']>
>[0];
type DoGenerateResult = Awaited<
  ReturnType<NonNullable<ConstructorParameters<typeof MockLanguageModelV3>[0]['doGenerate']>>
>;

const usage: DoGenerateResult['usage'] = {
  inputTokens: { total: 100, noCache: 6, cacheRead: 90, cacheWrite: 4 },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

function mockModel(content: DoGenerateResult['content'], onOptions?: (o: DoGenerateOptions) => void) {
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      onOptions?.(options);
      return {
        content,
        finishReason: {
          unified: content.some((p) => p.type === 'tool-call') ? 'tool-calls' : 'stop',
          raw: undefined,
        },
        usage,
        warnings: [],
      };
    },
  });
}

const listAddTools = {
  // No execute on purpose: DBOS owns the loop (decision 4) — the SDK must
  // return tool calls, never run them.
  list_add: tool({
    description: 'Add an item to a shared list',
    inputSchema: z.object({ item: z.string() }),
  }),
};

const userMsg: TurnMessage[] = [{ role: 'user', senderId: 'wife@wa', content: 'add milk' }];

describe('makeCallModel', () => {
  it('returns a text-only response as an AssistantMessage with no tool calls', async () => {
    const callModel = makeCallModel({
      model: mockModel([{ type: 'text', text: 'Added!' }]),
      systemPrompt: SYSTEM,
    });

    const assistant = await callModel(userMsg, { forceFinal: false });

    expect(assistant).toEqual({ role: 'assistant', content: 'Added!', toolCalls: [] });
  });

  it('returns text and every tool_use id/name/args in ONE assistant message', async () => {
    const callModel = makeCallModel({
      model: mockModel([
        { type: 'text', text: 'Adding it.' },
        { type: 'tool-call', toolCallId: 'tu_1', toolName: 'list_add', input: '{"item":"milk"}' },
        { type: 'tool-call', toolCallId: 'tu_2', toolName: 'list_add', input: '{"item":"bread"}' },
      ]),
      systemPrompt: SYSTEM,
      tools: listAddTools,
    });

    const assistant = await callModel(userMsg, { forceFinal: false });

    // One object = one journaled step output: a replay can never see the
    // message without its tool ids (T25's atomicity requirement).
    expect(assistant).toEqual({
      role: 'assistant',
      content: 'Adding it.',
      toolCalls: [
        { id: 'tu_1', name: 'list_add', args: { item: 'milk' } },
        { id: 'tu_2', name: 'list_add', args: { item: 'bread' } },
      ],
    });
  });

  it('sends the cached system prefix and mapped transcript to the provider', async () => {
    let seen: DoGenerateOptions | undefined;
    const callModel = makeCallModel({
      model: mockModel([{ type: 'text', text: 'ok' }], (o) => {
        seen = o;
      }),
      systemPrompt: SYSTEM,
      now: () => NOW,
    });

    await callModel(userMsg, { forceFinal: false });

    expect(seen?.prompt[0]).toMatchObject({
      role: 'system',
      content: SYSTEM,
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    });
    // The clock and the reply-language note ride between the cached prefix
    // and the transcript.
    expect(seen?.prompt[1]).toEqual({ role: 'system', content: renderCurrentTimePrompt(NOW) });
    expect(seen?.prompt[2]).toEqual({ role: 'system', content: renderReplyLanguagePrompt('en') });
    expect(seen?.prompt[3]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'wife@wa: add milk' }],
    });
  });

  it('derives the reply language from the latest member message, not the run before it', async () => {
    let seen: DoGenerateOptions | undefined;
    const callModel = makeCallModel({
      model: mockModel([{ type: 'text', text: 'ok' }], (o) => {
        seen = o;
      }),
      systemPrompt: SYSTEM,
    });

    await callModel(
      [
        { role: 'user', senderId: 'husband@wa', content: 'שדרגתי את המודל, זה אומר לך משהו?' },
        { role: 'assistant', content: 'אין לי דרך לראות באיזה מודל אני רץ', toolCalls: [] },
        { role: 'user', senderId: 'husband@wa', content: 'List all of the facts you have saved' },
      ],
      { forceFinal: false },
    );

    // [1] is the clock (default now); the language note follows it.
    expect(seen?.prompt[2]).toEqual({ role: 'system', content: renderReplyLanguagePrompt('en') });
  });

  it('passes the per-turn digest through as the post-prefix system block', async () => {
    let seen: DoGenerateOptions | undefined;
    const callModel = makeCallModel({
      model: mockModel([{ type: 'text', text: 'ok' }], (o) => {
        seen = o;
      }),
      systemPrompt: SYSTEM,
      now: () => NOW,
    });

    await callModel(userMsg, { forceFinal: false, digest: '- [act-1] create_event: dentist' });

    expect(seen?.prompt[0]).toMatchObject({
      role: 'system',
      content: SYSTEM,
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    });
    // Clock first of the dynamic blocks, then the digest.
    expect(seen?.prompt[1]).toEqual({ role: 'system', content: renderCurrentTimePrompt(NOW) });
    expect(seen?.prompt[2]).toEqual({
      role: 'system',
      content: '- [act-1] create_event: dentist',
    });
  });

  it('pushes the current time to the provider as a post-prefix system block', async () => {
    let seen: DoGenerateOptions | undefined;
    const callModel = makeCallModel({
      model: mockModel([{ type: 'text', text: 'ok' }], (o) => {
        seen = o;
      }),
      systemPrompt: SYSTEM,
      now: () => NOW,
    });

    await callModel(userMsg, { forceFinal: false });

    // Stable prefix first (cached), then the clock (no cacheControl).
    expect(seen?.prompt[0]).toMatchObject({ role: 'system', content: SYSTEM });
    expect(seen?.prompt[1]).toEqual({ role: 'system', content: renderCurrentTimePrompt(NOW) });
  });

  it('sends an explicit output cap — the pinned provider defaults unknown model ids to 4096', async () => {
    let seen: DoGenerateOptions | undefined;
    const callModel = makeCallModel({
      model: mockModel([{ type: 'text', text: 'ok' }], (o) => {
        seen = o;
      }),
      systemPrompt: SYSTEM,
    });

    await callModel(userMsg, { forceFinal: false });

    expect(seen?.maxOutputTokens).toBe(16_000);
  });

  it('passes the configured effort to the anthropic provider, and omits it when unset', async () => {
    let seen: DoGenerateOptions | undefined;
    const withEffort = makeCallModel({
      model: mockModel([{ type: 'text', text: 'ok' }], (o) => {
        seen = o;
      }),
      systemPrompt: SYSTEM,
      effort: 'low',
    });
    await withEffort(userMsg, { forceFinal: false });
    expect(seen?.providerOptions).toEqual({ anthropic: { effort: 'low' } });

    const withoutEffort = makeCallModel({
      model: mockModel([{ type: 'text', text: 'ok' }], (o) => {
        seen = o;
      }),
      systemPrompt: SYSTEM,
    });
    await withoutEffort(userMsg, { forceFinal: false });
    expect(seen?.providerOptions).toBeUndefined();
  });

  it('forceFinal forbids tool calls via toolChoice none', async () => {
    let seen: DoGenerateOptions | undefined;
    const callModel = makeCallModel({
      model: mockModel([{ type: 'text', text: 'Final answer.' }], (o) => {
        seen = o;
      }),
      systemPrompt: SYSTEM,
      tools: listAddTools,
    });

    await callModel(userMsg, { forceFinal: true });

    expect(seen?.toolChoice).toEqual({ type: 'none' });
  });

  it('surfaces usage including cache read/write through onUsage', async () => {
    const seen: ModelUsage[] = [];
    const callModel = makeCallModel({
      model: mockModel([{ type: 'text', text: 'ok' }]),
      systemPrompt: SYSTEM,
      onUsage: (u) => seen.push(u),
    });

    await callModel(userMsg, { forceFinal: false });

    expect(seen).toEqual([
      { inputTokens: 100, outputTokens: 20, cacheReadTokens: 90, cacheWriteTokens: 4 },
    ]);
  });
});

// Turn routing (docs/specs/jev-turn-routing-plan.md §5): the turn's tier picks
// the model; a tier with no model of its own — or no tier at all, the
// unrouted path — runs on the base (standard) model, never fails the call.
describe('makeCallModel tier selection', () => {
  function tagged(tag: string, seen: string[]) {
    return mockModel([{ type: 'text', text: tag }], () => seen.push(tag));
  }

  it('runs a routed turn on the model for its tier', async () => {
    const seen: string[] = [];
    const callModel = makeCallModel({
      model: tagged('standard', seen),
      models: { fast: tagged('fast', seen), deep: tagged('deep', seen) },
      systemPrompt: SYSTEM,
    });

    await callModel(userMsg, { forceFinal: false, tier: 'deep' });
    await callModel(userMsg, { forceFinal: true, tier: 'deep' });
    await callModel(userMsg, { forceFinal: false, tier: 'fast' });
    await callModel(userMsg, { forceFinal: false, tier: 'standard' });

    expect(seen).toEqual(['deep', 'deep', 'fast', 'standard']);
  });

  // REASONING_EFFORT is tuned for the standard model (Sonnet 5.5 rejects
  // `disabled`) and Haiku 4.5 REJECTS the parameter: sending it on a routed
  // fast turn would 400 every one of them. A tier model runs at its default.
  it('sends REASONING_EFFORT on the standard model only — never to a tier model', async () => {
    const efforts: Array<[string, unknown]> = [];
    const capture = (tag: string) =>
      mockModel([{ type: 'text', text: 'ok' }], (o) =>
        efforts.push([tag, (o.providerOptions?.anthropic as { effort?: unknown } | undefined)?.effort]),
      );
    const callModel = makeCallModel({
      model: capture('standard'),
      models: { fast: capture('fast'), deep: capture('deep') },
      systemPrompt: SYSTEM,
      effort: 'low',
    });

    await callModel(userMsg, { forceFinal: false });
    await callModel(userMsg, { forceFinal: false, tier: 'standard' });
    await callModel(userMsg, { forceFinal: false, tier: 'fast' });
    await callModel(userMsg, { forceFinal: true, tier: 'deep' });

    expect(efforts).toEqual([
      ['standard', 'low'],
      ['standard', 'low'],
      ['fast', undefined],
      ['deep', undefined],
    ]);
  });

  it('sends each tier model its own effort when one is configured', async () => {
    const efforts: Array<[string, unknown]> = [];
    const capture = (tag: string) =>
      mockModel([{ type: 'text', text: 'ok' }], (o) =>
        efforts.push([tag, (o.providerOptions?.anthropic as { effort?: unknown } | undefined)?.effort]),
      );
    const callModel = makeCallModel({
      model: capture('standard'),
      models: { fast: capture('fast'), deep: capture('deep') },
      efforts: { fast: 'low', deep: 'medium' },
      systemPrompt: SYSTEM,
      effort: 'low',
    });

    await callModel(userMsg, { forceFinal: false, tier: 'fast' });
    await callModel(userMsg, { forceFinal: false, tier: 'deep' });

    expect(efforts).toEqual([
      ['fast', 'low'],
      ['deep', 'medium'],
    ]);
  });

  it('reports the turn tier with usage so traces can split cost per tier', async () => {
    const usages: ModelUsage[] = [];
    const callModel = makeCallModel({
      model: mockModel([{ type: 'text', text: 'ok' }]),
      models: { deep: mockModel([{ type: 'text', text: 'ok' }]) },
      systemPrompt: SYSTEM,
      onUsage: (u) => usages.push(u),
    });

    await callModel(userMsg, { forceFinal: false, tier: 'deep' });
    await callModel(userMsg, { forceFinal: false });

    expect(usages[0]!.tier).toBe('deep');
    expect(usages[1]).not.toHaveProperty('tier');
  });

  it('falls back to the base model for an unrouted call or a tier without a model', async () => {
    const seen: string[] = [];
    const callModel = makeCallModel({
      model: tagged('standard', seen),
      models: { deep: tagged('deep', seen) },
      systemPrompt: SYSTEM,
    });

    await callModel(userMsg, { forceFinal: false });
    await callModel(userMsg, { forceFinal: false, tier: 'fast' });

    expect(seen).toEqual(['standard', 'standard']);
  });
});
