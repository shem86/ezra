// routeTurn (docs/specs/jev-turn-routing-plan.md §5): the body of the
// journaled `routeTurn` step that handleTurn runs once per turn, before round
// 0. Its output is the turn's tier; the workflow only reads it, so recovery
// replays the journaled decision instead of asking Jev again.
//
// It never throws. Routing is an optimization over today's Sonnet-only
// behavior, so a Jev failure must degrade to exactly that — standard, with
// the failure kind recorded in `source` — rather than retry or fail a turn.

import type { TurnMessage } from './context.js';
import {
  JevError,
  makeJevClient,
  type JevAnswer,
  type JevClient,
  type JevErrorKind,
  type JevQuestions,
} from './jev-client.js';
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
  /** The exact { state, questions } sent — for turn_route_log re-runs (§5). */
  readonly request?: { readonly state: unknown; readonly questions: JevQuestions };
  /** Jev's validated answers, wire format. */
  readonly response?: Readonly<Record<string, JevAnswer>>;
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
    let request: RouteDecision['request'];
    try {
      const state = renderRouteState({
        recent: toRouteMessages(input.prior, deps.labelFor),
        latest: input.latest.map((m) => ({ from: deps.labelFor(m.senderId), text: m.text })),
      });
      request = { state, questions: turnRouteQuestions };
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
        request,
        response: response.answers,
      };
    } catch (error) {
      const kind = error instanceof JevError ? error.kind : 'internal';
      return {
        ...base,
        tier: 'standard',
        proposed: 'standard',
        source: `fallback-error:${kind}`,
        latencyMs: Math.round(now() - started),
        ...(request === undefined ? {} : { request }),
      };
    }
  };
}

/**
 * Sender JID → member label. A member may have several JID forms
 * (phone-shaped and @lid — docs/pairing.md). An unknown sender becomes
 * 'member', never its JID: Jev is a third party and must not see one (§4).
 */
export function makeMemberLabeler(memberJids: {
  readonly husband: readonly string[];
  readonly wife: readonly string[];
}): (senderId: string) => string {
  const husband = new Set(memberJids.husband);
  const wife = new Set(memberJids.wife);
  return (senderId) => (husband.has(senderId) ? 'husband' : wife.has(senderId) ? 'wife' : 'member');
}

export interface TurnRoutingOptions {
  readonly mode: 'off' | RouteMode;
  readonly typesafeApiKey: string | undefined;
  readonly jevModel: string;
  readonly enabledTiers: ReadonlySet<Tier>;
  readonly labelFor: (senderId: string) => string;
  /** Tracing + streak-log tap. Runs inside the step; a throw is swallowed. */
  readonly onDecision: (decision: RouteDecision) => void;
  /** Injectable for tests; defaults to a real client from the key + pin. */
  readonly jev?: JevClient;
}

/**
 * The composers' one call (src/main.ts, src/dev/main.ts): undefined when
 * routing is off — nothing is wired, no routeTurn step exists — otherwise
 * the Jev client (for the startup probe) and the routeTurn dep.
 */
export function makeTurnRouting(
  options: TurnRoutingOptions,
): { readonly jev: JevClient; readonly routeTurn: (input: RouteTurnInput) => Promise<RouteDecision> } | undefined {
  if (options.mode === 'off') return undefined;
  if (options.jev === undefined && options.typesafeApiKey === undefined) {
    throw new Error('turn routing: TYPESAFE_API_KEY is required when routing is not off');
  }
  const jev =
    options.jev ?? makeJevClient({ apiKey: options.typesafeApiKey!, model: options.jevModel });
  const inner = makeRouteTurn({
    jev,
    mode: options.mode,
    enabledTiers: options.enabledTiers,
    labelFor: options.labelFor,
  });
  return {
    jev,
    async routeTurn(input) {
      const decision = await inner(input);
      try {
        options.onDecision(decision);
      } catch {
        // Observability must never fail or retry the routing step.
      }
      return decision;
    },
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
