// The compaction eval harness's env reader — fallback + parse logic (CI-safe).
import { describe, expect, it } from 'vitest';
import { readCompactionEvalEnv } from '../../evals/harness/eval-env.ts';

describe('readCompactionEvalEnv', () => {
  it('defaults to undefined overrides and a limit of 20 on an empty env', () => {
    const e = readCompactionEvalEnv({});
    expect(e.summarizerModelOverride).toBeUndefined();
    expect(e.reportPath).toBeUndefined();
    expect(e.spotcheckDatabaseUrl).toBeUndefined();
    expect(e.spotcheckLimit).toBe(20);
  });

  it('falls back to BACKOFFICE_DATABASE_URL when no explicit spot-check URL', () => {
    expect(readCompactionEvalEnv({ BACKOFFICE_DATABASE_URL: 'postgres://ro@h/db' }).spotcheckDatabaseUrl).toBe(
      'postgres://ro@h/db',
    );
    // The explicit knob wins over the fallback.
    expect(
      readCompactionEvalEnv({
        COMPACTION_SPOTCHECK_DATABASE_URL: 'postgres://explicit@h/db',
        BACKOFFICE_DATABASE_URL: 'postgres://ro@h/db',
      }).spotcheckDatabaseUrl,
    ).toBe('postgres://explicit@h/db');
  });

  it('parses the limit and ignores a non-numeric value', () => {
    expect(readCompactionEvalEnv({ COMPACTION_SPOTCHECK_LIMIT: '5' }).spotcheckLimit).toBe(5);
    expect(readCompactionEvalEnv({ COMPACTION_SPOTCHECK_LIMIT: 'nope' }).spotcheckLimit).toBe(20);
  });

  it('passes through the model override and report path', () => {
    const e = readCompactionEvalEnv({
      COMPACTION_SUMMARIZER_MODEL: 'claude-sonnet-4-6',
      COMPACTION_EVAL_REPORT: '/tmp/r.txt',
    });
    expect(e.summarizerModelOverride).toBe('claude-sonnet-4-6');
    expect(e.reportPath).toBe('/tmp/r.txt');
  });
});
