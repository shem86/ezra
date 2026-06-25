// The read-only /api/* router. Dispatches GET requests (the server only ever
// calls this for GET) to the data layers. Read-only by construction: each
// handler is a SELECT/read, returns plain JSON, and there is no mutation path.
// Grows one handler per screen-slice (B2 adds costs/logs/status/overview).

import type { ApiResponse, ApiRouter } from './server.js';
import { isTableKey, queryTable, tableCatalogue, type Queryable } from './queries.js';
import type { CostClient } from './cost.js';
import { getLogs, type TurnEnricher } from './journal.js';
import type { StatusResponse } from './probes.js';
import type { CalendarReader } from './calendar.js';

// The calendar is a virtual, read-only "table" sourced live from Google
// Calendar (no DB table) — listed in the catalogue alongside the real ones.
const CALENDAR_TABLE = 'calendar_events';

export interface ApiDeps {
  /** SELECT-only pool in production (BACKOFFICE_DATABASE_URL → SELECT-only role). */
  readonly db: Queryable;
  /** Langfuse-derived costs (Costs screen); absent until BO-9 wires it. */
  readonly cost?: CostClient | undefined;
  /** Langfuse per-turn enrichment (Logs screen); degrades to `—` if absent. */
  readonly enricher?: TurnEnricher | undefined;
  /** Live health probes (Status screen), cached by the composer. */
  readonly status?: (() => Promise<StatusResponse>) | undefined;
  /** Live Google Calendar read (Database `calendar_events` rows). */
  readonly calendar?: CalendarReader | undefined;
}

function clampLimit(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function createApiRouter(deps: ApiDeps): ApiRouter {
  return {
    async handle(_method: string, url: URL): Promise<ApiResponse | undefined> {
      const path = url.pathname;

      // GET /api/db → the table catalogue (drives the Database rail). The live
      // calendar is appended as a virtual table when available.
      if (path === '/api/db') {
        const tables: { table: string; label: string; icon: string }[] = tableCatalogue();
        if (deps.calendar !== undefined) {
          tables.push({ table: CALENDAR_TABLE, label: CALENDAR_TABLE, icon: 'calendar' });
        }
        return { status: 200, body: { tables } };
      }

      // GET /api/costs → Langfuse-derived (estimated) spend + token economics.
      if (path === '/api/costs') {
        if (deps.cost === undefined) return { status: 503, body: { error: 'costs unavailable' } };
        try {
          return { status: 200, body: await deps.cost.getCosts() };
        } catch {
          // The whole payload comes from Langfuse — there is no journal fallback
          // the way /api/logs has, so a transient read failure (429/timeout/outage)
          // degrades to 503 rather than bubbling to a 500 that blanks the overview.
          return { status: 503, body: { error: 'costs temporarily unavailable' } };
        }
      }

      // GET /api/logs → durable turn list (DBOS journal) + Langfuse enrichment.
      if (path === '/api/logs') {
        const limit = clampLimit(url.searchParams.get('limit'));
        const logs = await getLogs(deps.db, deps.enricher, limit === undefined ? {} : { limit });
        return { status: 200, body: logs };
      }

      // GET /api/status → live health probes.
      if (path === '/api/status') {
        if (deps.status === undefined) return { status: 503, body: { error: 'status unavailable' } };
        return { status: 200, body: await deps.status() };
      }

      // GET /api/db/calendar_events → live Google Calendar read (virtual table).
      if (path === `/api/db/${CALENDAR_TABLE}`) {
        if (deps.calendar === undefined) return { status: 503, body: { error: 'calendar unavailable' } };
        const { columns, rows } = await deps.calendar.list();
        return { status: 200, body: { table: CALENDAR_TABLE, label: CALENDAR_TABLE, icon: 'calendar', columns, rows } };
      }

      // GET /api/db/:table → one table's rows (paged via ?limit).
      if (path.startsWith('/api/db/')) {
        const table = decodeURIComponent(path.slice('/api/db/'.length));
        if (!isTableKey(table)) {
          return { status: 404, body: { error: `unknown table: ${table}` } };
        }
        const limit = clampLimit(url.searchParams.get('limit'));
        const listing = await queryTable(deps.db, table, limit === undefined ? {} : { limit });
        return { status: 200, body: listing };
      }

      return undefined; // no match → server returns 404
    },
  };
}
