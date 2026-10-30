// Router panel (docs/specs/jev-turn-routing-plan.md §5b): router health is
// PULLED here, never paged — a dead router degrades turns to standard, today's
// behavior, so it is a degraded optimization and Telegram stays up/down-only.
// Evidence is our own Postgres (turn_route_log), never Langfuse. SELECT-only,
// like every backoffice read; rows are Zod-parsed at the boundary.
//
// One bounded read (7 days of route rows — household volume is a few hundred)
// plus a turn count from the DBOS journal; every window below is derived in
// TypeScript so each amber rule is unit-testable without a database.

import { z } from 'zod';
import type { Queryable } from './queries.js';

/** Starting thresholds (plan §5b) — tuned during the shadow phase. */
const WINDOW = 20;
const FALLBACK_RATE_MAX = 0.2;
const FALLBACK_STREAK_MAX = 3;
const P95_MAX_MS = 1_000;
const DEEP_SHARE_MAX = 0.4;
const UNSETTLED_SHARE_MAX = 0.5;
const YES = 0.7;
const NO = 0.3;
const RECENT = 15;
const DAY_MS = 24 * 60 * 60 * 1_000;

const answersSchema = z.looseObject({
  asksAnything: z.number(),
  intent: z.string(),
  severalRequests: z.number(),
  refersBack: z.number(),
  weighsOptions: z.number(),
  scheduleReasoning: z.number(),
  correctsPrevious: z.number(),
});

const rowSchema = z.object({
  workflow_id: z.string(),
  conversation_id: z.string(),
  created_at: z.string(),
  mode: z.string(),
  tier: z.string(),
  proposed: z.string(),
  source: z.string(),
  latency_ms: z.number().nullable(),
  answers: answersSchema.nullable(),
  latest_text: z.string().nullable(),
});

export interface RouteLogRow {
  readonly workflowId: string;
  readonly conversationId: string;
  /** ISO timestamp. */
  readonly createdAt: string;
  readonly mode: string;
  readonly tier: string;
  readonly proposed: string;
  readonly source: string;
  readonly latencyMs: number | null;
  readonly answers: z.infer<typeof answersSchema> | null;
  /** First latest message's text — the turn view's one-line identity. */
  readonly latestText: string | null;
}

export interface RouterHealthInput {
  readonly now: Date;
  /** handleTurn workflows started in the last 24h (DBOS journal). */
  readonly turns24h: number;
  /** turn_route_log rows from the last 7 days, any order. */
  readonly rows: readonly RouteLogRow[];
}

export interface RouterHealthRow {
  readonly name: string;
  readonly value: string;
  readonly status: 'ok' | 'amber';
  readonly detail: string;
}

export interface RouterHealth {
  /** Mode of the newest row; null when the router has never logged a turn. */
  readonly mode: string | null;
  readonly rows: RouterHealthRow[];
  readonly recent: RouteLogRow[];
}

const isFallback = (r: RouteLogRow): boolean => r.source.startsWith('fallback-error:');
const isPreRule = (r: RouteLogRow): boolean => r.source.startsWith('pre-rule:');
const pct = (n: number, d: number): string => (d === 0 ? '—' : `${Math.round((100 * n) / d)}%`);

export function deriveRouterHealth(input: RouterHealthInput): RouterHealth {
  const newestFirst = [...input.rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const dayAgo = input.now.getTime() - DAY_MS;
  const day = newestFirst.filter((r) => Date.parse(r.createdAt) >= dayAgo);
  const routed = newestFirst.filter((r) => !isPreRule(r)).slice(0, WINDOW);

  const rows: RouterHealthRow[] = [];

  // Last routed turn — the "router silent" signal: wiring broke, or the mode
  // was silently left off, while the household kept talking.
  const last = newestFirst[0];
  const silent = input.turns24h > 0 && day.length === 0;
  rows.push({
    name: 'Last routed turn',
    value: last === undefined ? 'never' : last.createdAt,
    status: silent ? 'amber' : 'ok',
    detail: silent
      ? `${input.turns24h} turn(s) in 24h but no route rows — is TURN_ROUTING off?`
      : `${day.length} routed of ${input.turns24h} turn(s) in 24h`,
  });

  // Fallback rate + streak over the last WINDOW turns that asked Jev.
  let streak = 0;
  for (const r of routed) {
    if (!isFallback(r)) break;
    streak++;
  }
  const fallbacks = routed.filter(isFallback).length;
  const fallbackAmber = streak >= FALLBACK_STREAK_MAX || (routed.length > 0 && fallbacks / routed.length > FALLBACK_RATE_MAX);
  rows.push({
    name: 'Fallback rate',
    value: `${pct(fallbacks, routed.length)} of last ${routed.length}${streak > 0 ? ` · ${streak} in a row` : ''}`,
    status: fallbackAmber ? 'amber' : 'ok',
    detail: fallbacks > 0 ? `latest: ${routed.find(isFallback)!.source}` : 'every routed turn answered by Jev',
  });

  // Jev latency p95 over the last WINDOW answered turns.
  const lat = routed
    .filter((r) => r.source === 'jev' && r.latencyMs !== null)
    .map((r) => r.latencyMs!)
    .sort((a, b) => a - b);
  const p95 = lat.length === 0 ? null : lat[Math.min(lat.length - 1, Math.floor(0.95 * lat.length))]!;
  rows.push({
    name: 'Jev latency p95',
    value: p95 === null ? '—' : `${p95}ms`,
    status: p95 !== null && p95 > P95_MAX_MS ? 'amber' : 'ok',
    detail: `over the last ${lat.length} answered turn(s); the deadline is 1.5s`,
  });

  // Tier mix (24h): proposals, not effective tiers — in shadow every turn
  // runs standard, and the proposal is what is being evaluated.
  const answered = day.filter((r) => r.source === 'jev');
  const deep = answered.filter((r) => r.proposed === 'deep').length;
  const fast = answered.filter((r) => r.proposed === 'fast').length;
  const unsettled = answered.filter((r) => {
    const a = r.answers;
    if (a === null) return false;
    return [a.severalRequests, a.refersBack, a.weighsOptions, a.scheduleReasoning, a.asksAnything].some(
      (p) => p >= NO && p <= YES,
    );
  }).length;
  const mixAmber =
    answered.length > 0 &&
    (deep / answered.length > DEEP_SHARE_MAX || unsettled / answered.length > UNSETTLED_SHARE_MAX);
  rows.push({
    name: 'Tier mix (24h)',
    value: `deep ${pct(deep, answered.length)} · fast ${pct(fast, answered.length)} · unsettled ${pct(unsettled, answered.length)}`,
    status: mixAmber ? 'amber' : 'ok',
    detail: `proposed tiers over ${answered.length} answered turn(s)`,
  });

  // Corrections per tier (7d): a turn whose message corrects the assistant is
  // charged to the tier that produced the PREVIOUS reply in that conversation.
  const byConversation = new Map<string, RouteLogRow[]>();
  for (const r of [...newestFirst].reverse()) {
    const list = byConversation.get(r.conversationId) ?? [];
    list.push(r);
    byConversation.set(r.conversationId, list);
  }
  const turnsByTier = new Map<string, number>();
  const correctionsByTier = new Map<string, number>();
  for (const list of byConversation.values()) {
    list.forEach((r, i) => {
      turnsByTier.set(r.tier, (turnsByTier.get(r.tier) ?? 0) + 1);
      const prev = list[i - 1];
      if (prev !== undefined && (r.answers?.correctsPrevious ?? 0) > YES) {
        correctionsByTier.set(prev.tier, (correctionsByTier.get(prev.tier) ?? 0) + 1);
      }
    });
  }
  const rate = (tier: string): number =>
    (correctionsByTier.get(tier) ?? 0) / Math.max(1, turnsByTier.get(tier) ?? 0);
  const tiers = ['fast', 'standard', 'deep'].filter((t) => (turnsByTier.get(t) ?? 0) > 0);
  const worse = tiers.filter((t) => t !== 'standard' && rate(t) > rate('standard'));
  rows.push({
    name: 'Corrections per tier (7d)',
    value:
      tiers.length === 0
        ? '—'
        : tiers.map((t) => `${t} ${correctionsByTier.get(t) ?? 0}/${turnsByTier.get(t)}`).join(' · '),
    status: worse.length > 0 ? 'amber' : 'ok',
    detail:
      worse.length > 0
        ? `${worse.join(', ')} corrected more often than standard — check those turns`
        : 'replies the household corrected, by the tier that wrote them',
  });

  return { mode: last?.mode ?? null, rows, recent: newestFirst.slice(0, RECENT) };
}

/** The panel's reads: 7 days of route rows + today's turn count. SELECT-only. */
export async function getRouterHealth(db: Queryable, now: Date = new Date()): Promise<RouterHealth> {
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const res = await db.query(
    `SELECT workflow_id, conversation_id, created_at::text AS created_at, mode, tier, proposed,
            source, latency_ms, answers, request->'state'->'latest_messages'->0->>'text' AS latest_text
       FROM turn_route_log
      WHERE created_at >= $1::timestamptz
      ORDER BY created_at DESC
      LIMIT 2000`,
    [weekAgo],
  );
  const turns = await db.query(
    `SELECT count(*)::int AS n FROM dbos.workflow_status
      WHERE name = 'handleTurn' AND created_at >= $1`,
    [now.getTime() - DAY_MS],
  );
  const rows = res.rows.map((raw) => {
    const r = rowSchema.parse(raw);
    return {
      workflowId: r.workflow_id,
      conversationId: r.conversation_id,
      // Postgres text timestamps → ISO, so string order is time order.
      createdAt: new Date(r.created_at).toISOString(),
      mode: r.mode,
      tier: r.tier,
      proposed: r.proposed,
      source: r.source,
      latencyMs: r.latency_ms,
      answers: r.answers,
      latestText: r.latest_text,
    };
  });
  const turns24h = z.object({ n: z.number() }).parse(turns.rows[0]).n;
  return deriveRouterHealth({ now, turns24h, rows });
}
