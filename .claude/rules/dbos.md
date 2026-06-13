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
- **Launch-time recovery races datasource initialization.** `DBOS.launch()`
  starts recovering pending workflows inside `executor.init()` BEFORE it
  initializes registered datasources; under load a recovered workflow's
  first un-journaled transaction throws `DataSource <name> is not
  initialized` and the workflow errors **permanently**. Kill/recovery tests
  therefore run children under their own executor ID (`DBOS__VMID`, read at
  SDK import like `DBOS__APPVERSION`) and the parent resumes the workflow
  explicitly post-launch via `DBOS.resumeWorkflow` (public; re-enqueues any
  non-terminal workflow). ✅ Production solved at T42 with the same recipe:
  `src/start.ts` sets a per-generation `DBOS__VMID` before the SDK import
  (launch-time auto-recovery becomes a no-op), and
  `resumeStrandedWorkflows()` (`src/orchestration/recovery.ts`) runs
  explicitly post-launch — finds prior-generation PENDING roots, skips the
  current generation and foreign app versions, resumes the rest. Proven in
  `tests/integration/launch-recovery.test.ts` (in `test:recovery`).
- `DBOS.registerScheduled(fn, …)` requires `fn` to ALREADY be a registered
  workflow — pass the wrapper `DBOS.registerWorkflow` returned (same `name`
  in both calls). A raw function fails **silently-ish**: the scheduler loop
  logs "`… is @scheduled but not a workflow`" every tick and never runs it.
  Scheduled firings run with workflowID `sched-<name>-<ISO time>` on DBOS's
  internal queue.
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
- **Never invoke a registered workflow as a method.** The invoker
  `DBOS.registerWorkflow` returns reads its `this`: a property call like
  `deps.processBatch(batch)` binds `this = deps` and the SDK throws "Attempt
  to call a `workflow` function on an object that is not a
  `ConfiguredInstance`". Destructure the function off the deps object first
  (`const { processBatch } = deps; await processBatch(batch)`) so it runs as a
  free function (`this === undefined`). This bit the prod drain (T42):
  `processBatch` is a step in the test fixtures but the `processTurnBatch`
  child *workflow* in production composition, and only workflows carry the
  check — so green integration tests hid it. The queue fixture now registers
  its `processBatch` as a workflow to guard the regression. Calling via
  `DBOS.startWorkflow(deps.fn, …)` is fine — that path doesn't read `this`.
- The determinism lint rule covers all three workflow forms: `@DBOS.workflow()`
  members, functions passed to `DBOS.registerWorkflow` (inline or same-file
  reference), and bodies returned from factories named `make*Workflow` — the
  src DI pattern, where the body lives in src and registration happens in the
  composing caller. **Name workflow factories `make*Workflow` or the rule
  cannot see them.** Step-wrapper callbacks (`runStep`/`registerStep`/
  `runTransaction`/`registerTransaction`) are exempt by design.

## Scheduling

- Crontab is the DBOS 6-field variant (optional leading seconds field).
- Reminder times always anchor to the household timezone (Eastern), never
  server time.
