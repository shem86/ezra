# Spec: Ezra Backoffice

Status: **APPROVED** (2026-06-23) — Phase 1 complete, all decisions confirmed.
Plan: `docs/backoffice-plan.md` (Phase 2).

## Objective

A single-operator, **read-only** web console for the Ezra WhatsApp household
assistant — an "observatory" over the live system: what it did (turns/logs),
what it knows (database), what it costs (tokenomics), and whether it's healthy
(status). The goal is operational visibility for the builder, not control.

**Imported design:** `claude.ai/design` project `Ezra Backoffice`
(`2be735ac-eb4c-44ab-8f23-bea685bff1fe`) — a React prototype with mock data.
Five screens, one warm-neutral design system, Hebrew/English RTL-aware. The
build ports the *look and components* faithfully and replaces the mock with
real, read-only data.

**User:** one person (the builder). The data is **real household PII** — phone
numbers, message summaries, facts. This is the dominant constraint: the console
must never be openly reachable, and it must never be able to mutate prod.

**Success = ** all five screens render live data from the running EC2 system,
behind authenticated HTTPS, with zero write paths reachable from the UI, and CI
green to the repo's existing bar (build + lint + test).

### Decisions locked with the user (2026-06-23)

1. **Scope: read-only observatory.** No mutations in v1. The prototype's
   Approve/Deny and Edit-row controls stay visible-but-disabled. Any mutation
   (e.g. approving a parked action through the HITL layer) is a clearly-scoped
   **Phase 2**, out of this spec.
2. **Exposure: Tailscale — reachable-from-anywhere, auth-gated, no public port**
   (confirmed 2026-06-23). Original choice was on-host HTTPS with one inbound
   nftables port; superseded by Tailscale, which also provides TLS. Open-port +
   Caddy remains the documented fallback.
3. **Stack: Vite + React + TS workspace** in this repo, built to repo
   conventions (strict TS, Zod boundaries, exact pins, `config.ts`-only env).

### Resolutions — round 2 (2026-06-23)

- **Q1 Langfuse read API — RESOLVED, available.** Langfuse Cloud exposes
  `GET /api/public/metrics/daily` (date · totalCost · per-model
  input/output/total usage + cost) and `GET /api/public/v2/metrics` (custom
  aggregation), HTTP Basic auth with the **existing**
  `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY`/`LANGFUSE_BASE_URL`. **No local
  usage ledger needed.** Costs ← `metrics/daily`; cost-by-model ← `v2/metrics`
  by `providedModelName`; Logs per-turn enrichment ← observations API by trace.
  *Caveat:* the cache-read split (token-economics donut) is best-effort from
  observation `usageDetails`; if absent, that one widget degrades, nothing else.
- **Q2 TLS + Q3 Exposure — CONFIRMED: Tailscale (solves both).**
  Put the host on a **Tailscale** tailnet and bind the backoffice to the
  tailnet interface only. `tailscale serve` fronts it with a **valid
  auto-provisioned Let's Encrypt cert** on the device's `*.ts.net` MagicDNS
  name — so: **no public inbound port** (nftables unchanged), **no cert
  provenance problem** (no self-signed warning, no domain to buy), encrypted by
  default, free tier covers a personal tailnet, reach-from-anywhere preserved.
  This collapses Q2 and Q3 into one clean answer and removes the only new public
  attack surface. App-level bearer-token auth stays as defence-in-depth.
  **Fallback** if you'd rather not run a tailnet: original on-host HTTPS +
  Caddy (internal CA or DuckDNS+Let's Encrypt) + one nftables port.
- **Q4 Calendar — RESOLVED: read live from Google Calendar API.** The Database
  screen's `calendar_events` is sourced live via the existing service-account
  client (read-only `events.list`), not a local table. Adds an egress call +
  latency; must respect the egress allowlist.
- **Q5 Baileys liveness — RESOLVED: derive from dead-man/heartbeat.** Status
  reports Baileys liveness from the dead-man signal / a heartbeat row, since the
  socket state lives in the spine process, not the backoffice.
- **Q6 Dashboard layout — RESOLVED: `focus`** (spend card + approvals up top,
  then KPI row, then recent-turns + health). The `cards`/`dense` variants are
  dropped.

## Tech Stack

- **Frontend:** Vite + React 18 + TypeScript (strict). `backoffice/` is an
  **isolated sub-package** with its own `package.json`, lockfile, and
  `tsconfig.json` — mirroring the `infra/pulumi` pattern, *not* a root pnpm
  workspace. This deliberately keeps Vite's React/TS toolchain out of the app's
  strict TS 6 / DBOS-determinism-lint scope (the same reason `infra/pulumi`
  pins its own TS). CSS ported verbatim from the prototype's `<style>` block
  (OKLCH warm-neutral system). Prototype's in-browser Babel, mock `data.js`,
  tweaks panel, and the 3 layout variants are **dropped**; the `focus` layout is
  kept.
- **Backend:** a **separate** read-only HTTP service — its own process, *not*
  the durable spine. No DBOS, no tool layer, no write paths by construction.
  Opens a read-only Postgres pool (ideally as a dedicated read-only DB role).
  Proposed: zero-dep `node:http`/`node:https` + Zod-validated handlers,
  matching the repo's zero-dep ethos (ADR-0002 precedent: Voyage/Langfuse
  clients are hand-rolled). New entry `src/backoffice/` + `pnpm backoffice`.
- **Serving:** the Vite production build is emitted to static assets the
  backoffice service serves; the same service serves `/api/*`. One process, one
  port, one TLS endpoint.
- **Auth:** single long random bearer token (or signed httpOnly cookie set from
  it); constant-time compare; basic rate-limit / lockout. Token in `config.ts`
  only. Kept as defence-in-depth even behind the tailnet.
- **TLS + exposure:** **Tailscale** (recommended, see round-2 resolution) — bind
  to the tailnet interface; `tailscale serve` provides the HTTPS cert on the
  `*.ts.net` name; no public port. Fallback: Caddy + one nftables port.
- **Costs/Logs data:** Langfuse read API (`/api/public/metrics/daily`,
  `/api/public/v2/metrics`, observations) via a hand-rolled zero-dep client
  reusing the existing Langfuse keys (mirrors the langfuse-*sink* precedent,
  now a *source*).

## Commands

```
pnpm backoffice          # run the read-only API + built static UI (prod; src/backoffice/cli.ts)
pnpm -C backoffice dev    # Vite dev server (UI only, proxied to a local API)
pnpm -C backoffice build  # typecheck + Vite production build → backoffice/dist
pnpm -C backoffice lint   # the frontend's own eslint (isolated, like infra/pulumi)
pnpm build               # repo tsc — now also compiles src/backoffice/** (server is app code)
pnpm lint                # eslint . — covers src/backoffice; backoffice/ lints itself
pnpm test                # vitest (adds API-handler unit tests; integration gated on DATABASE_URL)
```

The frontend is built/linted on its own (`pnpm -C backoffice …`), like
`infra/pulumi`; the read-only **server** is app code under `src/backoffice/` and
rides the repo's existing `pnpm build`/`lint`/`test`. Exact scripts finalize in
Tasks.

## Project Structure

```
backoffice/                  → isolated sub-package (own deps/lockfile/tsconfig): the React SPA
  src/
    main.tsx, app.tsx        → shell (sidebar + topbar + routing)
    screens/                 → overview, database, logs, costs, status
    components/              → ported primitives (Icon, Dot, Badge, Card, BarChart, Cell…)
    api/                     → typed read-only client + shared response types
    styles.css               → ported verbatim from the prototype
  index.html, vite.config.ts, tsconfig.json, package.json, eslint.config.js

src/backoffice/              → the read-only HTTP service (app package; rides pnpm build/lint/test)
  server.ts                  → http(s) + route table + auth middleware (DI via deps)
  queries.ts                 → read-only SQL (the only DB access; SELECT-only role)
  probes.ts                  → live service-health checks (Status screen)
  cost.ts                    → Langfuse read-API client (Costs/Logs)
  cli.ts                     → `pnpm backoffice` entry (reads Config, composes, listens)

tests/unit/backoffice/       → handler/auth/query-shape unit tests
tests/integration/backoffice/→ read-only queries against real Postgres (DATABASE_URL-gated)
docs/backoffice-spec.md      → this file
```

`src/ops/config.ts` gains the backoffice vars (it stays the only env reader).
Infra changes are expressed as code — see **CI/CD & Infrastructure-as-Code**
below: `infra/pulumi` (Tailscale bootstrap, optional SG fallback), the prod
compose + Dockerfile, `infra/egress` (new outbound endpoints), and the
`.github/workflows` build/deploy.

## Design → reality mapping (the crux)

The mock's shapes are close but invented fields/tables that have **no local
source**. Per-screen sourcing:

| Screen | Mock source | Real source | Gap / decision |
|---|---|---|---|
| **Database** | 7 mock tables | Direct SELECT on real tables: `lists`, `reminders`, `household_facts`, `pending_actions`, `sent_log`, `conversation_inbox`, `conversation_context` | `facts` mock has `confidence`/`source_turn`/`id` — real `household_facts` is `key/value/updated_at` only → drop those columns. `sent_log` has no `status`/`to`/`kind` → map to `delivery_class`/`conversation_id`. **No `calendar_events` table** → **read live from the Google Calendar API** (service-account `events.list`, read-only; respects egress allowlist). **No `turns` table** → see Logs. |
| **Logs** | mock `logs[]` (60 rows) | **DBOS journal** (`dbos.workflow_status`: id, name, status, created/updated) for the turn list; per-turn tokens/cost/tier/tool from the **Langfuse observations read API** keyed by trace | Tracing is push-only today, but the **read API is available** (resolved Q1). List turns from the DBOS journal; enrich from Langfuse; render `—` only where a span lacks the field. |
| **Costs** | mock `models[]`, `dailyCost[]`, `tokenSplit[]` | **Langfuse `/api/public/metrics/daily`** (MTD, daily bars, per-model) + `v2/metrics`; budget from Config | Resolved (Q1): no local ledger. Cache-read split (donut) best-effort from observation `usageDetails`; degrades alone if absent. |
| **Status** | mock `services[]`, `edges[]` | **Live probes** in `src/backoffice/probes.ts`: Postgres `SELECT 1`+latency, pgvector row count, Anthropic/Voyage/Langfuse/GCal cheap auth ping (must respect the egress allowlist), Baileys liveness | No stored health snapshot exists (`health.ts` is an alert monitor; `deadman.ts` pings outward). Baileys socket state lives in the **spine** process, not the backoffice process → expose via a heartbeat row / the dead-man signal, not a direct read. `edges[]` are static copy from the recovery runbook → keep as static. |
| **Overview** | composed | composes the above | KPIs (turns today, errors 24h, pending approvals, MTD spend) derive from the same sources. |

This table is the heart of the build — most residual risk is Logs/Costs span
enrichment (what individual Langfuse observations carry), not the aggregate
Costs numbers (resolved Q1).

## CI/CD & Infrastructure-as-Code

The backoffice is a **first-class part of the pipeline**, not a side-deploy.
Nothing is provisioned or shipped by hand; it rides the same git-driven flow as
the spine. Verified against the merged Pulumi IaC (PR #12) and the existing
`ci.yml`/`deploy.yml`.

### IaC — Pulumi (`infra/pulumi`, the isolated TS 5.9.x workspace)

The host today is one EC2 box: a security group that is **SSH-only ingress /
open egress**, with real egress controlled in-host by the nftables allowlist
(`infra/egress` ← `src/ops/egress-allowlist.ts`). The backoffice fits as code:

- **Exposure = Tailscale, no SG change.** The SG stays SSH-only ingress —
  Tailscale dials **out**, so no `443` ingress rule. IaC work is in the
  **cloud-init render** (`infra/pulumi/cloud-init/render.ts`): install `tailscale`,
  `tailscale up` with an **auth key from secrets** (a new SSM SecureString under
  `/hh-assistant/*`, delivered by the existing `secretsMode` path), and
  `tailscale serve` to front the backoffice with its `*.ts.net` HTTPS cert.
  Because the instance carries `ignoreChanges:[userData]` (replacing userData
  would destroy Baileys + pgdata), the Tailscale bootstrap is applied to the
  live host out-of-band on first roll, then encoded in cloud-init so a
  **create-from-zero** env brings the tailnet up automatically — preserving the
  reproducibility capability (and the import-don't-replace-prod rule).
- **Fallback (open-port) is also code:** add an `ingress` rule (`443` from a
  restricted CIDR, *not* `0.0.0.0/0`) to the SG in
  `infra/pulumi/components/host-environment.ts`, plus Caddy in compose. One
  localized diff — which is exactly why Tailscale is preferred: it needs none.
- **Egress allowlist** (`src/ops/egress-allowlist.ts` + the nftables mirror)
  gains the new **outbound** endpoints: Tailscale coordination/DERP, the
  Langfuse read API host, and the Google Calendar API. The allowlist is
  drift-tested against the nftables render, so both move together.
- The Pulumi workspace stays isolated — the backoffice does **not** pull it
  into the app tsconfig, and vice versa.

### CD — release → deploy (`deploy.yml` + `infra/deploy/on-host-deploy.sh`)

Ships on the same **published GitHub release** over SSM (no inbound SSH):

- **Image:** extend `infra/Dockerfile` to also build the frontend
  (`pnpm -C backoffice build` → `backoffice/dist`) and include `src/backoffice`
  in the compiled output, so one immutable image carries spine + backoffice.
- **Compose:** add a `backoffice` service to `infra/docker-compose.prod.yml`
  (same image, different entry: `pnpm backoffice`), sharing the Postgres,
  bound to the tailnet interface.
- **Healthcheck + rollback:** `on-host-deploy.sh` waits for a backoffice
  `up:` marker alongside the spine's `ezra up:` (extend the existing 180s
  wait); the existing **auto-rollback to the prior tag** then covers the
  backoffice too.
- **Migrate-gate:** unaffected — the backoffice is read-only and adds no
  migrations. The one DB touch is creating a **SELECT-only role** (a one-time
  grant; applied via the migrate path or a Pulumi/SSM step — decide in Plan).
- **Redeploy/rollback** of an already-released tag stays the Actions →
  Deploy `workflow_dispatch` path; `pnpm release` still cuts releases.

### CI — build + smoke + push (`ci.yml`)

- Add the backoffice to the gates: `pnpm -C backoffice build` (typecheck +
  Vite) and its lint/tests, plus the existing app `build`/`lint`/`test`
  (which now compile `src/backoffice`).
- Extend the **config smoke** so the production image boots the backoffice
  entry and `loadProductionConfig` validates the new vars.
- Same push rules as today: a main push / `v*` tag pushes immutable GHCR tags;
  **PRs build + smoke but never push.**

### Secrets / config

New `config.ts` vars (the only env reader), delivered by the existing secrets
mechanism (SSM SecureString `/hh-assistant/env`, or SOPS): backoffice **bearer
token**, **Tailscale auth key**, the **SELECT-only DB URL/role**, and the
Google Calendar read scope (reusing the existing service-account key). No new
secret store; no secrets in the UI bundle.

## Code Style

Repo conventions apply (`.claude/rules/conventions.md`): strict TS, no `any` at
boundaries, **Zod at every boundary** (here: API responses and the Langfuse
read-API payloads), kebab-case files, camelCase symbols, **no default exports**,
**DI via a `deps` object** (no module singletons), `config.ts` the only env
reader. Example of the intended API-handler shape:

```ts
// src/backoffice/queries.ts — read-only, SELECT-only, typed out
export const reminderRowSchema = z.object({
  id: z.string(),
  body: z.string(),
  created_by: z.string(),
  due_at: z.date(),
  status: z.enum(['scheduled', 'fired', 'cancelled']),
});
export type ReminderRow = z.infer<typeof reminderRowSchema>;

export interface QueryDeps { db: Queryable } // injected read-only pool
export async function listReminders({ db }: QueryDeps): Promise<ReminderRow[]> {
  const { rows } = await db.query('SELECT id, body, created_by, due_at, status FROM reminders ORDER BY due_at DESC LIMIT 500');
  return rows.map((r) => reminderRowSchema.parse(r)); // boundary parse, never trust shape
}
```

Frontend mirrors the prototype's component decomposition (`Icon`, `Dot`,
`Badge`, `Card`, `SectionTitle`, `Cell`, `BarChart`) as typed `.tsx`, importing
the typed API client instead of `window.DATA`. RTL handling (the
`/[֐-׿]/` detection + `unicodeBidi: 'plaintext'`) is preserved — the
household is Hebrew/English.

## Testing Strategy

Per `.claude/rules/testing.md`:

- **Unit** (CI, no DB): API auth (reject without/with-bad token, constant-time),
  Zod response schemas, query-string builders, RTL/`Cell` rendering, cost
  aggregation math. Frontend component render tests as feasible under Vitest.
- **Integration** (CI + local, `DATABASE_URL`-gated, runs on the `_test`
  sibling DB): each read-only query returns correctly-shaped rows against real
  Postgres. Asserts the queries are **SELECT-only** (no write reachable).
- **Never in CI:** real WhatsApp/calendar/model/Langfuse calls. Probe and
  Langfuse-read clients are injected and faked in tests; real wire exercised by
  a spike, mirroring the Langfuse-sink precedent.
- TDD discipline: failing test first for each handler.

## Boundaries

- **Always:** read-only by construction (SELECT-only DB role + no tool/DBOS
  import in the backoffice service) · `pnpm lint && pnpm test` green before
  commit · Zod-parse every API and external response · exact-pin every new dep ·
  secrets only via `config.ts` · keep the conversation-allowlist privacy
  boundary — the console shows only allowlisted-household data.
- **Ask first (per CLAUDE.md — flagged, not yet approved):**
  - **New dependencies:** `react`, `react-dom`, `vite`, `@vitejs/plugin-react`,
    `@types/react*` — all confined to the **isolated** `backoffice/` package
    (own lockfile), so they never enter the app's dependency graph. Backend
    server: zero new runtime deps (`node:http`). WhatsApp-adjacent: none.
  - **DB:** a read-only **SELECT-only role** (recommended). *No* usage-ledger
    table — Q1 resolved to the Langfuse read API, so no schema change for Costs.
  - **IaC (Pulumi):** Tailscale bootstrap in `cloud-init/render.ts` + an
    out-of-band first-roll on the protected prod host (userData is
    `ignoreChanges`); the open-port fallback instead adds an SG ingress rule.
  - **CI/CD:** extending `infra/Dockerfile`, `docker-compose.prod.yml`,
    `on-host-deploy.sh` (healthcheck), and `ci.yml`/`deploy.yml` to build and
    ship the backoffice on the existing release flow.
  - **Egress:** Tailscale coordination/DERP, the GCal read (Q4), and the
    Langfuse read API add outbound calls that must be added to the egress
    allowlist (`src/ops/egress-allowlist.ts` + the drift-tested nftables mirror).
- **Never:** expose any write path to prod · pull household data outside the
  allowlist · put credentials into the UI bundle or client · weaken a failing
  test/lint rule · restore Baileys state · run the backoffice inside the
  durable spine process.

### Flag: the exposure choice (resolved to the safer option)

You asked for my recommendation and I gave it: **Tailscale**, which keeps
"reach-from-anywhere" while removing the only genuinely new public attack
surface on a PII-holding box, *and* hands us a real HTTPS cert for free (no
domain, no self-signed warning). **Confirmed as the baseline (2026-06-23);** the
open-port + Caddy build remains the documented fallback.

## Success Criteria

1. Five screens (Overview, Database, Logs, Costs, Status) render **live** data
   from the running EC2 system; no mock `data.js` ships.
2. **Zero** write paths reachable from the UI — verified by the SELECT-only DB
   role and a test asserting no mutation handler/route exists.
3. Reachable only over **authenticated HTTPS**; unauthenticated requests get
   401; the bundle contains no secrets.
4. Database screen browses the real `lists`, `reminders`, `household_facts`,
   `pending_actions`, `sent_log` with the row drawer; invented columns dropped.
5. Costs shows real MTD spend vs. the configured budget (token/model breakdown
   if the Langfuse read API supports it, else gracefully degraded).
6. Status reflects **live** probe results, not static text (edges may stay
   static).
7. Hebrew rows render RTL correctly.
8. `pnpm build && pnpm lint && pnpm test` green (app + `src/backoffice`), and
   `pnpm -C backoffice build` + its lint/tests green; new code holds the repo's
   strict-TS / Zod-boundary / no-default-export / DI bar.
9. **CI** builds the backoffice (frontend + server) and the prod image, runs
   the config smoke against it, and pushes immutable GHCR tags on main/`v*`;
   PRs build + smoke but never push.
10. **CD** ships the backoffice on the same published-release → SSM flow:
    healthchecked behind its `up:` marker, covered by the existing
    auto-rollback; no by-hand deploy step.
11. **IaC** expresses the exposure as code — Tailscale bootstrap in Pulumi
    cloud-init (or the SG-ingress fallback) — so a create-from-zero env stands
    the backoffice up reproducibly and adopt-prod imports in place.
12. New outbound endpoints (Tailscale, Langfuse read API, GCal) are in the
    egress allowlist and pass the nftables drift test.

## Open Questions — all resolved (2026-06-23)

| # | Question | Resolution |
|---|---|---|
| 1 | Langfuse read API | **Available** — `metrics/daily` + `v2/metrics` + observations, existing keys. No local ledger. |
| 2 | TLS cert | **Tailscale-provisioned** (`*.ts.net` Let's Encrypt) — folded into Q3. |
| 3 | Exposure | **Tailscale** (confirmed); open-port + Caddy = fallback. |
| 4 | Calendar | **Read live** from Google Calendar API (read-only). |
| 5 | Baileys liveness | **Derive** from dead-man / heartbeat. |
| 6 | Dashboard layout | **`focus`**. |

All decisions confirmed (2026-06-23). Phase 2 plan: `docs/backoffice-plan.md`.

