# M1 spike results

## T8 — DBOS semantics spike (2026-06-09)

**Verdict: PASS. DBOS pinned at `@dbos-inc/dbos-sdk` 4.19.8 (+ `@dbos-inc/node-pg-datasource` 4.19.8).**

`tests/integration/dbos-spike.test.ts` proves, against the single dev Postgres
(`docker compose up -d`), everything the architecture leans on:

1. **Transactional step atomicity / exactly-once** — a datasource transaction's
   app-state write commits atomically with its checkpoint
   (`dbos.transaction_completion` in the same DB); re-running the same
   `workflowID` returns the same output without re-applying the write.
2. **Kill-mid-flight recovery** — child process SIGKILLed between steps;
   `DBOS.launch()` in a fresh process recovers the pending workflow, replays
   the completed step from the journal (no double effect), executes the
   remaining step exactly once, and produces output identical to an
   uninterrupted run.
3. **Queue concurrency-1 FIFO** — five enqueued workflows execute serially in
   enqueue order.
4. **Scheduled workflows fire** (6-field crontab, `DBOS.registerScheduled`).
5. **Co-residence** — DBOS journal (`dbos` schema), app state, and the
   pgvector extension all live in the one `hh_assistant` database
   (`systemDatabaseUrl` = app `DATABASE_URL`).

### Version-specific findings (4.19.x)

- **Queues register at runtime**: `DBOS.registerQueue` must be called *after*
  `DBOS.launch()` (throws before). Workflows and scheduled workflows register
  *before* launch.
- **Recovery is application-version-scoped**: pending workflows are only
  claimed by an executor whose app version matches. The version is an MD5 of
  workflow source unless pinned via `DBOS__APPVERSION`, which DBOS reads **at
  SDK import time**. Differently-transformed copies of the same source (vitest
  vs `node` type-stripping) hash differently — production deploys that expect
  recovery across restarts must keep workflow source stable or pin the version
  explicitly. The spike pins it through vitest `test.env`.
- **Transactions are datasource-based**: the old `@DBOS.transaction()` is gone;
  use `@dbos-inc/node-pg-datasource` (`dataSource.registerTransaction` /
  `runTransaction`), with `NodePostgresDataSource.initializeDBOSSchema()` run
  once at setup.
- **Shutdown race**: runtime queue registration can race pool teardown on
  `DBOS.shutdown()` ("Cannot use a pool after calling end"); the suite inserts
  a short grace period. Revisit if it flakes in CI.

### Follow-up for M3

- The T9 determinism lint rule matches the `@DBOS.workflow()` decorator form.
  The spike (and likely the production code) uses the functional
  `DBOS.registerWorkflow(fn)` API — **extend the rule to cover functions
  passed to `DBOS.registerWorkflow` before T22** (tracked as part of T22's
  acceptance, or a small T9 follow-up at M3 entry).

## T7 — Prompt-caching spike (2026-06-09)

**Verdict: PASS — `cache_control` works through AI SDK Core provider
passthrough. No `@anthropic-ai/sdk` escape hatch needed.**

`spikes/cache-control.ts` (`node --env-file=.env spikes/cache-control.ts`),
pinned at `ai` 6.0.199 + `@ai-sdk/anthropic` 3.0.82, model `claude-haiku-4-5`,
~6.1k-token stable system prefix with
`providerOptions.anthropic.cacheControl: { type: 'ephemeral' }`:

- Cold call: `cache_creation_input_tokens: 6135`, `cache_read_input_tokens: 0`
- Every subsequent call (different user questions, two separate process runs):
  `cache_read_input_tokens: 6135`, only 14 uncached input tokens per request

Notes for M4 (`callModel`):
- The AI SDK surfaces the numbers in `result.usage.inputTokenDetails`
  (`cacheReadTokens`/`cacheWriteTokens`) and raw Anthropic usage under
  `result.providerMetadata.anthropic.usage`.
- `providerOptions` attach to a system *message* (requires
  `allowSystemInMessages: true`), not to the plain `system:` string option.
- Haiku-class minimum cacheable prefix is 2048 tokens — shorter prefixes
  silently don't cache.

## T10 — M1 gate review

**CLOSED 2026-06-09** — builder accepted the gate: caching confirmed via T7
(no escape hatch), DBOS pin 4.19.8 accepted per T8 findings above. Follow-up
carried into M3: extend the T9 determinism rule to the functional
`DBOS.registerWorkflow` API before T22.
