# hh-assistant

![CI](https://github.com/shem86/hh-assistant/actions/workflows/ci.yml/badge.svg)
![lines of code](https://img.shields.io/badge/lines%20of%20code-6.6k-blue)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node.js-22-339933?logo=node.js&logoColor=white)
![Postgres](https://img.shields.io/badge/Postgres-pgvector-4169E1?logo=postgresql&logoColor=white)
![DBOS](https://img.shields.io/badge/DBOS-4.19.8-0A0A0A)
![Claude](https://img.shields.io/badge/Claude-Anthropic-D97757?logo=anthropic&logoColor=white)

A WhatsApp household assistant for a two-person family group, built as a
production-grade exercise in reliable agentic systems. It handles reminders,
shared lists (groceries/todos), Google Calendar, and memory-backed household
Q&A — in mixed Hebrew and English.

**The governing principle: reliability beats sophistication in every v1
trade-off.** The interesting engineering here is not the LLM — it's making an
agent that survives `kill -9` mid-turn without losing a reminder or
double-booking a calendar event.

## How it works

The agent is not a long-lived process holding a conversation — it is a
sequence of short-lived **durable turns** orchestrated by
[DBOS](https://www.dbos.dev/) on top of a single Postgres:

```
WhatsApp (Baileys) ──► durable enqueue ──► one FIFO lane (concurrency 1)
                       before ack             │
                                              ▼
                                   handleTurn workflow
                                   loadContext → model loop → persistContext
                                              │
                          Claude via AI SDK Core (Sonnet reasons — v1 single-tier,
                          prompt caching on the stable prefix)
                                              │
                              typed tools (Zod schema, risk tier,
                              idempotency key, revalidation)
                                              ▼
                          ONE Postgres: DBOS journal + structured state
                          + pgvector, co-located on purpose
```

Design properties worth knowing:

- **Exactly-once state writes.** Every structured-state write happens in a
  DBOS transactional step, so the write and its journal checkpoint commit in
  one Postgres transaction. Crash recovery replays the journal instead of
  re-executing completed steps — proven by the kill-mid-flight test suite.
- **One lane, three event sources.** Human messages (debounced), scheduled
  reminders, and approval events all enqueue into a single concurrency-1
  queue keyed by the conversation. Tasks co-exist as state; they never
  co-execute.
- **Human-in-the-loop without blocking.** Risky actions (calendar writes)
  park as `pending_actions` rows with an approval prompt; a quoted-reply
  approval resumes them in a fresh turn, revalidated at execute time.
- **Classified sends.** Every outbound message is at-least-once (reminders,
  approval prompts) or at-most-once (echoes), tracked against a sent-log —
  no unclassified side effects.
- **Credentials stay out of the model.** API keys, OAuth tokens, and the
  Baileys session never enter prompts, traces, or the semantic store — by
  construction: tools receive authenticated clients via `deps`, never raw
  credentials.

## Project status

| Milestone | Gate | Status |
|---|---|---|
| M0 — Scaffold (TS/pnpm/Vitest/ESLint/CI/dev DB) | CI green end-to-end | ✅ done |
| M1 — De-risking spikes | caching + DBOS semantics proven | ✅ done (gate closed 2026-06-09) |
| M2 — Transport adapter + ops monitoring | alert + dead-man drills | ⬜ next |
| M2.5 — Host + encrypted backups | verified restore | ⬜ |
| M3 — Durable core (stubbed model/transport) | `pnpm test:recovery` green | ⬜ |
| M4 — Reasoning layer | all tools exercised, cost ≤ $30/mo | ⬜ |
| M5 — HITL approval flows | five eval scenarios pass | ⬜ |
| M6 — Wire-up and launch | SPEC success checklist swept | ⬜ |

Live task-level progress: [`TASKS.md`](TASKS.md). Spike verdicts and pinned
versions: [`docs/spike-results.md`](docs/spike-results.md).

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
```

Spikes run directly under Node 22's type stripping:

```bash
node --env-file=.env spikes/cache-control.ts   # prompt-caching proof
```

CI (GitHub Actions) runs build + lint + the full test suite against a
pgvector service container on every push and PR.

## Repository layout

```
src/transport/      Baileys socket, ingestion, send classes, sent-log   (M2+)
src/orchestration/  DBOS workflows, queue, debounce, scheduled jobs     (M3+)
src/agent/          handleTurn loop, prompts, compaction                (M3+)
src/tools/          typed tool definitions: Zod, risk tiers, idempotency(M4+)
src/memory/         structured store + pgvector semantic store          (M3+)
src/hitl/           pending_actions, approval binding, TTL GC           (M5)
src/ops/            config/secrets loading, health, alerts              ✓ config
eslint-rules/       custom rule: no nondeterminism in workflow bodies   ✓
spikes/             M1 de-risking spikes (caching, DBOS semantics)      ✓
tests/              unit + integration (integration gated on DATABASE_URL)
infra/              compose, host/backup notes
docs/               spike results, runbooks (as they land)
```

## Documentation map

| Document | What it owns |
|---|---|
| `household-ai-agent-architecture-v3_5.md` | **Why** — the locked architecture decisions |
| [`SPEC.md`](SPEC.md) | **What/how** — scope, conventions, boundaries, success criteria |
| [`PLAN.md`](PLAN.md) | Build order, dependencies, risks, verification gates |
| [`TASKS.md`](TASKS.md) | Dependency-ordered tasks with acceptance criteria |
| [`docs/spike-results.md`](docs/spike-results.md) | Spike verdicts, version pins, gotchas |
| [`CLAUDE.md`](CLAUDE.md) + `.claude/rules/` | Working agreements for AI-assisted sessions |

## Stack

Node 22 · TypeScript (strict) · pnpm (exact pins) · DBOS 4.19.8 ·
Postgres + pgvector · Vercel AI SDK Core + Claude · Baileys · Langfuse ·
Vitest · ESLint (flat config + custom determinism rule) · GitHub Actions.

All dependency versions are pinned exact; the DBOS and AI SDK pins are the
versions the M1 spikes validated — bumps require re-running those suites.
