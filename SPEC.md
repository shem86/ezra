# Spec: Household AI Agent v1 (hh-assistant)

> **Status: APPROVED 2026-06-09 — Phase 2 (Plan) in progress, see `PLAN.md`.**
> Architecture decisions live in `household-ai-agent-architecture-v3_5.md` (the locked source of truth for *why*). This spec is the source of truth for *building*: scope, conventions, structure, verification, and boundaries. Where the two overlap, the architecture doc wins on rationale, this spec wins on implementation detail.

## Confirmed facts (were assumptions; confirmed by the builder 2026-06-09)

1. Household language is **mixed Hebrew + English** — prompts and eval fixtures cover both, including code-switched messages for the relatedness classifier.
2. Package manager is **pnpm** with `save-exact` pinning and a committed lockfile (the pinning requirement in architecture decision 1 makes exact versions non-negotiable regardless of tool).
3. Monthly Claude API budget for the runtime: **$10–30/mo** — the cost-control success criterion below derives from the upper bound.

## Remaining assumptions

4. Household timezone is **Eastern Time Zone** — all reminder scheduling anchors to it, never to server time.
5. Node 22 LTS, TypeScript strict mode, single-package repo (no monorepo — one process, one deployable).
6. Local dev runs a single Postgres (journal + state + pgvector in one instance) via Docker Compose, mirroring the production single-Postgres topology — co-location is a correctness requirement (transactional steps, decision 3), so dev must not split what prod co-locates.
7. Build order is gated: **Phase-0 spikes precede agent implementation** (per decision 4 — no cost plan without verified prompt caching). Number acquisition, warming, and soak testing are **out of scope** for this project; the transport is assumed paired and usable.
8. Test framework is Vitest; lint is ESLint (load-bearing, not a style choice — decision 3 requires a *custom ESLint rule* for workflow determinism, which rules out Biome for v1).

→ Hardened on spec approval (2026-06-09).

## Objective

A WhatsApp-based household assistant for two users (the builder and his wife) in a shared group, with dual goals: production-grade agentic-systems learning, and genuine daily utility. Reliability beats sophistication in every v1 trade-off (governing principle + blast-radius note in the architecture doc).

**v1 capabilities (confirmed scope):**
- Reminders / scheduling (proactive sends, anchored to household timezone)
- Shared lists (groceries / todos)
- Google Calendar read/write
- Memory-backed household Q&A

Everything else (subagents, self-improving loops, code execution) is explicitly later-phase.

## Tech Stack

| Layer | Choice | Locked by |
|---|---|---|
| Transport | Baileys (unofficial WhatsApp); number provisioning out of scope | Decision 1 |
| Orchestration | DBOS (TS durable execution, embedded) | Decision 3 |
| Reasoning | Vercel AI SDK Core primitives only (`generateText`/`generateObject` + Zod tools); DBOS owns the loop | Decision 4 |
| Models | Claude via Console API key — Sonnet-class for all turn reasoning (single-tier v1, ADR-0003); Haiku-class for cheap classification (compaction summaries, relatedness classifier) | Decision 6, narrowed by ADR-0003 |
| State | One local Postgres on the box: DBOS journal + structured state + pgvector, co-located so state writes commit atomically with their step record (exactly-once); WAL + base backups shipped off-box, encrypted, to B2/R2 for PITR | Decisions 3, 5, 8 |
| Tracing | Langfuse | Decision 9 |
| Host | Oracle PAYG if verified at provisioning, else Hetzner | Decision 7 |
| Runtime/tooling | Node 22 LTS, TypeScript strict, pnpm (exact pins), Vitest, ESLint + custom determinism rule | Assumptions 3, 4, 7 |

All dependency versions pinned exact; lockfile committed; WhatsApp-adjacent transitive tree reviewed per the supply-chain hygiene checklist (architecture open item).

## Commands

The scaffold must provide these from day one (they are the verification interface for every task):

```
Dev DB up:    docker compose up -d        # one Postgres with pgvector (journal + state co-located, mirrors prod)
Build:        pnpm build                  # tsc, strict
Test:         pnpm test                   # vitest run (unit + integration; integration needs dev DBs)
Lint:         pnpm lint                   # eslint, includes the custom DBOS-determinism rule; CI-failing
Dev:          pnpm dev                    # run the agent locally against dev DBs, transport stubbed
Eval:         pnpm eval                   # decision-9 scenario suite (model-in-the-loop; on-demand, not CI)
Recovery:     pnpm test:recovery          # kill-mid-flight replay scenario (decision 3/9)
```

## Project Structure

```
src/transport/      Baileys socket, ingestion (durable-enqueue-before-ack), self-echo
                    filter, send classes (at-least-once / at-most-once), sent-log
src/orchestration/  DBOS workflows + queue config, consumer-side debounce,
                    scheduled (timer) jobs
src/agent/          handleTurn loop, model calls, prompt assembly, compaction,
                    relatedness classifier
src/tools/          typed tool definitions (Zod), risk tiers, idempotency keys,
                    revalidation checks
src/memory/         structured store (source of truth), semantic store (pgvector,
                    pull-only recall tool), routing rule
src/hitl/           pending_actions store + status transitions, approval binding
                    (quoted-reply), TTL GC
src/ops/            socket-health monitor, independent alert channel, dead-man ping,
                    config/secrets loading
tests/              unit + integration (mirrors src/)
evals/              decision-9 scenario suite + fixtures
docs/               architecture doc, this spec, ADRs, recovery runbook
infra/              compose files, host provisioning notes, egress allowlist,
                    backup/PITR config (WAL archiving + base backups to B2/R2)
```

## Runtime Model: Sessions, Turns, and Context

How the single agent serves two users and many co-living tasks (grounded in architecture decisions 2, 4, 10; the items marked **locked here** are spec-level decisions made on top of them).

**No resident sessions.** The agent is a sequence of short-lived durable turns, not a long-lived process holding a conversation open. All continuity — conversation memory, in-flight tasks, schedules — lives in Postgres, never in process memory.

**One lane, three event sources.** A single DBOS queue (keyed by the group conversation, concurrency 1) receives everything that makes the agent act: debounced human message batches, scheduled-job firings, and approval/denial events. Exactly one turn executes at a time; tasks **co-exist** freely as state (pending_actions rows, scheduled workflows, store rows) but never **co-execute**. Single-step tasks start and finish inside one turn; approval tasks park as rows (fire-and-fold) and resume in a fresh turn; scheduled tasks just enqueue a proactive turn into the same lane.

**Context lifecycle per turn:**
- Every turn starts with a `loadContext(convId)` step (the persisted model-message transcript) and ends with `persistContext`. The concurrency-1 consumer is the transcript's only writer, so there is no context-merge problem by construction.
- Within a turn, `msgs` is workflow-local; each step records only its delta (assistant message, tool result), and replay rebuilds the transcript deterministically. The full transcript is never journaled per step.
- The live window is bounded by two mechanisms: `cache_control` on the stable prefix (system + tool defs + older turns; gated on the Phase-0 passthrough spike) and compaction (threshold-crossing summarize-and-truncate that folds older turns into the semantic store, idempotency-keyed).

**Truth vs continuity.** Exact facts (lists, reminders, schedules, household facts) are never trusted to the transcript — they are read through typed tools at the moment of use. The transcript records that a read/write happened; the database is the truth. Operational credentials (API keys, OAuth tokens, Baileys session state) never enter context, traces, or the semantic store — enforced by construction: tools receive authenticated clients via `deps`, never raw credentials, and prompt assembly never touches `Config`. (A user-facing secret-fact class existed through T27 and was removed — see `docs/adr-0001-remove-secret-fact-class.md`.)

**Cross-turn task state is injected, not remembered:**
- A parked action's real outcome enters the resuming turn as a *new* context message — never a second `tool_result` for the already-answered `tool_use` (architecture decision 10's transcript note).
- **Locked here:** turn assembly injects a small digest of currently outstanding pending actions every turn, so the reasoning model always sees what is in flight (the relatedness classifier decides what a new message *means* for them; the digest is how the model knows they exist).

**Semantic recall is pull-only (locked here).** Episodic recall from pgvector happens through a retrieval tool the model invokes when it judges it needs history — nothing is auto-attached top-k per turn. Rationale: cheaper, and auto-attached recall pollutes context with irrelevant history. Revisit only if evals show the model under-recalls.

## Code Style

Strict TS, no `any` at module boundaries, Zod at every boundary (inbound messages, tool args, model outputs). One representative snippet — a tool definition showing the conventions every tool follows (typed schema, risk tier, idempotency, revalidation):

```ts
export const createCalendarEvent = defineTool({
  name: 'create_calendar_event',
  description: 'Create an event on the shared household calendar.',
  schema: z.object({
    title: z.string().min(1),
    startsAt: z.string().datetime({ offset: true }), // always tz-explicit, household tz
    durationMin: z.number().int().positive().default(60),
  }),
  riskTier: 'confirm-before',
  // Deterministic external ID: makes the create idempotent (decision 10).
  externalId: (ctx) => `hh-${ctx.actionId}`,
  // Re-checked at execute time, not propose time (approval window can be long).
  revalidate: async (args, deps) => deps.calendar.isFree(args.startsAt, args.durationMin),
  execute: async (args, deps, ctx) => deps.calendar.create({ ...args, id: ctx.externalId }),
});
```

Conventions: kebab-case files, camelCase symbols, no default exports, dependency injection via a `deps` object (no module-level singletons — required for testability of workflows).

## Testing Strategy

Three levels, each owning a different failure class:

1. **Unit (Vitest, CI):** pure logic — debounce grouping, idempotency-key derivation, send-class selection, status-transition guards, self-echo filtering, Zod schemas. No network, no DB.
2. **Integration (Vitest + Docker Postgres, CI):** DBOS workflows against real Postgres — the full `handleTurn` with a stubbed model and stubbed transport; the **recovery replay test** (kill mid-flight, replay, diff output, assert no double external effect); **exactly-once state writes** (kill between a transactional step's work and any later point, assert the state mutation is neither lost nor double-applied); pending-action execute-once under duplicate approvals.
3. **Eval (model-in-the-loop, on-demand):** the decision-9 scenarios — approve-after-delay, deny, abandon-by-unrelated-message, refine-the-pending-action, stale-action-at-execution — plus relatedness-classifier accuracy on a fixture set (including mixed Hebrew/English fixtures per assumption 1).

Never in CI: real WhatsApp traffic, real calendar writes, real model calls. Real-traffic transport verification is out of scope for this project.

## Boundaries

**Always:**
- Run `pnpm lint && pnpm test` before any commit; the determinism lint rule is CI-blocking.
- Every external effect carries an idempotency key or declared delivery class (at-least-once / at-most-once) — no unclassified sends.
- Every write to the structured state goes through a DBOS transactional step (decision 3) — never a plain step or a direct query; the atomic state-write + step-record commit is the exactly-once guarantee and it only holds inside a transactional step.
- Every `tool_use` gets a `tool_result`, including denials and parks.
- New/changed tools declare a risk tier; confirm-before tools declare a revalidation check.
- Exact-pin every dependency; lockfile in every commit that touches deps.

**Ask first:**
- Adding any dependency (anything WhatsApp-adjacent gets the full transitive review).
- Database schema changes; changing a tool's risk tier; changing delivery class of a message type.
- Anything that sends real WhatsApp traffic.
- Spending decisions (host provisioning, backup storage (B2/R2), model-tier changes).

**Never:**
- Commit secrets, tokens, or Baileys session state.
- Auto-execute a confirm-before tool, or block the consumer slot on a human.
- Let operational credentials (API keys, OAuth tokens, Baileys session state) into prompts, the semantic store, or Langfuse traces.
- Restore Baileys session state from backup (re-pair via QR is the only recovery).
- Remove or weaken a failing test/lint rule to make CI pass.

## Success Criteria

**Phase-0 gates (must pass before agent implementation):**
- [ ] `cache_control` verified through AI SDK provider passthrough: second identical-prefix call shows `cache_read_input_tokens > 0` (decision 4's named gate).
- [ ] Host provisioned; Oracle reclamation policy re-verified against current docs, or Hetzner chosen.
- [ ] Off-box encrypted backup pipeline (WAL archiving + base backups to B2/R2) running, and one restore into a scratch DB verified — an untested backup is a hypothesis (decision 8).

**Functional (each verified by an eval or integration scenario):**
- [ ] "Remind us at 7am" fires at 07:00 Eastern Time Zone, at-least-once, logged in the sent-log.
- [ ] Concurrent list edits from both spouses serialize with no lost update.
- [ ] Calendar create round-trips with a deterministic event ID; re-execution is a no-op.
- [ ] Household Q&A answers from the structured store for exact facts, semantic store for episodic recall.

**Reliability (the blast-radius criteria):**
- [ ] `kill -9` mid-turn: recovery completes the turn; no duplicate calendar event; reminder duplicates only within the declared at-least-once class.
- [ ] Socket drop alerts on the independent channel within 5 minutes; host death alerts via dead-man's switch within 2× ping interval.
- [ ] All five decision-9 HITL scenarios pass, including execute-once under double approval.
- [ ] One full restore drill: state restored to scratch DB, diffed, and the recovery runbook's reconciliation steps executed against the sent-log.

**Cost:**
- [ ] Steady-state runtime spend ≤ $30/mo at realistic household volume, with prompt caching verified active (cache-read tokens visible in Langfuse traces), measured Sonnet-only (ADR-0003 — reintroducing a cheap turn tier is the contingency lever if this fails, not a precondition).

## Open Questions

1. **Soft TTL default for approvals** — ~~proposing 12h (architecture says "hours to a day; exact value barely matters").~~ *Resolved at T34: 12h, written into `expires_at` at park time (`config.approvalTtlHours`).*
2. **`MAX_ROUNDS` default** — ~~proposing 8.~~ *Resolved at T22: 8 (`handle-turn.ts`), with the forced final user-facing message on cap.*
3. **Compaction threshold and summary shape** — ~~at what transcript size to compact, and what the summary keeps verbatim (e.g., open commitments) vs folds into semantic memory.~~ *Resolved 2026-06-11 (T29): compact above 60 messages keeping ≥ 20 (`defaultCompactionConfig`); the summary keeps open commitments verbatim and preserves languages as written, travels as a `system:compaction` user message, and the full text folds into the semantic store keyed `compact-<workflowID>`.*
4. **Bot persona name** for the group. *Resolved 2026-06-12 (M6 entry, builder pick): **Golem (גולם)**; renamed 2026-06-14 to **Ezra (עזרא)** — Hebrew-native, thematically apt (the root ע-ז-ר means "help"); lands in the production system prompt at T42.*
5. Oracle vs Hetzner — deliberately resolved at provisioning per decision 7, not here.
