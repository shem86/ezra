// Tool registry (T26): one set of definitions, two projections. The model
// side gets a definitions-only AI SDK ToolSet (no execute — DBOS owns the
// loop, decision 4); the workflow side gets the runTool body the composer
// wraps in registerTransactionalStep, so every tool's state writes co-commit
// with the step checkpoint (T22 fixture pattern).

import { tool, type ToolSet } from 'ai';
import type { ToolCall, ToolResult } from '../agent/context.js';
import type { Queryable } from '../memory/store.js';
import type { ToolDefinition } from './define-tool.js';

export type AnyToolDefinition<TDeps> = ToolDefinition<TDeps>;

export type ToolRegistry<TDeps> = ReadonlyMap<string, AnyToolDefinition<TDeps>>;

export function makeToolRegistry<TDeps>(
  defs: ReadonlyArray<AnyToolDefinition<TDeps>>,
): ToolRegistry<TDeps> {
  const byName = new Map<string, AnyToolDefinition<TDeps>>();
  for (const def of defs) {
    if (byName.has(def.name)) {
      throw new Error(`makeToolRegistry: duplicate tool name ${def.name}`);
    }
    byName.set(def.name, def);
  }
  return byName;
}

/**
 * Deterministic from journaled values only (the tool_use id lives in the
 * journaled assistant message), so a recovery replay re-derives the same id
 * without any DBOS runtime read. Exported so the T31 tracer tags spans with
 * the same id the runTool body uses — one derivation, no drift.
 */
export function deriveActionId(conversationId: string, toolUseId: string): string {
  return `act-${conversationId}-${toolUseId}`;
}

/** The `tools` dep for T25's makeCallModel: schemas for the model, no execute. */
export function toToolSet<TDeps>(registry: ToolRegistry<TDeps>): ToolSet {
  const toolSet: ToolSet = {};
  for (const def of registry.values()) {
    toolSet[def.name] = tool({ description: def.description, inputSchema: def.schema });
  }
  return toolSet;
}

/** What the park seam (T34's production implementation) receives. */
export interface ParkRequest {
  readonly actionId: string;
  readonly conversationId: string;
  readonly call: ToolCall;
  readonly externalId?: string;
}

export interface RunToolDeps<TDeps> {
  readonly toolDeps: TDeps;
  /**
   * Records the pending action and returns the synthetic "pending approval"
   * tool_result (decision 10 fire-and-fold). Runs on the same transaction-
   * scoped client as the step, so the row co-commits with the checkpoint.
   */
  readonly park: (db: Queryable, request: ParkRequest) => Promise<ToolResult>;
}

/**
 * Build the `(db, call, conversationId) → ToolResult` body for the runTool
 * transactional step. Model-mistake paths (unknown tool, schema-invalid
 * args) come back as error tool_results, never throws — every tool_use gets
 * a tool_result. Execute errors DO propagate: the transaction rolls back
 * rather than committing a partial write.
 */
export function makeRunTool<TDeps>(
  registry: ToolRegistry<TDeps>,
  deps: RunToolDeps<TDeps>,
): (db: Queryable, call: ToolCall, conversationId: string) => Promise<ToolResult> {
  return async function runTool(db, call, conversationId) {
    const def = registry.get(call.name);
    if (def === undefined) {
      return { toolUseId: call.id, content: `unknown tool: ${call.name}`, parked: false };
    }

    const parsed = def.schema.safeParse(call.args);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ');
      return {
        toolUseId: call.id,
        content: `invalid arguments for ${call.name} — ${issues}`,
        parked: false,
      };
    }

    const idCtx = {
      actionId: deriveActionId(conversationId, call.id),
      conversationId,
      toolUseId: call.id,
    };
    const externalId = def.externalId?.(idCtx);

    if (def.riskTier === 'confirm-before') {
      const result = await deps.park(db, {
        ...idCtx,
        call,
        ...(externalId === undefined ? {} : { externalId }),
      });
      // parked drives fire-and-fold in the loop — never trust an
      // implementation to remember it.
      return { ...result, parked: true };
    }

    const content = await def.execute(parsed.data, deps.toolDeps, {
      ...idCtx,
      db,
      ...(externalId === undefined ? {} : { externalId }),
    });
    return { toolUseId: call.id, content, parked: false };
  };
}
