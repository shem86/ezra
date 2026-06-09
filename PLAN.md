# Plan: Household AI Agent v1 (hh-assistant)

> **Status: APPROVED 2026-06-09 — Phase 3 (Tasks) in progress, see `TASKS.md`.**
> Derived from `SPEC.md` (approved 2026-06-09) and `household-ai-agent-architecture-v3_5.md`. This is the implementation strategy: build order, dependencies, risks, verification gates. Phase 3 (Tasks) breaks the approved version of this into per-session tasks.

## Shape of the plan

Two tracks run in parallel from day one:

- **Track W (wall-clock):** burner SIM, number warming, staged soak. Weeks of elapsed time, almost no engineering effort. It is the project's critical path, so it starts first.
- **Track S (software):** milestones M0–M6 below. Each milestone ends at a verification gate; no milestone starts on an unverified foundation.

The agent meets the real transport only at M6, when both tracks are done — per the architecture's hard rule: no agent on an unsoaked transport.

```
Track W:  SIM → warm (1–2wk) → soak A → soak B → soak C ──────────────┐
                      (needs M2 harness for B)                        │
Track S:  M0 scaffold → M1 spikes → M2 soak harness → M3 durable core │
                                      → M4 reasoning → M5 HITL ───────┴→ M6 wire-up → launch
          (M2.5 host/backup and calendar OAuth run parallel to M3–M5)
```

## Track W — transport (start immediately)

1. Buy physical prepaid SIM (~$20, VoIP blocked at registration). Register WhatsApp, create the 2-person group, both spouses save the contact.
2. **Warm 1–2 weeks:** use it like a human (Stage A soak is this warming window observed via the M2 harness once it exists).
3. **Stage B (needs M2):** one proactive bot send per day, human-like delays, ≥1 forced reconnect, several days.
4. **Stage C:** ramp toward v1 cadence, watch for enforcement.
5. Log everything in `docs/soak-log.md` (dates, traffic, anomalies). Gate for M6.

Risk: ban during soak → number is disposable; buy a new SIM, restart warming. The schedule absorbs this; the design does not change.

## Track S — software milestones

### M0 — Scaffold (no product code)
Repo skeleton per SPEC structure; pnpm (exact pins), strict tsconfig, Vitest, ESLint, Docker Compose for the single dev Postgres (pgvector image), CI running build/lint/test, Langfuse account + keys wired into config loading.
**Gate:** `pnpm build && pnpm lint && pnpm test` green in CI on a hello-world workflow test against the dev Postgres.

### M1 — De-risking spikes (the two named gates + determinism rule)
Three independent pieces, parallelizable:
- **1a. Prompt-caching spike (SPEC Phase-0 gate):** minimal AI SDK Core `generateText` against Claude with `cache_control` via provider passthrough; assert `cache_read_input_tokens > 0` on the second call. **If it fails, stop and decide the `@anthropic-ai/sdk` escape hatch for the model-call step only** — this is the one pre-authorized deviation (architecture decision 4).
- **1b. DBOS semantics spike:** minimal workflow on the dev Postgres proving the assumptions the whole design leans on: transactional step (state write + step record atomic), kill-mid-flight recovery replay, queue concurrency-1 ordering, a scheduled workflow firing, and journal/state/pgvector co-residing in one Postgres. Pin the DBOS version this validates.
- **1c. Determinism ESLint rule:** custom rule banning clock reads, randomness, env branches, direct I/O inside `@DBOS.workflow` bodies; fixture tests; CI-failing.
**Gate:** 1a result recorded in `docs/` (caching confirmed or escape hatch decided); 1b spike repo-committed with passing kill/replay test; 1c rule red on fixtures, green on clean code.

### M2 — Transport soak harness (standalone, agent-free)
Baileys socket behind the `src/transport/` interface, session-state persistence (writable volume, never backed up for restore), socket-health monitor, **independent alert channel** (Telegram/Pushover — pick at build time), dead-man ping to healthchecks.io-style service, forced-reconnect command, minimal once-a-day proactive send for Stage B. Runs on the dev box or the host, no LLM, no DB writes beyond a soak log.
**Gate:** harness sustains Stage A traffic; alert fires on manual socket kill; dead-man fires on process kill. Unblocks Track W Stage B.

### M2.5 — Host + backups (parallel to M3–M5, before M6)
Provision host (Oracle PAYG re-verified that week, else Hetzner). Production Postgres on the box, process hardening (non-root, read-only rootfs + the two writable volumes, no extra capabilities), egress allowlist v0 (Anthropic, Google, B2/R2, alert channel, WhatsApp — iterate), WAL archiving + base backups to B2/R2 client-side encrypted.
**Gate (SPEC Phase-0):** restore into a scratch DB verified — an untested backup is a hypothesis.

### M3 — Durable core (stubbed model, stubbed transport)
The spine, fully testable without LLM or WhatsApp:
- Structured store schema v0: lists, reminders, household facts, `pending_actions`, sent-log, persisted conversation context, secret-class column convention.
- Ingestion contract: durable-enqueue-before-ack seam (transport stub honors it), self-echo filter, consumer-side debounce on dequeue.
- `handleTurn` workflow skeleton with stubbed `callModel`; transactional-step helpers for all state writes; `(workflowID, stepNumber)` idempotency-key helper for external effects.
- Scheduled reminder workflows enqueueing proactive turns into the same lane.
**Gate:** integration suite green, specifically: recovery replay (kill mid-flight, diff, no double effect), exactly-once state write under kill, execute-once pending-action guard under duplicate approvals, debounce grouping, FIFO ordering across human + proactive interleave. This is the `pnpm test:recovery` checkpoint from SPEC.

### M4 — Reasoning layer (real model, stubbed transport)
- `callModel` step via AI SDK Core with caching from M1a; Haiku router; tool registry (`defineTool`: Zod schema, risk tier, idempotency, revalidation hooks).
- Tools for lists, reminders, memory read/write (calendar arrives in M5.5); pull-only semantic recall tool; compaction step (idempotency-keyed) with threshold from Open Question 3 (propose: compact at ~30 turns, keep open commitments verbatim).
- MAX_ROUNDS cap with forced final user-facing message; Langfuse tracing on every step; mixed Hebrew/English prompt + fixture set.
**Gate:** scripted conversations through `pnpm dev` (stub transport) exercise every tool happy-path; traces show cache reads; cost per realistic turn measured and extrapolated ≤ $30/mo.

### M5 — HITL (the riskiest behavior, still stubbed transport)
Fire-and-fold end-to-end: park (synthetic pending result + `pending_actions` row + approval prompt), quoted-reply binding, relatedness classifier (Haiku), pending-actions digest injection, fresh-turn execution with revalidation and status transitions, TTL GC with gentle expiry surfacing.
**Gate:** `pnpm eval` passes all five SPEC scenarios — approve-after-delay, deny, abandon-by-unrelated-message, refine-the-pending-action, stale-action-at-execution — plus execute-once under double approval. Mixed-language fixtures included.

### M5.5 — Calendar (parallelizable after M4 tool registry exists)
Google Cloud project, OAuth consent + scopes, refresh-token storage as secret-class, deterministic event IDs from action_id, revalidation (slot still free), calendar tools registered confirm-before.
**Gate:** create/read round-trip on a test calendar; re-execution no-ops; revalidation catches a manufactured conflict.

### M6 — Wire-up and launch (requires Track W complete + M2.5 + M5 gates)
Swap stub transport for the soaked Baileys harness; durable-enqueue-before-ack against the real socket; send classes live (at-least-once: reminders, nags, approval prompts; at-most-once: echoes); recovery runbook written (`docs/recovery-runbook.md`) using sent-log + deterministic IDs; full restore drill incl. runbook reconciliation; deploy hardened process to host.
**Gate:** SPEC success-criteria checklist swept top to bottom; ramp per Stage C cadence. Launch is the checklist completing, not a date.

## Dependency summary

- M1b blocks M3 (don't build the spine on unverified DBOS semantics). M1a blocks M4's cost design only (M4 can start, caching wiring waits).
- M2 blocks Track W Stage B; Track W blocks M6 only.
- M2.5 and M5.5 float; both must land before M6.
- M3 → M4 → M5 is strictly sequential (each layer is the test fixture for the next).

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Core passthrough can't express `cache_control` | Low–med | M1a is first; pre-authorized escape hatch scoped to the model-call step |
| DBOS behavior diverges from assumed semantics | Low | M1b proves transactional steps, replay, queues before anything builds on them; pin the validated version |
| Number banned mid-soak | Med | Disposable SIM; restart warming; schedule absorbs it; agent code unaffected |
| Oracle capacity/policy blocks $0 host | Med | Hetzner decision pre-made at ~EUR 4/mo; M2.5 is host-agnostic |
| Relatedness classifier misjudges refine-vs-unrelated | Med | M5 eval fixtures (incl. code-switched Hebrew/English); accepted v1 risk per architecture |
| Cost exceeds $30/mo | Low | M4 gate measures per-turn cost before launch; levers: compaction threshold, Haiku routing share |
| Old-Mac dev environment (Colima/QEMU) flakiness | Low | Single-Postgres compose is the only container need; CI (Linux) is the arbiter, Colima only for local runs |

## What this plan deliberately defers

Subagents, self-improving loops, code-execution tools (architecture decision 11), LLM-as-judge quality evals, any second conversation/group (the queue is keyed by conversation, so the seam exists; nothing else is built for it).

## Verification checkpoints (the gates, in one list)

1. M0: CI green on scaffold.
2. M1: caching confirmed-or-escape-hatch; DBOS spike passes kill/replay; lint rule proven on fixtures.
3. M2: alert fires on socket kill; dead-man fires on process kill.
4. M2.5: scratch-DB restore verified.
5. M3: recovery replay, exactly-once, execute-once, debounce, FIFO — all green (`pnpm test`, `pnpm test:recovery`).
6. M4: all tools exercised via stub transport; cache reads visible; cost extrapolation ≤ $30/mo.
7. M5: all five HITL eval scenarios pass (`pnpm eval`).
8. M5.5: calendar round-trip + idempotent re-execute + revalidation catch.
9. Track W: soak log shows A, B, C complete without enforcement.
10. M6: SPEC success-criteria checklist fully swept.
