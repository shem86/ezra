# Spec: Compaction & Embedding Evaluation Harness

**Status:** DRAFT — awaiting human review (Phase 1 of spec-driven workflow; do not implement until approved).
**Date:** 2026-06-29
**Owner:** Shem

## Objective

Make the conversation-compaction mechanism (summarize-and-embed, T29 — `src/agent/compaction.ts`,
`src/agent/handle-turn.ts:351-378`) **evaluable**: be able to score, on demand, whether a
generated summary faithfully preserves what it was made from — especially the open commitments the
summary prompt promises to keep verbatim.

This is a **quality-evaluation** deliverable, not a console screen. The user is the builder, judging
the mechanism's correctness so it can be tuned (e.g. is the Haiku-class summarizer good enough, or
does compaction need a stronger model?).

### Why this needs new groundwork (the core finding)

Today the *input* to summarization is unrecoverable, so quality cannot be assessed after the fact:

| Question | Recoverable today? | Source |
|---|---|---|
| When a compaction happened | ✅ | `semantic_memories.created_at`, `dbos.operation_outputs` |
| How many times | ✅ | row/step count (**prod: 1, ever**) |
| The result (summary text) | ✅ | `semantic_memories.content` |
| **What was summarized (the head/input)** | ❌ | discarded |
| Quality vs. input | ❌ | blocked by the row above |

The head is discarded because DBOS journals step **outputs** not inputs, `conversation_context` is
**overwritten** with the compacted transcript, and trace spans deliberately carry **metadata only,
never content** (`src/ops/tracing.ts:5-7`). So the spec has two pillars: **(1) durably capture each
compaction's input+output** (a new table), and **(2) an on-demand harness that scores summaries**
against their inputs — fed by both replayable fixtures and real captured rows.

### Success criteria (testable)

1. Every real compaction (dev **and** prod) writes exactly one `compaction_log` row; a crash-replay
   re-derives the same key and is a no-op (no duplicate). Proven by an integration/recovery test.
2. A `compaction_log` row carries the head transcript, the summary, the cut metadata, and the
   **summarizer model id**, and joins to its `semantic_memories` row on `source_key`.
3. `pnpm eval` runs a compaction suite that replays ≥8 code-switched (Hebrew/English) fixture
   conversations through the **real** summarizer and scores each on the rubric below, printing
   per-dimension and aggregate scores.
4. Hard-assert dimensions (structural integrity, language preservation, conciseness) **fail** the
   eval on violation; quality dimensions (commitment preservation, faithfulness) report a score and
   fail below a configured threshold.
5. The summarizer model is a harness knob, so the same fixtures can be run through Haiku-class vs
   Sonnet-class and compared (answers "is the cheap model good enough for compaction?").
6. A prod spot-check mode scores the last *K* real `compaction_log` rows with the same scorer,
   read-only.

## Tech Stack

Unchanged from the repo (locked): Node 22 / TS 6 strict · DBOS 4.19.8 · single Postgres + pgvector ·
Vercel AI SDK Core + Claude (Haiku-class summarizer `config.cheapModelId`, Sonnet-class judge) ·
Voyage embeddings · Vitest (eval config). New work adds **no new dependencies**.

## Commands

```
pnpm eval                 # runs evals/*.eval.ts incl. the new compaction.eval.ts (real models, never CI)
pnpm eval -t "compaction" # filter to the compaction suite
pnpm migrate              # applies migrations/0008-compaction-log.sql (forward-only)
pnpm test tests/integration/compaction-log.test.ts   # idempotent-capture gate (DATABASE_URL set)
```

Prod spot-check (read-only, points at a DB URL you choose — dev by default, the SELECT-only role for prod):
```
COMPACTION_EVAL_SOURCE=db pnpm eval -t "compaction prod spot-check"
```

## Project Structure

```
migrations/0008-compaction-log.sql      → new capture table (forward-only, idempotent)
src/memory/compaction-log.ts            → write + read accessors (mirrors memory/semantic.ts)
src/agent/handle-turn.ts                → extend CompactionDeps; write the log row in the compaction block
src/main.ts                             → wire writeCompactionLog transactional step + summarizerModelId
src/dev/main.ts                         → mirror the wiring (scripted-day path)
evals/fixtures/compaction.ts            → curated conversations + planted ground-truth commitments
evals/harness/judge.ts                  → reusable LLM-judge (Sonnet/Opus-class)
evals/compaction.eval.ts                → the driver + scorer (fixture mode + prod-db mode)
tests/integration/compaction-log.test.ts→ exactly-once capture + replay no-dup
tests/unit/compaction-*.test.ts         → existing pure-split tests stay the structural guard
```

## Code Style

Match the repo: kebab-case files, no default exports, DI via `deps`, Zod at boundaries, `src/ops/config.ts`
the only env reader, `.js` specifiers in `src/`. The capture write is a **datasource transaction**
(structured-state invariant), idempotency-keyed like the existing semantic write:

```ts
// src/memory/compaction-log.ts — idempotent insert, same discipline as writeSemanticMemory
export async function writeCompactionLog(db: Queryable, input: CompactionLogInput): Promise<boolean> {
  const res = await db.query(
    `INSERT INTO compaction_log
       (workflow_id, conversation_id, source_key, head, summary,
        cut_index, head_count, tail_count, summarizer_model, head_chars, summary_chars)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (source_key) DO NOTHING
     RETURNING id`,
    [/* … */],
  );
  return res.rows.length === 1; // false on the replay path
}
```

In `handle-turn.ts`, the new step slots into the existing compaction block (same `source_key =
compact-<workflowId>` so the log row and the semantic row share a join key), after `writeMemory`:

```ts
await compaction.writeCompactionLog({
  workflowId, conversationId,
  sourceKey: `compact-${workflowId}`,
  head, summary, cutIndex: cut,
  headCount: head.length, tailCount: msgs.length - cut,
  summarizerModel: compaction.summarizerModelId,
});
```

The scorer's judge rubric is derived directly from `summarySystemPrompt` so the eval tests the
contract the prompt actually makes.

## Testing Strategy

- **Capture (integration, CI-eligible):** `tests/integration/compaction-log.test.ts` against real
  Postgres — drive a compaction, assert exactly one row, kill-mid-flight + replay asserts no
  duplicate (the `source_key` ON CONFLICT path). This is durability, so real DB, not mocks.
- **Structural integrity (unit, CI):** the existing pure `findCompactionCut` tests remain the guard
  that a cut never orphans a `tool_result` — deterministic, no model, no DB.
- **Quality (eval, on-demand only, `pnpm eval`, NEVER CI):** model-in-the-loop. Costs money (real
  summarizer + judge calls), so it lives in `evals/` exactly like `injection.eval.ts` /
  `decision9.eval.ts` and is excluded from CI by `vitest.eval.config.ts`.

### Scoring rubric (the heart of the eval)

Each `(head → summary)` pair is scored on six dimensions drawn from `summarySystemPrompt`:

| Dimension | Type | How |
|---|---|---|
| **Commitment preservation** | quality (threshold) | every open commitment/promise/unresolved question in the head survives, correctly attributed. Fixture mode: planted ground-truth list. Prod mode: judge-extracted. |
| **Faithfulness** | quality (threshold) | nothing invented that isn't in the head (no hallucinated commitments/facts) |
| **Structural integrity** | hard assert | cut landed on a user boundary; no orphaned tool_result (also unit-covered) |
| **Language preservation** | hard assert | Hebrew stays Hebrew, English stays English — no translation |
| **Boundary discipline** | quality | lists/reminders/facts mentioned as context, not restated as authoritative |
| **Conciseness** | hard assert | summary materially shorter than the head it replaces |

Quality dimensions are scored by an LLM-judge (Sonnet/Opus-class); hard-assert dimensions are
mechanical where possible. The eval prints a per-dimension table and an aggregate, and fails when a
hard assert is violated or a quality score drops below its threshold.

### Eval data (both paths, per decision)

- **Fixtures (repeatable volume):** ≥8 curated multi-turn conversations in `evals/fixtures/compaction.ts`,
  code-switched Hebrew/English, each with **planted open commitments** (known ground truth) and at
  least one including a prior `system:compaction` summary (exercises the fold-in rule). Replayed
  through the real `makeSummarize` at a lowered threshold — the harness owns the head, so survival
  is checkable exactly.
- **Prod spot-check (real-world):** read the last *K* `compaction_log` rows and run the same scorer.
  No planted ground truth, so commitment-preservation there is judge-derived. Read-only; points at a
  chosen DB URL (the SELECT-only role for prod), never auto-hits prod.

## Boundaries

- **Always:** capture write goes through a datasource transaction with the `compact-<workflowId>`
  idempotency key · `pnpm lint && pnpm test` before commit · exact-pin any (none expected) new dep ·
  reminder/clock anchored to household TZ (n/a here).
- **Ask first:** *(this spec is the ask)* the `compaction_log` schema change — **approved**. Any
  change to the compaction threshold/keep defaults, risk tiers, or the summary prompt itself.
- **Never:** weaken the structural/recovery tests to get green · let operational secrets into the
  log table, fixtures, or judge prompts · run the quality eval in CI · auto-write to or destructively
  read prod.

## Decisions (open questions, resolved 2026-06-29)

1. **Judge model:** `claude-sonnet-4-6` (Sonnet-class). Verify the exact id against the claude-api
   reference at implementation time.
2. **Thresholds:** start **report-only** to calibrate over a run or two, then set pass/fail gates.
   Until calibrated, hard-assert dimensions (structural integrity, language, conciseness) still fail
   the eval; quality dimensions (commitment, faithfulness) only print scores.
3. **`compaction_log.head` growth:** leave it — no prune policy or size cap (negligible at household
   scale).
4. **Prod spot-check connection:** reuse `BACKOFFICE_DATABASE_URL` (the SELECT-only role) as the
   read path. No snapshot.
5. **Capture scope:** success path only. Do **not** log skipped compactions — `findCompactionCut`
   returning null is a defensive guard (no user-boundary cut available ⇒ never corrupt to proceed)
   that realistically never fires for this app, so it carries no evaluation value. If ever wanted, a
   one-line counter is cheaper than a table row.

## Plan / Tasks (Phase 2/3 — sketched, not started)

Sequencing once the spec is approved:

1. `0008-compaction-log.sql` + `src/memory/compaction-log.ts` + accessor unit/integration tests (capture substrate).
2. Wire `writeCompactionLog` into `handle-turn.ts` compaction block + `main.ts`/`dev/main.ts`; the exactly-once integration + replay test (Success criteria 1–2).
3. `evals/fixtures/compaction.ts` (code-switched, planted commitments, fold-in case).
4. `evals/harness/judge.ts` + `evals/compaction.eval.ts` fixture mode + rubric scorer (Success criteria 3–5).
5. Prod spot-check mode reading `compaction_log` (Success criterion 6).
6. Calibrate thresholds; document a Haiku-vs-Sonnet comparison run.

Each task: ≤5 files, its own verification (test/build/eval run), reviewed before the next.
