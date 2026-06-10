import { describe, expect, it, vi } from 'vitest';
import { createBaileysTransport, type WaSocketLike } from '../../src/transport/baileys.ts';
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
function harness(overrides: { maxAttempts?: number } = {}) {
  const sockets: FakeSocket[] = [];
  const states: TransportState[] = [];
  const messages: InboundMessage[] = [];
  const sleeps: number[] = [];
  const transport = createBaileysTransport({
    sessionStore: fakeSessionStore(),
    createSocket: () => {
      const s = fakeSocket();
      sockets.push(s);
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
  return { transport, sockets, states, messages, sleeps };
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
});
