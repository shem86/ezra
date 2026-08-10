// `pnpm backoffice` entry: read Config, compose the read-only server, listen.
// THE composing caller for the backoffice process (mirrors src/main.ts's role
// for the spine) — the one place env becomes wiring. Prints `backoffice up:`
// once listening; the deploy healthcheck waits for that marker (BO-14).

import { resolve } from 'node:path';
import { Pool } from 'pg';
import { loadBackofficeConfig } from '../ops/config.js';
import { makeGoogleCalendarClient } from '../tools/calendar-client.js';
import { createApiRouter } from './api.js';
import { makeRateLimiter } from './auth.js';
import { makeCalendarReader } from './calendar.js';
import { makeCostClient } from './cost.js';
import { makeTurnEnricher } from './journal.js';
import { makeObservationsSource } from './observations.js';
import {
  makeAnthropicPing,
  makeLangfusePing,
  makeVoyagePing,
  runProbes,
  type StatusResponse,
} from './probes.js';
import { createBackofficeServer } from './server.js';

function main(): void {
  const config = loadBackofficeConfig();
  const distDir = resolve(config.distDir);
  // 8 WRONG tokens from one address *within 15 minutes* → 15-minute lockout.
  // Both qualifiers matter: credential-less requests don't count, and the
  // window slides, so ordinary 401s can't sum into a lockout over days.
  const rateLimiter = makeRateLimiter({ maxFailures: 8, lockoutMs: 15 * 60_000, windowMs: 15 * 60_000 });

  // The SELECT-only pool (BO-17 role). A small pool: this is a single-operator
  // console, not a high-throughput service.
  const pool = new Pool({ connectionString: config.databaseUrl, max: 4 });
  // ONE Langfuse read behind both data screens: Costs aggregates it per day,
  // Logs joins it per trace. Caching, in-flight de-duplication and the failure
  // cache all live in the source, so the two screens can never stampede it.
  const observations = makeObservationsSource({
    baseUrl: config.langfuse.baseUrl,
    publicKey: config.langfuse.publicKey,
    secretKey: config.langfuse.secretKey,
    logger: (msg) => console.error(msg),
  });
  const cost = makeCostClient({ observations, budgetUsd: config.monthlyBudgetUsd });
  const enricher = makeTurnEnricher({ observations });

  const db = { query: (sql: string, params?: readonly unknown[]) => pool.query(sql, params === undefined ? undefined : [...params]) };

  // Calendar client (read-only events.list) — for the Status GCal ping and the
  // Database calendar rows (BO-12). Built from the service-account key.
  const calendar = makeGoogleCalendarClient({
    clientEmail: config.googleServiceAccount.clientEmail,
    privateKey: config.googleServiceAccount.privateKey,
    calendarIds: config.calendarIds,
  });

  // Live status, cached briefly (probes hit external APIs).
  let statusCache: { at: number; value: StatusResponse } | undefined;
  const status = async (): Promise<StatusResponse> => {
    if (statusCache !== undefined && Date.now() - statusCache.at < 30_000) return statusCache.value;
    const value = await runProbes({
      db,
      pingAnthropic: makeAnthropicPing(config.anthropicApiKey),
      pingVoyage: makeVoyagePing(config.voyageApiKey),
      pingLangfuse: makeLangfusePing(config.langfuse.baseUrl, config.langfuse.publicKey, config.langfuse.secretKey),
      pingCalendar: async () => {
        const t = Date.now();
        const win = { start: new Date(), end: new Date(Date.now() + 60_000) };
        await calendar.listEvents('husband', win);
        return Date.now() - t;
      },
    });
    statusCache = { at: Date.now(), value };
    return value;
  };

  const calendarReader = makeCalendarReader(calendar);
  const api = createApiRouter({ db, cost, enricher, status, calendar: calendarReader });

  const server = createBackofficeServer({
    token: config.token,
    distDir,
    rateLimiter,
    api,
    logger: (msg) => console.error(msg),
  });

  server.listen(config.port, () => {
    console.log(`backoffice up: read-only console listening on :${config.port} (dist ${distDir})`);
    // Warm the shared read once — that covers BOTH Costs and Logs, where the
    // old warm-up only ever primed Costs and left Logs to pay a cold fetch.
    // Best-effort; never fatal.
    void observations.recent().catch((err: unknown) => {
      console.error(`backoffice: observation warm-up skipped — ${err instanceof Error ? err.message : String(err)}`);
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
