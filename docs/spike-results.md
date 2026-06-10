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

## T7 — Prompt-caching spike

**Status: NOT RUN — blocked on `ANTHROPIC_API_KEY`** (no key in the local
environment; the call also spends real money, which is ask-first per SPEC).
Provide a key in `.env` and the spike script can be added/run; the M1 gate
(T10) stays open until this records either `cache_read_input_tokens > 0` or
the `@anthropic-ai/sdk` escape-hatch decision.

## T10 — M1 gate review

**Status: OPEN** — awaiting T7 plus builder sign-off on the 4.19.8 pin above.
