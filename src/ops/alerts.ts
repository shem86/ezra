// Independent (non-WhatsApp) alert channel (T12). The down-alert for a
// dropped socket must not ride the socket it monitors (architecture
// decision 7) — Telegram is a separate transport entirely.

export interface AlertChannel {
  /** Deliver one alert; rejects on failure (callers decide whether to swallow). */
  sendAlert(text: string): Promise<void>;
}

export interface TelegramAlertChannelDeps {
  botToken: string;
  chatId: string;
  /** Test seam; defaults to global fetch. */
  fetchFn?: typeof fetch;
}

// Telegram rejects messages over 4096 chars — truncating beats an alert
// that fails precisely when an error dump is long.
const TELEGRAM_TEXT_LIMIT = 4096;

interface TelegramResponse {
  ok?: boolean;
  description?: string;
}

export function createTelegramAlertChannel(deps: TelegramAlertChannelDeps): AlertChannel {
  const fetchFn = deps.fetchFn ?? fetch;
  // The token lives in the URL, so raw fetch errors may leak it — every
  // failure path below throws a message built only from safe parts.
  const url = `https://api.telegram.org/bot${deps.botToken}/sendMessage`;

  return {
    async sendAlert(text: string): Promise<void> {
      let response: Response;
      try {
        response = await fetchFn(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: deps.chatId,
            text: text.slice(0, TELEGRAM_TEXT_LIMIT),
          }),
        });
      } catch {
        throw new Error('telegram alert failed: network error reaching api.telegram.org');
      }

      let parsed: TelegramResponse = {};
      try {
        parsed = (await response.json()) as TelegramResponse;
      } catch {
        // Non-JSON body — fall through to the status check.
      }
      if (!response.ok || parsed.ok !== true) {
        const detail = parsed.description ?? `HTTP ${response.status}`;
        throw new Error(`telegram alert failed: ${detail}`);
      }
    },
  };
}
