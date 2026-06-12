// T31: tracing seam — span emission from the turn's step taps.
// All sinks here are captured fakes; Langfuse never runs in CI.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { makeTracer, type TraceSink, type TraceSpan } from '../../src/ops/tracing.js';
import { defineTool } from '../../src/tools/define-tool.js';
import { makeRunTool, makeToolRegistry } from '../../src/tools/registry.js';
import type { ToolCall } from '../../src/agent/context.js';
import type { Queryable } from '../../src/memory/store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function capturedSink(): { spans: TraceSpan[]; sink: TraceSink } {
  const spans: TraceSpan[] = [];
  return { spans, sink: { emit: (span) => spans.push(span) } };
}

const fakeDb: Queryable = {
  query: async () => ({ rows: [], rowCount: 0 }),
} as unknown as Queryable;

interface FakeDeps {
  readonly label: string;
}

const echoTool = defineTool<FakeDeps, z.ZodType<{ text: string }>>({
  name: 'echo',
  description: 'echoes its input',
  schema: z.object({ text: z.string() }),
  riskTier: 'autonomous',
  execute: async (args) => `echo: ${args.text}`,
});

const failingTool = defineTool<FakeDeps, z.ZodType<{ text: string }>>({
  name: 'kaboom',
  description: 'always throws',
  schema: z.object({ text: z.string() }),
  riskTier: 'autonomous',
  execute: async () => {
    throw new Error('db exploded');
  },
});

const registry = makeToolRegistry<FakeDeps>([echoTool, failingTool]);

function runToolDeps() {
  return {
    toolDeps: { label: 'test' },
    park: async () => ({ toolUseId: 'never', content: 'parked', parked: true }),
  };
}

const call = (name: string, args: unknown, id = 'tu_1'): ToolCall => ({ id, name, args });

// ---------------------------------------------------------------------------
// Model-usage tap
// ---------------------------------------------------------------------------

describe('makeTracer — onModelUsage', () => {
  it('emits a callModel span carrying tier and full usage incl. cache tokens', () => {
    const { spans, sink } = capturedSink();
    const tracer = makeTracer({ sink, getTraceId: () => 'wf-123' });

    tracer.onModelUsage(
      { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 5 },
      'cheap',
    );

    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe('callModel');
    expect(spans[0]!.traceId).toBe('wf-123');
    expect(spans[0]!.attributes).toEqual({
      tier: 'cheap',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 80,
      cacheWriteTokens: 5,
    });
  });

  it('omits usage fields the provider did not report', () => {
    const { spans, sink } = capturedSink();
    const tracer = makeTracer({ sink });

    tracer.onModelUsage(
      {
        inputTokens: 10,
        outputTokens: undefined,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      },
      'reasoning',
    );

    expect(spans[0]!.attributes).toEqual({ tier: 'reasoning', inputTokens: 10 });
  });

  it('never throws into the caller, even when the sink throws', () => {
    const tracer = makeTracer({
      sink: {
        emit: () => {
          throw new Error('exporter down');
        },
      },
    });

    expect(() =>
      tracer.onModelUsage(
        { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        'cheap',
      ),
    ).not.toThrow();
  });

  it('never throws when getTraceId throws; span still emits without a traceId', () => {
    const { spans, sink } = capturedSink();
    const tracer = makeTracer({
      sink,
      getTraceId: () => {
        throw new Error('no workflow context');
      },
    });

    tracer.onModelUsage(
      { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      'cheap',
    );

    expect(spans).toHaveLength(1);
    expect(spans[0]!.traceId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// runTool tap
// ---------------------------------------------------------------------------

describe('makeTracer — traceRunTool', () => {
  it('emits a runTool span with tool name, risk tier, actionId, parked — result unchanged', async () => {
    const { spans, sink } = capturedSink();
    const tracer = makeTracer({ sink, getTraceId: () => 'wf-9' });
    const runTool = tracer.traceRunTool(makeRunTool(registry, runToolDeps()), registry);

    const result = await runTool(fakeDb, call('echo', { text: 'hi' }), 'conv-1');

    expect(result).toEqual({ toolUseId: 'tu_1', content: 'echo: hi', parked: false });
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe('runTool');
    expect(spans[0]!.traceId).toBe('wf-9');
    expect(spans[0]!.attributes).toEqual({
      tool: 'echo',
      riskTier: 'autonomous',
      actionId: 'act-conv-1-tu_1',
      parked: false,
    });
    expect(spans[0]!.error).toBeUndefined();
  });

  it('still emits a span for an unknown tool (no riskTier attribute)', async () => {
    const { spans, sink } = capturedSink();
    const tracer = makeTracer({ sink });
    const runTool = tracer.traceRunTool(makeRunTool(registry, runToolDeps()), registry);

    const result = await runTool(fakeDb, call('no_such_tool', {}), 'conv-1');

    expect(result.content).toMatch(/unknown tool/);
    expect(spans[0]!.attributes).toEqual({
      tool: 'no_such_tool',
      actionId: 'act-conv-1-tu_1',
      parked: false,
    });
  });

  it('emits an error span and rethrows when execute throws (transaction must roll back)', async () => {
    const { spans, sink } = capturedSink();
    const tracer = makeTracer({ sink });
    const runTool = tracer.traceRunTool(makeRunTool(registry, runToolDeps()), registry);

    await expect(runTool(fakeDb, call('kaboom', { text: 'x' }), 'conv-1')).rejects.toThrow(
      'db exploded',
    );

    expect(spans).toHaveLength(1);
    expect(spans[0]!.error).toContain('db exploded');
    expect(spans[0]!.attributes).toEqual({
      tool: 'kaboom',
      riskTier: 'autonomous',
      actionId: 'act-conv-1-tu_1',
    });
  });
});

// ---------------------------------------------------------------------------
// Generic step tap (compaction summarize/embed)
// ---------------------------------------------------------------------------

describe('makeTracer — traceStep', () => {
  it('emits a named span around a successful step and passes the result through', async () => {
    const { spans, sink } = capturedSink();
    const tracer = makeTracer({ sink, getTraceId: () => 'wf-c' });
    const summarize = tracer.traceStep('summarizeContext', async (head: readonly string[]) => {
      return `summary of ${head.length}`;
    });

    const out = await summarize(['a', 'b']);

    expect(out).toBe('summary of 2');
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe('summarizeContext');
    expect(spans[0]!.traceId).toBe('wf-c');
    expect(spans[0]!.endTime.getTime()).toBeGreaterThanOrEqual(spans[0]!.startTime.getTime());
  });

  it('emits an error span and rethrows when the step rejects', async () => {
    const { spans, sink } = capturedSink();
    const tracer = makeTracer({ sink });
    const embed = tracer.traceStep('embedSummary', async () => {
      throw new Error('voyage 500');
    });

    await expect(embed()).rejects.toThrow('voyage 500');
    expect(spans[0]!.name).toBe('embedSummary');
    expect(spans[0]!.error).toContain('voyage 500');
  });
});
