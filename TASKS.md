# Tasks: Household AI Agent v1 (hh-assistant)

> **Status: APPROVED 2026-06-09 — execution in progress.**
> Breakdown of `PLAN.md` (approved 2026-06-09). Tasks are dependency-ordered within each milestone; each is sized for one focused session and touches ≤ ~5 files. M0–M3 are fully specified; M4–M6 tasks are named and gated but get their full acceptance criteria refined at milestone entry (their shape depends on what M1/M3 validate). `[H]` marks tasks the builder does by hand (drills, approvals, external accounts). Number acquisition, warming, and soak testing are out of scope; tasks assume a paired, usable WhatsApp number.

## M0 — Scaffold

- [x] **T1: Repo + TypeScript scaffold** *(done 2026-06-09)*
  - Acceptance: pnpm project with `save-exact` enforced via `.npmrc`; strict `tsconfig.json`; `src/index.ts` placeholder; `pnpm build` compiles.
  - Verify: `pnpm build`.
  - Files: `package.json`, `.npmrc`, `tsconfig.json`, `src/index.ts`.

- [x] **T2: Vitest wiring** *(done 2026-06-09)*
  - Acceptance: `pnpm test` runs a passing smoke test; unit/integration split configured (integration suite skipped when DB env is absent).
  - Verify: `pnpm test`.
  - Files: `vitest.config.ts`, `tests/unit/smoke.test.ts`, `package.json`.

- [x] **T3: ESLint baseline** *(done 2026-06-09)*
  - Acceptance: flat-config ESLint with TS support; `pnpm lint` clean on scaffold; rule slot reserved for the custom determinism rule (T9).
  - Verify: `pnpm lint`.
  - Files: `eslint.config.js`, `package.json`.

- [x] **T4: Dev database (single Postgres + pgvector)** *(done 2026-06-09)*
  - Acceptance: `docker compose up -d` starts one Postgres with pgvector; a connect-and-`CREATE EXTENSION vector` smoke check passes. Note in `infra/README.md`: local runtime is Colima on the dev Mac; CI (Linux) is the arbiter.
  - Verify: `pnpm test` integration smoke against the dev DB.
  - Files: `docker-compose.yml`, `infra/README.md`, `.env.example`, `tests/integration/db-smoke.test.ts`.
  - Depends on: T2.

- [x] **T5: CI pipeline** *(done 2026-06-09: repo pushed to github.com/shem86/hh-assistant, CI green on main. Caveat: branch protection requires GitHub Pro or a public repo — "red CI blocks merge" is unenforced until the builder upgrades or makes the repo public.)*
  - Acceptance: GitHub Actions running `pnpm build && pnpm lint && pnpm test` with a Postgres+pgvector service container; red CI blocks merge.
  - Verify: CI green on a pushed branch.
  - Files: `.github/workflows/ci.yml`.
  - Depends on: T1–T4.

- [x] **T6: Config and secrets loading** *(done 2026-06-09)*
  - Acceptance: env-based config module, Zod-validated at startup with clear failure messages; placeholders for Anthropic key, Langfuse keys, DB URL, alert-channel token; no secret ever read outside this module.
  - Verify: unit tests (valid env passes, missing/invalid env fails loudly).
  - Files: `src/ops/config.ts`, `tests/unit/config.test.ts`, `.env.example`.
  - Depends on: T1, T2.
  - **Gate M0 complete:** CI green end-to-end.

## M1 — De-risking spikes (T7–T9 parallelizable)

- [x] **T7: Prompt-caching spike (SPEC Phase-0 gate)** *(done 2026-06-09: PASS, cache_read_input_tokens=6135 through AI SDK passthrough; no escape hatch — see docs/spike-results.md)*
  - Acceptance: script calls Claude twice via AI SDK Core with `cache_control` on a stable prefix through provider passthrough; usage fields captured; result (cache_read tokens > 0, or failure) written to `docs/spike-results.md`. On failure: stop, surface the `@anthropic-ai/sdk` escape-hatch decision to the builder before M4.
  - Verify: run `spikes/cache-control.ts` twice; read the recorded usage numbers.
  - Files: `spikes/cache-control.ts`, `docs/spike-results.md`, `package.json`.
  - Depends on: T6.

- [x] **T8: DBOS semantics spike (SPEC Phase-0 foundation)** *(done 2026-06-09; pinned @dbos-inc/dbos-sdk 4.19.8 — see docs/spike-results.md)*
  - Acceptance: committed integration test proving, against the dev Postgres: (1) transactional step = state write + step record atomic; (2) kill-mid-flight then recover replays to identical output with no double effect; (3) queue concurrency-1 FIFO; (4) a scheduled workflow fires; (5) journal/state/pgvector co-reside in one Postgres. DBOS version pinned to what this validates.
  - Verify: `pnpm test` (spike suite); kill/replay test green.
  - Files: `spikes/dbos/spike.ts`, `tests/integration/dbos-spike.test.ts`, `package.json`, `docs/spike-results.md`.
  - Depends on: T4.

- [x] **T9: Determinism ESLint rule** *(done 2026-06-09)*
  - Acceptance: custom rule bans `Date.now`/`new Date`, `Math.random`, `process.env` reads, and direct I/O calls inside `@DBOS.workflow` function bodies; red on violation fixtures, green on clean fixtures; wired into `pnpm lint` as CI-failing.
  - Verify: rule's own fixture tests + `pnpm lint`.
  - Files: `eslint-rules/no-nondeterminism-in-workflow.ts`, `eslint-rules/no-nondeterminism-in-workflow.test.ts`, `eslint.config.js`.
  - Depends on: T3.

- [x] **T10 [H]: M1 gate review** *(closed 2026-06-09: builder accepted — caching confirmed, DBOS 4.19.8 pin accepted; see docs/spike-results.md)*
  - Acceptance: builder reads `docs/spike-results.md`; caching confirmed or escape hatch decided; DBOS version pin accepted.
  - Verify: gate recorded in the doc with a date.
  - Depends on: T7, T8, T9.

## M2 — Transport adapter + ops monitoring (agent-free)

- [x] **T11: Transport interface + Baileys connection** *(done 2026-06-09 — baileys 7.0.0-rc13 reviewed+pinned (docs/dep-reviews/), adapter unit-tested via injected socket, session store with re-pair-only recovery; builder verified manual QR pairing AND restart-reconnect-without-re-pair via `pnpm pair` same day. Running on builder's personal number — echo suppression is sent-id-based, not fromMe (see docs/pairing.md))*
  - Acceptance: `Transport` interface (connect, send, onMessage, onStateChange, forceReconnect) that M3's stub and M6's real adapter both implement; Baileys connects with session state persisted to a configurable writable dir; QR pairing flow documented; session dir is gitignored and never backed up for restore (re-pair on loss).
  - Verify: manual pairing with the project's WhatsApp number (provisioning out of scope); reconnect after process restart without re-pairing.
  - Files: `src/transport/types.ts`, `src/transport/baileys.ts`, `src/transport/session-store.ts`, `docs/pairing.md`.
  - Depends on: T6; needs a paired WhatsApp number available.

- [x] **T12: Health monitoring + independent alerting + dead-man ping** *(done 2026-06-10: Telegram alert channel (plain Bot API fetch, no new dep, token-redacted errors); health monitor 60s-grace down-alerts / immediate logged-out / recovery, one alert per outage; dead-man GET pinger, passive error handling; config requires ALERT_CHANNEL_CHAT_ID + DEADMAN_PING_URL. 19 unit tests. Builder created the bot + healthchecks.io check and verified the Telegram channel end-to-end (bot token rotated after a WhatsApp self-send leak). The kill-drills in this task's verify line — socket kill → alert, process kill → dead-man fires — are identical to T14's drill content and are executed/logged there)*
  - Acceptance: socket-state monitor emitting down-alerts over a non-WhatsApp channel (Telegram bot unless builder objects at T10); scheduled dead-man ping to an external check service; both configurable via T6 config.
  - Verify: unit tests for state transitions; manual: kill socket → alert arrives; stop process → external dead-man fires.
  - Files: `src/ops/health.ts`, `src/ops/alerts.ts`, `src/ops/deadman.ts`, `tests/unit/health.test.ts`.
  - Depends on: T11.

- [x] **T13: Standalone transport runner** *(done 2026-06-10: `pnpm transport` wires Baileys + T12 health/Telegram/dead-man + stdin commands (send <jid> <text> with 1.5–4.5s human jitter, reconnect, status, help, quit); refuses to start unpaired; command core unit-tested against a fake transport; runner-cli.ts entry follows the pair-cli pattern; loadTransportOpsConfig means no LLM/DB keys needed. Builder dry-run verified same day: connect, inbound logging, manual send arrived in the group. Bonus finding: sends to @lid JIDs deliver — see docs/pairing.md)*
  - Acceptance: standalone runnable (`pnpm transport`) that connects, monitors, supports a manual test send (human-like delay jitter) and a forced-reconnect command. No LLM, no DB writes.
  - Verify: dry-run locally; one manual test send arrives in the group.
  - Files: `src/transport/runner.ts`, `package.json`.
  - Depends on: T11, T12.

- [ ] **T14 [H]: M2 operational drill**
  - Acceptance: on the running transport runner — socket kill produces an alert on the independent channel; process kill trips the dead-man within 2× ping interval; forced reconnect recovers cleanly. Results logged.
  - Verify: manual drill; results in `docs/ops-drills.md`.
  - Depends on: T13.

## M2.5 — Host + backups (parallel to M3–M5; all required before M6)

- [ ] **T15 [H]: Provision host** — Oracle PAYG with reclamation policy re-verified that week, else Hetzner; decision + evidence in `infra/host.md`.
- [ ] **T16: Production runtime hardening** — non-root service user, read-only rootfs, writable volumes only for Baileys session + Postgres data, egress allowlist v0 (Anthropic, Google, B2/R2, alert channel, WhatsApp iterated), secrets injected at runtime. Files: `infra/` (compose/systemd + allowlist). Verify: process runs hardened; blocked egress to a non-listed host confirmed.
- [ ] **T17: Backup pipeline + restore drill (SPEC Phase-0 gate)** — WAL archiving + base backups, client-side encrypted, to B2/R2; restore into a scratch DB and diff. Files: `infra/backup/`. Verify: documented successful restore. Depends on: T15.

## M3 — Durable core (stubbed model, stubbed transport)

- [x] **T18: Structured store schema v0** *(done 2026-06-09: 0001-structured-store-v0.sql + forward-only runner (`pnpm migrate`; CI applies via the integration suite); store accessors take a Queryable so T19 can run them inside datasource transactions)*
  - Acceptance: migrations for `lists`, `reminders`, `household_facts` (with secret-class flag), `pending_actions`, `sent_log`, `conversation_context`; migration runner wired into dev/CI setup.
  - Verify: migrations apply cleanly in CI; store round-trip tests.
  - Files: `migrations/*.sql`, `src/memory/store.ts`, `tests/integration/store.test.ts`.
  - Depends on: T8 (validated DBOS/Postgres setup).

- [ ] **T19: Step helpers — transactional writes + idempotency keys**
  - Acceptance: helper enforcing every structured-state write goes through a DBOS transactional step (SPEC boundary); `(workflowID, stepNumber)` idempotency-key helper for external effects; both unit-tested.
  - Verify: `pnpm test`; exactly-once write test (kill around the step, state neither lost nor doubled).
  - Files: `src/orchestration/steps.ts`, `tests/integration/steps.test.ts`.
  - Depends on: T18.

- [ ] **T20: Ingestion seam — durable-enqueue-before-ack**
  - Acceptance: inbound message contract (Zod); stub transport implementing the `Transport` interface with explicit ack callback; ingestion enqueues durably *then* acks; self-echo (`fromMe`) filtered; crash-between-receive-and-enqueue test shows redelivery path (un-acked message not lost).
  - Verify: integration tests including the crash window.
  - Files: `src/orchestration/ingest.ts`, `src/transport/stub.ts`, `tests/integration/ingest.test.ts`.
  - Depends on: T11 (interface), T19.

- [ ] **T21: Conversation queue + consumer-side debounce**
  - Acceptance: one concurrency-1 DBOS queue keyed by conversation; dequeue groups a sender's rapid bubbles within the silence window (1.5–3s, configurable) into one batch; FIFO across human + proactive items.
  - Verify: integration tests — debounce grouping, no pre-enqueue holding, FIFO interleave with a proactive job.
  - Files: `src/orchestration/queue.ts`, `src/orchestration/debounce.ts`, `tests/integration/queue.test.ts`.
  - Depends on: T20.

- [ ] **T22: `handleTurn` skeleton + context persistence**
  - Acceptance: the SPEC loop shape with stubbed `callModel` (scripted tool calls); `loadContext`/`persistContext` steps; every `tool_use` answered incl. deny/park paths; `MAX_ROUNDS` cap with forced final message; msgs never journaled whole.
  - Verify: integration tests for loop invariants; recovery replay on the skeleton.
  - Files: `src/agent/handle-turn.ts`, `src/agent/context.ts`, `tests/integration/handle-turn.test.ts`.
  - Depends on: T19, T21.

- [ ] **T23: Scheduled reminders → proactive turns**
  - Acceptance: DBOS scheduled workflows that enqueue proactive turns into the same lane; reminder times anchored to household timezone (Eastern), never server time.
  - Verify: integration test — scheduled job waits behind an in-flight turn; tz conversion unit tests.
  - Files: `src/orchestration/scheduled.ts`, `tests/integration/scheduled.test.ts`, `tests/unit/tz.test.ts`.
  - Depends on: T21.

- [ ] **T24: M3 reliability suite (`pnpm test:recovery`)**
  - Acceptance: the named gate tests in one suite — recovery replay (kill mid-flight, diff vs uninterrupted, no double effect), exactly-once state write, execute-once pending-action guard under duplicate approvals (table + guard land here even though full HITL is M5), debounce grouping, FIFO ordering.
  - Verify: `pnpm test:recovery` green in CI.
  - Files: `tests/integration/recovery.test.ts`, `src/hitl/pending-actions.ts`, `package.json`.
  - Depends on: T22, T23.
  - **Gate M3 complete.**

## M4 — Reasoning layer *(full acceptance criteria refined at milestone entry)*

- [ ] **T25: `callModel` via AI SDK Core + prompt caching (per T7's verdict); model-call step records assistant msg + tool_use ids atomically**
- [ ] **T26: Tool registry — `defineTool` (Zod schema, risk tier, idempotency, revalidation hooks)**
- [ ] **T27: Tools — lists, reminders, household facts read/write**
- [ ] **T28: Pull-only semantic recall tool (pgvector) + embedding write path**
- [ ] **T29: Compaction step (threshold per Open Q3 proposal: ~30 turns; idempotency-keyed; open commitments kept verbatim)**
- [ ] **T30: Haiku router (cheap-vs-reasoning model selection)**
- [ ] **T31: Langfuse tracing on every step; secret-class redaction in traces**
- [ ] **T32: System prompt + mixed Hebrew/English fixture set; pending-actions digest injection slot**
- [ ] **T33 [H]: Cost gate — measure per-turn cost on realistic scripted days, extrapolate ≤ $30/mo; cache reads visible in traces**
  - **Gate M4 complete:** every tool exercised through `pnpm dev` stub conversations; T33 numbers recorded.

## M5 — HITL *(refined at milestone entry)*

- [ ] **T34: Fire-and-fold park path (synthetic pending result, `pending_actions` row, approval prompt as closing message)**
- [ ] **T35: Quoted-reply approval binding + fresh-turn execution (status transitions from T24, revalidation, result injected as new context message)**
- [ ] **T36: Relatedness classifier (Haiku) — refine / unrelated / approve-deny routing while actions pend**
- [ ] **T37: TTL GC + gentle expiry surfacing**
- [ ] **T38: Eval harness (`pnpm eval`) + the five SPEC scenarios incl. code-switched fixtures**
  - **Gate M5 complete:** all five scenarios pass + execute-once under double approval.

## M5.5 — Calendar *(parallel after T26)*

- [ ] **T39 [H]: Google Cloud project, OAuth consent, scopes, refresh-token storage as secret-class**
- [ ] **T40: Calendar tools — deterministic event IDs from action_id, confirm-before tier, revalidation (slot still free)**
- [ ] **T41: Round-trip gate — create/read on a test calendar; re-execute no-ops; manufactured conflict caught**

## M6 — Wire-up and launch *(refined at milestone entry; requires T14, T17, M5 gate)*

- [ ] **T42: Swap stub for the M2 Baileys adapter; durable-enqueue-before-ack against the real socket**
- [ ] **T43: Send classes live — at-least-once (reminders, nags, approval prompts; send-then-log) and at-most-once (echoes; log-then-send) against `sent_log`**
- [ ] **T44: Recovery runbook (`docs/recovery-runbook.md`) + full restore drill incl. external-effect reconciliation**
- [ ] **T45 [H]: Deploy hardened process to host; egress allowlist final**
- [ ] **T46 [H]: Launch sweep — SPEC success-criteria checklist top to bottom**

## Sequencing notes

- Start with T1–T6 (scaffold batch).
- T7/T8/T9 are independent — good parallel batch after M0.
- T11 needs a paired WhatsApp number available (provisioning out of scope) — everything else in M2–M5 proceeds without it via the stub transport.
- M4 tasks stay coarse on purpose: T25's exact shape depends on T7's verdict, T29's threshold on real transcript sizes from T33's scripted days. Refine at milestone entry per the living-document rule.
