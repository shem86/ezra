import { describe, expect, it, vi } from 'vitest';
import type {
  InboundMessage,
  OutboundMessage,
  SendReceipt,
  Transport,
  TransportState,
} from '../../src/transport/types.js';
import { createRunner, parseRunnerCommand } from '../../src/transport/runner.js';
import { computeHumanSendDelay, HUMAN_SEND_DELAY } from '../../src/transport/protocol.js';

function makeFakeTransport(overrides: Partial<Transport> = {}): Transport & {
  stateHandlers: Array<(s: TransportState) => void>;
  sent: OutboundMessage[];
} {
  const stateHandlers: Array<(s: TransportState) => void> = [];
  const sent: OutboundMessage[] = [];
  return {
    stateHandlers,
    sent,
    connect: vi.fn(async () => {}),
    send: vi.fn(async (message: OutboundMessage): Promise<SendReceipt> => {
      sent.push(message);
      return { messageId: 'WAMID-1' };
    }),
    onMessage: vi.fn((_handler: (m: InboundMessage) => void) => {}),
    onStateChange: vi.fn((handler: (s: TransportState) => void) => {
      stateHandlers.push(handler);
    }),
    forceReconnect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    ...overrides,
  };
}

function makeRunner(transport: Transport, random = () => 0) {
  const out: string[] = [];
  const sleeps: number[] = [];
  const runner = createRunner({
    transport,
    out: (line) => out.push(line),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random,
  });
  return { runner, out, sleeps };
}

describe('parseRunnerCommand', () => {
  it('parses send with a JID and multi-word text', () => {
    expect(parseRunnerCommand('send 123-456@g.us hello there')).toEqual({
      kind: 'send',
      to: '123-456@g.us',
      text: 'hello there',
    });
  });

  it('rejects send without a JID-shaped target or without text', () => {
    expect(parseRunnerCommand('send hello')).toMatchObject({ kind: 'invalid' });
    expect(parseRunnerCommand('send 123@s.whatsapp.net')).toMatchObject({ kind: 'invalid' });
  });

  it('parses reconnect, status, help, and quit, ignoring surrounding whitespace', () => {
    expect(parseRunnerCommand('  reconnect ')).toEqual({ kind: 'reconnect' });
    expect(parseRunnerCommand('status')).toEqual({ kind: 'status' });
    expect(parseRunnerCommand('help')).toEqual({ kind: 'help' });
    expect(parseRunnerCommand('quit')).toEqual({ kind: 'quit' });
  });

  it('returns empty for blank lines and unknown for anything else', () => {
    expect(parseRunnerCommand('   ')).toEqual({ kind: 'empty' });
    expect(parseRunnerCommand('frobnicate')).toMatchObject({ kind: 'unknown' });
  });
});

describe('computeHumanSendDelay', () => {
  it('spans the configured jitter window', () => {
    expect(computeHumanSendDelay(() => 0)).toBe(HUMAN_SEND_DELAY.minMs);
    expect(computeHumanSendDelay(() => 0.999999)).toBeLessThanOrEqual(HUMAN_SEND_DELAY.maxMs);
    expect(computeHumanSendDelay(() => 0.5)).toBeGreaterThan(HUMAN_SEND_DELAY.minMs);
  });
});

describe('createRunner', () => {
  it('send waits a human-like jittered delay before hitting the transport', async () => {
    const transport = makeFakeTransport();
    const { runner, out, sleeps } = makeRunner(transport, () => 0.5);

    const keepGoing = await runner.handleLine('send 123-456@g.us shopping test');

    expect(keepGoing).toBe(true);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(HUMAN_SEND_DELAY.minMs);
    expect(sleeps[0]).toBeLessThanOrEqual(HUMAN_SEND_DELAY.maxMs);
    expect(transport.sent).toEqual([{ conversationId: '123-456@g.us', text: 'shopping test' }]);
    expect(out.join('\n')).toContain('WAMID-1');
  });

  it('surfaces a send failure without crashing the loop', async () => {
    const transport = makeFakeTransport({
      send: vi.fn(async () => {
        throw new Error('transport not connected');
      }),
    });
    const { runner, out } = makeRunner(transport);

    const keepGoing = await runner.handleLine('send 123@s.whatsapp.net hi');

    expect(keepGoing).toBe(true);
    expect(out.join('\n')).toContain('transport not connected');
  });

  it('reconnect triggers forceReconnect and reports success', async () => {
    const transport = makeFakeTransport();
    const { runner, out } = makeRunner(transport);

    await runner.handleLine('reconnect');

    expect(transport.forceReconnect).toHaveBeenCalledTimes(1);
    expect(out.join('\n')).toMatch(/reconnect/i);
  });

  it('reconnect failure is reported, not thrown', async () => {
    const transport = makeFakeTransport({
      forceReconnect: vi.fn(async () => {
        throw new Error('WhatsApp logged out — re-pair via QR (docs/pairing.md)');
      }),
    });
    const { runner, out } = makeRunner(transport);

    const keepGoing = await runner.handleLine('reconnect');

    expect(keepGoing).toBe(true);
    expect(out.join('\n')).toContain('re-pair');
  });

  it('status reports the last state seen from the transport', async () => {
    const transport = makeFakeTransport();
    const { runner, out } = makeRunner(transport);

    for (const handler of transport.stateHandlers) handler('open');
    await runner.handleLine('status');

    expect(out.join('\n')).toContain('open');
  });

  it('quit returns false to end the loop; unknown input prints usage', async () => {
    const transport = makeFakeTransport();
    const { runner, out } = makeRunner(transport);

    expect(await runner.handleLine('frobnicate')).toBe(true);
    expect(out.join('\n')).toMatch(/help|usage|commands/i);
    expect(await runner.handleLine('quit')).toBe(false);
  });
});
