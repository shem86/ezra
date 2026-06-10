import { z } from 'zod';

// The ONLY module allowed to read environment/secrets (SPEC src/ops contract).
// Everything else receives a Config through its deps object — never process.env.

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'required — postgres connection string, see .env.example'),
  ANTHROPIC_API_KEY: z.string().min(1, 'required — Claude Console API key'),
  LANGFUSE_PUBLIC_KEY: z.string().min(1, 'required — Langfuse project public key'),
  LANGFUSE_SECRET_KEY: z.string().min(1, 'required — Langfuse project secret key'),
  LANGFUSE_BASE_URL: z.url('must be a URL').default('https://cloud.langfuse.com'),
  ALERT_CHANNEL_TOKEN: z.string().min(1, 'required — independent alert channel bot token'),
  WA_SESSION_DIR: z.string().min(1).default('.wa-session'),
});

export interface Config {
  readonly databaseUrl: string;
  readonly anthropicApiKey: string;
  readonly langfusePublicKey: string;
  readonly langfuseSecretKey: string;
  readonly langfuseBaseUrl: string;
  readonly alertChannelToken: string;
  readonly waSessionDir: string;
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
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return {
    databaseUrl: parsed.data.DATABASE_URL,
    anthropicApiKey: parsed.data.ANTHROPIC_API_KEY,
    langfusePublicKey: parsed.data.LANGFUSE_PUBLIC_KEY,
    langfuseSecretKey: parsed.data.LANGFUSE_SECRET_KEY,
    langfuseBaseUrl: parsed.data.LANGFUSE_BASE_URL,
    alertChannelToken: parsed.data.ALERT_CHANNEL_TOKEN,
    waSessionDir: parsed.data.WA_SESSION_DIR,
  };
}
