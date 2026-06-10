// T25: callModel via AI SDK Core. All tests run against MockLanguageModelV3 —
// real model calls never run in CI (SPEC testing strategy).

import { tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { makeCallModel, toSdkMessages, type ModelUsage } from '../../src/agent/call-model.js';
import type { TurnMessage } from '../../src/agent/context.js';

const SYSTEM = 'You are the household assistant.';

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
    });

    await callModel(userMsg, { forceFinal: false });

    expect(seen?.prompt[0]).toMatchObject({
      role: 'system',
      content: SYSTEM,
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    });
    expect(seen?.prompt[1]).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: 'wife@wa: add milk' }],
    });
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
