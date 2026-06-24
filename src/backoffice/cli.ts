// `pnpm backoffice` entry: read Config, compose the read-only server, listen.
// THE composing caller for the backoffice process (mirrors src/main.ts's role
// for the spine) — the one place env becomes wiring. Prints `backoffice up:`
// once listening; the deploy healthcheck waits for that marker (BO-14).

import { resolve } from 'node:path';
import { loadBackofficeConfig } from '../ops/config.js';
import { makeRateLimiter } from './auth.js';
import { createBackofficeServer } from './server.js';

function main(): void {
  const config = loadBackofficeConfig();
  const distDir = resolve(config.distDir);
  // 8 bad tokens from one address → 15-minute lockout. Generous for a fat
  // finger, tight enough that the tailnet+token combo isn't brute-forceable.
  const rateLimiter = makeRateLimiter({ maxFailures: 8, lockoutMs: 15 * 60_000 });

  const server = createBackofficeServer({
    token: config.token,
    distDir,
    rateLimiter,
    logger: (msg) => console.error(msg),
  });

  server.listen(config.port, () => {
    console.log(`backoffice up: read-only console listening on :${config.port} (dist ${distDir})`);
  });

  const shutdown = (signal: string): void => {
    console.error(`backoffice: ${signal} — closing`);
    server.close(() => process.exit(0));
    // Don't hang forever on a stuck socket.
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
