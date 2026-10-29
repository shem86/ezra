// Tracing seam (T31): spans from the turn's step taps, exporter-agnostic.
// The composer injects a TraceSink (Langfuse in production, captured fakes in
// tests) and wires the taps around the existing deps — this module never
// touches Config, credentials, or DBOS (the composer passes
// () => DBOS.workflowID as getTraceId so workflow context stays out of ops).
// Spans carry metadata only — names, token counts, ids — never
// transcript content and never anything from Config, which is what the
// credential-boundary sweep in tests/unit/tracing.test.ts locks.

import type { ModelUsage } from '../agent/call-model.js';
import type { RouteDecision } from '../agent/route-turn.js';
import type { ToolCall, ToolResult } from '../agent/context.js';
import type { Queryable } from '../memory/store.js';
import { deriveActionId, type ToolRegistry } from '../tools/registry.js';

export type AttributeValue = string | number | boolean;

export interface TraceSpan {
  readonly name: string;
  /** Groups one turn's spans — the workflowID when running under DBOS. */
  readonly traceId: string | undefined;
  readonly startTime: Date;
  readonly endTime: Date;
  readonly attributes: Readonly<Record<string, AttributeValue>>;
  readonly error?: string;
}

export interface TraceSink {
  /** May buffer; must not block the turn. Throws are swallowed by the tracer. */
  emit(span: TraceSpan): void;
}

export interface TracerDeps {
  readonly sink: TraceSink;
  readonly getTraceId?: () => string | undefined;
}

type RunToolFn = (db: Queryable, call: ToolCall, conversationId: string) => Promise<ToolResult>;

export interface Tracer {
  /** Drop-in for CallModelDeps['onUsage'] — per-call cost, tier-tagged on routed turns. */
  onModelUsage(usage: ModelUsage): void;
  /**
   * The routeTurn span (docs/specs/jev-turn-routing-plan.md §5): decision +
   * probabilities only. The decision's request carries household text and is
   * deliberately NOT emitted — it lives in turn_route_log.
   */
  onRouteDecision(decision: RouteDecision): void;
  /** Wraps the composed runTool body; span carries tool name, risk tier, actionId. */
  traceRunTool<TDeps>(runTool: RunToolFn, registry: ToolRegistry<TDeps>): RunToolFn;
  /** Wraps a plain async step dep (compaction summarize/embed) in a timed span. */
  traceStep<TArgs extends unknown[], TResult>(
    name: string,
    fn: (...args: TArgs) => Promise<TResult>,
  ): (...args: TArgs) => Promise<TResult>;
}

export function makeTracer(deps: TracerDeps): Tracer {
  // Tracing must never fail or retry a step: every path out of this module
  // swallows its own errors (same contract as the onUsage taps it feeds).
  // Isolated so a throwing getTraceId degrades to an unparented span instead
  // of swallowing the span entirely.
  function traceId(): string | undefined {
    try {
      return deps.getTraceId?.();
    } catch {
      return undefined;
    }
  }

  function emit(
    name: string,
    startTime: Date,
    attributes: Record<string, AttributeValue>,
    error?: string,
  ): void {
    try {
      deps.sink.emit({
        name,
        traceId: traceId(),
        startTime,
        endTime: new Date(),
        attributes,
        ...(error === undefined ? {} : { error }),
      });
    } catch {
      // A broken exporter must not take the turn down with it.
    }
  }

  return {
    onModelUsage(usage) {
      const now = new Date();
      emit('callModel', now, {
        ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
        ...(usage.outputTokens === undefined ? {} : { outputTokens: usage.outputTokens }),
        ...(usage.cacheReadTokens === undefined
          ? {}
          : { cacheReadTokens: usage.cacheReadTokens }),
        ...(usage.cacheWriteTokens === undefined
          ? {}
          : { cacheWriteTokens: usage.cacheWriteTokens }),
        ...(usage.tier === undefined ? {} : { tier: usage.tier }),
      });
    },

    onRouteDecision(decision) {
      const optional = <T extends AttributeValue>(key: string, value: T | undefined) =>
        value === undefined ? {} : { [key]: value };
      const a = decision.answers;
      emit('routeTurn', new Date(), {
        tier: decision.tier,
        proposed: decision.proposed,
        source: decision.source,
        mode: decision.mode,
        questionsVersion: decision.questionsVersion,
        ...optional('jevModel', decision.jevModel),
        ...optional('latencyMs', decision.latencyMs),
        ...optional('jevInputTokens', decision.inputTokens),
        ...(a === undefined
          ? {}
          : {
              intent: a.intent,
              pAsksAnything: a.asksAnything,
              pSeveralRequests: a.severalRequests,
              pRefersBack: a.refersBack,
              pWeighsOptions: a.weighsOptions,
              pScheduleReasoning: a.scheduleReasoning,
              pCorrectsPrevious: a.correctsPrevious,
            }),
      });
    },

    traceRunTool(runTool, registry) {
      return async function tracedRunTool(db, call, conversationId) {
        const startTime = new Date();
        const def = registry.get(call.name);
        const base = {
          tool: call.name,
          actionId: deriveActionId(conversationId, call.id),
          ...(def === undefined ? {} : { riskTier: def.riskTier }),
        };
        try {
          const result = await runTool(db, call, conversationId);
          emit('runTool', startTime, { ...base, parked: result.parked });
          return result;
        } catch (err) {
          emit('runTool', startTime, base, String(err));
          throw err;
        }
      };
    },

    traceStep(name, fn) {
      return async function tracedStep(...args) {
        const startTime = new Date();
        try {
          const result = await fn(...args);
          emit(name, startTime, {});
          return result;
        } catch (err) {
          emit(name, startTime, {}, String(err));
          throw err;
        }
      };
    },
  };
}
