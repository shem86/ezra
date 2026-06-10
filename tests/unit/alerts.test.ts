import { describe, expect, it, vi } from 'vitest';
import { createTelegramAlertChannel } from '../../src/ops/alerts.js';

const BOT_TOKEN = '7000000001:AAFakeTokenForTests';
const CHAT_ID = '123456789';

function telegramOk(): Response {
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
}

function channelWith(fetchFn: typeof fetch) {
  return createTelegramAlertChannel({ botToken: BOT_TOKEN, chatId: CHAT_ID, fetchFn });
}

describe('createTelegramAlertChannel', () => {
  it('POSTs the alert text to the Telegram sendMessage endpoint as JSON', async () => {
    const fetchFn = vi.fn(async () => telegramOk());

    await channelWith(fetchFn).sendAlert('socket down');

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ chat_id: CHAT_ID, text: 'socket down' });
  });

  it('throws on an HTTP error, surfacing Telegram description but never the bot token', async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }), {
          status: 401,
        }),
    );

    const error = await channelWith(fetchFn)
      .sendAlert('x')
      .catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/Unauthorized/);
    expect(error.message).not.toContain(BOT_TOKEN);
  });

  it('throws when Telegram answers 200 but ok:false', async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, description: 'chat not found' }), {
          status: 200,
        }),
    );

    await expect(channelWith(fetchFn).sendAlert('x')).rejects.toThrowError(/chat not found/);
  });

  it('wraps network failures without leaking the token-bearing URL', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError(`fetch failed: https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    });

    const error = await channelWith(fetchFn)
      .sendAlert('x')
      .catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain(BOT_TOKEN);
  });

  it('truncates alert text to the Telegram 4096-char limit instead of failing', async () => {
    const fetchFn = vi.fn(async () => telegramOk());

    await channelWith(fetchFn).sendAlert('a'.repeat(5000));

    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { text: string };
    expect(body.text).toHaveLength(4096);
  });
});
