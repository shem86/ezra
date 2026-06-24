// Logs — the durable turn list from the DBOS journal (dbos.workflow_status),
// enriched per-turn from the Langfuse observations read API. The journal is the
// source of truth for WHAT ran (id, status, timing, recovery); Langfuse adds
// tokens/cache/cost/tier where a trace exists. Anything Langfuse lacks renders
// `—` (BO-8: cost is estimated, model absent). workflow_uuid === Langfuse
// traceId (both `turn-…`), which is the join key.
//
// The journal query is SELECT-only against the dbos schema (the SELECT-only
// role is granted USAGE+SELECT there, BO-17). Enrichment is a single, cached
// Langfuse fetch grouped by trace — never one call per turn.

import { z } from 'zod';
import { PRICE_PER_TOKEN } from './cost.js';
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

const observationsSchema = z.object({
  data: z.array(
    z.object({
      traceId: z.string().nullable(),
      type: z.string(),
      usageDetails: z
        .object({
          input: z.number().optional(),
          output: z.number().optional(),
          cache_read_input_tokens: z.number().optional(),
          cache_creation_input_tokens: z.number().optional(),
        })
        .optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});

export interface EnricherDeps {
  readonly baseUrl: string;
  readonly publicKey: string;
  readonly secretKey: string;
  readonly fetchFn?: typeof fetch;
  readonly now?: () => number;
  /** How many recent observations to scan (covers the turn-list window). */
  readonly sampleSize?: number;
}

const ENRICH_TTL_MS = 5 * 60_000;

export function makeTurnEnricher(deps: EnricherDeps): TurnEnricher {
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? Date.now;
  const auth = 'Basic ' + Buffer.from(`${deps.publicKey}:${deps.secretKey}`).toString('base64');
  const base = deps.baseUrl.replace(/\/$/, '');
  // Langfuse caps the observations page at 100; ask for the max.
  const sample = deps.sampleSize ?? 100;
  let cache: { at: number; value: Map<string, Enrichment> } | undefined;

  return {
    async byTrace(): Promise<Map<string, Enrichment>> {
      if (cache !== undefined && now() - cache.at < ENRICH_TTL_MS) return cache.value;
      const res = await fetchFn(`${base}/api/public/observations?limit=${sample}`, {
        headers: { authorization: auth, accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`langfuse observations: HTTP ${res.status}`);
      const parsed = observationsSchema.parse(await res.json());

      interface Acc {
        fresh: number;
        cacheRead: number;
        cacheWrite: number;
        output: number;
        tier: string | null;
        tool: string | null;
      }
      const acc = new Map<string, Acc>();
      for (const o of parsed.data) {
        if (o.traceId === null) continue;
        const a = acc.get(o.traceId) ?? { fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0, tier: null, tool: null };
        const u = o.usageDetails;
        if (u !== undefined) {
          a.fresh += u.input ?? 0;
          a.cacheRead += u.cache_read_input_tokens ?? 0;
          a.cacheWrite += u.cache_creation_input_tokens ?? 0;
          a.output += u.output ?? 0;
        }
        const meta = o.metadata ?? {};
        if (a.tier === null && typeof meta['riskTier'] === 'string') a.tier = meta['riskTier'];
        if (a.tool === null && typeof meta['tool'] === 'string') a.tool = meta['tool'];
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
      cache = { at: now(), value: out };
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
