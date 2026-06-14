// T25: callModel via AI SDK Core. All tests run against MockLanguageModelV3 —
// real model calls never run in CI (SPEC testing strategy).

import { tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { makeCallModel, toSdkMessages, type ModelUsage } from '../../src/agent/call-model.js';
import { renderCurrentTimePrompt } from '../../src/agent/prompts.js';
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
    // The clock rides between the cached prefix and the transcript.
    expect(seen?.prompt[1]).toEqual({ role: 'system', content: renderCurrentTimePrompt(NOW) });
    expect(seen?.prompt[2]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'wife@wa: add milk' }],
    });
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
