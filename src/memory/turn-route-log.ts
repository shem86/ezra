// turn_route_log writer (migrations/0009, docs/specs/jev-turn-routing-plan.md
// §5). Runs inside a registered datasource transaction like every structured
// write; the row co-commits with that step's checkpoint.

import type { RouteDecision } from '../agent/route-turn.js';
import type { Queryable } from './store.js';

export interface TurnRouteLogInput {
  readonly workflowId: string;
  readonly conversationId: string;
  readonly decision: RouteDecision;
}

/**
 * Idempotent insert keyed on workflow_id — the router runs at most once per
 * turn, so a crash-replay re-issues the same row and ON CONFLICT drops it.
 * Returns false on the replay path.
 */
export async function writeTurnRouteLog(db: Queryable, input: TurnRouteLogInput): Promise<boolean> {
  const d = input.decision;
  const json = (value: unknown): string | null => (value === undefined ? null : JSON.stringify(value));
  const res = await db.query(
    `INSERT INTO turn_route_log
       (workflow_id, conversation_id, mode, tier, proposed, source, questions_version,
        jev_model, latency_ms, input_tokens, answers, request, response)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb)
     ON CONFLICT (workflow_id) DO NOTHING
     RETURNING id`,
    [
      input.workflowId,
      input.conversationId,
      d.mode,
      d.tier,
      d.proposed,
      d.source,
      d.questionsVersion,
      d.jevModel ?? null,
      d.latencyMs ?? null,
      d.inputTokens ?? null,
      json(d.answers),
      json(d.request),
      json(d.response),
    ],
  );
  return res.rows.length === 1;
}
