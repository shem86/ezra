// Costs data — derived from the shared Langfuse v2 observation read
// (observations.ts), which is also what the Logs screen enriches from. The BO-8
// spike proved Langfuse has accurate token volume and the cache-read split, but
// NO cost and NO model name; re-verified against production on 2026-08-10 —
// v2's `totalCost`/`costDetails`/`modelId` come back 0/empty/null for this
// project. So USD stays ESTIMATED here from token counts × a Sonnet-class price
// table (conservative — Haiku is cheaper but indistinguishable), and per-model
// attribution degrades to per-usage-type. `estimated: true` rides on the
// response so the UI can label it honestly.
//
// This used to read `/api/public/metrics/daily` for the per-day series. That
// endpoint allows 10 requests per DAY on this plan, which a 5-minute cache
// exhausts in under an hour — after which the screen 503'd for the rest of the
// day. The daily series is now folded from the observation records themselves,
// which also gives a REAL per-day cache split instead of applying one sampled
// ratio to every day.

import type { ObservationsSource, ObservationUsage } from './observations.js';

// Anthropic Sonnet-class prices, USD per token (the spend backstop is
// provider-side, V2 §12 — this is a display estimate, not billing).
export const PRICE_PER_TOKEN = {
  freshInput: 3 / 1_000_000,
  output: 15 / 1_000_000,
  cacheRead: 0.3 / 1_000_000,
  cacheWrite: 3.75 / 1_000_000,
} as const;

export interface CostDeps {
  /** The shared Langfuse v2 read — cached and de-duplicated there. */
  readonly observations: ObservationsSource;
  readonly budgetUsd: number;
  /** Injectable clock (month boundaries); defaults to Date.now. */
  readonly now?: () => number;
}

export interface TokenSplitSlice {
  readonly label: string;
  readonly pct: number;
  readonly color: string;
}
export interface UsageTypeRow {
  readonly name: string;
  readonly note: string;
  readonly tokens: number;
  readonly cost: number;
  readonly share: number;
}
export interface CostsResponse {
  readonly estimated: true;
  readonly budgetUsd: number;
  readonly monthCostUsd: number;
  readonly lastMonthCostUsd: number;
  readonly tokensMonth: number;
  readonly cacheReadPct: number;
  readonly dailyCost: number[];
  readonly tokenSplit: TokenSplitSlice[];
  readonly byUsage: UsageTypeRow[];
}

/** Token counts split by how they are billed. */
interface Split {
  fresh: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface CostClient {
  getCosts(): Promise<CostsResponse>;
}

function emptySplit(): Split {
  return { fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
}

/** Fold one observation's usage in. `input` is the FRESH (uncached) side —
 *  Langfuse reports cache reads/writes as separate counters, not inside it. */
function add(into: Split, u: ObservationUsage): void {
  into.fresh += u.input;
  into.cacheRead += u.cacheRead;
  into.cacheWrite += u.cacheWrite;
  into.output += u.output;
}

function merge(into: Split, s: Split): void {
  into.fresh += s.fresh;
  into.cacheRead += s.cacheRead;
  into.cacheWrite += s.cacheWrite;
  into.output += s.output;
}

function costOf(s: Split): number {
  return (
    s.fresh * PRICE_PER_TOKEN.freshInput +
    s.cacheRead * PRICE_PER_TOKEN.cacheRead +
    s.cacheWrite * PRICE_PER_TOKEN.cacheWrite +
    s.output * PRICE_PER_TOKEN.output
  );
}

function tokensOf(s: Split): number {
  return s.fresh + s.cacheRead + s.cacheWrite + s.output;
}

export function makeCostClient(deps: CostDeps): CostClient {
  const now = deps.now ?? Date.now;

  return {
    async getCosts(): Promise<CostsResponse> {
      const records = await deps.observations.recent();
      const nowDate = new Date(now());
      const monthStart = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), 1));
      const prevMonthStart = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() - 1, 1));

      // Fold every observation into its UTC day. Records without usage (tool
      // spans) carry no tokens and simply contribute nothing here.
      const byDay = new Map<string, Split>();
      const window = emptySplit();
      for (const r of records) {
        if (r.usage === null || r.startTime === null) continue;
        const day = r.startTime.slice(0, 10);
        const bucket = byDay.get(day) ?? emptySplit();
        add(bucket, r.usage);
        byDay.set(day, bucket);
        add(window, r.usage);
      }

      const inRange = (day: string, from: Date, to?: Date): boolean => {
        const t = new Date(day + 'T00:00:00Z');
        return t >= from && (to === undefined || t < to);
      };
      const month = emptySplit();
      const prev = emptySplit();
      for (const [day, s] of byDay) {
        if (inRange(day, monthStart)) merge(month, s);
        else if (inRange(day, prevMonthStart, monthStart)) merge(prev, s);
      }

      const monthCostUsd = costOf(month);
      const lastMonthCostUsd = costOf(prev);
      const tokensMonth = tokensOf(month);

      // last-30-days estimated daily cost array (oldest→newest), 0-filled.
      const dailyCost: number[] = [];
      for (let i = 29; i >= 0; i--) {
        const d = new Date(nowDate.getTime() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const day = byDay.get(d);
        dailyCost.push(day === undefined ? 0 : Math.round(costOf(day) * 10000) / 10000);
      }

      // Economics panels describe the CURRENT month; before the month has any
      // traffic that would be an all-zero donut, so fall back to the whole
      // read window rather than render nothing.
      const split = tokensOf(month) > 0 ? month : window;
      const inputSide = split.fresh + split.cacheRead + split.cacheWrite;
      const totalTokens = tokensOf(split) || 1;
      const cacheReadPct = inputSide > 0 ? Math.round((split.cacheRead / inputSide) * 100) : 0;

      const tokenSplit: TokenSplitSlice[] = [
        { label: 'Cache read', pct: split.cacheRead / totalTokens, color: 'var(--ok)' },
        { label: 'Fresh input', pct: split.fresh / totalTokens, color: 'var(--accent)' },
        { label: 'Cache write', pct: split.cacheWrite / totalTokens, color: 'var(--amber)' },
        { label: 'Output', pct: split.output / totalTokens, color: 'var(--muted-2)' },
      ];

      const byUsage: UsageTypeRow[] = [
        { name: 'Cache read', note: '$0.30 / 1M', tokens: split.cacheRead, cost: split.cacheRead * PRICE_PER_TOKEN.cacheRead },
        { name: 'Fresh input', note: '$3.00 / 1M', tokens: split.fresh, cost: split.fresh * PRICE_PER_TOKEN.freshInput },
        { name: 'Cache write', note: '$3.75 / 1M', tokens: split.cacheWrite, cost: split.cacheWrite * PRICE_PER_TOKEN.cacheWrite },
        { name: 'Output', note: '$15.00 / 1M', tokens: split.output, cost: split.output * PRICE_PER_TOKEN.output },
      ].map((r, _i, arr) => {
        const totalCost = arr.reduce((a, x) => a + x.cost, 0) || 1;
        return { ...r, share: r.cost / totalCost };
      });

      return {
        estimated: true,
        budgetUsd: deps.budgetUsd,
        monthCostUsd: Math.round(monthCostUsd * 100) / 100,
        lastMonthCostUsd: Math.round(lastMonthCostUsd * 100) / 100,
        tokensMonth,
        cacheReadPct,
        dailyCost,
        tokenSplit,
        byUsage,
      };
    },
  };
}
