import { describe, expect, it, vi } from 'vitest';
import {
  createBaileysTransport,
  type DisconnectInfo,
  type WaSocketLike,
} from '../../src/transport/baileys.ts';
import {
  createWaVersionSource,
  type WaVersion,
  type WaVersionSource,
} from '../../src/transport/wa-version.ts';
import type { SessionStore } from '../../src/transport/session-store.ts';
import type { InboundMessage, TransportState } from '../../src/transport/types.ts';

type Listener = (payload: unknown) => void;

interface FakeSocket extends WaSocketLike {
  emit(event: string, payload: unknown): void;
  sendMessage: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

function fakeSocket(): FakeSocket {
  const listeners = new Map<string, Listener[]>();
  let nextId = 0;
  return {
    ev: {
      on(event: string, cb: Listener) {
        listeners.set(event, [...(listeners.get(event) ?? []), cb]);
      },
    },
    emit(event: string, payload: unknown) {
      for (const cb of listeners.get(event) ?? []) cb(payload);
    },
    user: { id: '15550001111:7@s.whatsapp.net' },
    sendMessage: vi.fn(async () => ({ key: { id: `SENT-${nextId++}` } })),
    end: vi.fn(),
  } as unknown as FakeSocket;
}

function fakeSessionStore(): SessionStore {
  return {
    isPaired: () => true,
    loadAuthState: async () =>
      ({ state: { creds: {}, keys: {} }, saveCreds: vi.fn(async () => {}) }) as never,
    clear: async () => {},
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Builds a transport whose createSocket hands out fresh fake sockets. */
function harness(overrides: { maxAttempts?: number; versionSource?: WaVersionSource } = {}) {
  const sockets: FakeSocket[] = [];
  const states: TransportState[] = [];
  const messages: InboundMessage[] = [];
  const sleeps: number[] = [];
  const disconnects: DisconnectInfo[] = [];
  /** The version handed to each socket, in creation order. */
  const versions: Array<WaVersion | undefined> = [];
  const transport = createBaileysTransport({
    sessionStore: fakeSessionStore(),
    onDisconnect: (info) => disconnects.push(info),
    ...(overrides.versionSource ? { versionSource: overrides.versionSource } : {}),
    createSocket: (_auth, version) => {
      const s = fakeSocket();
      sockets.push(s);
      versions.push(version);
      return s;
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    reconnectPolicy: {
      initialMs: 100,
      maxMs: 1_000,
      factor: 2,
      jitter: 0,
      maxAttempts: overrides.maxAttempts ?? 3,
    },
    sendTimeoutMs: 50,
  });
  transport.onStateChange((s) => states.push(s));
  transport.onMessage((m) => messages.push(m));
  return { transport, sockets, states, messages, sleeps, disconnects, versions };
}

async function connectOpen(h: ReturnType<typeof harness>): Promise<void> {
  const pending = h.transport.connect();
  await flush();
  h.sockets[0]!.emit('connection.update', { connection: 'open' });
  await pending;
}

describe('baileys adapter: connection lifecycle', () => {
  it('connect resolves on open and reports connecting → open', async () => {
    const h = harness();
    await connectOpen(h);
    expect(h.states).toEqual(['connecting', 'open']);
  });

  it('401 close goes to logged-out and never auto-reconnects', async () => {
    const h = harness();
    await connectOpen(h);

    h.sockets[0]!.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });
    await flush();

    expect(h.states.at(-1)).toBe('logged-out');
    expect(h.sockets).toHaveLength(1); // no new socket created
  });

  it('515 close reconnects immediately without backoff', async () => {
    const h = harness();
    await connectOpen(h);

    h.sockets[0]!.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    });
    await flush();

    expect(h.sockets).toHaveLength(2);
    expect(h.sleeps).toEqual([]);
    h.sockets[1]!.emit('connection.update', { connection: 'open' });
    await flush();
    expect(h.states.at(-1)).toBe('open');
  });

  it('transient close retries with growing backoff and recovers', async () => {
    const h = harness();
    await connectOpen(h);

    h.sockets[0]!.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 408 } } },
    });
    await flush();
    expect(h.sockets).toHaveLength(2);
    expect(h.sleeps).toEqual([100]);

    h.sockets[1]!.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 408 } } },
    });
    await flush();
    expect(h.sockets).toHaveLength(3);
    expect(h.sleeps).toEqual([100, 200]);

    h.sockets[2]!.emit('connection.update', { connection: 'open' });
    await flush();
    expect(h.states.at(-1)).toBe('open');
  });

  it('gives up after maxAttempts and reports closed', async () => {
    const h = harness({ maxAttempts: 2 });
    await connectOpen(h);

    for (let i = 0; i < 3; i++) {
      h.sockets.at(-1)!.emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 408 } } },
      });
      await flush();
    }

    expect(h.states.at(-1)).toBe('closed');
    expect(h.sockets).toHaveLength(3); // initial + 2 retries, then gave up
  });

  it('a successful open resets the retry budget', async () => {
    const h = harness({ maxAttempts: 2 });
    await connectOpen(h);

    h.sockets[0]!.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 408 } } },
    });
    await flush();
    h.sockets[1]!.emit('connection.update', { connection: 'open' });
    await flush();

    // Two more transient drops must still be within budget after the reset.
    h.sockets[1]!.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 408 } } },
    });
    await flush();
    h.sockets[2]!.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 408 } } },
    });
    await flush();
    expect(h.states.at(-1)).not.toBe('closed');
    expect(h.sockets).toHaveLength(4);
  });

  it('disconnect closes intentionally with no reconnect', async () => {
    const h = harness();
    await connectOpen(h);

    await h.transport.disconnect();
    h.sockets[0]!.emit('connection.update', { connection: 'close', lastDisconnect: {} });
    await flush();

    expect(h.states.at(-1)).toBe('closed');
    expect(h.sockets).toHaveLength(1);
    expect(h.sockets[0]!.end).toHaveBeenCalled();
  });

  it('forceReconnect tears down and reconnects immediately', async () => {
    const h = harness();
    await connectOpen(h);

    const pending = h.transport.forceReconnect();
    h.sockets[0]!.emit('connection.update', { connection: 'close', lastDisconnect: {} });
    await flush();
    expect(h.sockets).toHaveLength(2);
    h.sockets[1]!.emit('connection.update', { connection: 'open' });
    await pending;

    expect(h.sleeps).toEqual([]);
    expect(h.states.at(-1)).toBe('open');
  });

  it('surfaces the QR through the onQr hook', async () => {
    const qrs: string[] = [];
    const sockets: FakeSocket[] = [];
    const transport = createBaileysTransport({
      sessionStore: fakeSessionStore(),
      createSocket: () => {
        const s = fakeSocket();
        sockets.push(s);
        return s;
      },
      onQr: (qr) => qrs.push(qr),
    });
    const pending = transport.connect();
    await flush();
    sockets[0]!.emit('connection.update', { qr: 'QR-DATA' });
    sockets[0]!.emit('connection.update', { connection: 'open' });
    await pending;

    expect(qrs).toEqual(['QR-DATA']);
  });
});

// The socket lifecycle was observable only as bare 'connecting'/'open'
// transitions, so a multi-minute reconnect (2 seen in prod over 3.5 days,
// 4.1 and 5.5 min — past the 3-min alert grace) left no trace of WHY it
// dropped or how much of the gap was backoff. These assert the reason and
// the backoff are surfaced to the composing caller.
describe('baileys adapter: disconnect reasons', () => {
  it('reports the status code, action, attempt and backoff for a transient drop', async () => {
    const h = harness();
    await connectOpen(h);

    h.sockets[0]!.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 408 } } },
    });
    await flush();

    expect(h.disconnects).toEqual([
      { statusCode: 408, action: 'retry', attempt: 1, retryDelayMs: 100, gaveUp: false },
    ]);
  });

  it('reports a 515 as a restart with no backoff', async () => {
    const h = harness();
    await connectOpen(h);

    h.sockets[0]!.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    });
    await flush();

    expect(h.disconnects).toEqual([
      { statusCode: 515, action: 'restart', attempt: 0, retryDelayMs: null, gaveUp: false },
    ]);
  });

  it('reports a 401 as re-pair', async () => {
    const h = harness();
    await connectOpen(h);

    h.sockets[0]!.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });
    await flush();

    expect(h.disconnects).toEqual([
      { statusCode: 401, action: 're-pair', attempt: 0, retryDelayMs: null, gaveUp: false },
    ]);
  });

  // The give-up is the transition the alert grace actually cares about:
  // it's the moment a long 'connecting' stretch becomes a real outage.
  it('flags the attempt that exhausts the retry budget', async () => {
    const h = harness({ maxAttempts: 2 });
    await connectOpen(h);

    for (let i = 0; i < 3; i++) {
      h.sockets.at(-1)!.emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 408 } } },
      });
      await flush();
    }

    expect(h.disconnects.map((d) => [d.attempt, d.retryDelayMs, d.gaveUp])).toEqual([
      [1, 100, false],
      [2, 200, false],
      [3, null, true],
    ]);
  });

  it('surfaces an unknown status code rather than dropping it', async () => {
    const h = harness();
    await connectOpen(h);

    h.sockets[0]!.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: {} },
    });
    await flush();

    expect(h.disconnects[0]).toMatchObject({ statusCode: undefined, action: 'retry' });
  });

  it('stays silent on an intentional disconnect (not an incident)', async () => {
    const h = harness();
    await connectOpen(h);

    await h.transport.disconnect();
    h.sockets[0]!.emit('connection.update', { connection: 'close' });
    await flush();

    expect(h.disconnects).toEqual([]);
  });
});

// 2026-07-28 outage. WhatsApp enforces the client version server-side and
// answers an obsolete one with 405. Ours had silently frozen at the Baileys
// bundled fallback (the upstream probe failed behind the egress allowlist
// without throwing), so the adapter burned its whole retry budget against a
// rejection that could never clear, then went terminally 'closed' — deaf for
// 5.7 days. The pin makes the version explicit; falling forward makes a
// deprecation self-heal instead of waiting for a human.
describe('baileys adapter: WhatsApp client version', () => {
  const PINNED: WaVersion = [2, 3000, 1043857760];
  const NEWER: WaVersion = [2, 3000, 1050000000];

  /** Lets the fall-forward probe + reconnect chain settle. */
  async function settle(): Promise<void> {
    await flush();
    await flush();
  }

  it('hands the pinned version to every socket it creates', async () => {
    const source = createWaVersionSource({ pinned: PINNED, fetchUpstream: async () => null });
    const h = harness({ versionSource: source });
    await connectOpen(h);
    expect(h.versions).toEqual([PINNED]);
  });

  it('passes no version when no source is configured (unchanged default)', async () => {
    const h = harness();
    await connectOpen(h);
    expect(h.versions).toEqual([undefined]);
  });

  it('falls forward to the upstream version on 405 and reconnects with it', async () => {
    const source = createWaVersionSource({ pinned: PINNED, fetchUpstream: async () => NEWER });
    const h = harness({ versionSource: source });
    await connectOpen(h);

    h.sockets[0]!.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 405 } } },
    });
    await settle();

    expect(h.sockets).toHaveLength(2);
    expect(h.versions).toEqual([PINNED, NEWER]);
    // A newly adopted version is a genuinely different attempt, not a repeat —
    // it reconnects at once rather than serving out the backoff.
    expect(h.sleeps).toEqual([]);

    h.sockets[1]!.emit('connection.update', { connection: 'open' });
    await flush();
    expect(h.states.at(-1)).toBe('open');
  });

  it('reports 405 as its own action so the log says why the socket dropped', async () => {
    const source = createWaVersionSource({ pinned: PINNED, fetchUpstream: async () => NEWER });
    const h = harness({ versionSource: source });
    await connectOpen(h);

    h.sockets[0]!.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 405 } } },
    });
    await settle();

    expect(h.disconnects[0]).toMatchObject({ statusCode: 405, action: 'version-rejected' });
  });

  it('a fall-forward resets the retry budget — the new version gets a full one', async () => {
    const versions = [NEWER, PINNED, NEWER];
    let i = 0;
    const source = createWaVersionSource({
      pinned: PINNED,
      fetchUpstream: async () => versions[i++] ?? null,
    });
    const h = harness({ versionSource: source, maxAttempts: 2 });
    await connectOpen(h);

    // Three consecutive 405s, each yielding a genuinely different version:
    // with a maxAttempts of 2 this would have given up by now if the budget
    // were shared with the ordinary retry path.
    for (let n = 0; n < 3; n++) {
      h.sockets.at(-1)!.emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 405 } } },
      });
      await settle();
    }

    expect(h.sockets).toHaveLength(4);
    expect(h.states).not.toContain('closed');
    expect(h.disconnects.every((d) => !d.gaveUp)).toBe(true);
  });

  it('falls back to bounded retry when there is no newer version to adopt', async () => {
    // Upstream agrees with the pin, so the rejection is not something we can
    // fix by moving the version. Retrying the same one is bounded, not endless.
    const source = createWaVersionSource({ pinned: PINNED, fetchUpstream: async () => PINNED });
    const h = harness({ versionSource: source, maxAttempts: 2 });
    await connectOpen(h);

    h.sockets[0]!.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 405 } } },
    });
    await settle();

    expect(h.sockets).toHaveLength(2);
    expect(h.versions).toEqual([PINNED, PINNED]);
    expect(h.sleeps).toEqual([100]); // served the backoff — it IS a repeat
  });

  it('still gives up on a 405 that no version change can fix', async () => {
    const source = createWaVersionSource({ pinned: PINNED, fetchUpstream: async () => PINNED });
    const h = harness({ versionSource: source, maxAttempts: 2 });
    await connectOpen(h);

    for (let n = 0; n < 3; n++) {
      h.sockets.at(-1)!.emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 405 } } },
      });
      await settle();
    }

    expect(h.states.at(-1)).toBe('closed');
    expect(h.disconnects.at(-1)).toMatchObject({ gaveUp: true, action: 'version-rejected' });
  });

  it('survives a 405 with no version source configured at all', async () => {
    const h = harness({ maxAttempts: 2 });
    await connectOpen(h);

    h.sockets[0]!.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 405 } } },
    });
    await settle();

    // Nothing to fall forward to, so it degrades to the ordinary retry path.
    expect(h.sockets).toHaveLength(2);
    expect(h.sleeps).toEqual([100]);
  });
});

describe('baileys adapter: messages', () => {
  const inbound = (overrides: { key?: Record<string, unknown>; message?: unknown } = {}) => ({
    key: {
      id: 'MSG-1',
      remoteJid: '15559998888@s.whatsapp.net',
      fromMe: false,
      ...(overrides.key ?? {}),
    },
    message: 'message' in overrides ? overrides.message : { conversation: 'תקני חלב בדרך' },
    pushName: 'Wife',
    messageTimestamp: 1760000000,
  });

  it('maps an inbound text to the InboundMessage contract', async () => {
    const h = harness();
    await connectOpen(h);

    h.sockets[0]!.emit('messages.upsert', { type: 'notify', messages: [inbound()] });
    await flush();

    expect(h.messages).toHaveLength(1);
    const m = h.messages[0]!;
    expect(m.id).toBe('MSG-1');
    expect(m.conversationId).toBe('15559998888@s.whatsapp.net');
    expect(m.senderId).toBe('15559998888@s.whatsapp.net');
    expect(m.senderName).toBe('Wife');
    expect(m.fromMe).toBe(false);
    expect(m.text).toBe('תקני חלב בדרך');
    expect(m.timestamp).toBe(1760000000);
  });

  it("delivers 'append' upserts too (own messages on a personal number)", async () => {
    const h = harness();
    await connectOpen(h);

    h.sockets[0]!.emit('messages.upsert', {
      type: 'append',
      messages: [inbound({ key: { id: 'MSG-2', fromMe: true } })],
    });
    await flush();

    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]!.fromMe).toBe(true);
  });

  it('suppresses echoes of messages the transport itself sent', async () => {
    const h = harness();
    await connectOpen(h);

    const receipt = await h.transport.send({
      conversationId: '15559998888@s.whatsapp.net',
      text: 'reminder: trash',
    });
    h.sockets[0]!.emit('messages.upsert', {
      type: 'append',
      messages: [inbound({ key: { id: receipt.messageId, fromMe: true } })],
    });
    await flush();

    expect(h.messages).toHaveLength(0);
  });

  it('skips null-content and status broadcast messages', async () => {
    const h = harness();
    await connectOpen(h);

    h.sockets[0]!.emit('messages.upsert', {
      type: 'notify',
      messages: [
        inbound({ message: null }),
        inbound({ key: { id: 'S-1', remoteJid: 'status@broadcast' } }),
      ],
    });
    await flush();

    expect(h.messages).toHaveLength(0);
  });

  it('surfaces captionless media as a placeholder instead of dropping it', async () => {
    const h = harness();
    await connectOpen(h);

    h.sockets[0]!.emit('messages.upsert', {
      type: 'notify',
      messages: [inbound({ message: { imageMessage: {} } })],
    });
    await flush();

    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]!.text).toBe('[image received]');
  });

  it('send returns the WhatsApp message id', async () => {
    const h = harness();
    await connectOpen(h);
    const receipt = await h.transport.send({ conversationId: 'x@s.whatsapp.net', text: 'hi' });
    expect(receipt.messageId).toMatch(/^SENT-/);
  });

  it('prepends the agent marker on the wire (shared identity needs it)', async () => {
    const h = harness();
    await connectOpen(h);
    await h.transport.send({ conversationId: 'x@s.whatsapp.net', text: 'trash night' });
    expect(h.sockets[0]!.sendMessage).toHaveBeenCalledWith('x@s.whatsapp.net', {
      text: '🤖 trash night',
    });
  });

  it('send fails fast when the socket hangs (timeout)', async () => {
    const h = harness();
    await connectOpen(h);
    h.sockets[0]!.sendMessage.mockImplementation(() => new Promise(() => {}));

    await expect(
      h.transport.send({ conversationId: 'x@s.whatsapp.net', text: 'hi' }),
    ).rejects.toThrow(/timed out/i);
  });

  it('send refuses when not connected', async () => {
    const h = harness();
    await expect(
      h.transport.send({ conversationId: 'x@s.whatsapp.net', text: 'hi' }),
    ).rejects.toThrow(/not connected/i);
  });

  it('rejects a structurally unroutable destination with the owned permanent error (ledger #15)', async () => {
    // A malformed jid (no @server) made Baileys jidDecode throw an unstable
    // internal error in the T42 smoke; the adapter now rejects it with the OWNED
    // `unroutable destination` error (the same recipe as `transport not
    // connected`), which the at-least-once reply path dead-letters instead of
    // letting it re-drain and wedge the lane forever. The send never reaches the
    // socket.
    const h = harness();
    await connectOpen(h);

    await expect(
      h.transport.send({ conversationId: 'conv-run-7f3a-no-server', text: 'reminder' }),
    ).rejects.toThrow(/unroutable destination/i);
    expect(h.sockets[0]!.sendMessage).not.toHaveBeenCalled();
  });
});
