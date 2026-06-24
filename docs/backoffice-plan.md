# Plan: Ezra Backoffice (Phase 2)

Status: **APPROVED** (2026-06-23). Implements `docs/backoffice-spec.md`.
**Execution model: autonomous AI agent run via `/goal`** — task ledger and the
ready-to-run goal statement live in `docs/backoffice-tasks.md` (Phase 3).

Milestones are `B0…B4` (the `B` namespace avoids colliding with the project's
`M0–M6`). Each milestone ends at a **verification gate** — the next milestone
does not start until the gate is green, mirroring `PLAN.md`'s discipline.

## Components & dependency graph

```
config (src/ops/config.ts vars) ─┐
                                  ├─▶ server skeleton (src/backoffice/server.ts, cli.ts, auth)
SELECT-only DB role ─────────────┘            │
                                              ├─▶ data endpoints (one slice per screen):
frontend scaffold (backoffice/) ──────────────┤      • queries.ts   → Database   (pure SQL)
  design system + shell + focus layout        │      • cost.ts      → Costs      (Langfuse read API)
  typed API client                            │      • journal+obs  → Logs       (DBOS status + Langfuse)
                                              │      • probes.ts    → Status     (live probes)
                                              │      • gcal read    → Database/calendar
                                              │      • compose      → Overview
                                              ▼
                          packaging (Dockerfile, compose, on-host-deploy) ─▶ CI gates
                                              ▼
                          IaC (Pulumi cloud-init Tailscale, egress allowlist) ─▶ ship
```

**Independence that enables parallelism:** each screen is a *vertical slice*
(backend handler → typed client → React screen) that shares only the server
skeleton and the design system. Once **B1** establishes the slice pattern, the
remaining screens in **B2** can be built in parallel. Frontend scaffold, server
skeleton, and config in **B0** can also proceed concurrently.

## Milestones

### B0 — Foundations *(parallel: 3 tracks)*

- **Frontend scaffold** — isolated `backoffice/` package (own
  `package.json`/lockfile/`tsconfig`/eslint, Vite + React 18 + strict TS). Port
  `styles.css` verbatim; port primitives (`Icon`, `Dot`, `Badge`, `Card`,
  `SectionTitle`, `Cell`, `BarChart`); build the app shell (sidebar + topbar +
  **hash routing** — the prototype already uses `location.hash`, so no
  server-side SPA fallback is needed) and the **`focus`** dashboard. Renders
  from a **local typed fixture** (the mock shapes) → visual parity with zero
  backend.
- **Server skeleton** — `src/backoffice/server.ts` + `cli.ts`: `node:http`,
  bearer-token auth middleware (constant-time compare, basic rate-limit/lockout),
  static serving of `backoffice/dist`, `/api/health`, DI composition reading
  `Config`. No data endpoints yet.
- **Config** — add backoffice vars to `src/ops/config.ts` (bearer token,
  SELECT-only DB URL, Tailscale auth-key param name) with schema tests. Decide
  SELECT-only role provisioning: migration vs Pulumi/SSM grant (lean: a small
  forward-only grant in the migrate path).

**Gate B0:** `pnpm -C backoffice build` + `pnpm build/lint/test` green; server
boots locally and serves the UI from the fixture; unauthenticated request → 401.

### B1 — Reference vertical slice: **Database** *(sequential; establishes the pattern)*

Lowest-risk screen (pure SQL), so it sets the template the others copy.

- `queries.ts`: SELECT-only over `lists`, `reminders`, `household_facts`,
  `pending_actions`, `sent_log`, `conversation_inbox`, `conversation_context`;
  Zod row schemas; drop the mock's invented columns.
- `/api/db/:table` endpoints (paged, filterable); typed API client; wire
  `DatabaseScreen` + `RowDrawer` to live data.
- TDD: unit (schema, query-string) + integration (DATABASE_URL-gated, `_test`
  DB) returning correctly-shaped rows; **a test asserting the layer is
  SELECT-only** (no mutation route/handler reachable).

**Gate B1:** Database screen renders live rows from real Postgres; SELECT-only
proven; the handler→client→screen slice pattern is documented for reuse.

### B2 — Remaining screens *(parallel: 4 slices, each copies the B1 pattern)*

- **Costs** — `cost.ts` zero-dep Langfuse read-API client
  (`/api/public/metrics/daily` for MTD/daily/per-model; `v2/metrics` for the
  model table); budget from Config; `CostsScreen`. *Cache-read donut degrades
  alone if observation `usageDetails` lack the split.*
- **Logs** — DBOS journal reader (`dbos.workflow_status`) for the turn list +
  Langfuse observations enrichment keyed by trace; `LogsScreen` with the
  expandable trace row.
- **Status** — `probes.ts`: Postgres `SELECT 1`+latency, pgvector row count,
  cheap auth pings to Anthropic/Voyage/Langfuse/GCal (allowlist-respecting),
  Baileys liveness from the dead-man/heartbeat; `StatusScreen`; `edges[]` stay
  static (recovery-runbook copy).
- **Calendar** — read live via the existing service-account client
  (`events.list`, read-only) for the Database screen's calendar rows.
- **Overview** — compose KPIs (turns today, errors 24h, pending approvals, MTD
  spend) from the above.

**Gate B2:** all five screens live; graceful `—` where a span/field is absent;
no mock `data.js` anywhere.

### B3 — Packaging & CI

- `infra/Dockerfile`: also run `pnpm -C backoffice build` and include compiled
  `src/backoffice` → one immutable image carries spine + backoffice.
- `infra/docker-compose.prod.yml`: add a `backoffice` service (same image,
  entry `pnpm backoffice`), tailnet-bound, sharing Postgres.
- `infra/deploy/on-host-deploy.sh`: wait for a backoffice `up:` marker
  alongside `ezra up:` (extend the 180s window); existing auto-rollback covers it.
- `.github/workflows/ci.yml`: add backoffice build + lint/tests to the gates;
  extend the config smoke to boot the backoffice entry; same push rules
  (PRs smoke-only).

**Gate B3:** CI green incl. backoffice build + config smoke; the prod image
runs the backoffice entry locally.

### B4 — IaC exposure & ship *(launch)*

- **Egress allowlist** (`src/ops/egress-allowlist.ts` + nftables mirror): add
  Tailscale coordination/DERP, the Langfuse read-API host, GCal; pass the drift
  test.
- **Pulumi cloud-init** (`infra/pulumi/cloud-init/render.ts`): install
  `tailscale`, `tailscale up` with an auth key from SSM, `tailscale serve` to
  front the backoffice with its `*.ts.net` HTTPS cert. Provision the
  SELECT-only role. Because prod's `userData` is `ignoreChanges`, apply the
  Tailscale bootstrap **out-of-band on the live host** first, then encode it so
  create-from-zero envs do it automatically.
- **Ship** via `pnpm release vX.Y.Z`; verify over the tailnet: HTTPS reachable,
  auth required, all screens live, **zero write path**, auto-rollback intact.

**Gate B4 (launch):** backoffice reachable at `*.ts.net` over HTTPS behind
auth, serving live data, no write path, deployed by the standard release flow.

## Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Langfuse **observation** spans thin (per-turn cost/tier missing) | Logs columns show `—` | Aggregate Costs already de-risked (Q1). **Spike the Langfuse read API at the start of B2** before building LogsScreen; degrade gracefully. |
| `dbos.workflow_status` shape is SDK-internal, may shift across DBOS versions | Logs/turns list breaks on upgrade | Thin query + Zod-parse + tolerate missing cols; pin to 4.19.8 (already pinned); cover with an integration test. |
| Tailscale **first-roll on protected prod** is out-of-band (userData `ignoreChanges`) | Drift between cloud-init code and live host | Document the one-time host step in `infra/runtime.md`; cloud-init still encodes it for fresh envs; note in the IaC PR. |
| SELECT-only role can't read `dbos`/`pgvector` schemas | Status/Logs queries fail | Grant `USAGE`+`SELECT` on the needed schemas explicitly; integration test runs as that role. |
| Backoffice egress (Langfuse/GCal/Tailscale) blocked by allowlist | Costs/Status/exposure fail silently | Allowlist additions land in **B4** *before* first ship; probes surface a blocked endpoint as `down`. |
| New frontend deps enter the app graph | Violates dep-review boundary | `backoffice/` is an isolated package with its own lockfile — verified by keeping it out of the root install. |

## Parallelization summary

- **B0:** 3 tracks concurrent (frontend / server / config).
- **B1:** sequential — it's the reference slice.
- **B2:** 4 slices concurrent once B1's pattern exists.
- **B3/B4:** mostly sequential (packaging → CI → IaC → ship), though the
  Dockerfile/compose drafts can begin during B2.

## Execution model — autonomous `/goal` agent

The build is driven by a `/goal` agent run, so the milestones above are
decomposed into atomic, **self-verifying** tasks in `docs/backoffice-tasks.md`.
Two things the agent decomposition adds on top of this plan:

- **Autonomy boundary.** The agent does everything that is codeable and
  verifiable **in-repo** — B0–B3 in full, plus *drafting* the B4 IaC / egress /
  migration code (tasks BO-1…BO-17). It **stops** at anything that touches prod
  or needs credentials/real traffic and hands those back to you: SSM secret
  provisioning, the Tailscale first-roll on the live host, `pulumi up`,
  `pnpm release`/deploy, and over-the-tailnet verification.
- **Standing guardrails** (enforced every task): read-only only — no mutation
  routes, no prod writes, integration tests on the `_test` DB; `backoffice/`
  stays an isolated package (frontend deps never enter root `package.json`); no
  `pnpm release` / deploy / AWS / real WhatsApp or calendar writes; honor
  `CLAUDE.md` + `.claude/rules/*`; new deps only within the pre-approved list,
  else stop and ask; verify-then-commit per task.

See `docs/backoffice-tasks.md` for the full ledger and the goal statement to
feed `/goal`.
