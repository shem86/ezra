// callModel (T25): the real model call behind T22's seam, via AI SDK Core.
// This module builds the request and folds the response into ONE
// AssistantMessage — text + every tool_use id together — because that single
// object is what DBOS.runStep journals; splitting them across outputs would
// let a crash persist a message without its tool ids (the atomicity T25 owns).

import { generateText, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import type { HandleTurnDeps } from './handle-turn.js';
import type { TurnMessage } from './context.js';

/** Per-call token accounting — feeds T31 traces and the T33 cost gate. */
export interface ModelUsage {
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly cacheReadTokens: number | undefined;
  readonly cacheWriteTokens: number | undefined;
}

export interface CallModelDeps {
  /** Instantiated by the composing caller from Config — never module-level. */
  readonly model: LanguageModel;
  /** The stable cacheable prefix (T32 brings the real one). */
  readonly systemPrompt: string;
  /** Definitions only — no execute: DBOS owns the loop (decision 4). */
  readonly tools?: ToolSet;
  /** Observability tap; must not throw (a throw fails and retries the step). */
  readonly onUsage?: (usage: ModelUsage) => void;
}

/**
 * Build the callModel dep that T22's workflow wraps in DBOS.runStep. The
 * returned AssistantMessage carries the text AND every tool_use id/name/args
 * from the same response — one object, one journaled step output, so replay
 * can never see a message without its tool ids.
 */
export function makeCallModel(deps: CallModelDeps): HandleTurnDeps['callModel'] {
  return async function callModel(messages, options) {
    const result = await generateText({
      model: deps.model,
      // The system prompt travels as a message so cacheControl attaches (T7).
      allowSystemInMessages: true,
      messages: toSdkMessages(deps.systemPrompt, messages),
      ...(deps.tools === undefined ? {} : { tools: deps.tools }),
      toolChoice: options.forceFinal ? 'none' : 'auto',
    });

    deps.onUsage?.({
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheReadTokens: result.usage.inputTokenDetails.cacheReadTokens,
      cacheWriteTokens: result.usage.inputTokenDetails.cacheWriteTokens,
    });

    return {
      role: 'assistant',
      content: result.text,
      toolCalls: result.toolCalls.map((call) => ({
        id: call.toolCallId,
        name: call.toolName,
        args: call.input,
      })),
    };
  };
}

/**
 * Convert the persisted transcript to AI SDK messages. The system prompt is
 * the stable cacheable prefix, so it travels as a system *message* with
 * anthropic cacheControl passthrough (T7: providerOptions cannot attach to
 * the plain `system:` option) — callers must pass `allowSystemInMessages`.
 */
export function toSdkMessages(systemPrompt: string, msgs: readonly TurnMessage[]): ModelMessage[] {
  // Tool-result parts require the tool's name, which the transcript only
  // carries on the originating assistant call — collect ids up front so an
  // orphaned result fails here, not as an opaque provider 400.
  const toolNamesById = new Map<string, string>();
  for (const msg of msgs) {
    if (msg.role === 'assistant') {
      for (const call of msg.toolCalls) toolNamesById.set(call.id, call.name);
    }
  }

  const sdk: ModelMessage[] = [
    {
      role: 'system',
      content: systemPrompt,
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    },
  ];

  for (const msg of msgs) {
    switch (msg.role) {
      case 'user':
        // Two-person household: the model must know which member is speaking,
        // and senderId only exists structurally in the transcript.
        sdk.push({ role: 'user', content: `${msg.senderId}: ${msg.content}` });
        break;
      case 'assistant':
        sdk.push({
          role: 'assistant',
          content: [
            ...(msg.content === '' ? [] : [{ type: 'text' as const, text: msg.content }]),
            ...msg.toolCalls.map((call) => ({
              type: 'tool-call' as const,
              toolCallId: call.id,
              toolName: call.name,
              input: call.args,
            })),
          ],
        });
        break;
      case 'tool': {
        const toolName = toolNamesById.get(msg.toolUseId);
        if (toolName === undefined) {
          throw new Error(
            `toSdkMessages: tool result ${msg.toolUseId} has no originating assistant tool call — corrupt transcript`,
          );
        }
        sdk.push({
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: msg.toolUseId,
              toolName,
              output: { type: 'text', value: msg.content },
            },
          ],
        });
        break;
      }
    }
  }

  return sdk;
}
