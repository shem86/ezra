# Testing rules

## Taxonomy (SPEC "Testing Strategy")

1. **Unit** (`tests/unit/`, CI, no DB/network): pure logic — debounce
   grouping, idempotency-key derivation, send-class selection, status-transition
   guards, Zod schemas. Also `eslint-rules/*.test.ts` (RuleTester fixtures).
2. **Integration** (`tests/integration/`, CI + local): DBOS workflows against
   real Postgres — recovery replay, exactly-once writes, execute-once guards,
   queue ordering. **Gated on `DATABASE_URL`**: the suite is excluded from the
   vitest `include` list when the env var is absent, so unit tests run
   anywhere. CI sets it via the pgvector service container.
   **Runs against a dedicated `<dbname>_test` database, never the app's**
   (issue #5): you point `DATABASE_URL` at the app DB as before, but
   `vitest.config.ts` derives the `_test` sibling on the same server and
   overrides `DATABASE_URL` for every worker (and the fixture child processes
   they spawn with `env: process.env`); `tests/integration/global-setup.ts`
   creates that database once before the suite. This keeps the locked
   single-Postgres co-location *within* the test environment while stopping
   test-stranded workflows/reminders from poisoning a real `pnpm start`. The
   derivation lives in `tests/integration/helpers/test-database-url.ts`
   (idempotent: an already-`_test` URL passes through).
3. **Eval** (`evals/`, M5+, on-demand only): model-in-the-loop decision-9
   scenarios. Never in CI.

**Never in CI:** real WhatsApp traffic, real calendar writes, real model calls.

## Discipline

- TDD: failing test first (RED), minimal code to green, then refactor. Bug
  fixes start with a reproduction test that fails (Prove-It), then the fix.
- Test state/outcomes, not internals. Prefer real Postgres over mocks for
  anything DBOS-touching — the integration suite exists precisely because
  mocked durability proves nothing.
- Don't re-run an already-green command unless code changed since.
- Never skip/weaken a failing test to get CI green (SPEC "Never").

## Recovery-test patterns (from the T8 spike — reuse, don't reinvent)

- **Kill-mid-flight:** spawn the workflow in a child `node` process, poll the
  DB for the first effect, `SIGKILL`, then `DBOS.launch()` in the test process
  and await `DBOS.retrieveWorkflow(id).getResult()`. Assert output identical
  to an uninterrupted run and each effect count == 1.
- Pin `DBOS__APPVERSION` for any cross-process recovery test (vitest
  `test.env`) — recovery only claims matching app versions, and the var is
  read at SDK import time.
- Make workflow IDs unique per test run (`Date.now()` suffix) so stale
  PENDING workflows from aborted runs can't collide.
- Tests within a spike/recovery file run sequentially and may share one
  launched DBOS runtime; the test that must observe a *pending* workflow
  before recovery goes first, since `DBOS.launch()` triggers recovery.
- Integration tests assume `docker compose up -d` Postgres; remember the
  dead-database failure mode reads as ECONNREFUSED, and Colima (not the code)
  is the usual suspect locally — CI is the arbiter.
- The suite runs against `hh_assistant_test` (issue #5, above), auto-created on
  first run; migrations are forward-only and tests own their rows, so residue
  accumulates there by design and never touches the app DB. To wipe test state:
  `docker exec hh-postgres psql -U hh -d postgres -c 'DROP DATABASE hh_assistant_test'`
  (next run recreates it), or `docker compose down -v` to reset everything. The
  app DB is never the one to reset for a test problem.
