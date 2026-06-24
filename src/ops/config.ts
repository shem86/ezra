import { z } from 'zod';

// The ONLY module allowed to read environment/secrets (SPEC src/ops contract).
// Everything else receives a Config through its deps object — never process.env.

// The downloaded key file holds more fields; only these two authenticate
// (ADR-0004): client_email is the JWT issuer, private_key signs it.
const serviceAccountKeySchema = z.looseObject({
  client_email: z.string().min(1),
  private_key: z.string().min(1),
});

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'required — postgres connection string, see .env.example'),
  ANTHROPIC_API_KEY: z.string().min(1, 'required — Claude Console API key'),
  VOYAGE_API_KEY: z.string().min(1, 'required — Voyage AI embeddings key (semantic recall, T28)'),
  // Reasoning = every turn call (ADR-0003); cheap = classification only
  // (compaction summarize, T36 relatedness). Overridable for T33 retuning.
  CHEAP_MODEL_ID: z.string().min(1).default('claude-haiku-4-5-20251001'),
  REASONING_MODEL_ID: z.string().min(1).default('claude-sonnet-4-6'),
  LANGFUSE_PUBLIC_KEY: z.string().min(1, 'required — Langfuse project public key'),
  LANGFUSE_SECRET_KEY: z.string().min(1, 'required — Langfuse project secret key'),
  LANGFUSE_BASE_URL: z.url('must be a URL').default('https://cloud.langfuse.com'),
  ALERT_CHANNEL_TOKEN: z.string().min(1, 'required — independent alert channel bot token'),
  ALERT_CHANNEL_CHAT_ID: z.string().min(1, 'required — Telegram chat id the alerts go to'),
  DEADMAN_PING_URL: z.url('must be a URL — external dead-man check endpoint'),
  WA_SESSION_DIR: z.string().min(1).default('.wa-session'),
  // Open Q1 (resolved at T34): how long a parked confirm-before action waits
  // for approval. Written into expires_at at park time; T37's sweep consumes it.
  APPROVAL_TTL_HOURS: z.coerce.number().positive().default(12),
  // Calendar service-account key (T39/ADR-0004), base64 of the downloaded
  // JSON file. Decoded and validated HERE so a bad paste fails at startup,
  // not at the first calendar call.
  GOOGLE_SA_KEY_B64: z
    .string()
    .min(1, 'required — base64 of the service-account key JSON (ADR-0004)')
    .transform((value, ctx) => {
      try {
        const parsed = serviceAccountKeySchema.parse(
          JSON.parse(Buffer.from(value, 'base64').toString('utf8')),
        );
        return { clientEmail: parsed.client_email, privateKey: parsed.private_key };
      } catch {
        ctx.addIssue({
          code: 'custom',
          message:
            'must be base64 of the service-account key JSON (with client_email and private_key)',
        });
        return z.NEVER;
      }
    }),
  // Per-owner calendar ids (ADR-0004 requester routing). For personal
  // primary calendars the id IS the Gmail address.
  CALENDAR_ID_HUSBAND: z.string().min(1, 'required — calendar id the husband-owner maps to'),
  CALENDAR_ID_WIFE: z.string().min(1, 'required — calendar id the wife-owner maps to'),
});

/** Comma-separated JID list → trimmed non-empty array. */
const jidList = (what: string): z.ZodType<string[], string> =>
  z
    .string({ error: `required — ${what}` })
    .transform((value) =>
      value
        .split(',')
        .map((jid) => jid.trim())
        .filter((jid) => jid.length > 0),
    )
    .refine((jids) => jids.length > 0, { message: `required — ${what}` });

// Production-only vars (T42). A member may appear under several JID forms
// (phone-shaped @s.whatsapp.net AND @lid — see docs/pairing.md), hence lists.
// The conversation allowlist is a hard privacy boundary: the bot runs on a
// PERSONAL number, so without it every chat on the account would flow into
// ingestion, prompts, and traces.
const productionEnvSchema = envSchema.extend({
  WA_JID_HUSBAND: jidList('comma-separated sender JIDs that are the husband'),
  WA_JID_WIFE: jidList('comma-separated sender JIDs that are the wife'),
  WA_HOUSEHOLD_CONVERSATIONS: jidList(
    'comma-separated chat JIDs the bot serves (the household group; optionally the two DMs)',
  ),
});

export interface Config {
  readonly databaseUrl: string;
  readonly anthropicApiKey: string;
  readonly voyageApiKey: string;
  readonly cheapModelId: string;
  readonly reasoningModelId: string;
  readonly langfusePublicKey: string;
  readonly langfuseSecretKey: string;
  readonly langfuseBaseUrl: string;
  readonly alertChannelToken: string;
  readonly alertChannelChatId: string;
  readonly deadmanPingUrl: string;
  readonly waSessionDir: string;
  readonly approvalTtlHours: number;
  readonly googleServiceAccount: { readonly clientEmail: string; readonly privateKey: string };
  readonly calendarIds: { readonly husband: string; readonly wife: string };
}

function formatIssues(issues: Array<{ path: PropertyKey[]; message: string }>): string {
  return issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`).join('\n');
}

// Narrow loader for the standalone transport runner (T13): connecting,
// monitoring, and alerting need no LLM or DB keys — demanding them would be
// a false coupling.
export interface TransportOpsConfig {
  readonly waSessionDir: string;
  readonly alertChannelToken: string;
  readonly alertChannelChatId: string;
  readonly deadmanPingUrl: string;
}

export function loadTransportOpsConfig(
  env: Record<string, string | undefined> = process.env,
): TransportOpsConfig {
  const parsed = envSchema
    .pick({
      WA_SESSION_DIR: true,
      ALERT_CHANNEL_TOKEN: true,
      ALERT_CHANNEL_CHAT_ID: true,
      DEADMAN_PING_URL: true,
    })
    .safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration:\n${formatIssues(parsed.error.issues)}`);
  }
  return {
    waSessionDir: parsed.data.WA_SESSION_DIR,
    alertChannelToken: parsed.data.ALERT_CHANNEL_TOKEN,
    alertChannelChatId: parsed.data.ALERT_CHANNEL_CHAT_ID,
    deadmanPingUrl: parsed.data.DEADMAN_PING_URL,
  };
}

// Narrow loader for the pairing CLI — pairing needs no API keys.
export function loadWaSessionDir(env: Record<string, string | undefined> = process.env): string {
  const parsed = envSchema.pick({ WA_SESSION_DIR: true }).safeParse(env);
  if (!parsed.success) {
    throw new Error('Invalid environment configuration:\n  WA_SESSION_DIR: must be a non-empty path');
  }
  return parsed.data.WA_SESSION_DIR;
}

// Narrow loader for tooling that only touches the database (e.g. the
// migration CLI) — demanding API keys to run DDL would be a false coupling.
export function loadDatabaseUrl(env: Record<string, string | undefined> = process.env): string {
  const parsed = envSchema.pick({ DATABASE_URL: true }).safeParse(env);
  if (!parsed.success) {
    throw new Error('Invalid environment configuration:\n  DATABASE_URL: required');
  }
  return parsed.data.DATABASE_URL;
}

export interface ProductionConfig extends Config {
  /** Sender JID(s) → member, the ledger #12 mapping (prompt + attribution). */
  readonly memberJids: { readonly husband: string[]; readonly wife: string[] };
  /** Chat JIDs the bot serves — everything else is ignored at ingestion. */
  readonly householdConversations: string[];
}

export function loadProductionConfig(
  env: Record<string, string | undefined> = process.env,
): ProductionConfig {
  const parsed = productionEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration:\n${formatIssues(parsed.error.issues)}`);
  }
  return {
    ...loadConfig(env),
    memberJids: {
      husband: parsed.data.WA_JID_HUSBAND,
      wife: parsed.data.WA_JID_WIFE,
    },
    householdConversations: parsed.data.WA_HOUSEHOLD_CONVERSATIONS,
  };
}

// --- Backoffice (read-only console) -----------------------------------------
// The backoffice runs as its OWN process (never inside the spine). Its env is
// the same SSM-delivered file, so its config is a narrow, purpose-built loader
// rather than the full app Config — it must NOT demand alert/dead-man/WA vars
// it never uses (same false-coupling reasoning as loadTransportOpsConfig). The
// data-source keys it does need (SELECT-only DB url, Langfuse, calendar) are
// added to this schema as the screens that use them land (BO-5, B2).
const backofficeEnvSchema = z.object({
  BACKOFFICE_TOKEN: z
    .string()
    .min(32, 'required — long random bearer token (>= 32 chars), defence-in-depth behind the tailnet'),
  BACKOFFICE_PORT: z.coerce.number().int().positive().default(8787),
  // Path to the built SPA (backoffice/dist). In the prod image this is an
  // absolute path baked by the Dockerfile; locally it is repo-relative.
  BACKOFFICE_DIST_DIR: z.string().min(1).default('backoffice/dist'),
  // The SELECT-only role's connection string (BO-17 migration creates the
  // role). DISTINCT from the spine's DATABASE_URL: the console must never hold
  // a write-capable handle. Kept separate so a misconfig fails closed (no
  // silent fallback to the app's read/write URL).
  BACKOFFICE_DATABASE_URL: z
    .string()
    .min(1, 'required — SELECT-only postgres connection string for the read-only console'),
  // Costs-screen monthly ceiling for the budget gauge (display only — the real
  // spend backstop is provider-side, V2 §12). $50 default (Phase 0).
  BACKOFFICE_MONTHLY_BUDGET_USD: z.coerce.number().positive().default(50),
});

export interface BackofficeConfig {
  readonly token: string;
  readonly port: number;
  readonly distDir: string;
  /** SELECT-only role connection string — never the spine's read/write URL. */
  readonly databaseUrl: string;
  readonly monthlyBudgetUsd: number;
}

export function loadBackofficeConfig(
  env: Record<string, string | undefined> = process.env,
): BackofficeConfig {
  const parsed = backofficeEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration:\n${formatIssues(parsed.error.issues)}`);
  }
  return {
    token: parsed.data.BACKOFFICE_TOKEN,
    port: parsed.data.BACKOFFICE_PORT,
    distDir: parsed.data.BACKOFFICE_DIST_DIR,
    databaseUrl: parsed.data.BACKOFFICE_DATABASE_URL,
    monthlyBudgetUsd: parsed.data.BACKOFFICE_MONTHLY_BUDGET_USD,
  };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration:\n${formatIssues(parsed.error.issues)}`);
  }
  return {
    databaseUrl: parsed.data.DATABASE_URL,
    anthropicApiKey: parsed.data.ANTHROPIC_API_KEY,
    voyageApiKey: parsed.data.VOYAGE_API_KEY,
    cheapModelId: parsed.data.CHEAP_MODEL_ID,
    reasoningModelId: parsed.data.REASONING_MODEL_ID,
    langfusePublicKey: parsed.data.LANGFUSE_PUBLIC_KEY,
    langfuseSecretKey: parsed.data.LANGFUSE_SECRET_KEY,
    langfuseBaseUrl: parsed.data.LANGFUSE_BASE_URL,
    alertChannelToken: parsed.data.ALERT_CHANNEL_TOKEN,
    alertChannelChatId: parsed.data.ALERT_CHANNEL_CHAT_ID,
    deadmanPingUrl: parsed.data.DEADMAN_PING_URL,
    waSessionDir: parsed.data.WA_SESSION_DIR,
    approvalTtlHours: parsed.data.APPROVAL_TTL_HOURS,
    googleServiceAccount: parsed.data.GOOGLE_SA_KEY_B64,
    calendarIds: {
      husband: parsed.data.CALENDAR_ID_HUSBAND,
      wife: parsed.data.CALENDAR_ID_WIFE,
    },
  };
}
