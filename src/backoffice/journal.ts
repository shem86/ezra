// Logs — the durable turn list from the DBOS journal (dbos.workflow_status),
// enriched per-turn from the Langfuse observations read API. The journal is the
// source of truth for WHAT ran (id, status, timing, recovery); Langfuse adds
// tokens/cache/cost/tier where a trace exists. Anything Langfuse lacks renders
// `—` (BO-8: cost is estimated, model absent). workflow_uuid === Langfuse
// traceId (both `turn-…`), which is the join key.
//
// The journal query is SELECT-only against the dbos schema (the SELECT-only
// role is granted USAGE+SELECT there, BO-17). Enrichment is a single, cached
// Langfuse fetch grouped by trace — never one call per turn — and that fetch is
// SHARED with the Costs screen (see observations.ts).

import { z } from 'zod';
import { PRICE_PER_TOKEN } from './cost.js';
import type { ObservationsSource } from './observations.js';
import type { Queryable } from './queries.js';

export interface TurnRow {
  id: string;
  ts: string; // ISO
  level: 'info' | 'warn' | 'error';
  st: string; // committed | recovered | error | cancelled | pending | enqueued
  ms: number | null;
  tool: string | null;
  tier: string | null;
  tokens: number | null;
  cache: number | null; // cache-read %
  cost: number | null; // estimated USD
}

export interface LogsResponse {
  turns: TurnRow[];
  enriched: boolean; // false when Langfuse enrichment was unavailable
}

const journalRowSchema = z.object({
  id: z.string(),
  status: z.string(),
  recovery_attempts: z.union([z.string(), z.number()]).transform((v) => Number(v)),
  created_at: z.union([z.string(), z.number()]).transform((v) => Number(v)),
  finished_at: z
    .union([z.string(), z.number(), z.null()])
    .transform((v) => (v === null ? null : Number(v))),
});

// The handleTurn workflow IS a turn; the *Compacting/*ParkRecovery variants are
// continuations of one. List the roots.
const TURN_WORKFLOW = 'handleTurn';

const LIST_SQL = `SELECT workflow_uuid AS id, status, recovery_attempts,
                         created_at, COALESCE(completed_at, updated_at) AS finished_at
                  FROM dbos.workflow_status
                  WHERE name = $1
                  ORDER BY created_at DESC
                  LIMIT $2`;

function mapStatus(status: string, recoveryAttempts: number): { level: TurnRow['level']; st: string } {
  const s = status.toUpperCase();
  if (s === 'ERROR' || s === 'RETRIES_EXCEEDED') return { level: 'error', st: 'error' };
  if (s === 'CANCELLED') return { level: 'warn', st: 'cancelled' };
  if (recoveryAttempts > 1) return { level: 'warn', st: 'recovered' };
  if (s === 'PENDING') return { level: 'warn', st: 'pending' };
  if (s === 'ENQUEUED') return { level: 'info', st: 'enqueued' };
  if (s === 'SUCCESS') return { level: 'info', st: 'committed' };
  return { level: 'info', st: status.toLowerCase() };
}

// --- Langfuse enrichment ----------------------------------------------------

export interface Enrichment {
  tokens: number;
  cache: number | null;
  cost: number;
  tier: string | null;
  tool: string | null;
}

export interface TurnEnricher {
  /** trace id (= workflow_uuid) → enrichment; empty map if Langfuse is down. */
  byTrace(): Promise<Map<string, Enrichment>>;
}

export interface EnricherDeps {
  /** The shared Langfuse v2 read — cached and de-duplicated there, so calling
   *  this per request costs one upstream fetch per TTL across BOTH screens. */
  readonly observations: ObservationsSource;
}

export function makeTurnEnricher(deps: EnricherDeps): TurnEnricher {
  return {
    async byTrace(): Promise<Map<string, Enrichment>> {
      const records = await deps.observations.recent();

      interface Acc {
        fresh: number;
        cacheRead: number;
        cacheWrite: number;
        output: number;
        tier: string | null;
        tool: string | null;
      }
      const acc = new Map<string, Acc>();
      // A turn's usage rides on its generations and its tier/tool on the tool
      // spans — both share the traceId, so fold every record into one bucket.
      for (const o of records) {
        if (o.traceId === null) continue;
        const a = acc.get(o.traceId) ?? { fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0, tier: null, tool: null };
        if (o.usage !== null) {
          a.fresh += o.usage.input;
          a.cacheRead += o.usage.cacheRead;
          a.cacheWrite += o.usage.cacheWrite;
          a.output += o.usage.output;
        }
        if (a.tier === null && o.tier !== null) a.tier = o.tier;
        if (a.tool === null && o.tool !== null) a.tool = o.tool;
        acc.set(o.traceId, a);
      }

      const out = new Map<string, Enrichment>();
      for (const [trace, a] of acc) {
        const inputSide = a.fresh + a.cacheRead + a.cacheWrite;
        const tokens = inputSide + a.output;
        const cost =
          a.fresh * PRICE_PER_TOKEN.freshInput +
          a.cacheRead * PRICE_PER_TOKEN.cacheRead +
          a.cacheWrite * PRICE_PER_TOKEN.cacheWrite +
          a.output * PRICE_PER_TOKEN.output;
        out.set(trace, {
          tokens,
          cache: inputSide > 0 ? Math.round((a.cacheRead / inputSide) * 100) : null,
          cost: Math.round(cost * 10000) / 10000,
          tier: a.tier,
          tool: a.tool,
        });
      }
      return out;
    },
  };
}

// --- compose ----------------------------------------------------------------

export async function getLogs(
  db: Queryable,
  enricher: TurnEnricher | undefined,
  options: { limit?: number } = {},
): Promise<LogsResponse> {
  const limit = Math.min(Math.max(1, options.limit ?? 60), 200);
  const result = await db.query(LIST_SQL, [TURN_WORKFLOW, limit]);
  const rows = result.rows.map((r) => journalRowSchema.parse(r));

  let enrichment: Map<string, Enrichment> = new Map();
  let enriched = false;
  if (enricher !== undefined) {
    try {
      enrichment = await enricher.byTrace();
      enriched = true;
    } catch {
      enriched = false; // degrade: turns still list, enrichment columns show —
    }
  }

  const turns: TurnRow[] = rows.map((r) => {
    const { level, st } = mapStatus(r.status, r.recovery_attempts);
    const e = enrichment.get(r.id);
    const ms = r.finished_at !== null ? Math.max(0, r.finished_at - r.created_at) : null;
    return {
      id: r.id,
      ts: new Date(r.created_at).toISOString(),
      level,
      st,
      ms,
      tool: e?.tool ?? null,
      tier: e?.tier ?? null,
      tokens: e?.tokens ?? null,
      cache: e?.cache ?? null,
      cost: e?.cost ?? null,
    };
  });

  return { turns, enriched };
}
