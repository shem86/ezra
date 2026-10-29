// routeTurn (docs/specs/jev-turn-routing-plan.md §5): the body of the
// journaled `routeTurn` step that handleTurn runs once per turn, before round
// 0. Its output is the turn's tier; the workflow only reads it, so recovery
// replays the journaled decision instead of asking Jev again.
//
// It never throws. Routing is an optimization over today's Sonnet-only
// behavior, so a Jev failure must degrade to exactly that — standard, with
// the failure kind recorded in `source` — rather than retry or fail a turn.

import type { TurnMessage } from './context.js';
import { JevError, type JevClient, type JevErrorKind } from './jev-client.js';
import {
  applyRollout,
  decideTier,
  preRouteTier,
  renderRouteState,
  routeQuestionsVersion,
  toRouteAnswers,
  turnRouteQuestions,
  type PreRouteRule,
  type RouteAnswers,
  type RouteMessage,
  type Tier,
} from './turn-route.js';

export type RouteMode = 'shadow' | 'on';

export type RouteSource =
  | 'jev'
  | `pre-rule:${PreRouteRule}`
  | `fallback-error:${JevErrorKind | 'internal'}`;

/** Journaled step output — plain JSON, so it replays byte-identically. */
export interface RouteDecision {
  /** The tier this turn runs on. */
  readonly tier: Tier;
  /** What the router chose before shadow mode and the rollout clamp. */
  readonly proposed: Tier;
  readonly source: RouteSource;
  readonly mode: RouteMode;
  readonly questionsVersion: string;
  readonly jevModel?: string;
  readonly latencyMs?: number;
  readonly inputTokens?: number;
  readonly answers?: RouteAnswers;
}

export interface RouteTurnInput {
  /** The transcript as it stood BEFORE this turn's batch landed. */
  readonly prior: readonly TurnMessage[];
  /** The batch's human text, in order (media-only items already dropped). */
  readonly latest: ReadonlyArray<{ readonly senderId: string; readonly text: string }>;
  readonly hasPendingActions: boolean;
  readonly hasQuotedReply: boolean;
}

export interface RouteTurnDeps {
  readonly jev: JevClient;
  /** `off` is the composer not wiring routeTurn at all — the step never runs. */
  readonly mode: RouteMode;
  /** §7b staged rollout — a proposed tier outside this set runs as standard. */
  readonly enabledTiers: ReadonlySet<Tier>;
  /** Member label (husband/wife) for a sender id — Jev never sees a JID (§4). */
  readonly labelFor: (senderId: string) => string;
  /** Clock seam for latency; defaults to performance.now. */
  readonly now?: () => number;
}

export function makeRouteTurn(deps: RouteTurnDeps): (input: RouteTurnInput) => Promise<RouteDecision> {
  const now = deps.now ?? (() => performance.now());
  const base = { mode: deps.mode, questionsVersion: routeQuestionsVersion } as const;

  return async function routeTurn(input) {
    const pre = preRouteTier({
      hasPendingActions: input.hasPendingActions,
      hasQuotedReply: input.hasQuotedReply,
      hasText: input.latest.length > 0,
    });
    if (pre !== null) {
      return { ...base, tier: pre.tier, proposed: pre.tier, source: `pre-rule:${pre.rule}` };
    }

    const started = now();
    try {
      const state = renderRouteState({
        recent: toRouteMessages(input.prior, deps.labelFor),
        latest: input.latest.map((m) => ({ from: deps.labelFor(m.senderId), text: m.text })),
      });
      const response = await deps.jev.ask(state, turnRouteQuestions);
      const answers = toRouteAnswers(response.answers);
      const proposed = decideTier(answers);
      return {
        ...base,
        tier: deps.mode === 'on' ? applyRollout(proposed, deps.enabledTiers) : 'standard',
        proposed,
        source: 'jev',
        jevModel: response.model,
        latencyMs: Math.round(now() - started),
        inputTokens: response.inputTokens,
        answers,
      };
    } catch (error) {
      const kind = error instanceof JevError ? error.kind : 'internal';
      return {
        ...base,
        tier: 'standard',
        proposed: 'standard',
        source: `fallback-error:${kind}`,
        latencyMs: Math.round(now() - started),
      };
    }
  };
}

/**
 * The conversational tail Jev reads: people's messages under member labels
 * and the assistant's visible replies. Tool calls and results, and system
 * lines (hitl outcomes), are left out — the routing questions don't need
 * them, and leaving them out keeps tool payloads off the third-party call.
 */
export function toRouteMessages(
  messages: readonly TurnMessage[],
  labelFor: (senderId: string) => string,
): RouteMessage[] {
  const out: RouteMessage[] = [];
  for (const m of messages) {
    if (m.role === 'user' && !m.senderId.startsWith('system:')) {
      out.push({ from: labelFor(m.senderId), text: m.content });
    } else if (m.role === 'assistant' && m.content !== '') {
      out.push({ from: 'assistant', text: m.content });
    }
  }
  return out;
}
