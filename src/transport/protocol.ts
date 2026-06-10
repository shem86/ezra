// Pure protocol helpers for the WhatsApp transport. Deliberately free of any
// baileys import so unit tests and future consumers don't load the socket
// stack; numeric codes mirror baileys' DisconnectReason values.

export const DISCONNECT_LOGGED_OUT = 401;
export const DISCONNECT_RESTART_REQUIRED = 515;

export type DisconnectAction = 're-pair' | 'restart' | 'retry';

/**
 * 401 means WhatsApp revoked the pairing — reconnecting would loop forever,
 * and restoring old session state is forbidden (re-pair via QR is the only
 * recovery). 515 is the routine restart WhatsApp requests right after
 * pairing. Everything else (408 storms, 5xx, unknown) is retryable.
 */
export function classifyDisconnect(statusCode: number | undefined): DisconnectAction {
  if (statusCode === DISCONNECT_LOGGED_OUT) return 're-pair';
  if (statusCode === DISCONNECT_RESTART_REQUIRED) return 'restart';
  return 'retry';
}

export interface ReconnectPolicy {
  readonly initialMs: number;
  readonly maxMs: number;
  readonly factor: number;
  /** Total jitter band, e.g. 0.25 spreads delays across ±12.5%. */
  readonly jitter: number;
  readonly maxAttempts: number;
}

// Values OpenClaw converged on in production; revisit after our own M2 drill.
export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = {
  initialMs: 2_000,
  maxMs: 30_000,
  factor: 1.8,
  jitter: 0.25,
  maxAttempts: 12,
};

export function computeReconnectDelay(
  attempt: number,
  policy: ReconnectPolicy,
  random: () => number = Math.random,
): number {
  const base = Math.min(policy.initialMs * policy.factor ** attempt, policy.maxMs);
  const jitterFactor = 1 + policy.jitter * (random() - 0.5);
  return Math.round(base * jitterFactor);
}

type Content = Record<string, unknown>;

function asContent(value: unknown): Content | null {
  return typeof value === 'object' && value !== null ? (value as Content) : null;
}

/** Envelope types whose real content nests one level down under `message`. */
const WRAPPER_KEYS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'documentWithCaptionMessage',
] as const;

function unwrapContent(raw: unknown): Content | null {
  let content = asContent(raw);
  // Envelopes can nest (e.g. view-once inside ephemeral); unwrap until fixed point.
  for (let depth = 0; content && depth < 4; depth++) {
    const wrapperKey = WRAPPER_KEYS.find((key) => asContent(content![key])?.message);
    if (!wrapperKey) break;
    content = asContent(asContent(content[wrapperKey])!.message);
  }
  return content;
}

/**
 * Text of a message for text-only v1: plain conversation, extended text, or
 * a media caption. Captionless media yields null — the caller decides whether
 * to surface a placeholder.
 */
export function extractMessageText(raw: unknown): string | null {
  const content = unwrapContent(raw);
  if (!content) return null;

  if (typeof content.conversation === 'string' && content.conversation) {
    return content.conversation;
  }
  const extended = asContent(content.extendedTextMessage);
  if (extended && typeof extended.text === 'string' && extended.text) {
    return extended.text;
  }
  for (const key of ['imageMessage', 'videoMessage', 'documentMessage'] as const) {
    const media = asContent(content[key]);
    if (media && typeof media.caption === 'string' && media.caption) {
      return media.caption;
    }
  }
  return null;
}

/** Quoted-message stanza id — contextInfo can hang off any content subtype. */
export function extractQuotedMessageId(raw: unknown): string | null {
  const content = unwrapContent(raw);
  if (!content) return null;
  for (const value of Object.values(content)) {
    const inner = asContent(value);
    const contextInfo = inner ? asContent(inner.contextInfo) : null;
    if (contextInfo && typeof contextInfo.stanzaId === 'string' && contextInfo.stanzaId) {
      return contextInfo.stanzaId;
    }
  }
  return null;
}

/** Strips the `:device` suffix WhatsApp appends to user JIDs. */
export function normalizeJid(jid: string): string {
  return jid.replace(/:\d+(?=@)/, '');
}

/**
 * Bounded insertion-order id set. Echo suppression for a bot running on the
 * builder's personal number: the bot's own sends come back as fromMe inbound
 * events, indistinguishable by flag from the builder's typed messages — only
 * the ids we sent identify them.
 */
export class RecentIds {
  private readonly ids = new Set<string>();

  constructor(private readonly capacity: number) {}

  add(id: string): void {
    this.ids.delete(id);
    this.ids.add(id);
    if (this.ids.size > this.capacity) {
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }
}
