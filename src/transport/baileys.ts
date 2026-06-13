import {
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  type AuthenticationState,
} from 'baileys';
import { markAgentText } from './agent-marker.js';
import type { SessionStore } from './session-store.js';
import type {
  InboundMessage,
  MessageAck,
  OutboundMessage,
  SendReceipt,
  Transport,
  TransportState,
} from './types.js';
import {
  classifyDisconnect,
  computeReconnectDelay,
  DEFAULT_RECONNECT_POLICY,
  detectMediaType,
  extractMessageText,
  extractQuotedMessageId,
  getStatusCode,
  normalizeJid,
  RecentIds,
  toEpochSeconds,
  type ReconnectPolicy,
} from './protocol.js';

// Real Baileys adapter for the Transport seam. The socket factory is
// injectable so the full lifecycle (reconnects, echo suppression, timeouts)
// is unit-testable against a fake socket — WhatsApp itself is never touched
// in tests (SPEC "Never in CI").

/** The slice of a Baileys socket this adapter actually uses. */
export interface WaSocketLike {
  ev: {
    on(event: string, cb: (payload: never) => void): void;
  };
  user?: { id: string; lid?: string } | undefined;
  sendMessage(
    jid: string,
    content: { text: string },
  ): Promise<{ key?: { id?: string | null } | null } | undefined>;
  end(error: Error | undefined): void;
}

interface ConnectionUpdateLike {
  connection?: string;
  lastDisconnect?: { error?: unknown };
  qr?: string;
}

interface UpsertLike {
  type?: string;
  messages?: Array<{
    key?: {
      id?: string | null;
      remoteJid?: string | null;
      fromMe?: boolean | null;
      participant?: string | null;
    } | null;
    message?: unknown;
    pushName?: string | null;
    messageTimestamp?: unknown;
  }>;
}

export interface BaileysTransportDeps {
  sessionStore: SessionStore;
  reconnectPolicy?: ReconnectPolicy;
  sendTimeoutMs?: number;
  /** Pairing hook — the QR payload to render for the builder. */
  onQr?: (qr: string) => void;
  /** Test seams; default to the real socket, timer, and Math.random. */
  createSocket?: (auth: AuthenticationState) => Promise<WaSocketLike> | WaSocketLike;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

// Baileys wants a pino-like logger; this one drops everything.
interface SilentLogger {
  level: string;
  child(obj: unknown): SilentLogger;
  trace(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

const silentLogger: SilentLogger = {
  level: 'silent',
  child: () => silentLogger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

async function defaultCreateSocket(auth: AuthenticationState): Promise<WaSocketLike> {
  // Static fallback if the version probe fails: baileys' bundled default.
  // (Egress note in docs/dep-reviews/baileys-7.0.0-rc13.md; revisit at T16.)
  let version: [number, number, number] | undefined;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    version = undefined;
  }
  const logger = silentLogger as never;
  return makeWASocket({
    auth: {
      creds: auth.creds,
      keys: makeCacheableSignalKeyStore(auth.keys, logger),
    },
    ...(version ? { version } : {}),
    logger,
    browser: ['hh-assistant', 'Desktop', '1.0.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    keepAliveIntervalMs: 25_000,
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    // Without this, 7.x silently drops messages that need an E2EE retry
    // handshake (msg.message === null) — the worst failure class for us.
    getMessage: async () => ({ conversation: '' }),
  }) as unknown as WaSocketLike;
}

const SENT_ID_CAPACITY = 256;

export function createBaileysTransport(deps: BaileysTransportDeps): Transport {
  const policy = deps.reconnectPolicy ?? DEFAULT_RECONNECT_POLICY;
  const sendTimeoutMs = deps.sendTimeoutMs ?? 60_000;
  const createSocket = deps.createSocket ?? defaultCreateSocket;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;

  const sentIds = new RecentIds(SENT_ID_CAPACITY);
  const messageHandlers: Array<(m: InboundMessage, ack: MessageAck) => void> = [];
  // Receipt deferral is NOT possible on the real socket (T42 finding, builder
  // accepted 2026-06-12): Baileys 7.x sends the protocol receipt inside its
  // own message handler BEFORE emitting messages.upsert (messages-recv.js,
  // sendReceipt precedes upsertMessage), with no public hook — so this ack
  // callback is permanently a no-op here. The durability guarantee is carried
  // instead by (a) WhatsApp's offline redelivery on reconnect for any
  // process-down window — those arrive as 'append' upserts, handled below —
  // and (b) ingestWorkflowId dedupe making redelivery safe. The residual loss
  // window (receipt sent, crash before the inbox commit, ms-scale in-process)
  // is accepted and documented in the recovery runbook (T44).
  const noopAck: MessageAck = async () => {};
  const stateHandlers: Array<(s: TransportState) => void> = [];

  let sock: WaSocketLike | null = null;
  let state: TransportState = 'closed';
  let intentionalClose = false;
  let forceRestart = false;
  let retryAttempts = 0;

  function setState(next: TransportState): void {
    if (next === state) return;
    state = next;
    for (const handler of [...stateHandlers]) handler(next);
  }

  /** Resolves at the next 'open'; rejects on terminal states. */
  function waitForOpen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const handler = (s: TransportState): void => {
        if (s === 'connecting') return;
        stateHandlers.splice(stateHandlers.indexOf(handler), 1);
        if (s === 'open') resolve();
        else if (s === 'logged-out') {
          reject(new Error('WhatsApp logged out — re-pair via QR (docs/pairing.md)'));
        } else {
          reject(new Error('WhatsApp connection closed before opening'));
        }
      };
      stateHandlers.push(handler);
    });
  }

  function handleClose(statusCode: number | undefined): void {
    if (intentionalClose) {
      setState('closed');
      return;
    }
    if (forceRestart) {
      forceRestart = false;
      void startSocket();
      return;
    }
    switch (classifyDisconnect(statusCode)) {
      case 're-pair':
        // Auto-reconnecting on 401 would loop; restoring old state is
        // forbidden. A human re-pairs.
        setState('logged-out');
        return;
      case 'restart':
        void startSocket();
        return;
      case 'retry': {
        retryAttempts += 1;
        if (retryAttempts > policy.maxAttempts) {
          setState('closed');
          return;
        }
        const delay = computeReconnectDelay(retryAttempts - 1, policy, random);
        void sleep(delay).then(() => {
          if (!intentionalClose) return startSocket();
        });
        return;
      }
    }
  }

  function handleUpsert(event: UpsertLike): void {
    // Own messages on a personal number arrive as 'append', not 'notify'.
    if (event.type !== 'notify' && event.type !== 'append') return;
    for (const msg of event.messages ?? []) {
      const id = msg.key?.id;
      const conversationId = msg.key?.remoteJid;
      if (!id || !conversationId || conversationId === 'status@broadcast') continue;
      if (!msg.message) continue; // protocol/system events
      if (sentIds.has(id)) continue; // echo of our own send

      const mediaType = detectMediaType(msg.message);
      const text =
        extractMessageText(msg.message) ?? (mediaType ? `[${mediaType} received]` : null);
      if (text === null) continue; // reactions, polls, etc. — not v1 input

      const inbound: InboundMessage = {
        id,
        conversationId,
        senderId: normalizeJid(msg.key?.participant ?? conversationId),
        senderName: msg.pushName ?? null,
        fromMe: msg.key?.fromMe === true,
        text,
        quotedMessageId: extractQuotedMessageId(msg.message),
        timestamp: toEpochSeconds(msg.messageTimestamp),
      };
      for (const handler of [...messageHandlers]) handler(inbound, noopAck);
    }
  }

  async function startSocket(): Promise<void> {
    setState('connecting');
    const { state: authState, saveCreds } = await deps.sessionStore.loadAuthState();
    const socket = await createSocket(authState);
    sock = socket;
    socket.ev.on('creds.update', () => {
      void saveCreds();
    });
    socket.ev.on('messages.upsert', (event: UpsertLike) => handleUpsert(event));
    socket.ev.on('connection.update', (update: ConnectionUpdateLike) => {
      if (update.qr) deps.onQr?.(update.qr);
      if (update.connection === 'open') {
        retryAttempts = 0;
        setState('open');
      } else if (update.connection === 'close') {
        handleClose(getStatusCode(update.lastDisconnect?.error));
      }
    });
  }

  return {
    async connect(): Promise<void> {
      intentionalClose = false;
      const opened = waitForOpen();
      await startSocket();
      return opened;
    },

    async send(message: OutboundMessage): Promise<SendReceipt> {
      const socket = sock;
      if (!socket || state !== 'open') {
        throw new Error('transport not connected');
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`sendMessage timed out after ${sendTimeoutMs}ms`)),
          sendTimeoutMs,
        );
      });
      try {
        const result = await Promise.race([
          // Marker applied here, at the wire, so the journaled turn and model
          // context stay clean (src/transport/agent-marker.ts).
          socket.sendMessage(message.conversationId, { text: markAgentText(message.text) }),
          timeout,
        ]);
        const messageId = result?.key?.id;
        if (!messageId) throw new Error('sendMessage returned no message id');
        sentIds.add(messageId);
        return { messageId };
      } finally {
        clearTimeout(timer);
      }
    },

    onMessage(handler: (message: InboundMessage, ack: MessageAck) => void): void {
      messageHandlers.push(handler);
    },

    onStateChange(handler: (s: TransportState) => void): void {
      stateHandlers.push(handler);
    },

    async forceReconnect(): Promise<void> {
      const opened = waitForOpen();
      forceRestart = true;
      sock?.end(undefined);
      return opened;
    },

    async disconnect(): Promise<void> {
      intentionalClose = true;
      sock?.end(undefined);
      setState('closed');
    },
  };
}
