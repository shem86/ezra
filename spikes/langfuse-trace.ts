// Manual smoke for the Langfuse ingestion wire (T31) — the one place the
// real API is exercised; CI uses captured fake sinks. Run once per key/host
// change:
//   node --env-file=.env spikes/langfuse-trace.ts
// PASS criteria: flush succeeds (no rejected events) and the trace named
// `hh-spike-<timestamp>` appears in the Langfuse UI showing one generation
// (with usageDetails incl. cache_read_input_tokens) and one tool span.
// Cache-read tokens from REAL model calls are verified later through
// pnpm dev (T32/T33) — this spike proves the ingestion contract only.

import { makeLangfuseSink } from '../src/ops/langfuse-sink.ts';
import { makeTracer } from '../src/ops/tracing.ts';

const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
const secretKey = process.env.LANGFUSE_SECRET_KEY;
const baseUrl = process.env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com';
if (publicKey === undefined || publicKey === '' || secretKey === undefined || secretKey === '') {
  console.error('LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY missing — set them in .env first');
  process.exit(1);
}

const traceId = `hh-spike-${Date.now()}`;
const sink = makeLangfuseSink({ publicKey, secretKey, baseUrl });
const tracer = makeTracer({ sink, getTraceId: () => traceId });

console.log(`emitting spans under trace ${traceId} → ${baseUrl}`);

// A model round the way the routed onUsage tap reports one.
tracer.onModelUsage(
  { inputTokens: 1200, outputTokens: 60, cacheReadTokens: 1100, cacheWriteTokens: 0 },
  'cheap',
);

// A tool step the way traceStep reports one (traceRunTool needs a registry +
// db; the wire shape is identical).
const fakeTool = tracer.traceStep('runTool', async () => 'ok');
await fakeTool();

// An error span — should show level ERROR in the UI.
const failing = tracer.traceStep('embedSummary', async () => {
  throw new Error('spike: deliberate error span');
});
await failing().catch(() => undefined);

try {
  await sink.flush();
  console.log('PASS: flush accepted all events — now verify the trace renders in the UI:');
  console.log(`  trace ${traceId}: 1 generation (cache_read_input_tokens=1100), 1 span, 1 ERROR span`);
} catch (err) {
  console.error(`FAIL: ${String(err)}`);
  process.exit(1);
}
