// T37: the expiry sweep's pure parts — firing identity, the proactive item
// shape, and the row→notice mapping. The sweep workflow itself is proven in
// tests/integration/scheduled.test.ts against the real scheduler and lane.
import { describe, expect, it } from 'vitest';
import { expiryFiringId, toExpiryItem, toOverdueActions } from '../../src/hitl/expiry.ts';
import type { PendingAction } from '../../src/memory/store.ts';

const overdue = {
  actionId: 'act-conv-9-tu_1',
  conversationId: 'conv-9',
  toolName: 'propose_event',
  summary: '{"title":"תור לרופא"}',
};

describe('expiryFiringId', () => {
  it('derives from the action id alone — an action expires at most once ever', () => {
    expect(expiryFiringId('act-conv-9-tu_1')).toBe('expire-act-conv-9-tu_1');
    expect(expiryFiringId('act-conv-9-tu_1')).toBe(expiryFiringId('act-conv-9-tu_1'));
  });
});

describe('toExpiryItem', () => {
  it('rides the proactive lane as an actionUpdate from system:hitl, anchored on the firing id', () => {
    const item = toExpiryItem(overdue);
    expect(item).toMatchObject({
      conversationId: 'conv-9',
      kind: 'proactive',
      senderId: 'system:hitl',
      messageId: 'expire-act-conv-9-tu_1',
    });
    const payload = item.payload as { actionUpdate: string };
    expect(payload.actionUpdate).toContain('[action update]');
    expect(payload.actionUpdate).toContain('act-conv-9-tu_1');
    expect(payload.actionUpdate).toContain('propose_event');
    expect(payload.actionUpdate).toMatch(/nothing was executed/i);
  });
});

describe('toOverdueActions', () => {
  const row = (toolCall: unknown): PendingAction => ({
    actionId: 'act-x',
    conversationId: 'conv-x',
    toolCall,
    status: 'pending',
    createdAt: new Date(0),
    expiresAt: new Date(0),
    promptMessageId: null,
  });

  it('maps a stored call to its digest-shaped name and summary', () => {
    expect(toOverdueActions([row({ id: 'tu-1', name: 'propose_event', args: { a: 1 } })])).toEqual([
      {
        actionId: 'act-x',
        conversationId: 'conv-x',
        toolName: 'propose_event',
        summary: '{"a":1}',
      },
    ]);
  });

  it('a malformed stored call degrades to its JSON — the notice still goes out', () => {
    const [mapped] = toOverdueActions([row({ broken: true })]);
    expect(mapped).toMatchObject({ toolName: 'unknown', summary: '{"broken":true}' });
  });
});
