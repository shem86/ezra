import { describe, expect, it } from 'vitest';
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
} from '../../src/transport/protocol.ts';

describe('classifyDisconnect', () => {
  it('treats 401 (logged out) as re-pair — never auto-reconnect', () => {
    expect(classifyDisconnect(401)).toBe('re-pair');
  });

  it('treats 515 (restart required after pairing) as immediate restart', () => {
    expect(classifyDisconnect(515)).toBe('restart');
  });

  it('treats other codes and unknown errors as retryable', () => {
    expect(classifyDisconnect(408)).toBe('retry');
    expect(classifyDisconnect(500)).toBe('retry');
    expect(classifyDisconnect(undefined)).toBe('retry');
  });
});

describe('computeReconnectDelay', () => {
  const policy = { initialMs: 2_000, maxMs: 30_000, factor: 2, jitter: 0.5, maxAttempts: 12 };

  it('starts at initialMs with no jitter applied when random returns 0.5', () => {
    // jitter spans [1 - j/2, 1 + j/2); random=0.5 lands exactly on 1.0
    expect(computeReconnectDelay(0, policy, () => 0.5)).toBe(2_000);
  });

  it('grows by factor per attempt and caps at maxMs', () => {
    expect(computeReconnectDelay(1, policy, () => 0.5)).toBe(4_000);
    expect(computeReconnectDelay(2, policy, () => 0.5)).toBe(8_000);
    expect(computeReconnectDelay(10, policy, () => 0.5)).toBe(30_000);
  });

  it('keeps jittered delays within the configured band', () => {
    const low = computeReconnectDelay(0, policy, () => 0);
    const high = computeReconnectDelay(0, policy, () => 0.99);
    expect(low).toBe(1_500); // 2000 * (1 - 0.25)
    expect(high).toBe(2_490); // 2000 * (1 + 0.245)
  });

  it('default policy gives up after maxAttempts', () => {
    expect(DEFAULT_RECONNECT_POLICY.maxAttempts).toBeGreaterThan(0);
  });
});

describe('extractMessageText', () => {
  it('reads a plain conversation message', () => {
    expect(extractMessageText({ conversation: 'add milk' })).toBe('add milk');
  });

  it('reads an extended text message (Hebrew)', () => {
    expect(extractMessageText({ extendedTextMessage: { text: 'תוסיף חלב לרשימה' } })).toBe(
      'תוסיף חלב לרשימה',
    );
  });

  it('unwraps ephemeral and view-once envelopes', () => {
    expect(
      extractMessageText({
        ephemeralMessage: { message: { conversation: 'disappearing hello' } },
      }),
    ).toBe('disappearing hello');
    expect(
      extractMessageText({
        viewOnceMessageV2: { message: { extendedTextMessage: { text: 'once' } } },
      }),
    ).toBe('once');
  });

  it('returns null for non-text content (media) in text-only v1', () => {
    expect(extractMessageText({ imageMessage: { caption: '' } })).toBeNull();
    expect(extractMessageText({ audioMessage: {} })).toBeNull();
    expect(extractMessageText({})).toBeNull();
    expect(extractMessageText(null)).toBeNull();
  });

  it('uses a media caption as text when present', () => {
    expect(extractMessageText({ imageMessage: { caption: 'הקבלה מהסופר' } })).toBe(
      'הקבלה מהסופר',
    );
  });
});

describe('extractQuotedMessageId', () => {
  it('finds the quoted stanza id nested under any content type', () => {
    const content = {
      extendedTextMessage: {
        text: 'כן, תאשר',
        contextInfo: { stanzaId: 'ABC123', quotedMessage: { conversation: 'approve?' } },
      },
    };
    expect(extractQuotedMessageId(content)).toBe('ABC123');
  });

  it('returns null when nothing is quoted', () => {
    expect(extractQuotedMessageId({ conversation: 'hi' })).toBeNull();
    expect(extractQuotedMessageId(null)).toBeNull();
  });
});

describe('normalizeJid', () => {
  it('strips the device suffix from a user JID', () => {
    expect(normalizeJid('15551234567:10@s.whatsapp.net')).toBe('15551234567@s.whatsapp.net');
  });

  it('leaves plain user, group, and lid JIDs untouched', () => {
    expect(normalizeJid('15551234567@s.whatsapp.net')).toBe('15551234567@s.whatsapp.net');
    expect(normalizeJid('120363001234567890@g.us')).toBe('120363001234567890@g.us');
    expect(normalizeJid('100000000000002@lid')).toBe('100000000000002@lid');
  });
});

describe('getStatusCode', () => {
  it('reads a Boom-style status code off a disconnect error', () => {
    expect(getStatusCode({ output: { statusCode: 401 } })).toBe(401);
    expect(getStatusCode({ output: { statusCode: 515 } })).toBe(515);
  });

  it('returns undefined for plain or missing errors', () => {
    expect(getStatusCode(new Error('boom'))).toBeUndefined();
    expect(getStatusCode(undefined)).toBeUndefined();
  });
});

describe('detectMediaType', () => {
  it('recognizes media content, including inside envelopes', () => {
    expect(detectMediaType({ imageMessage: {} })).toBe('image');
    expect(detectMediaType({ audioMessage: {} })).toBe('audio');
    expect(
      detectMediaType({ viewOnceMessageV2: { message: { videoMessage: {} } } }),
    ).toBe('video');
  });

  it('returns null for text and protocol messages', () => {
    expect(detectMediaType({ conversation: 'hi' })).toBeNull();
    expect(detectMediaType({ protocolMessage: {} })).toBeNull();
    expect(detectMediaType(null)).toBeNull();
  });
});

describe('toEpochSeconds', () => {
  it('coerces number, string, and Long-like timestamps', () => {
    expect(toEpochSeconds(1760000000)).toBe(1760000000);
    expect(toEpochSeconds('1760000000')).toBe(1760000000);
    expect(toEpochSeconds({ toNumber: () => 1760000000 })).toBe(1760000000);
  });

  it('falls back to 0 for garbage', () => {
    expect(toEpochSeconds(undefined)).toBe(0);
    expect(toEpochSeconds({})).toBe(0);
  });
});

describe('RecentIds (echo suppression on a personal number)', () => {
  it('remembers ids it has seen', () => {
    const ids = new RecentIds(3);
    ids.add('a');
    expect(ids.has('a')).toBe(true);
    expect(ids.has('b')).toBe(false);
  });

  it('evicts the oldest id beyond capacity', () => {
    const ids = new RecentIds(2);
    ids.add('a');
    ids.add('b');
    ids.add('c');
    expect(ids.has('a')).toBe(false);
    expect(ids.has('b')).toBe(true);
    expect(ids.has('c')).toBe(true);
  });
});
