// T25: callModel via AI SDK Core. All tests run against MockLanguageModelV3 —
// real model calls never run in CI (SPEC testing strategy).

import { describe, expect, it } from 'vitest';
import { toSdkMessages } from '../../src/agent/call-model.js';
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
