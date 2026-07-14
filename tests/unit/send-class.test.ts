import { describe, expect, it } from 'vitest';
import {
  approvalSendId,
  deliverReply,
  isPermanentSendError,
  isTransientSendError,
  isUnroutableDestination,
  makeResilientSend,
  makeSendDeadLetter,
  replySendId,
  selectSendClass,
  unroutableDestinationError,
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
    expect(selectSendClass({ kind: 'human', senderId: '100000000000001@lid' })).toBe(
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
  deadLettered: { idempotencyKey: string; text: string; reason: string }[];
}

function fakeDeps(seed: Recorded, opts: { sendThrows?: boolean; sendError?: Error } = {}): DeliverReplyDeps {
  return {
    recordSend: async ({ idempotencyKey }) => {
      if (seed.logged.has(idempotencyKey)) return false;
      seed.logged.add(idempotencyKey);
      return true;
    },
    getSentEntry: async (key) => (seed.logged.has(key) ? { idempotencyKey: key } : null),
    send: async ({ text }) => {
      if (opts.sendError) throw opts.sendError;
      if (opts.sendThrows) throw new Error('wire down');
      seed.sent.push(text);
      return { messageId: `wa-${seed.sent.length}` };
    },
    deadLetter: async ({ idempotencyKey, body, error }) => {
      seed.deadLettered.push({
        idempotencyKey,
        text: (body as { text: string }).text,
        reason: error instanceof Error ? error.message : String(error),
      });
    },
  };
}

function freshSeed(over: Partial<Recorded> = {}): Recorded {
  return { sent: [], logged: new Set(), deadLettered: [], ...over };
}

describe('deliverReply — at-most-once (log-then-send)', () => {
  it('claims the log row, then sends', async () => {
    const seed = freshSeed();
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
    const seed = freshSeed({ logged: new Set(['send-1']) });
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
    const seed = freshSeed();
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
    const seed = freshSeed({ sent: ['reminder: trash night'] });
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
    const seed = freshSeed({ sent: ['reminder: trash night'], logged: new Set(['send-r1']) });
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

// Ledger #15 / T48: a permanent (unroutable-destination) failure on an
// at-least-once send must NOT throw out of deliverReply — a throw errors the
// turn workflow, the inbox item never marks processed, and the next enqueue
// re-drains the same poison item, wedging the concurrency-1 lane forever.
// Instead it is dead-lettered (alert + log via the injected handler) and the
// step completes, so the lane is freed and the poison message is loud, not lost.
describe('deliverReply — permanent failure on at-least-once (ledger #15)', () => {
  it('dead-letters an unroutable-destination send instead of throwing, freeing the lane', async () => {
    const seed = freshSeed();
    const result = await deliverReply(
      fakeDeps(seed, { sendError: unroutableDestinationError('conv-run-7f3a') }),
      {
        sendClass: 'at-least-once',
        idempotencyKey: 'send-r1',
        conversationId: 'conv-run-7f3a',
        text: 'reminder: trash night',
      },
    );

    expect(result.sent).toBe(false);
    expect(result.deadLettered).toBe(true);
    expect(seed.sent).toEqual([]); // never delivered
    expect(seed.logged.has('send-r1')).toBe(false); // never logged as sent
    expect(seed.deadLettered).toEqual([
      {
        idempotencyKey: 'send-r1',
        text: 'reminder: trash night',
        reason: 'unroutable destination: conv-run-7f3a',
      },
    ]);
  });

  it('re-raises a transient/genuine-outage failure — that is the T12 health case, never dead-lettered', async () => {
    // A non-permanent throw escaping deliverReply (e.g. the resilient send's
    // budget spent on a real multi-minute outage) must still error the turn so
    // DBOS keeps the work PENDING for recovery — not silently dropped.
    const seed = freshSeed();
    await expect(
      deliverReply(fakeDeps(seed, { sendError: new Error('transport not connected') }), {
        sendClass: 'at-least-once',
        idempotencyKey: 'send-r1',
        conversationId: 'c1',
        text: 'reminder: trash night',
      }),
    ).rejects.toThrow('transport not connected');
    expect(seed.deadLettered).toEqual([]); // a transient error is never dead-lettered
  });

  it('does NOT dead-letter the at-most-once class — a permanent failure there propagates (scoped to at-least-once)', async () => {
    // At-most-once is claim-then-send: the claim tombstone already prevents a
    // re-send on replay, so it self-heals after one retry and never wedges the
    // lane — dead-lettering is the at-least-once class's concern only.
    const seed = freshSeed();
    await expect(
      deliverReply(fakeDeps(seed, { sendError: unroutableDestinationError('conv-run-7f3a') }), {
        sendClass: 'at-most-once',
        idempotencyKey: 'send-1',
        conversationId: 'conv-run-7f3a',
        text: 'ok done',
      }),
    ).rejects.toThrow('unroutable destination');
    expect(seed.deadLettered).toEqual([]);
  });
});

// The production dead-letter handler: alert (loud, so a dropped reminder is
// never silent) + local log. It must NEVER throw — it is the lane-freeing path,
// so a failing alert channel cannot be allowed to re-wedge the lane.
describe('makeSendDeadLetter (ledger #15)', () => {
  const deadLetterInput = {
    idempotencyKey: 'send-r1',
    conversationId: 'conv-run-7f3a',
    deliveryClass: 'at-least-once' as const,
    body: { text: 'reminder: trash night' },
    error: unroutableDestinationError('conv-run-7f3a'),
  };

  it('alerts with the operational facts and logs the lost message locally', async () => {
    const alerts: string[] = [];
    const logs: string[] = [];
    const deadLetter = makeSendDeadLetter({
      alert: async (text) => {
        alerts.push(text);
      },
      log: (line) => logs.push(line),
    });

    await deadLetter(deadLetterInput);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('conv-run-7f3a'); // who
    expect(alerts[0]).toContain('unroutable destination'); // why
    expect(alerts[0]).toContain('send-r1'); // which send (for manual re-send)
    // The household message text stays OUT of the external alert channel; it is
    // available in the host-local log only.
    expect(alerts[0]).not.toContain('trash night');
    expect(logs.join('\n')).toContain('trash night');
  });

  it('never throws when the alert channel fails — the lane must still be freed', async () => {
    const logs: string[] = [];
    const deadLetter = makeSendDeadLetter({
      alert: async () => {
        throw new Error('telegram alert failed: HTTP 500');
      },
      log: (line) => logs.push(line),
    });

    await expect(deadLetter(deadLetterInput)).resolves.toBeUndefined();
    expect(logs.join('\n')).toContain('alert failed');
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

// Ledger #15 / T48: an at-least-once send to a structurally unroutable
// destination (a malformed jid with no @server — the T42 smoke's leftover
// `conv-run-…` ids made jidDecode throw inside Baileys relayMessage) is a poison
// pill. The transport detects the bad shape and throws an OWNED, stable error —
// the same recipe PROX-SEND-001 uses for `transport not connected` — so the
// classifier never has to guess from Baileys' fragile internal error text.
describe('isUnroutableDestination', () => {
  it('accepts a well-formed @lid jid as routable', () => {
    expect(isUnroutableDestination('100000000000001@lid')).toBe(false);
  });

  it('accepts a real @s.whatsapp.net jid and a @g.us group as routable', () => {
    expect(isUnroutableDestination('15551234567@s.whatsapp.net')).toBe(false);
    expect(isUnroutableDestination('15551234567-1600000000@g.us')).toBe(false);
  });

  it('rejects a test/leftover id with no @server (the T42 smoke poison pill)', () => {
    expect(isUnroutableDestination('conv-run-7f3a-2026-06-14')).toBe(true);
  });

  it('rejects empty / half-formed jids (missing user or server)', () => {
    expect(isUnroutableDestination('')).toBe(true);
    expect(isUnroutableDestination('@s.whatsapp.net')).toBe(true);
    expect(isUnroutableDestination('15551234567@')).toBe(true);
  });
});

describe('isPermanentSendError', () => {
  it('matches the owned unroutable-destination error (never retry, dead-letter it)', () => {
    expect(isPermanentSendError(unroutableDestinationError('conv-run-abc'))).toBe(true);
  });

  it('rejects the transient transport-not-connected disconnect', () => {
    // Default-to-transient: a disconnect must be waited out, never dead-lettered.
    expect(isPermanentSendError(new Error('transport not connected'))).toBe(false);
  });

  it('rejects a send timeout — could be transient network, so never dead-letter it', () => {
    expect(isPermanentSendError(new Error('sendMessage timed out after 60000ms'))).toBe(false);
  });

  it('rejects an unrecognized error — ambiguity fails toward retry, not toward drop', () => {
    expect(isPermanentSendError(new Error('something weird from baileys'))).toBe(false);
    expect(isPermanentSendError('unroutable destination')).toBe(false);
    expect(isPermanentSendError(undefined)).toBe(false);
  });

  it('is mutually exclusive with isTransientSendError on both owned signals', () => {
    const permanent = unroutableDestinationError('bad');
    const transient = new Error('transport not connected');
    expect(isPermanentSendError(permanent) && isTransientSendError(permanent)).toBe(false);
    expect(isPermanentSendError(transient) && isTransientSendError(transient)).toBe(false);
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

  it('delivers when the transport recovers LATE but within budget (no overshoot)', async () => {
    // The PROX-SEND-001 invariant the on-host drill exposed: the reconnect has a
    // slow tail (~85s observed). With the DEFAULT config the loop must keep
    // polling — capped at 5s — long enough to catch a ~85s-late recovery, and
    // NOT give up before the 5-min budget. 20 failures with the default config
    // is ~87.5s of elapsed retry (500+1000+2000+4000 then 5000×16), comfortably
    // inside the 300s budget, so the 21st attempt delivers.
    const sent: string[] = [];
    let attempts = 0;
    const send = makeResilientSend(
      async ({ text }) => {
        attempts += 1;
        if (attempts <= 20) throw new Error('transport not connected');
        sent.push(text);
        return { messageId: 'wa-late' };
      },
      undefined, // default config: maxElapsedMs 5min, maxDelayMs 5s cap
      async () => {}, // no real sleeping in the test
    );

    const receipt = await send({ conversationId: 'c1', text: 'reminder: trash night' });

    expect(receipt.messageId).toBe('wa-late');
    expect(sent).toEqual(['reminder: trash night']); // delivered, not dropped before budget
    expect(attempts).toBe(21);
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

  it('gives up once the elapsed budget is spent (bounded, not infinite)', async () => {
    let attempts = 0;
    const send = makeResilientSend(
      async () => {
        attempts += 1;
        throw new Error('transport not connected');
      },
      // 1s budget, fixed 500ms delays: retry after 0ms elapsed and after 500ms
      // elapsed; at 1000ms elapsed the budget is spent → throw. 3 attempts.
      { maxElapsedMs: 1000, baseDelayMs: 500, backoffRate: 1, maxDelayMs: 500 },
      noSleep,
    );

    await expect(send({ conversationId: 'c1', text: 'x' })).rejects.toThrow(
      'transport not connected',
    );
    expect(attempts).toBe(3);
  });

  it('caps the backoff so it keeps polling near the reconnect, and never sleeps on first-attempt success', async () => {
    const delays: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      delays.push(ms);
    };

    // First-attempt success: no sleep at all.
    const okSend = makeResilientSend(async () => ({ messageId: 'wa-1' }), undefined, sleep);
    await okSend({ conversationId: 'c1', text: 'hi' });
    expect(delays).toEqual([]);

    // Persistent transient: backoff ramps 0.5/1/2/4 then HOLDS at the 5s cap —
    // the fix that stops a long sleep from overshooting the reconnect moment.
    const flakySend = makeResilientSend(
      async () => {
        throw new Error('transport not connected');
      },
      { maxElapsedMs: 30_000, baseDelayMs: 500, backoffRate: 2, maxDelayMs: 5_000 },
      sleep,
    );
    await expect(flakySend({ conversationId: 'c1', text: 'x' })).rejects.toThrow();
    expect(delays.slice(0, 6)).toEqual([500, 1000, 2000, 4000, 5000, 5000]);
    expect(Math.max(...delays)).toBe(5000); // never exceeds the cap
  });

  it('reports each retry to onRetry with running elapsed so a stall is observable', async () => {
    const retries: { attempt: number; delayMs: number; elapsedMs: number }[] = [];
    const send = makeResilientSend(
      async () => {
        throw new Error('transport not connected');
      },
      { maxElapsedMs: 1500, baseDelayMs: 500, backoffRate: 2, maxDelayMs: 5_000 },
      async () => {},
      ({ attempt, delayMs, elapsedMs }) => retries.push({ attempt, delayMs, elapsedMs }),
    );

    await expect(send({ conversationId: 'c1', text: 'x' })).rejects.toThrow();
    // Retries fire while elapsed < budget; elapsed accumulates the slept delays.
    expect(retries).toEqual([
      { attempt: 1, delayMs: 500, elapsedMs: 0 },
      { attempt: 2, delayMs: 1000, elapsedMs: 500 },
    ]);
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
    const seed = freshSeed();
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
      deadLetter: async () => {
        throw new Error('should not dead-letter a transient disconnect');
      },
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
