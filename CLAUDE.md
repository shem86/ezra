# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

WhatsApp household assistant ("ezra") for two users (builder + wife): reminders,
shared lists, Google Calendar, household Q&A. Dual goal: production-grade
agentic-systems learning and daily utility. **Reliability beats sophistication
in every v1 trade-off.** v1 is built and launched (M0–M6 complete, all SPEC
success criteria verified — `docs/launch-checklist.md`); the system runs on an
AWS EC2 host. Work now is operation, hardening, and v2 (`V2_NOTES.md`).

## Source-of-truth documents (read before changing anything)

| Doc | Owns | Status |
|---|---|---|
| `household-ai-agent-architecture-v3_5.md` | *Why* — locked decisions 1–11 | LOCKED |
| `SPEC.md` | *Building* — scope, conventions, boundaries | APPROVED |
| `PLAN.md` | Milestones M0–M6 + verification gates | DONE |
| `TASKS.md` | Per-task ledger + live progress checkboxes | M0–M6 complete |
| `docs/spike-results.md` | Spike verdicts, pinned versions, gotchas | reference |
| `docs/launch-checklist.md` · `docs/recovery-runbook.md` · `docs/ops-drills.md` | Launch/ops runbooks | reference |
| `docs/adr-000*.md` | Reversed/locked decisions (router removed, Voyage, service-account calendar) | reference |

Where docs overlap: architecture wins on rationale, SPEC wins on
implementation detail. `TASKS.md` carries a per-task trail (the "T-numbers" in
commit messages and code comments index into it) — read the relevant T-entry
before changing the code it describes; it records *why* the code is shaped the
way it is and what already bit us.

## Commands

```
docker compose up -d   # dev DB: ONE Postgres with pgvector (journal+state co-located)
pnpm build             # tsc, strict
pnpm test              # vitest run; integration suite only runs when DATABASE_URL is set
pnpm test:recovery     # kill-mid-flight replay gate (named integration files; CI runs it after test)
pnpm lint              # eslint incl. custom DBOS-determinism rule (CI-failing)
pnpm eval              # model-in-the-loop scenarios — on-demand, never CI
pnpm dev               # scripted-day composition against dev DB, transport+model stubbed
```

Run a single test file / case:
`DATABASE_URL=postgres://hh:hh@localhost:5432/hh_assistant pnpm test tests/integration/queue.test.ts`
(append `-t "name"` to filter by test name). The integration suite redirects
itself to a dedicated `hh_assistant_test` database on the same server so it
never poisons the app DB (issue #5; `.claude/rules/testing.md`). Unit tests run
with no DB. Spikes run directly: `node --env-file=.env spikes/<name>.ts`
(Node 22 strips types).

Production / operational entries (REAL traffic — never CI, never tests):
```
pnpm start             # the production spine (src/start.ts → src/main.ts)
pnpm migrate           # apply forward-only SQL migrations (repo-root migrations/)
pnpm pair              # one-time Baileys QR pairing
pnpm transport         # standalone transport runner (Baileys + ops, no LLM/DB) for drills
```

## Architecture — the production spine

One process, composed by **dependency injection** with no module-level
singletons. Read these together to see the whole:

- **`src/start.ts`** — sets a per-generation `DBOS__VMID` **before** the SDK is
  imported (the one env *write* in `src/`), then loads `main.ts`. This makes
  launch-time auto-recovery a no-op and dodges the 4.19.x datasource-init race
  (see `.claude/rules/dbos.md`).
- **`src/main.ts`** — THE composing caller: builds Config → model/tools/embedder
  → registers transactional steps, the `handleTurn` workflow, the conversation
  lane (ingest → debounced concurrency-1 queue → drain → turn → reply), both
  scheduled sweeps (reminders, HITL expiry), and ops (health alerts, dead-man).
  DBOS registration order is load-bearing: datasource + workflows + scheduled
  **before** `DBOS.launch()`, queue registration **after**. `src/dev/main.ts` is
  the same wiring with a scripted day instead of the real socket.

Message flow: Baileys inbound → **ingestion** (allowlist, echo-filter,
durable-enqueue-*before*-ack) → **conversation queue** (per-conversation
partition, consumer-side debounce groups a burst into one turn) → **`handleTurn`**
workflow (load context → model rounds with tool calls → persist; compaction at
threshold; every `tool_use` gets a `tool_result`) → **reply** out a send step
with a declared delivery class against `sent_log`.

Module layout (`SPEC.md` "Project Structure", tests mirror under `tests/`):
`src/transport` (Baileys, send classes, sent-log) · `src/orchestration`
(workflows, queue, debounce, scheduled, recovery, steps) · `src/agent`
(handleTurn, call-model, prompts, compaction, context, relatedness) · `src/tools`
(defineTool: Zod schema + risk tier + idempotency + revalidation; lists,
reminders, facts, recall, calendar) · `src/memory` (structured store +
migrations + pgvector semantic store + embedder) · `src/hitl` (pending_actions,
park/fire-and-fold, approval binding, expiry) · `src/ops` (config, health,
alerts, dead-man, tracing, egress-allowlist).

`infra/` holds host provisioning, the hardened Docker Compose prod runtime, the
nftables egress allowlist (mirrors `src/ops/egress-allowlist.ts`, drift-tested),
and the PITR backup/restore pipeline.

## Hard boundaries (full list in SPEC.md)

- **Always:** `pnpm lint && pnpm test` before commit · every structured-state
  write goes through a DBOS datasource transaction (never a plain step/raw
  query) · every external effect has an idempotency key or declared delivery
  class · every `tool_use` gets a `tool_result` · exact-pin every dependency.
- **Ask first:** new dependencies (WhatsApp-adjacent ⇒ full transitive
  review) · DB schema changes · risk-tier/delivery-class changes · real
  WhatsApp traffic · spending money.
- **Never:** commit secrets or Baileys session state · auto-execute a
  confirm-before tool · let operational credentials (API keys, OAuth tokens,
  Baileys state) into prompts/traces/semantic store · restore Baileys session
  from backup (re-pair on loss) · weaken a failing test or lint rule to pass CI.

## Detailed rules (`.claude/rules/`) — read these

- `dbos.md` — durable-execution invariants + DBOS 4.19.x version-specific
  gotchas (determinism, registration order, recovery, the `this`/workflow trap).
- `conventions.md` — TS/code style (strict, Zod at boundaries, no default
  exports, DI via `deps`, `src/ops/config.ts` is the ONLY env reader), module
  layout, and tooling quirks (NodeNext `.js` specifiers, type-stripping, the
  flat ESLint config).
- `testing.md` — test taxonomy (unit / integration / eval), what runs where,
  the `hh_assistant_test` redirection, and recovery-test patterns.

## Deploying (CI/CD) — full detail + one-time prereqs in `infra/runtime.md`

CI (`.github/workflows/ci.yml`) builds the prod image (`infra/Dockerfile`), runs
the two config smokes (compose-config + `loadProductionConfig` in the real
image), and pushes immutable tags to `ghcr.io/shem86/hh-assistant` —
`:sha-<short>`+`:main` on a main push, `:<version>`+`:latest` on a `v*` tag. PRs
build+smoke but **never push**.

CD (`.github/workflows/deploy.yml`) deploys on a **published GitHub release**
(or `workflow_dispatch` with a `tag` input) over AWS SSM — no inbound SSH. It
OIDC-assumes `AWS_DEPLOY_ROLE_ARN`, then SSM-runs
`infra/deploy/on-host-deploy.sh` on `i-0a7e9f4767666ac9e`, which: checkout the
release ref → self-fetch the GHCR PAT from SSM Parameter Store
(`/hh-assistant/ghcr-pat`; host has aws-cli + the instance role) → `docker
login` → pull → **migrate-gate** (migrations run on the new image *before* the
swap; forward-only, so image-swap rollback reverts the app, **not** the schema)
→ `up -d` → healthcheck (wait for the `ezra up:` marker — real startup ~60s,
180s timeout) → **auto-rollback** to the prior tag on failure.

Cut a release — one push-button command from green `main`: **`pnpm release
vX.Y.Z`** (`infra/deploy/release.sh`). It guards (must be on a clean main that
matches origin, tag must be new), tags+pushes, **blocks on the CI image build
going green**, then `gh release create`s — which fires the deploy — and follows
it to its outcome. The blocking step is the point: the deploy doesn't wait for
the image, so publishing by hand risks deploying a tag whose image isn't in GHCR
yet. A `-rc.N` suffix cuts a prerelease (still fires the deploy — an rc dry-run).
Only cut off **green `main`** (branch protection is unavailable while private —
the CD gate is discipline). Redeploy or roll an already-released tag via Actions
→ Deploy → Run workflow (`workflow_dispatch` with the `tag`), **not** `pnpm
release`. PAT rotation is just `aws ssm put-parameter --overwrite`; the next
deploy picks it up, no host touch. Steady-state health is the hc-ping dead-man
(`src/ops/deadman.ts`), not the pipeline.

## Environment notes

- Stack (locked — do not substitute): Node 22 / TypeScript 6 strict / pnpm
  exact pins · DBOS 4.19.8 (durable execution) · single Postgres + pgvector ·
  Vercel AI SDK Core + Claude (Sonnet-class turns, Haiku-class for
  classification — tiered turn routing was removed, ADR-0003) · Voyage
  embeddings (zero-dep client, ADR-0002) · Baileys · Langfuse tracing · Vitest.
- Dev Mac containers run via Colima (occasionally flaky); **CI (Linux) is the
  arbiter** for anything container-dependent. Dead-database failures read as
  ECONNREFUSED — Colima is the usual local suspect, not the code.
- GitHub `shem86/hh-assistant` (private). CI = build+lint+test+recovery with a
  pgvector service container, **plus prod-image build/smoke/push to GHCR**; CD
  deploys on release over SSM (see Deploying). Branch protection unavailable on
  the free plan — treat red CI as merge-blocking by discipline.
- Household: mixed Hebrew + English (fixtures must cover code-switching);
  timezone Eastern — reminders/compaction anchor to it, never server time.
- Prod host root is via `ssh ubuntu@98.91.67.226` (the `hh` user can't sudo).
