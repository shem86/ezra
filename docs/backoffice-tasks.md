# Tasks: Ezra Backoffice (Phase 3) — for an autonomous `/goal` run

Implements `docs/backoffice-plan.md` (APPROVED). This ledger is written to be
executed by an autonomous agent. Tasks are ordered by dependency; each is a
single focused unit with **machine-checkable** acceptance. Work top-to-bottom;
do not start a task until its predecessors' verify commands are green.

IDs are `BO-N`. Commit messages should reference them (`backoffice: … (BO-7)`),
matching the repo's T-number convention.

---

## Goal statement (paste into `/goal`)

> Build the Ezra backoffice — a **read-only** operations console — by executing
> `docs/backoffice-tasks.md` top to bottom, one task at a time. It implements
> `docs/backoffice-spec.md` (APPROVED) and `docs/backoffice-plan.md`. After each
> task, run its **Verify** command(s); only commit and advance when green
> (`backoffice: <summary> (BO-N)`). Obey the **Guardrails** below without
> exception. **Stop at the Autonomy boundary** (after BO-17) and hand the
> remaining prod-credentialed steps back to me with a summary of what's left.
> Honor `CLAUDE.md` and `.claude/rules/*` throughout (strict TS, Zod at
> boundaries, no default exports, DI via `deps`, `src/ops/config.ts` is the only
> env reader). If a task needs a decision or a dependency outside the
> pre-approved list, stop and ask rather than guess.

## Guardrails (apply to every task)

1. **Read-only, always.** No mutation routes/handlers; no writes to any real
   DB; no tool-layer or DBOS imports in the backoffice service. Integration
   tests run against the `_test` DB (per `.claude/rules/testing.md`).
2. **No prod, no credentials, no real effects.** Never run `pnpm release`,
   deploy, `pulumi up`, AWS/SSM commands, real WhatsApp/calendar writes, or real
   model calls in CI. Drafting infra *code* is fine; *applying* it is not.
3. **Isolated frontend package.** `backoffice/` has its own
   `package.json`/lockfile/`tsconfig`/eslint. Frontend deps (`react`,
   `react-dom`, `vite`, `@vitejs/plugin-react`, `@types/react*`) go there only —
   never into root `package.json`. Any dep beyond that list ⇒ stop and ask.
4. **Exact pins** (`.npmrc` `save-exact`); commit the lockfile in any
   dep-touching commit.
5. **Verify-then-commit.** A task is done only when its Verify command(s) pass.
   One commit per task (or per small coherent step within it).
6. **Stay in the worktree/branch.** Do not push to `main`; do not open PRs
   unless asked.

## Autonomy boundary

Do **BO-1 … BO-17** (all codeable + in-repo-verifiable, including *drafting* the
IaC/egress/migration code). Then **STOP**. The following are **human-only** and
must be left to the operator (they touch prod or need credentials/real traffic):

- Provision SSM secrets: backoffice bearer token, Tailscale auth key, the
  SELECT-only DB URL.
- Tailscale **first-roll on the live host** (userData is `ignoreChanges`, so
  Pulumi won't run it on prod).
- `pulumi up` (apply the cloud-init + role changes).
- `pnpm release vX.Y.Z` and the release→SSM deploy.
- Over-the-tailnet verification (HTTPS reachable, auth required, screens live,
  zero write path).

Hand these back with a checklist and any values the operator must supply.

---

## B0 — Foundations

### BO-1 · Frontend package scaffold
- **Acceptance:** `backoffice/` exists as an isolated package — `package.json`
  (exact-pinned react/react-dom/vite/@vitejs/plugin-react/@types/react*),
  strict `tsconfig.json`, `eslint.config.js`, `vite.config.ts`, `index.html`,
  `src/main.tsx` mounting an empty `<App/>`.
- **Verify:** `pnpm -C backoffice install && pnpm -C backoffice build` → emits
  `backoffice/dist`. Root `package.json` unchanged.
- **Files:** `backoffice/**`.

### BO-2 · Port the design system
- **Acceptance:** `styles.css` copied verbatim from the prototype's `<style>`;
  primitives ported as typed `.tsx` (`Icon`, `Dot`, `Badge`, `Card`,
  `SectionTitle`, `Cell`, `BarChart`, `sColor`/`tierTone`); a typed `fixtures.ts`
  mirroring the `data.js` shapes (used until live data lands). RTL handling
  preserved.
- **Verify:** `pnpm -C backoffice build`; a Vitest render test mounts each
  primitive without error.
- **Files:** `backoffice/src/components/**`, `backoffice/src/styles.css`,
  `backoffice/src/fixtures.ts`.

### BO-3 · App shell + `focus` dashboard (from fixtures)
- **Acceptance:** sidebar + topbar + hash routing; the **`focus`** dashboard
  layout; all five screen components present, rendering fixture data (tweaks
  panel and the `cards`/`dense` variants are dropped).
- **Verify:** `pnpm -C backoffice build`; render test mounts `<App/>` and each
  route without error.
- **Files:** `backoffice/src/app.tsx`, `backoffice/src/screens/**`.

### BO-4 · Read-only server skeleton + auth
- **Acceptance:** `src/backoffice/server.ts` + `cli.ts` — `node:http`,
  bearer-token auth (constant-time compare, basic rate-limit/lockout), static
  serving of `backoffice/dist`, `GET /api/health`. DI composition reads `Config`.
  No data endpoints yet.
- **Verify:** Vitest unit tests — request without token → 401; with token →
  200; `/api/health` ok. `pnpm build` (compiles `src/backoffice`).
- **Files:** `src/backoffice/server.ts`, `src/backoffice/cli.ts`,
  `tests/unit/backoffice/auth.test.ts`.

### BO-5 · Config vars + `pnpm backoffice` script
- **Acceptance:** `src/ops/config.ts` gains backoffice vars (bearer token,
  SELECT-only `DATABASE_URL`, port) with Zod validation + tests; `.env.example`
  updated; `pnpm backoffice` script added.
- **Verify:** config unit tests pass; `pnpm build && pnpm lint`.
- **Files:** `src/ops/config.ts`, `tests/unit/**config**`, `.env.example`,
  `package.json`.

> **Gate B0:** `pnpm -C backoffice build` + `pnpm build && pnpm lint && pnpm test`
> green; server boots locally and serves the fixture UI; 401 without token.

## B1 — Reference slice: Database

### BO-6 · Read-only query layer
- **Acceptance:** `src/backoffice/queries.ts` — SELECT-only over `lists`,
  `reminders`, `household_facts`, `pending_actions`, `sent_log`,
  `conversation_inbox`, `conversation_context`; Zod row schemas; invented mock
  columns dropped.
- **Verify:** integration tests (`DATABASE_URL`-gated, `_test` DB) return
  correctly-shaped rows; a test asserts the layer issues **only** SELECT (no
  INSERT/UPDATE/DELETE reachable).
- **Files:** `src/backoffice/queries.ts`,
  `tests/integration/backoffice/queries.test.ts`.

### BO-7 · Database endpoints + screen wiring
- **Acceptance:** `GET /api/db/:table` (paged, filterable) on the server; typed
  API client in `backoffice/src/api/`; `DatabaseScreen` + `RowDrawer` render
  live data.
- **Verify:** handler unit test; `pnpm build`; `pnpm -C backoffice build`.
- **Files:** `src/backoffice/server.ts`, `backoffice/src/api/**`,
  `backoffice/src/screens/database.tsx`.

> **Gate B1:** Database screen renders live rows; SELECT-only proven. The
> handler→client→screen slice is now the template for B2.

## B2 — Remaining screens *(independent slices; each copies BO-6/BO-7)*

### BO-8 · Langfuse read spike (de-risk before Logs/Costs)
- **Acceptance:** `spikes/langfuse-read.ts` calls `/api/public/metrics/daily`
  and an observations query with the existing keys; prints the real shape;
  records findings (esp. whether per-observation `usageDetails` carry the
  cache-read split) in a comment.
- **Verify:** run manually with `.env` (`node --env-file=.env spikes/langfuse-read.ts`)
  — not CI. Findings noted.
- **Files:** `spikes/langfuse-read.ts`.

### BO-9 · Costs
- **Acceptance:** `src/backoffice/cost.ts` zero-dep Langfuse read client
  (`metrics/daily` + `v2/metrics`); `GET /api/costs`; `CostsScreen` live; budget
  from Config; cache-read donut degrades gracefully if the split is absent.
- **Verify:** unit tests with a faked `fetch`; `pnpm build` + `pnpm -C backoffice build`.
- **Files:** `src/backoffice/cost.ts`, `backoffice/src/screens/costs.tsx`.

### BO-10 · Logs
- **Acceptance:** DBOS-journal reader (`dbos.workflow_status`) for the turn list
  + Langfuse observations enrichment by trace; `GET /api/logs`; `LogsScreen`
  with the expandable trace row; missing fields render `—`.
- **Verify:** integration test seeds a workflow row in `_test` and asserts the
  list shape; unit test for enrichment merge.
- **Files:** `src/backoffice/journal.ts`, `backoffice/src/screens/logs.tsx`.

### BO-11 · Status (live probes)
- **Acceptance:** `src/backoffice/probes.ts` — Postgres `SELECT 1`+latency,
  pgvector row count, cheap auth pings to Anthropic/Voyage/Langfuse/GCal
  (allowlist-respecting), Baileys liveness from the dead-man/heartbeat;
  `GET /api/status`; `StatusScreen`; `edges[]` static.
- **Verify:** unit tests with faked probe clients (no real network in CI);
  `pnpm build`.
- **Files:** `src/backoffice/probes.ts`, `backoffice/src/screens/status.tsx`.

### BO-12 · Calendar rows (live GCal read)
- **Acceptance:** read-only `events.list` via the existing service-account
  client feeds the Database screen's calendar rows.
- **Verify:** unit test with a faked calendar client; `pnpm build`.
- **Files:** `src/backoffice/calendar.ts`, `backoffice/src/screens/database.tsx`.

### BO-13 · Overview composition
- **Acceptance:** `OverviewScreen` composes KPIs (turns today, errors 24h,
  pending approvals, MTD spend) from the live endpoints above.
- **Verify:** render test; `pnpm -C backoffice build`.
- **Files:** `backoffice/src/screens/overview.tsx`.

> **Gate B2:** all five screens render live data; graceful `—` on missing
> fields; no mock `data.js` in the shipped bundle.

## B3 — Packaging & CI

### BO-14 · Image + compose + healthcheck
- **Acceptance:** `infra/Dockerfile` also runs `pnpm -C backoffice build` and
  includes compiled `src/backoffice`; `infra/docker-compose.prod.yml` gains a
  `backoffice` service (same image, entry `pnpm backoffice`, tailnet-bound,
  shares Postgres); `on-host-deploy.sh` waits for a backoffice `up:` marker.
- **Verify:** `docker compose -f infra/docker-compose.prod.yml config` parses;
  `docker build` locally **if** Docker is available (else note CI is the
  arbiter). No deploy.
- **Files:** `infra/Dockerfile`, `infra/docker-compose.prod.yml`,
  `infra/deploy/on-host-deploy.sh`.

### BO-15 · CI gates
- **Acceptance:** `.github/workflows/ci.yml` adds `pnpm -C backoffice build` +
  lint/tests to the gates and extends the config smoke to boot the backoffice
  entry; PRs build+smoke but never push (unchanged rule).
- **Verify:** workflow YAML is valid; the added steps mirror existing ones.
  (CI actually runs on push — operator-observed.)
- **Files:** `.github/workflows/ci.yml`.

> **Gate B3:** CI green incl. backoffice build + config smoke.

## B4 — IaC / egress / migration *(draft only — apply is human-gated)*

### BO-16 · Egress allowlist additions
- **Acceptance:** `src/ops/egress-allowlist.ts` + nftables mirror gain Tailscale
  coordination/DERP, the Langfuse read-API host, and the GCal API host.
- **Verify:** the allowlist↔nftables **drift test** passes; `pnpm build && pnpm test`.
- **Files:** `src/ops/egress-allowlist.ts`, `infra/egress/**`, tests.

### BO-17 · SELECT-only role + Pulumi cloud-init draft
- **Acceptance:** a forward-only migration (or documented grant) creating the
  SELECT-only role with `USAGE`+`SELECT` on the app, `dbos`, and pgvector
  schemas; `infra/pulumi/cloud-init/render.ts` gains the Tailscale bootstrap
  (install + `tailscale up` from an SSM auth key + `tailscale serve`). **Code
  only — no `pulumi up`.**
- **Verify:** migration applies cleanly on the `_test` DB; `pnpm -C infra/pulumi`
  typechecks/builds. No apply.
- **Files:** `migrations/000X-backoffice-readonly-role.sql`,
  `infra/pulumi/cloud-init/render.ts`, `infra/pulumi/config.ts`.

> **STOP — autonomy boundary.** Hand back the human-only checklist (SSM secrets,
> Tailscale first-roll, `pulumi up`, `pnpm release`, tailnet verification).

---

## Operator handoff checklist (after BO-17)

- [ ] Put secrets in SSM: backoffice bearer token, Tailscale auth key,
      SELECT-only DB URL (under `/hh-assistant/*`).
- [ ] Tailscale first-roll on the live host (one-time; userData is
      `ignoreChanges`).
- [ ] `pulumi up` on the adopt-prod stack (cloud-init + role).
- [ ] Apply the SELECT-only role migration on prod.
- [ ] `pnpm release vX.Y.Z` → watch the release→SSM deploy + auto-rollback.
- [ ] Verify over the tailnet: `*.ts.net` HTTPS reachable, auth required, all
      five screens live, **zero write path**.
