import { z } from 'zod';

// The ONLY module allowed to read environment/secrets (SPEC src/ops contract).
// Everything else receives a Config through its deps object — never process.env.

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'required — postgres connection string, see .env.example'),
  ANTHROPIC_API_KEY: z.string().min(1, 'required — Claude Console API key'),
  VOYAGE_API_KEY: z.string().min(1, 'required — Voyage AI embeddings key (semantic recall, T28)'),
  LANGFUSE_PUBLIC_KEY: z.string().min(1, 'required — Langfuse project public key'),
  LANGFUSE_SECRET_KEY: z.string().min(1, 'required — Langfuse project secret key'),
  LANGFUSE_BASE_URL: z.url('must be a URL').default('https://cloud.langfuse.com'),
  ALERT_CHANNEL_TOKEN: z.string().min(1, 'required — independent alert channel bot token'),
  ALERT_CHANNEL_CHAT_ID: z.string().min(1, 'required — Telegram chat id the alerts go to'),
  DEADMAN_PING_URL: z.url('must be a URL — external dead-man check endpoint'),
  WA_SESSION_DIR: z.string().min(1).default('.wa-session'),
});

export interface Config {
  readonly databaseUrl: string;
  readonly anthropicApiKey: string;
  readonly voyageApiKey: string;
  readonly langfusePublicKey: string;
  readonly langfuseSecretKey: string;
  readonly langfuseBaseUrl: string;
  readonly alertChannelToken: string;
  readonly alertChannelChatId: string;
  readonly deadmanPingUrl: string;
  readonly waSessionDir: string;
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

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration:\n${formatIssues(parsed.error.issues)}`);
  }
  return {
    databaseUrl: parsed.data.DATABASE_URL,
    anthropicApiKey: parsed.data.ANTHROPIC_API_KEY,
    voyageApiKey: parsed.data.VOYAGE_API_KEY,
    langfusePublicKey: parsed.data.LANGFUSE_PUBLIC_KEY,
    langfuseSecretKey: parsed.data.LANGFUSE_SECRET_KEY,
    langfuseBaseUrl: parsed.data.LANGFUSE_BASE_URL,
    alertChannelToken: parsed.data.ALERT_CHANNEL_TOKEN,
    alertChannelChatId: parsed.data.ALERT_CHANNEL_CHAT_ID,
    deadmanPingUrl: parsed.data.DEADMAN_PING_URL,
    waSessionDir: parsed.data.WA_SESSION_DIR,
  };
}
