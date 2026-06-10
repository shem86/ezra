// defineTool (T26): the one shape every tool follows (SPEC "Code Style"
// snippet) — typed Zod schema, risk tier, deterministic external id,
// revalidation hook. Definition-time validation enforces what the type
// system can't: a confirm-before tool with no revalidation check is a SPEC
// "Always" violation and must never reach the registry.

import type { z } from 'zod';
import type { Queryable } from '../memory/store.js';

/** Architecture decision 10: reversibility/cost/third-party classification. */
export type RiskTier = 'autonomous' | 'notify-after' | 'confirm-before';

/** Inputs to the deterministic external-id derivation — journaled values only. */
export interface ExternalIdContext {
  readonly actionId: string;
  readonly conversationId: string;
  readonly toolUseId: string;
}

/** What execute sees beyond its parsed args and injected deps. */
export interface ToolContext extends ExternalIdContext {
  /**
   * Transaction-scoped: runTool runs as one datasource transaction, so
   * structured-state writes through this client co-commit with the step
   * checkpoint (the exactly-once guarantee).
   */
  readonly db: Queryable;
  /** Present iff the definition derives one — the idempotent external handle. */
  readonly externalId?: string;
}

export interface ToolDefinition<TDeps, TSchema extends z.ZodType = z.ZodType> {
  readonly name: string;
  readonly description: string;
  readonly schema: TSchema;
  readonly riskTier: RiskTier;
  /** Deterministic external ID — makes re-executed effects no-ops (decision 10). */
  readonly externalId?: (ctx: ExternalIdContext) => string;
  /**
   * Re-checked at execute time, not propose time (T35) — approval windows are
   * long. Method syntax (here and on execute) is deliberate: it keeps a
   * concretely-schemed definition assignable to AnyToolDefinition (bivariant
   * parameter check), which arrow-property declarations would forbid.
   */
  revalidate?(args: z.output<TSchema>, deps: TDeps): Promise<boolean>;
  /** Returns the model-facing tool_result content. */
  execute(args: z.output<TSchema>, deps: TDeps, ctx: ToolContext): Promise<string>;
}

export function defineTool<TDeps, TSchema extends z.ZodType>(
  def: ToolDefinition<TDeps, TSchema>,
): ToolDefinition<TDeps, TSchema> {
  if (def.name.length === 0) {
    throw new Error('defineTool: tool name must be non-empty');
  }
  if (def.riskTier === 'confirm-before' && def.revalidate === undefined) {
    throw new Error(
      `defineTool: ${def.name} is confirm-before but declares no revalidation check (SPEC boundary)`,
    );
  }
  return def;
}
