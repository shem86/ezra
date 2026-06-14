import { describe, expect, it } from 'vitest';
import {
  deliverReply,
  replySendId,
  selectSendClass,
  type DeliverReplyDeps,
} from '../../src/transport/send-class.ts';

// T43: the production reply path is one step for every outbound text — human
// replies, reminder firings, expiry notices all arrive as inbox items and the
// model's answer is the delivery. The send CLASS is therefore chosen from the
// lead item: only the reminder/nag producer (senderId 'system') is
// at-least-once (a missed reminder is the catastrophic failure); everything
// else — human replies and low-stakes system:hitl action updates — is
// at-most-once (a duplicate to the user is the failure we refuse).

describe('selectSendClass', () => {
  it('classifies a reminder/nag firing (proactive, sender system) as at-least-once', () => {
    expect(selectSendClass({ kind: 'proactive', senderId: 'system' })).toBe('at-least-once');
  });

  it('classifies a human reply as at-most-once', () => {
    expect(selectSendClass({ kind: 'human', senderId: '232155984703662@lid' })).toBe(
      'at-most-once',
    );
  });

  it('classifies a system:hitl expiry notice (low-stakes action update) as at-most-once', () => {
    expect(selectSendClass({ kind: 'proactive', senderId: 'system:hitl' })).toBe('at-most-once');
  });

  it('defaults an unrecognized sender to at-most-once — never spam a duplicate', () => {
    expect(selectSendClass({ kind: 'proactive', senderId: 'system:future' })).toBe('at-most-once');
  });
});

describe('replySendId', () => {
  it('derives a deterministic send id from the lead message id', () => {
    expect(replySendId({ messageId: 'remind-abc-2026-06-14T11:00:00.000Z' })).toBe(
      'send-remind-abc-2026-06-14T11:00:00.000Z',
    );
  });

  it('is stable across calls (replay-safe)', () => {
    const lead = { messageId: 'wa-message-99' };
    expect(replySendId(lead)).toBe(replySendId(lead));
  });

  it('distinguishes different firings of the same reminder by due instant', () => {
    const first = replySendId({ messageId: 'remind-r1-2026-06-14T11:00:00.000Z' });
    const second = replySendId({ messageId: 'remind-r1-2026-06-21T11:00:00.000Z' });
    expect(first).not.toBe(second);
  });
});

// deliverReply is the ordering primitive both classes build on. The sent_log
// claim (insert-if-absent) is the pivot: claim-before-send drops the replay
// double; send-before-claim re-sends on replay. These fakes prove the ordering
// deterministically; the kill-mid-flight durability is the integration gate.
interface Recorded {
  sent: string[];
  logged: Set<string>;
}

function fakeDeps(seed: Recorded, opts: { sendThrows?: boolean } = {}): DeliverReplyDeps {
  return {
    recordSend: async ({ idempotencyKey }) => {
      if (seed.logged.has(idempotencyKey)) return false;
      seed.logged.add(idempotencyKey);
      return true;
    },
    getSentEntry: async (key) => (seed.logged.has(key) ? { idempotencyKey: key } : null),
    send: async ({ text }) => {
      if (opts.sendThrows) throw new Error('wire down');
      seed.sent.push(text);
      return { messageId: `wa-${seed.sent.length}` };
    },
  };
}

describe('deliverReply — at-most-once (log-then-send)', () => {
  it('claims the log row, then sends', async () => {
    const seed: Recorded = { sent: [], logged: new Set() };
    const result = await deliverReply(fakeDeps(seed), {
      sendClass: 'at-most-once',
      idempotencyKey: 'send-1',
      conversationId: 'c1',
      text: 'ok done',
    });
    expect(result.sent).toBe(true);
    expect(seed.sent).toEqual(['ok done']);
    expect(seed.logged.has('send-1')).toBe(true);
  });

  it('skips the send when the claim was already taken (replay after crash)', async () => {
    const seed: Recorded = { sent: [], logged: new Set(['send-1']) };
    const result = await deliverReply(fakeDeps(seed), {
      sendClass: 'at-most-once',
      idempotencyKey: 'send-1',
      conversationId: 'c1',
      text: 'ok done',
    });
    expect(result.sent).toBe(false);
    expect(seed.sent).toEqual([]); // never duplicates
  });
});

describe('deliverReply — at-least-once (send-then-log)', () => {
  it('sends, then logs', async () => {
    const seed: Recorded = { sent: [], logged: new Set() };
    const result = await deliverReply(fakeDeps(seed), {
      sendClass: 'at-least-once',
      idempotencyKey: 'send-r1',
      conversationId: 'c1',
      text: 'reminder: trash night',
    });
    expect(result.sent).toBe(true);
    expect(seed.sent).toEqual(['reminder: trash night']);
    expect(seed.logged.has('send-r1')).toBe(true);
  });

  it('re-sends on replay when the log never committed (the accepted duplicate)', async () => {
    // Models a crash after send, before the log row: the log is still absent.
    const seed: Recorded = { sent: ['reminder: trash night'], logged: new Set() };
    const result = await deliverReply(fakeDeps(seed), {
      sendClass: 'at-least-once',
      idempotencyKey: 'send-r1',
      conversationId: 'c1',
      text: 'reminder: trash night',
    });
    expect(result.sent).toBe(true);
    expect(seed.sent).toHaveLength(2); // duplicate — a miss is never acceptable
  });

  it('skips the re-send once the log row is present', async () => {
    const seed: Recorded = { sent: ['reminder: trash night'], logged: new Set(['send-r1']) };
    const result = await deliverReply(fakeDeps(seed), {
      sendClass: 'at-least-once',
      idempotencyKey: 'send-r1',
      conversationId: 'c1',
      text: 'reminder: trash night',
    });
    expect(result.sent).toBe(false);
    expect(seed.sent).toHaveLength(1);
  });
});
