// T31: Langfuse sink — wire contract against a stubbed fetch (zero-dep client
// per the ADR-0002 precedent; the real wire is exercised by
// spikes/langfuse-trace.ts, never CI).

import { describe, expect, it } from 'vitest';
import { makeLangfuseSink } from '../../src/ops/langfuse-sink.js';
import type { TraceSpan } from '../../src/ops/tracing.js';

interface CapturedRequest {
  readonly url: string;
  readonly init: RequestInit;
  readonly body: { batch: Array<{ id: string; timestamp: string; type: string; body: Record<string, unknown> }> };
}

function stubbedFetch(status = 207, responseBody: unknown = { successes: [], errors: [] }) {
  const requests: CapturedRequest[] = [];
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    requests.push({
      url: String(url),
      init: init!,
      body: JSON.parse(String(init!.body)) as CapturedRequest['body'],
    });
    return new Response(JSON.stringify(responseBody), { status });
  }) as typeof fetch;
  return { requests, fetchFn };
}

function span(overrides: Partial<TraceSpan> = {}): TraceSpan {
  return {
    name: 'runTool',
    traceId: 'wf-1',
    startTime: new Date('2026-06-11T12:00:00.000Z'),
    endTime: new Date('2026-06-11T12:00:00.250Z'),
    attributes: { tool: 'add_list_item', riskTier: 'autonomous', parked: false },
    ...overrides,
  };
}

const options = (fetchFn: typeof fetch) => ({
  publicKey: 'pk-lf-test',
  secretKey: 'sk-lf-test',
  baseUrl: 'https://cloud.langfuse.com',
  fetchFn,
});

describe('makeLangfuseSink', () => {
  it('buffers spans and posts one batch to the ingestion endpoint with Basic auth', async () => {
    const { requests, fetchFn } = stubbedFetch();
    const sink = makeLangfuseSink(options(fetchFn));

    sink.emit(span());
    sink.emit(span({ name: 'summarizeContext', attributes: {} }));
    expect(requests).toHaveLength(0); // buffered, not sent per-span

    await sink.flush();

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://cloud.langfuse.com/api/public/ingestion');
    const auth = (requests[0]!.init.headers as Record<string, string>)['Authorization'];
    expect(auth).toBe(`Basic ${Buffer.from('pk-lf-test:sk-lf-test').toString('base64')}`);
  });

  it('announces each traceId once with a trace-create event before its observations', async () => {
    const { requests, fetchFn } = stubbedFetch();
    const sink = makeLangfuseSink(options(fetchFn));

    sink.emit(span({ traceId: 'wf-a' }));
    sink.emit(span({ traceId: 'wf-a', name: 'summarizeContext', attributes: {} }));
    sink.emit(span({ traceId: 'wf-b' }));
    await sink.flush();

    const batch = requests[0]!.body.batch;
    const traceCreates = batch.filter((e) => e.type === 'trace-create');
    expect(traceCreates.map((e) => e.body['id'])).toEqual(['wf-a', 'wf-b']);
    // The same trace is not re-announced on a later flush.
    sink.emit(span({ traceId: 'wf-a' }));
    await sink.flush();
    expect(requests[1]!.body.batch.filter((e) => e.type === 'trace-create')).toHaveLength(0);
  });

  it('maps callModel spans to generation-create with usageDetails incl. cache tokens', async () => {
    const { requests, fetchFn } = stubbedFetch();
    const sink = makeLangfuseSink(options(fetchFn));

    sink.emit(
      span({
        name: 'callModel',
        attributes: {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 80,
          cacheWriteTokens: 5,
        },
      }),
    );
    await sink.flush();

    const gen = requests[0]!.body.batch.find((e) => e.type === 'generation-create');
    expect(gen).toBeDefined();
    expect(gen!.body['traceId']).toBe('wf-1');
    expect(gen!.body['name']).toBe('callModel');
    expect(gen!.body['usageDetails']).toEqual({
      input: 100,
      output: 20,
      cache_read_input_tokens: 80,
      cache_creation_input_tokens: 5,
    });
    expect(gen!.body['metadata']).toBeUndefined();
    expect(gen!.body['startTime']).toBe('2026-06-11T12:00:00.000Z');
    expect(gen!.body['endTime']).toBe('2026-06-11T12:00:00.250Z');
  });

  it('maps non-model spans to span-create carrying attributes as metadata', async () => {
    const { requests, fetchFn } = stubbedFetch();
    const sink = makeLangfuseSink(options(fetchFn));

    sink.emit(span());
    await sink.flush();

    const sp = requests[0]!.body.batch.find((e) => e.type === 'span-create');
    expect(sp!.body['name']).toBe('runTool');
    expect(sp!.body['metadata']).toEqual({
      tool: 'add_list_item',
      riskTier: 'autonomous',
      parked: false,
    });
    expect(sp!.body['level']).toBeUndefined();
  });

  it('marks error spans level ERROR with the error as statusMessage', async () => {
    const { requests, fetchFn } = stubbedFetch();
    const sink = makeLangfuseSink(options(fetchFn));

    sink.emit(span({ error: 'Error: voyage 500' }));
    await sink.flush();

    const sp = requests[0]!.body.batch.find((e) => e.type === 'span-create');
    expect(sp!.body['level']).toBe('ERROR');
    expect(sp!.body['statusMessage']).toBe('Error: voyage 500');
  });

  it('gives every batch event a unique id (Langfuse dedups by event id)', async () => {
    const { requests, fetchFn } = stubbedFetch();
    const sink = makeLangfuseSink(options(fetchFn));

    sink.emit(span());
    sink.emit(span({ name: 'callModel', attributes: { inputTokens: 1 } }));
    await sink.flush();

    const ids = requests[0]!.body.batch.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('flush is a no-op on an empty buffer', async () => {
    const { requests, fetchFn } = stubbedFetch();
    const sink = makeLangfuseSink(options(fetchFn));

    await sink.flush();

    expect(requests).toHaveLength(0);
  });

  it('throws on a non-2xx response with the status in the message', async () => {
    const { fetchFn } = stubbedFetch(401, { message: 'invalid credentials' });
    const sink = makeLangfuseSink(options(fetchFn));

    sink.emit(span());
    await expect(sink.flush()).rejects.toThrow(/401/);
  });

  it('throws when the 207 response reports item-level errors', async () => {
    const { fetchFn } = stubbedFetch(207, {
      successes: [],
      errors: [{ id: 'evt-1', status: 400, message: 'bad body' }],
    });
    const sink = makeLangfuseSink(options(fetchFn));

    sink.emit(span());
    await expect(sink.flush()).rejects.toThrow(/1 event/);
  });

  it('auto-flushes when the buffer reaches flushAt without throwing into emit', async () => {
    const { requests, fetchFn } = stubbedFetch();
    const sink = makeLangfuseSink({ ...options(fetchFn), flushAt: 2 });

    sink.emit(span());
    sink.emit(span({ name: 'summarizeContext', attributes: {} }));
    // Auto-flush is fire-and-forget; give the microtask queue a turn.
    await new Promise((resolve) => setImmediate(resolve));

    expect(requests).toHaveLength(1);
  });
});
