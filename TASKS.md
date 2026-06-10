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

- [x] **T14 [H]: M2 operational drill** *(done 2026-06-10: all 5 drills pass — forced reconnect, network kill (caught and fixed a real monitor bug: down-state keyed on 'closed' which the adapter never emits mid-retry; regression-tested), device-logout 🚨 (simulated ban → immediate alert), kill -9 → dead-man fired ~2 min, restart recovered. Results in docs/ops-drills.md. M2 complete)*
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

- [x] **T19: Step helpers — transactional writes + idempotency keys** *(done 2026-06-10: `registerTransactionalStep` (wraps a store accessor in a datasource transaction — the sanctioned write path) + `deriveIdempotencyKey(workflowID, stepNumber)`; unit tests for both + integration gate: kill-mid-flight exactly-once write, same-wfid no-re-apply, derived-key send dedupe. Gotcha for future DBOS test files: each DBOS-launching test file must pin its own `DBOS__APPVERSION` (see `tests/integration/helpers/pin-appversion.ts`) — vitest runs files in parallel and recovery claims any matching-version pending workflow)*
  - Acceptance: helper enforcing every structured-state write goes through a DBOS transactional step (SPEC boundary); `(workflowID, stepNumber)` idempotency-key helper for external effects; both unit-tested.
  - Verify: `pnpm test`; exactly-once write test (kill around the step, state neither lost nor doubled).
  - Files: `src/orchestration/steps.ts`, `tests/integration/steps.test.ts`.
  - Depends on: T18.

- [x] **T20: Ingestion seam — durable-enqueue-before-ack** *(done 2026-06-10: Zod inbound contract + `createIngestion` (validate → echo-filter → durable enqueue → ack; no ack on failure — redelivery is the retry) + stub transport honoring redeliver-unacked-on-reconnect; `Transport.onMessage` gained the explicit ack callback (Baileys passes a documented no-op until M6 wires real socket acks). Deviation from acceptance as written: echo filter keys on sent-message ids, NOT `fromMe` — personal-number deployment makes builder messages fromMe (see types.ts note); `ingestWorkflowId(messageId)` is the dedupe anchor, proven in the crash-after-enqueue-before-ack integration test)*
  - Acceptance: inbound message contract (Zod); stub transport implementing the `Transport` interface with explicit ack callback; ingestion enqueues durably *then* acks; self-echo (`fromMe`) filtered; crash-between-receive-and-enqueue test shows redelivery path (un-acked message not lost).
  - Verify: integration tests including the crash window.
  - Files: `src/orchestration/ingest.ts`, `src/transport/stub.ts`, `tests/integration/ingest.test.ts`.
  - Depends on: T11 (interface), T19.

- [x] **T21: Conversation queue + consumer-side debounce** *(done 2026-06-10: `conversation_inbox` table (migration 0002, approved in-session) is the durable rendezvous — ingest inserts exactly-once (UNIQUE message_id absorbs redeliveries) then enqueues a drain workflow per message on a partitioned concurrency-1 queue (`partitionQueue: true`, partition key = conversationId; registered after launch per 4.19.x). The partition serializes drains: the first absorbs the burst via a silence-window quiet loop over journaled reads, stragglers no-op on an empty inbox — no cross-drain coordination, no races. `groupIntoBatches` (pure, unit-tested): consecutive same-sender human bubbles merge, proactive items stay singleton, seq = the total order (enqueue order, per decision 2's ordering note — concurrent enqueues land in nondeterministic call order and tests must not assume otherwise). T22 plugs in as the drain's `processBatch` dep; T23 enqueues proactive items through the same `enqueueConversationItem` workflow. Note for T24: one unreproduced flake of T19's kill-mid-flight test observed under triple-suite load (1 in ~9 runs) — watch for it in the recovery gate)*
  - Acceptance: one concurrency-1 DBOS queue keyed by conversation; dequeue groups a sender's rapid bubbles within the silence window (1.5–3s, configurable) into one batch; FIFO across human + proactive items.
  - Verify: integration tests — debounce grouping, no pre-enqueue holding, FIFO interleave with a proactive job.
  - Files: `src/orchestration/queue.ts`, `src/orchestration/debounce.ts`, `tests/integration/queue.test.ts`.
  - Depends on: T20.

- [x] **T22: `handleTurn` skeleton + context persistence** *(done 2026-06-10: `makeHandleTurnWorkflow` (factory naming matters — the extended determinism lint rule keys on `make*Workflow`) + `context.ts` Zod message schemas/`toModelMessages`. Loop invariants gated by integration tests: every `tool_use` answered (deny continues the loop, park breaks fire-and-fold + writes `pending_actions`), `MAX_ROUNDS` (default 8 per SPEC open Q2) forces a no-tools final and throws if the forced final still calls tools, transcript never journaled whole (asserted directly against `dbos.operation_outputs`; the load step's starting-transcript output is sanctioned by the architecture pseudocode), kill-mid-tool recovery replay completes with each effect exactly once. `callModel` is a plain-function dep wrapped in `DBOS.runStep` (transcript passes by closure); load/persist/runTool deps must be pre-registered steps/transactions. New conventions.md quirk: bare-node child entries value-importing src need `ts-ext-hooks.ts` + dynamic import)*
  - Acceptance: the SPEC loop shape with stubbed `callModel` (scripted tool calls); `loadContext`/`persistContext` steps; every `tool_use` answered incl. deny/park paths; `MAX_ROUNDS` cap with forced final message; msgs never journaled whole.
  - Verify: integration tests for loop invariants; recovery replay on the skeleton.
  - Files: `src/agent/handle-turn.ts`, `src/agent/context.ts`, `tests/integration/handle-turn.test.ts`.
  - Depends on: T19, T21.

- [x] **T23: Scheduled reminders → proactive turns** *(done 2026-06-10: `tz.ts` (Intl two-pass, no deps; DST gap → pre-transition, ambiguity → first occurrence, both test-locked) + `makeReminderSweepWorkflow` enqueuing proactive items through T21's enqueue workflow — firing id = reminder id + due instant anchors child workflowID AND inbox message_id, so replays/racing ticks are exactly-once (gated: repeated sweeps, FIFO behind a slow in-flight turn, real every-second cron). Sweep boundary types are plain JSON (`dueAtIso`, `asOfMs`) because step outputs replay through the journal where Dates degrade to strings. New dbos.md gotcha: `registerScheduled` needs an already-registered workflow, raw functions never run. Production cron cadence + make-up mode decision deferred to M6 wiring)*
  - Acceptance: DBOS scheduled workflows that enqueue proactive turns into the same lane; reminder times anchored to household timezone (Eastern), never server time.
  - Verify: integration test — scheduled job waits behind an in-flight turn; tz conversion unit tests.
  - Files: `src/orchestration/scheduled.ts`, `tests/integration/scheduled.test.ts`, `tests/unit/tz.test.ts`.
  - Depends on: T21.

- [x] **T24: M3 reliability suite (`pnpm test:recovery`)** *(done 2026-06-10: the script runs the named gate files as one suite — steps (kill mid-flight exactly-once write, derived-key dedupe), queue (debounce grouping, FIFO), handle-turn (recovery replay diff, no double effect), scheduled (proactive FIFO behind in-flight turn), recovery (NEW: `src/hitl/pending-actions.ts` guarded transitions; approved→executed single-winner claim co-commits with the effect — duplicate approvals gated sequential + concurrent + deny-blocks). CI runs `pnpm test:recovery` explicitly after `pnpm test`. Suite-shakeout found and fixed a 4.19.8 launch-ordering bug (launch-time recovery vs datasource init — permanently errors recovered workflows; see dbos.md, incl. ⚠ production note for M6): kill-drill children isolate under `DBOS__VMID`, parents resume post-launch via `DBOS.resumeWorkflow`)*
  - Acceptance: the named gate tests in one suite — recovery replay (kill mid-flight, diff vs uninterrupted, no double effect), exactly-once state write, execute-once pending-action guard under duplicate approvals (table + guard land here even though full HITL is M5), debounce grouping, FIFO ordering.
  - Verify: `pnpm test:recovery` green in CI.
  - Files: `tests/integration/recovery.test.ts`, `src/hitl/pending-actions.ts`, `package.json`.
  - Depends on: T22, T23.
  - **Gate M3 complete.**

## M4 — Reasoning layer *(full acceptance criteria refined at milestone entry)*

- [x] **T25: `callModel` via AI SDK Core + prompt caching (per T7's verdict); model-call step records assistant msg + tool_use ids atomically** *(done 2026-06-10: `makeCallModel` + `toSdkMessages` in `src/agent/call-model.ts`, 12 unit tests on `MockLanguageModelV3`. Atomicity is structural — one returned `AssistantMessage` = one `runStep` journal entry, test-locked. Gotchas: `exactOptionalPropertyTypes` rejects passing `ToolSet | undefined` to optional SDK params (conditional spread); V3 mock tool-call parts take stringified `input`, result-level `toolCalls[].input` comes back parsed. `tools` stays optional until T26's registry; composing caller owns provider instantiation (`createAnthropic` from Config) — wired at the M4 gate's `pnpm dev`)*
  - Acceptance *(refined 2026-06-10 at M4 entry)*: `makeCallModel(deps)` produces the `HandleTurnDeps['callModel']` function T22 wraps in `DBOS.runStep` — deps are `{ model, systemPrompt, tools?, onUsage? }` (DI; provider instantiation stays with the composing caller via Config, never module-level). Maps the persisted `TurnMessage[]` to AI SDK messages with the stable system prefix as a system message carrying `cacheControl: ephemeral` through provider passthrough (T7 verdict; `allowSystemInMessages`); tool-result messages resolve `toolName` from prior assistant tool calls and fail loud on an unresolvable id (corrupt transcript). `forceFinal` ⇒ `toolChoice: 'none'`. Returns ONE `AssistantMessage` carrying the response text + every tool_use id/name/args — that single object is the journaled step output, which *is* the atomicity requirement. Usage (incl. cache read/write) surfaces via `onUsage` for T31/T33, never into the transcript.
  - Verify: unit tests with `MockLanguageModelV3` (`ai/test`) — no network; real model calls never run in CI.
  - Files: `src/agent/call-model.ts`, `tests/unit/call-model.test.ts`.
  - Depends on: T22 (seam), T7 (caching verdict).
- [x] **T26: Tool registry — `defineTool` (Zod schema, risk tier, idempotency, revalidation hooks)** *(done 2026-06-10: `define-tool.ts` + `registry.ts`, 14 unit tests. Confirm-before-needs-revalidate enforced at definition time; `makeRunTool` forces `parked: true` on the park path regardless of the park impl; actionId = `act-<conversationId>-<toolUseId>` — journaled values only, replay re-derives identically with no DBOS runtime read. Type gotcha: `ToolDefinition` declares `execute`/`revalidate` in METHOD syntax on purpose — bivariant params keep concretely-schemed defs assignable to `AnyToolDefinition`; arrow-property syntax breaks the registry under strictFunctionTypes. Deferred: execute errors propagate (transaction rolls back, turn errors) — turn-level error folding lands with T27's real fallible tools; `revalidate` is carried but only invoked at T35)*
  - Acceptance *(refined 2026-06-10 at M4 entry)*: `defineTool` per the SPEC snippet — name, description, Zod schema, risk tier (autonomous / notify-after / confirm-before per architecture decision 10), optional `externalId(ctx)` (deterministic from actionId), optional `revalidate(args, deps)`, `execute(args, deps, ctx)`; the SPEC "Always" boundary *confirm-before ⇒ revalidation check declared* enforced at definition time (throws). `makeToolRegistry` rejects duplicate names. Two projections: `toToolSet` → AI SDK definitions-only ToolSet (no execute — DBOS owns the loop) feeding T25's `tools` dep; `makeRunTool(registry, deps)` → the `(db, call, conversationId) → ToolResult` body the composer wraps in `registerTransactionalStep` (T22 fixture pattern), which parses args through the tool's schema, derives `actionId` deterministically from journaled values only (conversationId + toolUseId — replay-safe without DBOS runtime reads), resolves `externalId`, and dispatches by tier: autonomous/notify-after execute in-turn against the transaction-scoped db; confirm-before NEVER executes — it goes through an injected `park` seam (T34 brings the production park; the synthetic pending result shape is the seam's contract). Model-mistake paths (unknown tool, schema-invalid args) return error `ToolResult`s, never throw — every tool_use gets a tool_result. `revalidate` is carried, not invoked (runs at T35's approval execution, not propose time). Execute errors propagate (transaction rolls back) — turn-level error folding deferred to T27 when real fallible tools land.
  - Verify: unit tests (pure logic + injected fake db/park) — definition invariant, duplicate rejection, ToolSet projection has no execute, dispatch/validation/park paths, deterministic actionId.
  - Files: `src/tools/define-tool.ts`, `src/tools/registry.ts`, `tests/unit/define-tool.test.ts`, `tests/unit/registry.test.ts`.
  - Depends on: T25 (ToolSet consumer), T19 (transactional-step pattern), T24 (pending-actions guard downstream).
- [x] **T27: Tools — lists, reminders, household facts read/write** *(done 2026-06-10: eight autonomous tools (`lists.ts`/`reminders.ts`/`facts.ts`, assembled in `index.ts`), 17 integration tests through `makeRunTool` against real Postgres + full suite green incl. recovery gates. All five hard criteria test-locked: EDT 07:00→11:00Z AND EST 07:00→12:00Z stored instants; secret-class values absent from both get_fact AND set_fact result content; guarded scheduled→cancelled (new `cancelReminder`/`getScheduledReminders` accessors); Hebrew/English round-trips. Ids in result content are the follow-up contract (`reminder <uuid>`, `id <uuid>` — tests regex them out as the model would). `list_reminders` renders Eastern wall time via Intl inside the tool (step context — journaled, determinism rule doesn't apply). uuid-validated id args turn model mistakes into invalid-args tool_results instead of Postgres cast errors aborting the turn)*
  - Acceptance *(refined 2026-06-10 at M4 entry)*: the v1 tool surface (architecture "v1 tool surface" note), every tool through T26's `defineTool` with a declared risk tier — all eight are **autonomous** (reversible household-internal DB rows; no cost, no third party — per decision 10's classification axes; calendar in M5.5 is where confirm-before appears): `add_list_item` / `get_list` / `mark_item_done`; `create_reminder` / `list_reminders` / `cancel_reminder`; `set_fact` / `get_fact`. Hard criteria, each test-locked: **(1) tz anchoring** — `create_reminder` takes household wall-time fields (year/month/day/hour/minute, Eastern implied) and converts via T23's `wallTimeToInstant`; stored `due_at` asserted equal to the named instant for an EST date AND an EDT date (offset actually applied, not server-time). **(2) Secret-class read enforcement** — `get_fact` on an `is_secret` row returns an existence acknowledgment that withholds the value (the schema comment's "enforcement lives in the read paths" lands here); the value string must not appear in the ToolResult content. **(3) Guarded cancel** — `cancel_reminder` flips only `scheduled` → `cancelled` (new guarded store accessor, same shape as `markReminderFired`); cancelling a fired/cancelled reminder reports failure, doesn't throw. **(4) Round-trip through the real path** — every tool exercised through `makeToolRegistry` + `makeRunTool` against real Postgres (integration suite), state asserted in the DB, not against fakes. **(5) Mixed Hebrew/English fixtures** — list items and fact values round-trip code-switched text intact. Model-facing result content includes the ids follow-up calls need (item ids in `get_list`, reminder id in `create_reminder`/`list_reminders`). Sender attribution (`addedBy`/`createdBy`) arrives as a model-supplied arg — the model reads it from sender-attributed user messages (T25); plumbing the raw sender through the seam is deliberately not done (eval T38 checks the model gets it right). Deferrals: recurrence stays schema-only (the T23 sweep doesn't reschedule recurring reminders yet — exposing it would half-work; M6 decision); execute-error folding moves to T40 where genuinely fallible external tools appear (these tools' only failure mode is the DB, which fails the whole turn anyway).
  - Verify: `DATABASE_URL=… pnpm test` — `tests/integration/tools.test.ts` green in CI; unit tests for pure formatting/validation.
  - Files: `src/tools/lists.ts`, `src/tools/reminders.ts`, `src/tools/facts.ts`, `src/tools/index.ts` (registry assembly), `src/memory/store.ts` (cancel + list-scheduled accessors), `tests/integration/tools.test.ts`.
  - Depends on: T26, T23 (tz), T18 (store).
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
