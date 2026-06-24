// Status — LIVE health probes (not stored snapshots). Postgres SELECT 1 +
// latency, pgvector row count, cheap auth pings to Anthropic/Voyage/Langfuse,
// a Google Calendar read, and Baileys/spine liveness DERIVED from the
// scheduler heartbeat (the minute-cadence reminderSweepCron in the spine
// process — the backoffice can't see the socket, so it reads the journal the
// spine writes). External pings respect the egress allowlist (BO-16 adds the
// new hosts). Reliability edges are static copy from the recovery runbook.

import type { Queryable } from './queries.js';

export interface ServiceRow {
  name: string;
  group: string;
  status: 'operational' | 'degraded' | 'down';
  latency: string;
  uptime: string;
  detail: string;
}
export interface EdgeRow {
  name: string;
  status: string;
  detail: string;
}
export interface StatusResponse {
  services: ServiceRow[];
  edges: EdgeRow[];
  turnsToday: number;
  avgLatency: string;
}

// Static — from docs/recovery-runbook.md (the spec keeps these as copy).
export const RELIABILITY_EDGES: EdgeRow[] = [
  { name: 'Ingestion', status: 'ok', detail: 'Durably enqueued before ack · dedupe on replay' },
  { name: 'Durable execution', status: 'ok', detail: 'Exactly-once · co-committed checkpoints' },
  { name: 'External effects', status: 'ok', detail: 'Deterministic ids · 409 folds to success' },
  { name: 'Recovery', status: 'ok', detail: 'Encrypted PITR · mechanical reconciliation' },
  { name: 'Liveness', status: 'ok', detail: 'Independent alert channel (dead-man)' },
];

/** A cheap auth ping: returns latency ms on success, throws on failure. */
export type Ping = () => Promise<number>;

export interface ProbeDeps {
  readonly db: Queryable;
  readonly pingAnthropic: Ping;
  readonly pingVoyage: Ping;
  readonly pingLangfuse: Ping;
  readonly pingCalendar: Ping;
  readonly now?: () => number;
}

const PROBE_TIMEOUT_MS = 12_000;
const SWEEP_STALE_MS = 180_000; // 3× the 1-minute sweep cadence

function fmtMs(ms: number): string {
  return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms';
}

async function timed(ping: Ping): Promise<{ status: ServiceRow['status']; latency: string; detail?: string }> {
  try {
    const ms = await Promise.race([
      ping(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), PROBE_TIMEOUT_MS)),
    ]);
    return { status: 'operational', latency: fmtMs(ms) };
  } catch (e) {
    return { status: 'down', latency: '—', detail: e instanceof Error ? e.message.slice(0, 80) : 'error' };
  }
}

// --- default ping implementations (composed by cli; faked in tests) ---------

export function makeAnthropicPing(apiKey: string, fetchFn: typeof fetch = fetch): Ping {
  return async () => {
    const t = Date.now();
    const res = await fetchFn('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Date.now() - t;
  };
}

export function makeVoyagePing(apiKey: string, fetchFn: typeof fetch = fetch): Ping {
  return async () => {
    const t = Date.now();
    // Empty input → 400 when AUTHED (no embedding generated, no spend); 401/403
    // means the key is bad. Anything that isn't an auth rejection = reachable.
    const res = await fetchFn('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ input: [], model: 'voyage-3-lite' }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.status === 401 || res.status === 403) throw new Error(`auth HTTP ${res.status}`);
    return Date.now() - t;
  };
}

export function makeLangfusePing(
  baseUrl: string,
  publicKey: string,
  secretKey: string,
  fetchFn: typeof fetch = fetch,
): Ping {
  const auth = 'Basic ' + Buffer.from(`${publicKey}:${secretKey}`).toString('base64');
  return async () => {
    const t = Date.now();
    const res = await fetchFn(`${baseUrl.replace(/\/$/, '')}/api/public/projects`, {
      headers: { authorization: auth },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Date.now() - t;
  };
}

// --- the orchestrator -------------------------------------------------------

export async function runProbes(deps: ProbeDeps): Promise<StatusResponse> {
  const now = deps.now ?? Date.now;

  async function pgProbe(): Promise<ServiceRow> {
    const t = now();
    try {
      await deps.db.query('SELECT 1');
      return { name: 'Postgres', group: 'Core', status: 'operational', latency: fmtMs(now() - t), uptime: '', detail: 'journal + state, co-committed' };
    } catch (e) {
      return { name: 'Postgres', group: 'Core', status: 'down', latency: '—', uptime: '', detail: e instanceof Error ? e.message.slice(0, 80) : 'error' };
    }
  }

  async function pgvectorProbe(): Promise<ServiceRow> {
    try {
      const { rows } = await deps.db.query('SELECT count(*)::int AS n FROM semantic_memories');
      const n = (rows[0] as { n?: number } | undefined)?.n ?? 0;
      return { name: 'pgvector memory', group: 'Core', status: 'operational', latency: '—', uptime: '', detail: `${n.toLocaleString()} embeddings` };
    } catch (e) {
      return { name: 'pgvector memory', group: 'Core', status: 'down', latency: '—', uptime: '', detail: e instanceof Error ? e.message.slice(0, 80) : 'error' };
    }
  }

  // Spine + Baileys liveness from the scheduler heartbeat (reminderSweepCron,
  // every minute, runs in the spine process that hosts the WhatsApp socket).
  async function livenessProbes(): Promise<ServiceRow[]> {
    let ageMs: number | null = null;
    try {
      const { rows } = await deps.db.query(
        `SELECT max(created_at) AS last FROM dbos.workflow_status WHERE name = 'reminderSweepCron'`,
      );
      const last = (rows[0] as { last?: string | number | null } | undefined)?.last;
      if (last !== null && last !== undefined) ageMs = now() - Number(last);
    } catch {
      ageMs = null;
    }
    const fresh = ageMs !== null && ageMs < SWEEP_STALE_MS;
    const status: ServiceRow['status'] = ageMs === null ? 'degraded' : fresh ? 'operational' : 'down';
    const ageTxt = ageMs === null ? 'no heartbeat seen' : `last sweep ${fmtMs(ageMs)} ago`;
    return [
      { name: 'DBOS scheduler', group: 'Core', status, latency: '—', uptime: '', detail: `minute-cadence heartbeat · ${ageTxt}` },
      { name: 'WhatsApp (Baileys)', group: 'Transport', status, latency: '—', uptime: '', detail: `liveness via spine heartbeat · ${ageTxt}` },
    ];
  }

  async function externalProbe(name: string, group: string, ping: Ping, detail: string): Promise<ServiceRow> {
    const r = await timed(ping);
    return { name, group, status: r.status, latency: r.latency, uptime: '', detail: r.detail ?? detail };
  }

  async function metrics(): Promise<{ turnsToday: number; avgLatency: string }> {
    try {
      const startOfDay = Math.floor(now() / 86_400_000) * 86_400_000;
      const { rows } = await deps.db.query(
        `SELECT count(*)::int AS turns,
                COALESCE(avg(completed_at - created_at) FILTER (WHERE completed_at IS NOT NULL), 0)::int AS avg_ms
         FROM dbos.workflow_status
         WHERE name = 'handleTurn' AND created_at >= $1`,
        [startOfDay],
      );
      const r = rows[0] as { turns?: number; avg_ms?: number } | undefined;
      return { turnsToday: r?.turns ?? 0, avgLatency: r?.avg_ms ? fmtMs(r.avg_ms) : '—' };
    } catch {
      return { turnsToday: 0, avgLatency: '—' };
    }
  }

  const [pg, pgv, liveness, anthropic, voyage, langfuse, calendar, m] = await Promise.all([
    pgProbe(),
    pgvectorProbe(),
    livenessProbes(),
    externalProbe('Anthropic API', 'Models', deps.pingAnthropic, 'claude-sonnet / haiku'),
    externalProbe('Voyage API', 'Models', deps.pingVoyage, 'voyage embeddings'),
    externalProbe('Langfuse tracing', 'Observability', deps.pingLangfuse, 'trace + read API'),
    externalProbe('Google Calendar', 'Integrations', deps.pingCalendar, 'service-account read'),
    metrics(),
  ]);

  return {
    services: [pg, pgv, ...liveness, anthropic, voyage, langfuse, calendar],
    edges: RELIABILITY_EDGES,
    turnsToday: m.turnsToday,
    avgLatency: m.avgLatency,
  };
}
