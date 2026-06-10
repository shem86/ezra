# DBOS rules (pinned 4.19.8 — validated by T8, `tests/integration/dbos-spike.test.ts`)

## Durable-execution invariants (architecture decision 3)

- Workflow bodies must be **deterministic**: no clock reads, randomness, env
  reads, or direct I/O — enforced by the custom lint rule
  `hh/no-nondeterminism-in-workflow` (`eslint-rules/`). Anything
  nondeterministic lives in a step and gets journaled.
- Every structured-state write goes through a **datasource transaction**
  (`dataSource.registerTransaction` / `runTransaction`) — never a plain step
  or raw query. The app write and the step checkpoint commit in one Postgres
  transaction; that co-commit *is* the exactly-once guarantee.
- External effects use idempotency keys derived from
  `(workflowID, stepNumber)` so recovery replay cannot double-fire them.
- Journal, structured state, and pgvector deliberately share ONE Postgres
  (`systemDatabaseUrl` = `DATABASE_URL`). Never split them — splitting breaks
  the atomic co-commit. Dev must mirror prod on this.

## 4.19.x version-specific gotchas (cost us debugging time — don't relearn)

- `DBOS.registerQueue` must be called **after** `DBOS.launch()` (throws
  before). Workflows (`DBOS.registerWorkflow`) and scheduled workflows
  (`DBOS.registerScheduled`) register **before** launch.
- **Recovery is application-version-scoped.** Pending workflows are only
  claimed by an executor whose app version matches — an MD5 of workflow
  source unless pinned via the `DBOS__APPVERSION` env var, which DBOS reads
  **at SDK import time** (setting it later is a silent no-op). Differently
  transformed copies of identical source (vitest vs `node` type-stripping)
  hash differently; cross-process recovery tests must pin the version (see
  `vitest.config.ts` `test.env`).
- The old `@DBOS.transaction()` decorator is gone. Transactions go through
  `@dbos-inc/node-pg-datasource`; run
  `NodePostgresDataSource.initializeDBOSSchema()` once at setup (creates
  `dbos.transaction_completion`).
- Shutdown race: runtime queue registration can race pool teardown on
  `DBOS.shutdown()` ("Cannot use a pool after calling end") — test suites
  insert a short grace period before shutdown.
- Use the **functional API** (`DBOS.registerWorkflow(fn)`) with *named*
  functions — registration names must be identical in every process that may
  recover the workflow.
- ⚠ Open follow-up (pre-T22): the determinism lint rule currently detects the
  `@DBOS.workflow()` decorator form only; extend it to functions passed to
  `DBOS.registerWorkflow` before writing production workflows.

## Scheduling

- Crontab is the DBOS 6-field variant (optional leading seconds field).
- Reminder times always anchor to the household timezone (Eastern), never
  server time.
