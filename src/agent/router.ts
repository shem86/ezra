// router (T30): cheap-vs-reasoning model selection.
// Wraps makeCallModel to switch between a Haiku-class (cheap) and
// Sonnet-class (reasoning) model based on per-call context signals.
// The composing caller provides both model instances from Config — this
// module never touches process.env or credentials directly.

import type { LanguageModel, ToolSet } from 'ai';
import { makeCallModel, type ModelUsage } from './call-model.js';
import type { HandleTurnDeps, ModelCallOptions } from './handle-turn.js';
import type { TurnMessage } from './context.js';

export type ModelTier = 'cheap' | 'reasoning';

export interface RouterPolicy {
  select(messages: readonly TurnMessage[], options: ModelCallOptions): ModelTier;
}

/**
 * Default routing heuristic (v1):
 * - forceFinal → cheap (text formatting only, no tools possible)
 * - 0–1 tool rounds this turn → cheap (Haiku handles most simple household tasks)
 * - 2+ tool rounds this turn → reasoning (chained multi-step planning)
 *
 * "This turn" is everything after the last user message: the loop appends the
 * batch's user messages before any round runs and never mid-turn, so that
 * suffix is exactly the current turn's rounds. Counting the whole transcript
 * instead would make escalation sticky — one tool-heavy turn (or one parallel
 * two-call round) would route every later turn of the conversation to the
 * reasoning tier. A round is ONE assistant message with tool calls, however
 * many calls it carries in parallel.
 */
export const defaultRouterPolicy: RouterPolicy = {
  select(messages, options) {
    if (options.forceFinal) return 'cheap';
    const lastUser = messages.findLastIndex((m) => m.role === 'user');
    let rounds = 0;
    for (const m of messages.slice(lastUser + 1)) {
      if (m.role === 'assistant' && m.toolCalls.length > 0) rounds += 1;
    }
    return rounds >= 2 ? 'reasoning' : 'cheap';
  },
};

export interface RoutedCallModelDeps {
  readonly cheap: LanguageModel;
  readonly reasoning: LanguageModel;
  readonly systemPrompt: string;
  readonly tools?: ToolSet;
  /** Usage callback receives the tier so T31 traces can tag model cost by tier. */
  readonly onUsage?: (usage: ModelUsage, tier: ModelTier) => void;
  readonly policy?: RouterPolicy;
}

export function makeRoutedCallModel(deps: RoutedCallModelDeps): HandleTurnDeps['callModel'] {
  const policy = deps.policy ?? defaultRouterPolicy;
  // exactOptionalPropertyTypes: spread undefined into optional keys via
  // conditional spread (the same pattern as call-model.ts line 43).
  const toolsEntry = deps.tools !== undefined ? { tools: deps.tools } : {};

  const tierFns: Record<ModelTier, HandleTurnDeps['callModel']> = {
    cheap: makeCallModel({
      model: deps.cheap,
      systemPrompt: deps.systemPrompt,
      ...toolsEntry,
      ...(deps.onUsage !== undefined ? { onUsage: (u) => deps.onUsage!(u, 'cheap') } : {}),
    }),
    reasoning: makeCallModel({
      model: deps.reasoning,
      systemPrompt: deps.systemPrompt,
      ...toolsEntry,
      ...(deps.onUsage !== undefined ? { onUsage: (u) => deps.onUsage!(u, 'reasoning') } : {}),
    }),
  };

  return function routedCallModel(messages, options) {
    const tier = policy.select(messages, options);
    return tierFns[tier](messages, options);
  };
}
