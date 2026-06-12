// T34: pending_actions rows → digest entries for the system-prompt slot.
// Pure mapping — the DB read happens in a journaled step owned by the
// composer; what's tested here is the row-to-entry shape.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toDigestEntries } from '../../src/hitl/digest.ts';
import { defineTool } from '../../src/tools/define-tool.ts';
import { makeToolRegistry } from '../../src/tools/registry.ts';
import type { PendingAction } from '../../src/memory/store.ts';

function row(overrides: Partial<PendingAction> = {}): PendingAction {
  return {
    actionId: 'act-conv-1-tu_9',
    conversationId: 'conv-1',
    toolCall: { id: 'tu_9', name: 'create_event', args: { title: 'dentist', at: '15:00' } },
    status: 'pending',
    createdAt: new Date('2026-06-12T10:00:00Z'),
    expiresAt: new Date('2026-06-12T22:00:00Z'),
    promptMessageId: null,
    ...overrides,
  };
}

describe('toDigestEntries', () => {
  it('maps a parked tool call to actionId, tool name, args summary, and expiry', () => {
    const [entry] = toDigestEntries([row()]);

    expect(entry).toMatchObject({
      actionId: 'act-conv-1-tu_9',
      toolName: 'create_event',
      expiresAt: new Date('2026-06-12T22:00:00Z'),
    });
    expect(entry!.summary).toContain('dentist');
    expect(entry!.summary).toContain('15:00');
  });

  it('degrades a malformed tool_call to its JSON instead of throwing', () => {
    const [entry] = toDigestEntries([row({ toolCall: { weird: true } })]);

    expect(entry!.toolName).toBe('unknown');
    expect(entry!.summary).toContain('weird');
  });

  it('preserves row order', () => {
    const entries = toDigestEntries([
      row(),
      row({ actionId: 'act-conv-1-tu_10', toolCall: { id: 'tu_10', name: 'create_event', args: {} } }),
    ]);
    expect(entries.map((e) => e.actionId)).toEqual(['act-conv-1-tu_9', 'act-conv-1-tu_10']);
  });
});

// T40: the per-tool human renderer the T34 done-note deferred to the first
// real confirm-before tool. Registry-aware summaries; every degradation path
// (no registry, unknown tool, no hook, schema drift, a throwing hook) falls
// back to the raw-args JSON rather than breaking the digest.
describe('toDigestEntries with a registry (per-tool summaries)', () => {
  type NoDeps = Record<string, never>;
  const schema = z.object({ title: z.string(), at: z.string() });

  function toolWith(summarize?: (args: z.output<typeof schema>) => string) {
    return defineTool<NoDeps, typeof schema>({
      name: 'create_event',
      description: 'test tool',
      schema,
      riskTier: 'confirm-before',
      revalidate: async () => true,
      execute: async () => 'done',
      ...(summarize === undefined ? {} : { summarize }),
    });
  }

  it("renders the tool's summarize output when the registry carries the hook", () => {
    const registry = makeToolRegistry<NoDeps>([
      toolWith((args) => `"${args.title}" at ${args.at}`),
    ]);
    const [entry] = toDigestEntries([row()], registry);
    expect(entry!.summary).toBe('"dentist" at 15:00');
  });

  it('falls back to JSON when the tool declares no summarize hook', () => {
    const registry = makeToolRegistry<NoDeps>([toolWith()]);
    const [entry] = toDigestEntries([row()], registry);
    expect(entry!.summary).toContain('dentist');
    expect(entry!.summary).toContain('15:00');
  });

  it('falls back to JSON when the stored args no longer satisfy the schema', () => {
    const registry = makeToolRegistry<NoDeps>([toolWith(() => 'never reached')]);
    const [entry] = toDigestEntries(
      [row({ toolCall: { id: 'tu_9', name: 'create_event', args: { title: 'dentist' } } })],
      registry,
    );
    expect(entry!.summary).toContain('dentist');
    expect(entry!.summary).not.toBe('never reached');
  });

  it('falls back to JSON when summarize throws — the digest must never break', () => {
    const registry = makeToolRegistry<NoDeps>([
      toolWith(() => {
        throw new Error('renderer bug');
      }),
    ]);
    const [entry] = toDigestEntries([row()], registry);
    expect(entry!.summary).toContain('dentist');
  });

  it('falls back to JSON for a tool the registry does not know', () => {
    const registry = makeToolRegistry<NoDeps>([]);
    const [entry] = toDigestEntries([row()], registry);
    expect(entry!.summary).toContain('dentist');
  });
});
