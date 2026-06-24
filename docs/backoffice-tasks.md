# Tasks: Ezra Backoffice (Phase 3) — for an autonomous, **end-to-end** `/goal` run

Implements `docs/backoffice-plan.md` (APPROVED). This ledger is written to be
executed by an autonomous agent that **runs to completion with production
access** — it writes the code, gets CI green, applies the IaC, deploys via the
standard release flow, wires Tailscale on the live host, and verifies the
result. When the run finishes, the backoffice is **built, connected, and
working on the host**. There is no mid-run hand-back.

The human's only involvement is **Phase 0** below: a one-time set of
prerequisites that hand the agent the credentials and the single secret a human
must mint (a Tailscale auth key). Do Phase 0 first, then launch `/goal`.

Tasks are `BO-N`, ordered by dependency. Commit messages reference them
(`backoffice: … (BO-7)`), matching the repo's T-number convention.

> **"Read-only" means the product, not the agent.** The backoffice never writes
> to any real datastore (no mutation routes, no tool/DBOS imports, SELECT-only
> DB role). The *agent*, by contrast, is fully empowered: it pushes to `main`,
> runs `pnpm release`, applies Pulumi, and SSHes the prod host. Keep these two
> ideas separate everywhere below.

---

## Phase 0 — Operator prerequisites *(human, ONE TIME, before the run)*

Complete these, then start the `/goal` run. Their purpose is to leave the agent
with **zero blockers** — every credential it needs is already reachable from the
environment you launch it in, and the one secret only a human can produce is
already minted.

- [ ] **Run the agent in a credentialed environment.** The shell that runs
      `/goal` must already have, working and non-interactive:
  - **AWS** credentials that can: assume/serve as the deploy role, write SSM
    SecureStrings under `/hh-assistant/*`, and run `pulumi up` on the
    adopt-prod stack (i.e. the Pulumi state backend + passphrase are reachable,
    `pulumi whoami` succeeds, `aws sts get-caller-identity` succeeds).
  - **GitHub** (`gh auth status` green) with push rights to
    `shem86/hh-assistant` and permission to create releases — `pnpm release`
    pushes a tag and runs `gh release create`.
  - **Prod host SSH**: key-based `ssh ubuntu@98.91.67.226` works
    non-interactively (the `ubuntu` user can sudo; `hh` cannot — see
    `host-sudo-access-path` memory). Needed for the Tailscale first-roll and any
    psql on the prod DB.
- [ ] **Mint a Tailscale auth key** in the Tailscale admin console (reusable or
      ephemeral; tagged so ACLs allow it) and store it as an SSM SecureString,
      e.g. `/hh-assistant/tailscale-authkey`. Confirm the tailnet has **HTTPS
      certificates + MagicDNS enabled** so `tailscale serve` can get a
      `*.ts.net` cert. This is the one secret the agent cannot generate itself.
- [ ] **Confirm the budget number** the Costs screen should show as the monthly
      ceiling (or accept the default the agent picks from Config and flag it).
- [ ] **Tell the agent the release version** to cut (e.g. `v0.8.0`), or let it
      pick the next semver off `main` and report it.

Everything else the agent generates and stores itself (the backoffice bearer
token and the SELECT-only DB password), because Phase 0 gave it SSM write.

> After Phase 0: launch `/goal` with the goal statement below and walk away.

---

## Goal statement (paste into `/goal`)

> Build **and ship** the Ezra backoffice — a read-only operations console — end
> to end, with production access, by executing `docs/backoffice-tasks.md` top to
> bottom, one task at a time. It implements `docs/backoffice-spec.md` (APPROVED)
> and `docs/backoffice-plan.md`. Phase 0 (operator prerequisites) is already
> done, so every credential you need is available and the Tailscale auth key is
> in SSM at `/hh-assistant/tailscale-authkey`. After each task run its
> **Verify** command(s); only commit and advance when green
> (`backoffice: <summary> (BO-N)`). Obey the **Guardrails** without exception.
> Run all the way to **BO-23** — do not stop early or hand back: when you
> finish, the backoffice must be reachable over the tailnet at `*.ts.net` HTTPS,
> behind auth, serving live data, with zero write path. Honor `CLAUDE.md` and
> `.claude/rules/*` throughout (strict TS, Zod at boundaries, no default
> exports, DI via `deps`, `src/ops/config.ts` is the only env reader). If a task
> needs a dependency outside the pre-approved list, add it only after noting
> why; if a `Verify` fails after a genuine fix attempt, deploy auto-rollback or
> CI red is your stop signal — diagnose and fix, do not weaken the gate.

## Guardrails (apply to every task)

1. **The product is read-only.** No mutation routes/handlers; no writes to any
   real datastore from the backoffice; no tool-layer or DBOS imports in the
   backoffice service; the running service connects through the **SELECT-only**
   DB role. Integration tests run against the `_test` DB
   (`.claude/rules/testing.md`).
2. **The agent ships to prod — carefully.** You may push to `main`, run
   `pnpm release`, `pulumi up`, `aws ssm`, and SSH the prod host. The standard
   safety rails still bind: **never commit secrets or Baileys session state**,
   never let credentials enter prompts/traces/the semantic store, **never
   restore Baileys from backup**, never weaken a failing test or lint rule to go
   green (`CLAUDE.md` "Never"). Schema/role changes are forward-only.
3. **Isolated frontend package.** `backoffice/` has its own
   `package.json`/lockfile/`tsconfig`/eslint. Frontend deps (`react`,
   `react-dom`, `vite`, `@vitejs/plugin-react`, `@types/react*`) go there only —
   never into root `package.json`.
4. **Exact pins** (`.npmrc` `save-exact`); commit the lockfile in any
   dep-touching commit.
5. **Verify-then-commit.** A task is done only when its Verify command(s) pass.
   One commit per task (or per small coherent step within it).
6. **Green `main` gates the release.** `pnpm release` requires a clean `main`
   matching origin with a green CI image build. Land all code on `main` and get
   CI green *before* the deploy tasks (B5).

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
  SELECT-only `DATABASE_URL`, port, optional monthly-budget number) with Zod
  validation + tests; `.env.example` updated; `pnpm backoffice` script added.
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
  shares Postgres); `on-host-deploy.sh` waits for a backoffice `up:` marker
  alongside `ezra up:` (extend the 180s window); existing auto-rollback covers it.
- **Verify:** `docker compose -f infra/docker-compose.prod.yml config` parses;
  `docker build` locally if Docker is available (else note CI is the arbiter).
- **Files:** `infra/Dockerfile`, `infra/docker-compose.prod.yml`,
  `infra/deploy/on-host-deploy.sh`.

### BO-15 · CI gates
- **Acceptance:** `.github/workflows/ci.yml` adds `pnpm -C backoffice build` +
  lint/tests to the gates and extends the config smoke to boot the backoffice
  entry; PRs build+smoke but never push (unchanged rule).
- **Verify:** workflow YAML is valid; the added steps mirror existing ones; on
  push to a branch, CI runs green (observe the run).
- **Files:** `.github/workflows/ci.yml`.

> **Gate B3:** CI green incl. backoffice build + config smoke.

## B4 — IaC, egress, SELECT-only role *(code)*

### BO-16 · Egress allowlist additions
- **Acceptance:** `src/ops/egress-allowlist.ts` + nftables mirror gain Tailscale
  coordination/DERP, the Langfuse read-API host, and the GCal API host.
- **Verify:** the allowlist↔nftables **drift test** passes; `pnpm build && pnpm test`.
- **Files:** `src/ops/egress-allowlist.ts`, `infra/egress/**`, tests.

### BO-17 · SELECT-only role migration + Pulumi cloud-init code
- **Acceptance:** a forward-only migration creating the SELECT-only role with
  `USAGE`+`SELECT` on the app, `dbos`, and pgvector schemas (the role's password
  is set out-of-band from the SSM SELECT-only DB URL, **not** hard-coded in the
  migration); `infra/pulumi/cloud-init/render.ts` gains the Tailscale bootstrap
  (install + `tailscale up` from the SSM auth key + `tailscale serve` fronting
  the backoffice port) so a from-zero env wires it automatically. Code lands
  here; it is *applied* in B5.
- **Verify:** migration applies cleanly on the `_test` DB; a `_test`-DB
  integration test connects as the SELECT-only role and proves it can read but
  not write; `pnpm -C infra/pulumi` typechecks/builds.
- **Files:** `migrations/000X-backoffice-readonly-role.sql`,
  `infra/pulumi/cloud-init/render.ts`, `infra/pulumi/config.ts`.

> **Gate B4:** all code merged to a green branch; SELECT-only role proven on
> `_test`; Pulumi workspace builds.

## B5 — Provision, deploy, and verify on prod *(the agent does all of this)*

### BO-18 · Generate + store the agent-owned secrets in SSM
- **Acceptance:** mint a strong backoffice bearer token and a strong SELECT-only
  DB password; store both as SSM SecureStrings under `/hh-assistant/*`
  (e.g. `/hh-assistant/backoffice-token`, `/hh-assistant/backoffice-db-url` with
  the full SELECT-only connection string). Values never touch git, prompts, or
  traces.
- **Verify:** `aws ssm get-parameter --with-decryption` returns each; the
  values match what the migration/role and Config expect.
- **Files:** none in-repo (SSM only); note the param names in the deploy log.

### BO-19 · Land on `main`, CI green
- **Acceptance:** merge the backoffice branch into `main` (fast-forward / PR as
  the repo allows); the CI image build for that `main` commit is green.
- **Verify:** `git log origin/main` shows the backoffice commits; the GHCR image
  for `:main` (or the release SHA) exists; CI run is green.
- **Files:** none (git/CI).

### BO-20 · `pulumi up` (adopt-prod): egress + role + cloud-init
- **Acceptance:** apply the Pulumi adopt-prod stack so the egress allowlist,
  SELECT-only role provisioning hook, and encoded cloud-init are in state. Note
  the prod instance's `userData` is `ignoreChanges` — `pulumi up` will **not**
  re-run cloud-init on the existing box; that's why BO-22 rolls Tailscale
  out-of-band. The diff must be intentional (no instance replacement).
- **Verify:** `pulumi up` succeeds with no resource that would replace the live
  instance/volume; `pulumi preview` afterward is clean.
- **Files:** none beyond what BO-16/BO-17 produced.

### BO-21 · Release + deploy (release → SSM)
- **Acceptance:** cut the release with `pnpm release vX.Y.Z` (version from Phase
  0 or the next semver). This blocks on the CI image build, then fires the
  release→SSM deploy: migrate-gate runs the BO-17 migration (creating the
  SELECT-only role/grants), `up -d` starts the spine **and** the new backoffice
  service, healthcheck waits for both `ezra up:` and the backoffice marker, with
  auto-rollback on failure. Set the SELECT-only role's **password** on prod
  (psql over SSH) to match the SSM `backoffice-db-url`.
- **Verify:** the deploy run reaches healthy (no auto-rollback); on the host,
  `docker compose ps` shows the backoffice container up and the spine healthy;
  the backoffice can connect with the SELECT-only URL.
- **Files:** none (release/deploy); record the version cut.

### BO-22 · Tailscale first-roll + serve on the live host
- **Acceptance:** over `ssh ubuntu@98.91.67.226`: install `tailscale`,
  `tailscale up` using the auth key from `/hh-assistant/tailscale-authkey`, then
  `tailscale serve` to front the backoffice's tailnet-bound port with the
  node's `*.ts.net` HTTPS cert. No public inbound port is opened (the SG stays
  SSH-only ingress). This mirrors the cloud-init encoded in BO-17 for from-zero
  envs; document the one-time host step in `infra/runtime.md`.
- **Verify:** `tailscale status` shows the node online; `tailscale serve status`
  shows the backoffice fronted on HTTPS; the SG still has no new public ingress.
- **Files:** `infra/runtime.md` (document the one-time step).

### BO-23 · End-to-end verification over the tailnet
- **Acceptance:** from a tailnet client, the backoffice is reachable at
  `https://<host>.<tailnet>.ts.net`, **requires auth** (401 without the bearer
  token, 200 with it), serves **live** data on all five screens (Overview,
  Database, Logs, Costs, Status), and exposes **zero write path** (no mutation
  route responds). Steady-state health (the spine's hc-ping dead-man) is intact.
- **Verify:** curl without token → 401; with token → 200 + live JSON on each
  `/api/*`; a probe for any mutating method returns 404/405; screens load in a
  browser over the tailnet. Report the URL and the result.
- **Files:** none — this is the final acceptance.

> **Done:** the backoffice is built, connected, and working on the host —
> reachable over the tailnet behind auth, serving live read-only data, deployed
> by the standard release flow with auto-rollback intact.
