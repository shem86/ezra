# hh-assistant

WhatsApp household assistant for two users (builder + wife): reminders, shared
lists, Google Calendar, household Q&A. Dual goal: production-grade
agentic-systems learning and daily utility. **Reliability beats sophistication
in every v1 trade-off.**

## Source-of-truth documents (read before changing anything)

| Doc | Owns | Status |
|---|---|---|
| `household-ai-agent-architecture-v3_5.md` | *Why* — locked decisions 1–11 | LOCKED |
| `SPEC.md` | *Building* — scope, conventions, boundaries | APPROVED 2026-06-09 |
| `PLAN.md` | Milestones M0–M6 + verification gates | APPROVED 2026-06-09 |
| `TASKS.md` | Per-session tasks + live progress checkboxes | APPROVED; M0+M1 done |
| `docs/spike-results.md` | Spike verdicts, pinned versions, gotchas | T7/T8/T28-wire PASS, T10 closed |

Where docs overlap: architecture wins on rationale, SPEC wins on
implementation detail. Update `TASKS.md` checkboxes as tasks complete.

## Commands

```
docker compose up -d   # dev DB: ONE Postgres with pgvector (journal+state co-located)
pnpm build             # tsc, strict
pnpm test              # vitest; integration suite only runs when DATABASE_URL is set
pnpm lint              # eslint incl. custom DBOS-determinism rule (CI-failing)
pnpm dev               # (M3+) agent against dev DB, transport stubbed
pnpm eval              # (M5) model-in-the-loop scenarios — on-demand, never CI
pnpm test:recovery     # (M3) kill-mid-flight replay gate
```

Local integration runs: `DATABASE_URL=postgres://hh:hh@localhost:5432/hh_assistant pnpm test`.
Spikes run directly: `node --env-file=.env spikes/<name>.ts` (Node 22 strips types).

## Stack (locked — do not substitute)

Node 22 / TypeScript strict / pnpm exact pins · DBOS 4.19.8 (durable
execution) · single Postgres + pgvector · Vercel AI SDK Core + Claude
(Haiku-class routing, Sonnet-class reasoning; prompt caching verified through
passthrough) · Voyage embeddings (voyage-4-lite, zero-dep fetch client —
ADR-0002) · Baileys (M2+) · Langfuse tracing · Vitest · ESLint flat config.

## Hard boundaries (full list in SPEC.md)

- **Always:** `pnpm lint && pnpm test` before commit · every structured-state
  write goes through a DBOS transactional step · every external effect has an
  idempotency key or declared delivery class · every `tool_use` gets a
  `tool_result` · exact-pin every dependency.
- **Ask first:** new dependencies (WhatsApp-adjacent ⇒ full transitive
  review) · DB schema changes · risk-tier/delivery-class changes · real
  WhatsApp traffic · spending money.
- **Never:** commit secrets or Baileys session state · auto-execute a
  confirm-before tool · let operational credentials (API keys, OAuth tokens,
  Baileys state) into prompts/traces/semantic store · restore Baileys session
  from backup · weaken a failing test or lint rule to pass CI.

## Detailed rules (`.claude/rules/`)

- `dbos.md` — durable-execution rules + DBOS 4.19.x version-specific gotchas
- `conventions.md` — TS/code style, module layout, config access, tooling quirks
- `testing.md` — test taxonomy, what runs where, recovery-test patterns

## Environment notes

- Dev Mac containers run via Colima (occasionally flaky); **CI (Linux) is the
  arbiter** for anything container-dependent.
- GitHub: `shem86/hh-assistant` (private). CI = build+lint+test with pgvector
  service container. Branch protection unavailable on the free plan — treat
  red CI as merge-blocking by discipline.
- Household: mixed Hebrew + English (fixtures must cover code-switching);
  timezone Eastern — reminders anchor to it, never server time.
