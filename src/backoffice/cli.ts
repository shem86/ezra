// `pnpm backoffice` entry: read Config, compose the read-only server, listen.
// THE composing caller for the backoffice process (mirrors src/main.ts's role
// for the spine) — the one place env becomes wiring. Prints `backoffice up:`
// once listening; the deploy healthcheck waits for that marker (BO-14).

import { resolve } from 'node:path';
import { Pool } from 'pg';
import { loadBackofficeConfig } from '../ops/config.js';
import { createApiRouter } from './api.js';
import { makeRateLimiter } from './auth.js';
import { makeCostClient } from './cost.js';
import { makeTurnEnricher } from './journal.js';
import { createBackofficeServer } from './server.js';

function main(): void {
  const config = loadBackofficeConfig();
  const distDir = resolve(config.distDir);
  // 8 bad tokens from one address → 15-minute lockout. Generous for a fat
  // finger, tight enough that the tailnet+token combo isn't brute-forceable.
  const rateLimiter = makeRateLimiter({ maxFailures: 8, lockoutMs: 15 * 60_000 });

  // The SELECT-only pool (BO-17 role). A small pool: this is a single-operator
  // console, not a high-throughput service.
  const pool = new Pool({ connectionString: config.databaseUrl, max: 4 });
  const cost = makeCostClient({
    baseUrl: config.langfuse.baseUrl,
    publicKey: config.langfuse.publicKey,
    secretKey: config.langfuse.secretKey,
    budgetUsd: config.monthlyBudgetUsd,
  });
  const enricher = makeTurnEnricher({
    baseUrl: config.langfuse.baseUrl,
    publicKey: config.langfuse.publicKey,
    secretKey: config.langfuse.secretKey,
  });
  const api = createApiRouter({
    db: { query: (sql, params) => pool.query(sql, params === undefined ? undefined : [...params]) },
    cost,
    enricher,
  });

  const server = createBackofficeServer({
    token: config.token,
    distDir,
    rateLimiter,
    api,
    logger: (msg) => console.error(msg),
  });

  server.listen(config.port, () => {
    console.log(`backoffice up: read-only console listening on :${config.port} (dist ${distDir})`);
    // Warm the Langfuse cost cache (a cold read is ~15-20s over the US region);
    // best-effort so the operator's first Costs view is instant. Never fatal.
    void cost.getCosts().catch((err: unknown) => {
      console.error(`backoffice: cost warm-up skipped — ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  const shutdown = (signal: string): void => {
    console.error(`backoffice: ${signal} — closing`);
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
    // Don't hang forever on a stuck socket.
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
