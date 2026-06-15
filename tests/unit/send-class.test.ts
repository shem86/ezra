import { describe, expect, it } from 'vitest';
import {
  approvalSendId,
  deliverReply,
  isTransientSendError,
  makeResilientSend,
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

describe('approvalSendId', () => {
  it('keys an approval-prompt send on its action id (at-least-once, deterministic)', () => {
    expect(approvalSendId('act-abc')).toBe('approval-act-abc');
    expect(approvalSendId('act-abc')).toBe(approvalSendId('act-abc'));
  });

  it('does not collide with a reply send id for the same string', () => {
    expect(approvalSendId('x')).not.toBe(replySendId({ messageId: 'x' }));
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

// PROX-SEND-001 (docs/known-issues.md) — found in the T45 on-host self-heal
// drill. A proactive at-least-once send (reminder/nag/approval prompt) fires
// from the scheduled sweep, which on restart can run before Baileys reconnects.
// A bare send then throws `transport not connected` and errors the whole turn
// workflow terminally — DBOS recovers PENDING, never ERROR — so the reminder is
// silently DROPPED, the one failure the at-least-once class exists to prevent.
// The fix is a resilient send wrapper (makeResilientSend) that waits out a
// transient disconnect with bounded backoff; it lands ABOVE deliverReply (on
// the transport send), so the original deliverReply-level repro is relocated
// here per the known-issues note.

describe('isTransientSendError', () => {
  it('matches the transport-not-connected disconnect (the one transient case)', () => {
    expect(isTransientSendError(new Error('transport not connected'))).toBe(true);
  });

  it('rejects a permanent/unroutable-destination error — never retry a poison send', () => {
    // Ledger #15: a bad jid must propagate immediately, not spin forever.
    expect(isTransientSendError(new Error('bad jid: not a valid destination'))).toBe(false);
  });

  it('rejects non-Error throws', () => {
    expect(isTransientSendError('transport not connected')).toBe(false);
    expect(isTransientSendError(undefined)).toBe(false);
  });
});

describe('makeResilientSend (PROX-SEND-001)', () => {
  const noSleep = async (): Promise<void> => {};

  it('retries past a transient "transport not connected" and delivers exactly once', async () => {
    const sent: string[] = [];
    let attempts = 0;
    const send = makeResilientSend(
      async ({ text }) => {
        attempts += 1;
        if (attempts < 3) throw new Error('transport not connected');
        sent.push(text);
        return { messageId: `wa-${sent.length}` };
      },
      undefined,
      noSleep,
    );

    const receipt = await send({ conversationId: 'c1', text: 'reminder: trash night' });

    expect(receipt.messageId).toBe('wa-1');
    expect(sent).toEqual(['reminder: trash night']); // delivered, not dropped, not duplicated
    expect(attempts).toBe(3);
  });

  it('does not retry a permanent error — propagates on the first attempt (ledger #15)', async () => {
    let attempts = 0;
    const send = makeResilientSend(
      async () => {
        attempts += 1;
        throw new Error('bad jid: not a valid destination');
      },
      undefined,
      noSleep,
    );

    await expect(send({ conversationId: 'c1', text: 'x' })).rejects.toThrow('bad jid');
    expect(attempts).toBe(1); // a poison message must never spin the lane
  });

  it('gives up after maxAttempts on a persistent transient failure (bounded, not infinite)', async () => {
    let attempts = 0;
    const send = makeResilientSend(
      async () => {
        attempts += 1;
        throw new Error('transport not connected');
      },
      { maxAttempts: 4, baseDelayMs: 10, backoffRate: 2 },
      noSleep,
    );

    await expect(send({ conversationId: 'c1', text: 'x' })).rejects.toThrow(
      'transport not connected',
    );
    expect(attempts).toBe(4);
  });

  it('backs off with growing delays between retries, and never sleeps on first-attempt success', async () => {
    const delays: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      delays.push(ms);
    };

    // First-attempt success: no sleep at all.
    const okSend = makeResilientSend(async () => ({ messageId: 'wa-1' }), undefined, sleep);
    await okSend({ conversationId: 'c1', text: 'hi' });
    expect(delays).toEqual([]);

    // Persistent transient: bounded, strictly-growing backoff before each retry.
    const flakySend = makeResilientSend(
      async () => {
        throw new Error('transport not connected');
      },
      { maxAttempts: 4, baseDelayMs: 500, backoffRate: 2 },
      sleep,
    );
    await expect(flakySend({ conversationId: 'c1', text: 'x' })).rejects.toThrow();
    // 3 sleeps for 4 attempts; each strictly larger than the last.
    expect(delays).toEqual([500, 1000, 2000]);
  });
});

// The end-to-end invariant the bug violated, at unit speed: a resilient send
// composed with deliverReply at the at-least-once class, against a
// throw-then-recover transport, delivers exactly once and writes exactly one
// sent_log row — not dropped, not duplicated by the in-step retry. The DBOS
// crash-durability of these orderings is gated separately by
// tests/integration/send-class-recovery.test.ts.
describe('resilient send + deliverReply at-least-once across a transient disconnect', () => {
  it('delivers the reminder exactly once with exactly one log row', async () => {
    const seed: Recorded = { sent: [], logged: new Set() };
    let attempts = 0;
    const resilientSend = makeResilientSend(
      async ({ text }: { conversationId: string; text: string }) => {
        attempts += 1;
        if (attempts < 3) throw new Error('transport not connected');
        seed.sent.push(text);
        return { messageId: `wa-${seed.sent.length}` };
      },
      undefined,
      async () => {},
    );
    const deps: DeliverReplyDeps = {
      recordSend: async ({ idempotencyKey }) => {
        if (seed.logged.has(idempotencyKey)) return false;
        seed.logged.add(idempotencyKey);
        return true;
      },
      getSentEntry: async (key) => (seed.logged.has(key) ? { idempotencyKey: key } : null),
      send: resilientSend,
    };

    const result = await deliverReply(deps, {
      sendClass: 'at-least-once',
      idempotencyKey: 'send-reminder-1',
      conversationId: 'c1',
      text: 'reminder: trash night',
    });

    expect(result.sent).toBe(true);
    expect(seed.sent).toEqual(['reminder: trash night']); // delivered, not dropped
    expect([...seed.logged]).toEqual(['send-reminder-1']); // exactly one log row
  });
});
