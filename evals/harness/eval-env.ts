// The compaction eval harness's single env reader (docs/compaction-eval-spec.md).
// src/ops/config.ts is the ONLY env reader in src/ (conventions.md); evals are
// scaffolding outside that rule (like spikes), but we keep the same shape — ONE
// place touches process.env — so the eval files stay env-free and the knobs are
// unit-testable. These vars are eval-only and deliberately NOT part of the app
// Config: a report path, a model override, a spot-check source DB.

export interface CompactionEvalEnv {
  /** Override the summarizer model id — run the same fixtures through Haiku vs
   *  Sonnet to compare. Undefined ⇒ config.cheapModelId (production default). */
  readonly summarizerModelOverride: string | undefined;
  /** Write the run's report here (vitest's run reporter swallows console.log). */
  readonly reportPath: string | undefined;
  /** Prod spot-check source DB — the SELECT-only role; falls back to
   *  BACKOFFICE_DATABASE_URL. Undefined ⇒ the spot-check suite skips. */
  readonly spotcheckDatabaseUrl: string | undefined;
  /** How many recent compaction_log rows the spot-check scores (default 20). */
  readonly spotcheckLimit: number;
}

export function readCompactionEvalEnv(
  env: Record<string, string | undefined> = process.env,
): CompactionEvalEnv {
  const limit = Number.parseInt(env.COMPACTION_SPOTCHECK_LIMIT ?? '20', 10);
  return {
    summarizerModelOverride: env.COMPACTION_SUMMARIZER_MODEL,
    reportPath: env.COMPACTION_EVAL_REPORT,
    spotcheckDatabaseUrl: env.COMPACTION_SPOTCHECK_DATABASE_URL ?? env.BACKOFFICE_DATABASE_URL,
    spotcheckLimit: Number.isFinite(limit) ? limit : 20,
  };
}
