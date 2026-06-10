import { createInterface } from 'node:readline';
import { loadTransportOpsConfig } from '../ops/config.js';
import { createTelegramAlertChannel } from '../ops/alerts.js';
import { createDeadmanPinger } from '../ops/deadman.js';
import { createHealthMonitor } from '../ops/health.js';
import { createBaileysTransport } from './baileys.js';
import { createRunner } from './runner.js';
import { createSessionStore } from './session-store.js';

// Standalone transport runner entry point (`pnpm transport`, T13): connect,
// monitor (T12 health → Telegram + dead-man ping), and take manual commands.
// No LLM, no DB writes — this is the M2 drill harness (T14 runs on it).

const config = loadTransportOpsConfig();
const store = createSessionStore({ dir: config.waSessionDir });

if (!store.isPaired()) {
  console.error(`No WhatsApp session in ${config.waSessionDir} — pair first: pnpm pair`);
  process.exit(1);
}

const alertChannel = createTelegramAlertChannel({
  botToken: config.alertChannelToken,
  chatId: config.alertChannelChatId,
});
const health = createHealthMonitor({
  alertChannel,
  onAlertError: (error) => console.error('[alerts]', error),
});
const deadman = createDeadmanPinger({
  pingUrl: config.deadmanPingUrl,
  onPingError: (error) => console.error('[deadman]', error),
});

const transport = createBaileysTransport({
  sessionStore: store,
  onQr: () => {
    console.error('[transport] unexpected QR — session invalid; quit and re-pair via pnpm pair');
  },
});

transport.onStateChange((state) => {
  console.log(`[transport] state: ${state}`);
  health.onStateChange(state);
});
transport.onMessage((message) => {
  const preview = message.text.length > 80 ? `${message.text.slice(0, 80)}…` : message.text;
  console.log(
    `[inbound] ${message.conversationId} ${message.senderName ?? message.senderId}: ${preview}`,
  );
});

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
const runner = createRunner({ transport, out: (line) => console.log(line) });

let shuttingDown = false;
async function shutdown(code: number): Promise<never> {
  if (shuttingDown) process.exit(code);
  shuttingDown = true;
  rl.close();
  deadman.stop();
  health.stop();
  await transport.disconnect().catch(() => undefined);
  process.exit(code);
}

process.on('SIGINT', () => {
  void shutdown(0);
});

console.log(`Connecting with session from ${config.waSessionDir}…`);
try {
  await transport.connect();
} catch (error) {
  console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
  await shutdown(1);
}

console.log('✅ Connected. Monitoring is live (Telegram alerts + dead-man ping). Type `help`.');
deadman.start();
rl.prompt();

rl.on('line', (line) => {
  // Serialize command handling: pause input while a command (and its
  // human-like send delay) is in flight.
  rl.pause();
  void runner
    .handleLine(line)
    .then(async (keepGoing) => {
      if (!keepGoing) return shutdown(0);
      rl.resume();
      rl.prompt();
    })
    .catch(async (error: unknown) => {
      console.error('[runner]', error);
      return shutdown(1);
    });
});
rl.on('close', () => {
  void shutdown(0);
});
