# hh-assistant

![CI](https://github.com/shem86/hh-assistant/actions/workflows/ci.yml/badge.svg)
![status](https://img.shields.io/badge/status-live-success)
![lines of code](https://img.shields.io/badge/lines%20of%20code-7k-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node.js-22-339933?logo=node.js&logoColor=white)
![Postgres](https://img.shields.io/badge/Postgres-pgvector-4169E1?logo=postgresql&logoColor=white)
![DBOS](https://img.shields.io/badge/DBOS-4.19.8-0A0A0A)
![Claude](https://img.shields.io/badge/Claude-Anthropic-D97757?logo=anthropic&logoColor=white)
![Vercel AI SDK](https://img.shields.io/badge/Vercel%20AI%20SDK-Core-000000?logo=vercel&logoColor=white)

**Ezra** (עזרא) is a WhatsApp household assistant for a two-person family group,
built as a production-grade exercise in reliable agentic systems. It handles
reminders, shared lists (groceries/todos), Google Calendar, and memory-backed
household Q&A — in mixed Hebrew and English. It is **live**, running on a
hardened cloud host against the real WhatsApp group.

## What's actually interesting here

The hard part of a household agent is not the model — it's that this class of
system **fails quietly at its edges**, and the consequence of a silent failure
is a person who stops getting reminders and tells you about it before your logs
do. So the engineering is spread across five boundaries where these systems
tend to fail without a crash, plus the cross-cutting concerns of cost and
operability. The LLM is the easy 10%.

### 1. The ingestion boundary — durable capture before ack

An inbound WhatsApp message is **durably enqueued before it is acknowledged**.
A crash between receive and enqueue replays from WhatsApp's offline redelivery;
`ingestWorkflowId` dedupe makes that redelivery safe. The message is never lost
in the window where most naive agents drop it.

### 2. Durable execution — exactly-once, surviving `kill -9`

The agent is not a long-lived process holding a conversation; it's a sequence
of short-lived **durable turns** orchestrated by [DBOS](https://www.dbos.dev/)
on one Postgres. Every structured-state write happens in a DBOS transactional
step, so the write and its journal checkpoint **co-commit in one Postgres
transaction** — that co-commit *is* the exactly-once guarantee. Crash recovery
replays the journal instead of re-running completed steps. A custom ESLint rule
(`hh/no-nondeterminism-in-workflow`, CI-failing) bans clock reads, randomness,
and env access inside workflow bodies so replay stays deterministic. Proven by
a kill-mid-flight recovery suite (`pnpm test:recovery`) that SIGKILLs a child
process mid-turn and asserts identical output with every effect count == 1.

### 3. The human boundary — non-blocking human-in-the-loop

Risky actions (calendar writes — third-party-visible) never auto-execute. They
**park** as `pending_actions` rows with an approval prompt and fold the turn
closed — no blocked process, no held lock. A quoted-reply approval binds to the
action via the persisted prompt message id and resumes it in a *fresh turn
through the same lane*, **revalidated at execute time** (the slot is re-checked
free right before the write). The approved→executed claim is a single-winner
co-commit with the effect, so both spouses answering "yes" back-to-back
executes exactly once. Approve/deny is decided by **deterministic Hebrew/English
keyword sets — no model in the approval decision**; a Haiku-class relatedness
classifier only routes the ambiguous middle (refine / unrelated / approve-deny)
while an action pends, and a TTL sweep gently expires unanswered ones.

### 4. The external-service boundary — idempotency everywhere

Every external effect carries an idempotency key derived from
`(workflowID, stepNumber)`. Calendar events use a **deterministic id**
(`hh` + SHA-256 of the action id), so a recovery replay re-creating an event
hits Google's 409 and folds it to success — no duplicate booking. Outbound
messages are **classified**: at-least-once (reminders, nags, approval prompts —
send-then-log) or at-most-once (conversational echoes — log-then-send), tracked
against a `sent_log`; a permanent unroutable-destination error dead-letters with
an alert instead of wedging the concurrency-1 lane forever.

### 5. The recovery & failure-detection boundaries — restore is mechanical, not heroic

State is backed up as **client-side-encrypted point-in-time-recovery** (base
backups + continuous WAL) to S3, using **asymmetric age encryption** — the host
holds only the public recipient, so a host compromise can't decrypt existing
backups; the private key lives offline, restore-only. After a restore,
reconciliation is mechanical: `sent_log` answers "what did we already send" and
deterministic calendar ids answer "what did we already create" (re-execute →
409 → already-exists). A documented runbook + a self-contained restore drill
prove it. Liveness is watched by an **independent** channel: a Telegram
down-alert on a path that does not depend on the WhatsApp socket it monitors,
plus an external dead-man ping.

### Cross-cutting: cost discipline & a real security posture

- **Prompt caching is engineered, not hoped for.** The system prompt is a
  byte-stable cache prefix; per-turn dynamic state (the pending-actions digest,
  the pushed wall-clock) appends strictly *after* it. On live traffic, **78% of
  input tokens are cache reads**, holding cost to **~$9/mo** (and under the
  $30/mo ceiling even priced as if caching were off). The cost gate is
  measured, not assumed —
  [ADR-0003](docs/adr-0003-remove-turn-router.md) even *removed* a tiered
  cheap/expensive router once measurement showed it forfeited the cache for no
  real saving.
- **Credentials never reach the model — by construction and by CI.** API keys,
  OAuth tokens, and the Baileys session never enter prompts, traces, or the
  semantic store; tools receive authenticated clients via `deps`, never raw
  secrets, and a test sweeps emitted traces for any secret value. The egress
  allowlist is a **unit-tested source of truth** — a new dependency that dials
  an unlisted host turns CI red — and it renders the host's default-deny
  nftables ruleset. The runtime is a non-root, read-only-rootfs,
  `cap_drop: [ALL]` container.

> One detail that delighted me: the model had **no clock**. Its training anchor
> made "today" feel like mid-2025, so "remind me in 5 minutes" resolved 11
> months into the past and fired instantly — a silent success. The fix
> ([T47](TASKS.md)) pushes the real Eastern wall-time into every turn as a
> post-prefix system block (cache-safe), mirroring how Claude's own system
> prompt injects `{{currentDateTime}}`.

## How it works

```
WhatsApp (Baileys) ──► durable enqueue ──► one FIFO lane (concurrency 1,
                       before ack             │       partitioned per conversation)
                                              ▼
                                   handleTurn workflow
                                   loadContext → model loop → persistContext
                                              │
                          Claude via AI SDK Core (Sonnet-class turn reasoning,
                          single-tier v1; prompt caching on the stable prefix)
                                              │
                              typed tools (Zod schema, risk tier,
                              idempotency key, revalidation)
                                              ▼
                          ONE Postgres: DBOS journal + structured state
                          + pgvector semantic memory, co-located on purpose
```

Three event sources — human messages (debounced), scheduled reminders, and
approval events — all enqueue into a **single concurrency-1 lane keyed by the
conversation**. Tasks co-exist as durable state; they never co-execute. Memory
is split: a structured store (lists, reminders, facts, pending actions) and a
pull-only **pgvector** semantic recall tool
([Voyage](docs/adr-0002-voyage-embeddings.md) embeddings); a compaction step
folds long transcripts into an embedded summary while keeping open commitments
verbatim.

## Project status — **live (v1)**

All milestones M0–M6 are complete; the
[launch checklist](docs/launch-checklist.md) closed every SPEC success
criterion with evidence.

| Milestone | Gate | Status |
|---|---|---|
| M0 — Scaffold (TS/pnpm/Vitest/ESLint/CI/dev DB) | CI green end-to-end | ✅ done |
| M1 — De-risking spikes | caching + DBOS semantics proven | ✅ done |
| M2 — Transport adapter + ops monitoring | alert + dead-man drills | ✅ done |
| M2.5 — Host + encrypted backups | verified restore | ✅ done |
| M3 — Durable core | `pnpm test:recovery` green | ✅ done |
| M4 — Reasoning layer | all tools exercised, cost ≤ $30/mo | ✅ done (~$9/mo) |
| M5 — HITL approval flows | five decision-9 eval scenarios pass | ✅ done (8/8) |
| M5.5 — Calendar | real-wire round-trip gate | ✅ done |
| M6 — Wire-up and launch | SPEC success checklist swept | ✅ **live** |

Live on a hardened AWS EC2 host with continuous PITR backups; ~7k lines of
strict TypeScript, 57 test files (598 unit + integration, plus a dedicated
recovery gate). Task-level history: [`TASKS.md`](TASKS.md). Spike verdicts and
pinned versions: [`docs/spike-results.md`](docs/spike-results.md).

## Getting started

Prerequisites: Node 22+, pnpm 10, Docker (Colima works).

```bash
pnpm install
docker compose up -d          # one Postgres with pgvector on :5432
cp .env.example .env          # fill in keys (never committed)

pnpm build                    # tsc, strict
pnpm lint                     # eslint incl. the custom DBOS-determinism rule
pnpm test                     # unit only without DATABASE_URL…
DATABASE_URL=postgres://hh:hh@localhost:5432/hh_assistant pnpm test   # …+ integration
pnpm test:recovery            # kill-mid-flight replay gate
```

Spikes run directly under Node 22's type stripping:

```bash
node --env-file=.env spikes/cache-control.ts   # prompt-caching proof
```

CI (GitHub Actions) runs build + lint + the full test suite against a pgvector
service container on every push and PR. Model calls, real WhatsApp traffic, and
real calendar writes never run in CI.

## Repository layout

```
src/transport/      Baileys socket, ingestion, send classes, sent-log
src/orchestration/  DBOS workflows, queue, debounce, scheduled jobs, recovery
src/agent/          handleTurn loop, prompts, compaction, call-model
src/tools/          typed tool definitions: Zod, risk tiers, idempotency, calendar
src/memory/         structured store + pgvector semantic store + embedder
src/hitl/           pending_actions, park, approval binding, refine, TTL expiry
src/ops/            config/secrets, health, alerts, dead-man, tracing, egress
src/main.ts         production composition (Baileys + DBOS + Claude)
eslint-rules/       custom rule: no nondeterminism in workflow bodies
spikes/             de-risking + real-wire smoke scripts
infra/              host provisioning, hardened compose, egress nftables, backups
tests/              unit + integration (integration gated on DATABASE_URL)
evals/              model-in-the-loop decision-9 scenarios (on-demand)
docs/               ADRs, spike results, runbooks, drill logs, launch checklist
```

## Documentation map

| Document | What it owns |
|---|---|
| `household-ai-agent-architecture-v3_5.md` | **Why** — the locked architecture decisions |
| [`SPEC.md`](SPEC.md) | **What/how** — scope, conventions, boundaries, success criteria |
| [`docs/adr-0001-remove-secret-fact-class.md`](docs/adr-0001-remove-secret-fact-class.md) | Why the user-facing secret-fact class was dropped |
| [`docs/adr-0002-voyage-embeddings.md`](docs/adr-0002-voyage-embeddings.md) | Why Voyage + a zero-dependency fetch client for embeddings |
| [`docs/adr-0003-remove-turn-router.md`](docs/adr-0003-remove-turn-router.md) | Why the tiered cheap/reasoning turn router was removed |
| [`docs/adr-0004-service-account-calendar.md`](docs/adr-0004-service-account-calendar.md) | Why a shared-calendar service account over OAuth consent |
| [`docs/launch-checklist.md`](docs/launch-checklist.md) | SPEC success criteria, each box closed with evidence |
| [`docs/recovery-runbook.md`](docs/recovery-runbook.md) | The four loss scenarios + mechanical reconciliation |
| [`docs/spike-results.md`](docs/spike-results.md) | Spike verdicts, version pins, gotchas |
| [`CLAUDE.md`](CLAUDE.md) + `.claude/rules/` | Working agreements for AI-assisted sessions |

Build history lives in [`PLAN.md`](PLAN.md) (milestones M0–M6) and
[`TASKS.md`](TASKS.md) (the dependency-ordered task ledger with per-task
done-notes and the deferred-decisions ledger).

## Stack

Node 22 · TypeScript (strict) · pnpm (exact pins) · DBOS 4.19.8 ·
Postgres + pgvector · Vercel AI SDK Core + Claude (Sonnet-class reasoning,
Haiku-class classification) · Voyage embeddings (voyage-4-lite) · Baileys ·
Langfuse · Vitest · ESLint (flat config + custom determinism rule) ·
GitHub Actions · age-encrypted PITR to S3 · host nftables egress allowlist.

All dependency versions are pinned exact; the DBOS and AI SDK pins are the
versions the M1 spikes validated — bumps require re-running those suites.
</content>
