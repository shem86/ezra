import qrcode from 'qrcode-terminal';
import { loadWaSessionDir } from '../ops/config.js';
import { createBaileysTransport } from './baileys.js';
import { createSessionStore } from './session-store.js';

// Manual pairing / reconnect-verification entry point (`pnpm pair`).
// Run once to pair via QR; run again to prove the persisted session
// reconnects without re-pairing (T11 acceptance). `--reset` wipes the
// session first — the ONLY sanctioned recovery for a lost/corrupt session.

const sessionDir = loadWaSessionDir();
const store = createSessionStore({ dir: sessionDir });

if (process.argv.includes('--reset')) {
  await store.clear();
  console.log(`Session at ${sessionDir} cleared — fresh pairing will start.`);
}

console.log(
  store.isPaired()
    ? `Existing session found in ${sessionDir} — expecting reconnect WITHOUT a QR.`
    : `No session in ${sessionDir} — a QR will appear; keep your phone ready.`,
);

const transport = createBaileysTransport({
  sessionStore: store,
  onQr: (qr) => {
    console.log('\nOn your phone: WhatsApp → Settings → Linked Devices → Link a Device\n');
    qrcode.generate(qr, { small: true });
  },
});

transport.onStateChange((state) => console.log(`[transport] state: ${state}`));

try {
  await transport.connect();
  console.log(`\n✅ Connected. Session persisted in ${sessionDir}.`);
  // Give the creds save queue a moment to flush before exiting.
  await new Promise((r) => setTimeout(r, 3_000));
  await transport.disconnect();
  process.exit(0);
} catch (err) {
  console.error(`\n❌ ${err instanceof Error ? err.message : String(err)}`);
  console.error('If the session is corrupt or logged out, re-run with --reset to re-pair.');
  process.exit(1);
}
