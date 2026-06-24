// Costs data — a zero-dep Langfuse READ client (mirrors the langfuse-*sink*
// precedent, now a *source*; ADR-0002 zero-dep ethos). The BO-8 spike proved
// Langfuse has accurate token volume and the cache-read split, but NO cost and
// NO model name. So USD is ESTIMATED here from token counts × a Sonnet-class
// price table (conservative — Haiku is cheaper but indistinguishable), and
// per-model attribution degrades to per-usage-type. `estimated: true` rides on
// the response so the UI can label it honestly.

import { z } from 'zod';

// Anthropic Sonnet-class prices, USD per token (the spend backstop is
// provider-side, V2 §12 — this is a display estimate, not billing).
export const PRICE_PER_TOKEN = {
  freshInput: 3 / 1_000_000,
  output: 15 / 1_000_000,
  cacheRead: 0.3 / 1_000_000,
  cacheWrite: 3.75 / 1_000_000,
} as const;

export interface CostDeps {
  readonly baseUrl: string;
  readonly publicKey: string;
  readonly secretKey: string;
  readonly budgetUsd: number;
  readonly fetchFn?: typeof fetch;
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

const dailySchema = z.object({
  data: z.array(
    z.object({
      date: z.string(),
      usage: z
        .array(
          z.object({
            inputUsage: z.number().default(0),
            outputUsage: z.number().default(0),
            totalUsage: z.number().default(0),
          }),
        )
        .default([]),
    }),
  ),
});

const observationsSchema = z.object({
  data: z.array(
    z.object({
      usageDetails: z
        .object({
          input: z.number().optional(),
          output: z.number().optional(),
          cache_read_input_tokens: z.number().optional(),
          cache_creation_input_tokens: z.number().optional(),
        })
        .optional(),
    }),
  ),
});

interface DayUsage {
  date: string;
  input: number; // input-side total INCLUDING cache reads/writes (daily can't split)
  output: number;
  total: number;
}
interface InputSplit {
  fresh: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface CostClient {
  getCosts(): Promise<CostsResponse>;
}

// The Langfuse read API is slow (multi-second over the US region); the Costs
// data barely moves minute to minute, so memoize for this long. Keeps the
// screen snappy and avoids hammering Langfuse on every view/refresh.
const COST_TTL_MS = 5 * 60_000;

export function makeCostClient(deps: CostDeps): CostClient {
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? Date.now;
  const auth = 'Basic ' + Buffer.from(`${deps.publicKey}:${deps.secretKey}`).toString('base64');
  const base = deps.baseUrl.replace(/\/$/, '');
  let cache: { at: number; value: CostsResponse } | undefined;

  async function getJson(path: string): Promise<unknown> {
    const res = await fetchFn(`${base}${path}`, {
      headers: { authorization: auth, accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`langfuse read ${path}: HTTP ${res.status}`);
    }
    return res.json();
  }

  async function fetchDaily(from: Date, to: Date): Promise<DayUsage[]> {
    const q = `fromTimestamp=${encodeURIComponent(from.toISOString())}&toTimestamp=${encodeURIComponent(to.toISOString())}`;
    const parsed = dailySchema.parse(await getJson(`/api/public/metrics/daily?${q}`));
    return parsed.data.map((d) => {
      const input = d.usage.reduce((a, u) => a + u.inputUsage, 0);
      const output = d.usage.reduce((a, u) => a + u.outputUsage, 0);
      const total = d.usage.reduce((a, u) => a + u.totalUsage, 0);
      return { date: d.date, input, output, total: total || input + output };
    });
  }

  // Sample recent generations to learn the input-side cache split (daily can't
  // provide it). Fractions are applied to daily input tokens for cost + donut.
  async function fetchSplit(): Promise<InputSplit> {
    const parsed = observationsSchema.parse(
      await getJson('/api/public/observations?type=GENERATION&limit=50'),
    );
    const acc: InputSplit = { fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    for (const o of parsed.data) {
      const u = o.usageDetails;
      if (u === undefined) continue;
      acc.fresh += u.input ?? 0;
      acc.cacheRead += u.cache_read_input_tokens ?? 0;
      acc.cacheWrite += u.cache_creation_input_tokens ?? 0;
      acc.output += u.output ?? 0;
    }
    return acc;
  }

  function estimateDayCost(day: DayUsage, split: InputSplit): number {
    const inputSide = split.fresh + split.cacheRead + split.cacheWrite;
    // Fractions of the input-side tokens (fall back to all-fresh if no sample).
    const fFresh = inputSide > 0 ? split.fresh / inputSide : 1;
    const fRead = inputSide > 0 ? split.cacheRead / inputSide : 0;
    const fWrite = inputSide > 0 ? split.cacheWrite / inputSide : 0;
    const inputCost =
      day.input *
      (fFresh * PRICE_PER_TOKEN.freshInput +
        fRead * PRICE_PER_TOKEN.cacheRead +
        fWrite * PRICE_PER_TOKEN.cacheWrite);
    return inputCost + day.output * PRICE_PER_TOKEN.output;
  }

  return {
    async getCosts(): Promise<CostsResponse> {
      if (cache !== undefined && now() - cache.at < COST_TTL_MS) return cache.value;
      const nowDate = new Date(now());
      const monthStart = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), 1));
      const prevMonthStart = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() - 1, 1));
      // Fetch from the start of last month so both calendar months are covered.
      const [daily, split] = await Promise.all([fetchDaily(prevMonthStart, nowDate), fetchSplit()]);

      const byDay = new Map(daily.map((d) => [d.date, d]));
      const inMonth = daily.filter((d) => new Date(d.date + 'T00:00:00Z') >= monthStart);
      const inPrev = daily.filter((d) => {
        const t = new Date(d.date + 'T00:00:00Z');
        return t >= prevMonthStart && t < monthStart;
      });

      const monthCostUsd = inMonth.reduce((a, d) => a + estimateDayCost(d, split), 0);
      const lastMonthCostUsd = inPrev.reduce((a, d) => a + estimateDayCost(d, split), 0);
      const tokensMonth = inMonth.reduce((a, d) => a + d.total, 0);

      // last-30-days estimated daily cost array (oldest→newest), 0-filled.
      const dailyCost: number[] = [];
      for (let i = 29; i >= 0; i--) {
        const d = new Date(nowDate.getTime() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const day = byDay.get(d);
        dailyCost.push(day ? Math.round(estimateDayCost(day, split) * 10000) / 10000 : 0);
      }

      const inputSide = split.fresh + split.cacheRead + split.cacheWrite;
      const totalTokens = inputSide + split.output || 1;
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

      const value: CostsResponse = {
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
      cache = { at: now(), value };
      return value;
    },
  };
}
