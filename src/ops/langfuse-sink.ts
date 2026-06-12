// Langfuse sink (T31): TraceSink → Langfuse batch ingestion API
// (POST /api/public/ingestion, Basic auth). Zero-dep fetch client per the
// ADR-0002 precedent — one endpoint, one wire shape, cheaper than a
// dependency review. Keys arrive from Config at the composing caller; this
// module never reads env. Never runs in CI: unit tests stub fetchFn, the
// real wire is exercised by spikes/langfuse-trace.ts.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { TraceSink, TraceSpan } from './tracing.js';

export interface LangfuseSinkOptions {
  /** From Config (src/ops/config.ts) — never read env here. */
  readonly publicKey: string;
  readonly secretKey: string;
  readonly baseUrl: string;
  /** Injectable for unit tests; defaults to global fetch. */
  readonly fetchFn?: typeof fetch;
  /** Buffer size that triggers a fire-and-forget auto-flush. */
  readonly flushAt?: number;
}

export interface LangfuseSink extends TraceSink {
  /** Send everything buffered; the composer calls this on shutdown. */
  flush(): Promise<void>;
}

const requestTimeoutMs = 10_000;
const defaultFlushAt = 20;

// 207 body: per-item results. Only the errors matter — a silent partial drop
// would defeat the T33 cost measurements that read these traces.
const ingestionResponseSchema = z.looseObject({
  errors: z.array(z.looseObject({ id: z.string(), message: z.string().optional() })).default([]),
});

interface IngestionEvent {
  readonly id: string;
  readonly timestamp: string;
  readonly type: 'trace-create' | 'span-create' | 'generation-create';
  readonly body: Record<string, unknown>;
}

// Spans without a workflowID (e.g. taps exercised outside DBOS) still group
// under one visible trace instead of being dropped.
const untracedId = 'untraced';

function toEvent(span: TraceSpan): IngestionEvent {
  const traceId = span.traceId ?? untracedId;
  const errorFields =
    span.error === undefined ? {} : { level: 'ERROR', statusMessage: span.error };

  if (span.name === 'callModel') {
    const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = span.attributes;
    return {
      id: randomUUID(),
      timestamp: span.endTime.toISOString(),
      type: 'generation-create',
      body: {
        id: randomUUID(),
        traceId,
        name: span.name,
        startTime: span.startTime.toISOString(),
        endTime: span.endTime.toISOString(),
        // Anthropic-convention usage keys — Langfuse surfaces cache reads in
        // the UI from these (the SPEC "cache reads visible" criterion).
        usageDetails: {
          ...(inputTokens === undefined ? {} : { input: inputTokens }),
          ...(outputTokens === undefined ? {} : { output: outputTokens }),
          ...(cacheReadTokens === undefined ? {} : { cache_read_input_tokens: cacheReadTokens }),
          ...(cacheWriteTokens === undefined
            ? {}
            : { cache_creation_input_tokens: cacheWriteTokens }),
        },
        ...errorFields,
      },
    };
  }

  return {
    id: randomUUID(),
    timestamp: span.endTime.toISOString(),
    type: 'span-create',
    body: {
      id: randomUUID(),
      traceId,
      name: span.name,
      startTime: span.startTime.toISOString(),
      endTime: span.endTime.toISOString(),
      metadata: span.attributes,
      ...errorFields,
    },
  };
}

export function makeLangfuseSink(options: LangfuseSinkOptions): LangfuseSink {
  const fetchFn = options.fetchFn ?? fetch;
  const flushAt = options.flushAt ?? defaultFlushAt;
  const auth = `Basic ${Buffer.from(`${options.publicKey}:${options.secretKey}`).toString('base64')}`;
  const url = `${options.baseUrl.replace(/\/$/, '')}/api/public/ingestion`;

  let buffer: IngestionEvent[] = [];
  const announcedTraces = new Set<string>();

  function enqueue(span: TraceSpan): void {
    const traceId = span.traceId ?? untracedId;
    if (!announcedTraces.has(traceId)) {
      announcedTraces.add(traceId);
      buffer.push({
        id: randomUUID(),
        timestamp: span.startTime.toISOString(),
        type: 'trace-create',
        body: { id: traceId, name: 'turn', timestamp: span.startTime.toISOString() },
      });
    }
    buffer.push(toEvent(span));
  }

  async function flush(): Promise<void> {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];

    const response = await fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify({ batch }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`langfuse ingestion: HTTP ${response.status} — ${body.slice(0, 200)}`);
    }

    const parsed = ingestionResponseSchema.parse(await response.json());
    if (parsed.errors.length > 0) {
      const first = parsed.errors[0]!;
      throw new Error(
        `langfuse ingestion: ${parsed.errors.length} event(s) rejected — first: ${first.id} ${first.message ?? ''}`,
      );
    }
  }

  return {
    emit(span) {
      enqueue(span);
      if (buffer.length >= flushAt) {
        // Fire-and-forget: emit must never block or fail the turn. Flush
        // failures surface on the next explicit flush() or here in the log.
        flush().catch((err: unknown) => {
          console.warn(`langfuse auto-flush failed: ${String(err)}`);
        });
      }
    },
    flush,
  };
}
