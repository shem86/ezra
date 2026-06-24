// BO-8 spike: de-risk the Langfuse READ API before building Costs (BO-9) and
// Logs enrichment (BO-10). Langfuse has been a trace *sink* (src/ops/langfuse-sink.ts);
// here it becomes a *source*. We hit the public read endpoints with the SAME
// keys (HTTP Basic: public:secret) and print the real shapes.
//
// Endpoints probed (per spec Q1 resolution):
//   GET /api/public/metrics/daily          → date · totalCost · per-model usage/cost
//   GET /api/public/v2/metrics             → custom aggregation (cost by model)
//   GET /api/public/observations           → per-observation usageDetails (cache split?)
//
// Run: node --env-file=.env spikes/langfuse-read.ts   (NOT CI). Findings noted
// in a comment at the bottom after the first real run.

const baseUrl = (process.env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com').replace(/\/$/, '');
const publicKey = process.env.LANGFUSE_PUBLIC_KEY ?? '';
const secretKey = process.env.LANGFUSE_SECRET_KEY ?? '';

if (!publicKey || !secretKey) {
  console.error('missing LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY');
  process.exit(1);
}

const auth = 'Basic ' + Buffer.from(`${publicKey}:${secretKey}`).toString('base64');

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: auth, accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = await res.text();
  }
  return { status: res.status, body };
}

function show(label: string, result: { status: number; body: unknown }): void {
  console.log(`\n===== ${label} → HTTP ${result.status} =====`);
  const json = JSON.stringify(result.body, null, 2);
  console.log(json.length > 4000 ? json.slice(0, 4000) + '\n…(truncated)' : json);
}

async function main(): Promise<void> {
  const today = new Date();
  const from = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const to = today.toISOString();

  show(
    `metrics/daily (full ISO)`,
    await get(`/api/public/metrics/daily?fromTimestamp=${encodeURIComponent(from)}&toTimestamp=${encodeURIComponent(to)}`),
  );

  // Does ANY generation carry a resolved model + non-zero cost? (the spike's
  // first row had model:null, cost:0 — find out if that's universal).
  const obs = (await get('/api/public/observations?type=GENERATION&limit=50')).body as {
    data?: { model: string | null; calculatedTotalCost: number | null; usageDetails?: Record<string, number> }[];
  };
  const gens = obs.data ?? [];
  const withModel = gens.filter((g) => g.model !== null).length;
  const withCost = gens.filter((g) => (g.calculatedTotalCost ?? 0) > 0).length;
  const withCacheSplit = gens.filter((g) => g.usageDetails?.['cache_read_input_tokens'] !== undefined).length;
  console.log(
    `\n===== GENERATION scan (n=${gens.length}) =====\n` +
      `  with model set: ${withModel}\n  with cost>0: ${withCost}\n  with cache_read split: ${withCacheSplit}`,
  );

  // v2/metrics: cost grouped by model (the "cost by model" table).
  const query = encodeURIComponent(
    JSON.stringify({
      view: 'observations',
      metrics: [{ measure: 'totalCost', aggregation: 'sum' }],
      dimensions: [{ field: 'providedModelName' }],
      fromTimestamp: `${from}T00:00:00Z`,
      toTimestamp: `${to}T23:59:59Z`,
    }),
  );
  show('v2/metrics (cost by providedModelName)', await get(`/api/public/v2/metrics?query=${query}`));

  // observations: does usageDetails carry the cache-read split?
  show('observations?limit=3', await get('/api/public/observations?limit=3'));

  // traces: the per-turn list anchor (id ↔ workflowID linkage probe).
  show('traces?limit=3', await get('/api/public/traces?limit=3'));
}

main().catch((err: unknown) => {
  console.error('spike failed:', err);
  process.exit(1);
});

// ───────────────────────── FINDINGS (2026-06-24, BO-8) ─────────────────────
// metrics/daily REQUIRES full ISO datetimes (YYYY-MM-DDTHH:MM:SSZ); date-only
// → HTTP 400. Shape: data[]{ date, countTraces, countObservations, totalCost,
// usage[]{ model, inputUsage, outputUsage, totalUsage, totalCost } }.
//
// CRITICAL: Langfuse has NO cost and NO model name for this project —
// totalCost is 0 and usage[].model is null on EVERY day; on observations
// model:null, calculatedTotalCost:0, costDetails:{}. The trace sink
// (src/ops/langfuse-sink.ts) records token usage but not the model id or
// pricing, so Langfuse can't compute cost. => Costs screen must ESTIMATE USD
// from token counts × a local price table (Sonnet-class, conservative), and
// per-MODEL attribution is unavailable (degrade the "by model" table to "by
// usage type"). This is the spec's allowed graceful-degradation path (Q1).
//
// GOOD NEWS: token volume IS accurate (daily input/output/total), and the
// cache-read split IS present on 50/50 generations:
//   observations.data[].usageDetails = { input, output, total,
//     cache_read_input_tokens, cache_creation_input_tokens }
// so the token-economics donut + cache-read% are REAL, not degraded.
//
// LOGS linkage (BO-10): observation.traceId === `turn-${WORKFLOWID}` (e.g.
// turn-AC2E22CB49C91EA6F3E96F7FC4843102). Enrich the DBOS workflow_status turn
// list by querying observations per trace id = `turn-${id}` and summing
// usageDetails; cost is an estimate (same table), tier from span metadata
// (runTool.metadata.riskTier seen in the spike).
