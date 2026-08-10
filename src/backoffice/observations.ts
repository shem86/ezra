// The ONE Langfuse read the console makes. Both data screens (Costs, Logs) are
// derived from this single fetch — same records, different aggregation.
//
// Why v2 and why `fields`: the legacy `/api/public/observations` endpoint is
// deprecated on Langfuse Cloud and now answers an unfiltered page with a
// server-side timeout ("Request timed out", HTTP 422) after ~30s — measured in
// production, where it failed on EVERY Logs load, so enrichment never once
// succeeded. `/api/public/v2/observations` returns the same window in ~1s. The
// `fields` parameter is NOT optional for us: without it the v2 list omits
// `usageDetails` and `metadata` entirely (all we would get is null prices), and
// those two carry every enrichment column the console shows.
//
// Costs also used to read `/api/public/metrics/daily`. That endpoint is capped
// at 10 requests per DAY on this plan (x-ratelimit-limit: 10, ~24h reset), so a
// 5-minute cache burned the whole quota within the hour and the Costs screen
// then 503'd until the next day. The per-day series is aggregated from these
// records instead — same underlying data, no quota.

import { z } from 'zod';

const usageSchema = z
  .object({
    input: z.number().optional(),
    output: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
  })
  .nullish();

const recordSchema = z.object({
  traceId: z.string().nullish(),
  type: z.string().nullish(),
  startTime: z.string().nullish(),
  usageDetails: usageSchema,
  metadata: z.record(z.string(), z.unknown()).nullish(),
});

const pageSchema = z.object({
  data: z.array(recordSchema),
  meta: z.object({ cursor: z.string().nullish() }).nullish(),
});

export interface ObservationUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** One normalised observation. `usage` is present on generations; `tier`/`tool`
 *  ride on the tool spans — a single turn contributes both. */
export interface Observation {
  readonly traceId: string | null;
  readonly startTime: string | null;
  readonly usage: ObservationUsage | null;
  readonly tier: string | null;
  readonly tool: string | null;
}

export interface ObservationsSource {
  recent(): Promise<Observation[]>;
}

export interface ObservationsDeps {
  readonly baseUrl: string;
  readonly publicKey: string;
  readonly secretKey: string;
  readonly fetchFn?: typeof fetch;
  readonly now?: () => number;
  /** How far back to read. Must cover the previous calendar month (Costs shows
   *  last-month spend) plus the Logs turn window. */
  readonly lookbackDays?: number;
  readonly pageLimit?: number;
  readonly maxPages?: number;
  readonly timeoutMs?: number;
  readonly ttlMs?: number;
  readonly failureTtlMs?: number;
  readonly logger?: ((msg: string) => void) | undefined;
}

const DEFAULT_LOOKBACK_DAYS = 90;
const DEFAULT_PAGE_LIMIT = 1000; // v2 allows 1000/page (legacy capped at 100)
const DEFAULT_MAX_PAGES = 5;
// v2 answers in ~1s. The old 30s ceiling only ever bought a longer hang: the
// upstream had already given up server-side by then.
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_TTL_MS = 5 * 60_000;
// A failure is cached too, briefly — otherwise a broken upstream costs every
// single request a full timeout, which is exactly how Logs came to block 30s
// on every load.
const DEFAULT_FAILURE_TTL_MS = 30_000;

function toUsage(raw: z.infer<typeof usageSchema>): ObservationUsage | null {
  if (raw === null || raw === undefined) return null;
  const usage = {
    input: raw.input ?? 0,
    output: raw.output ?? 0,
    cacheRead: raw.cache_read_input_tokens ?? 0,
    cacheWrite: raw.cache_creation_input_tokens ?? 0,
  };
  const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return total > 0 ? usage : null;
}

function readString(meta: Record<string, unknown> | null | undefined, key: string): string | null {
  const v = meta?.[key];
  return typeof v === 'string' ? v : null;
}

export function makeObservationsSource(deps: ObservationsDeps): ObservationsSource {
  const fetchFn = deps.fetchFn ?? fetch;
  const now = deps.now ?? Date.now;
  const auth = 'Basic ' + Buffer.from(`${deps.publicKey}:${deps.secretKey}`).toString('base64');
  const base = deps.baseUrl.replace(/\/$/, '');
  const lookbackDays = deps.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const pageLimit = deps.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const maxPages = deps.maxPages ?? DEFAULT_MAX_PAGES;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  const failureTtlMs = deps.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS;

  let ok: { at: number; value: Observation[] } | undefined;
  let failed: { at: number; error: Error } | undefined;
  let inFlight: Promise<Observation[]> | undefined;

  async function fetchPage(cursor: string | undefined): Promise<z.infer<typeof pageSchema>> {
    const from = new Date(now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();
    const params = new URLSearchParams({
      limit: String(pageLimit),
      fields: 'core,basic,usage,metadata',
      fromStartTime: from,
    });
    if (cursor !== undefined) params.set('cursor', cursor);
    const res = await fetchFn(`${base}/api/public/v2/observations?${params.toString()}`, {
      headers: { authorization: auth, accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`langfuse v2 observations: HTTP ${res.status}`);
    return pageSchema.parse(await res.json());
  }

  async function loadAll(): Promise<Observation[]> {
    const out: Observation[] = [];
    let cursor: string | undefined;
    for (let pageNo = 0; pageNo < maxPages; pageNo++) {
      const parsed = await fetchPage(cursor);
      for (const r of parsed.data) {
        out.push({
          traceId: r.traceId ?? null,
          startTime: r.startTime ?? null,
          usage: toUsage(r.usageDetails),
          tier: readString(r.metadata, 'riskTier'),
          tool: readString(r.metadata, 'tool'),
        });
      }
      const next = parsed.meta?.cursor;
      if (next === null || next === undefined || next === '') return out;
      cursor = next;
    }
    // Never let a bound go unreported — a silently truncated window reads as
    // "that's all the data" on a screen whose whole job is telling the truth.
    deps.logger?.(
      `backoffice: observation window truncated at ${maxPages} pages (${out.length} records) — older turns will show —`,
    );
    return out;
  }

  return {
    async recent(): Promise<Observation[]> {
      const t = now();
      if (ok !== undefined && t - ok.at < ttlMs) return ok.value;
      if (failed !== undefined && t - failed.at < failureTtlMs) throw failed.error;
      // Collapse concurrent callers onto one upstream fetch: Costs and Logs
      // both land here, and the SPA fires them together.
      if (inFlight !== undefined) return inFlight;

      inFlight = loadAll()
        .then((value) => {
          ok = { at: now(), value };
          failed = undefined;
          return value;
        })
        .catch((err: unknown) => {
          const error = err instanceof Error ? err : new Error(String(err));
          failed = { at: now(), error };
          throw error;
        })
        .finally(() => {
          inFlight = undefined;
        });
      return inFlight;
    },
  };
}
