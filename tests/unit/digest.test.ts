// T34: pending_actions rows → digest entries for the system-prompt slot.
// Pure mapping — the DB read happens in a journaled step owned by the
// composer; what's tested here is the row-to-entry shape.

import { describe, expect, it } from 'vitest';
import { toDigestEntries } from '../../src/hitl/digest.ts';
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
