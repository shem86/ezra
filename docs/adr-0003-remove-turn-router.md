# ADR-0003: remove tiered turn routing — Sonnet-only v1

**Date:** 2026-06-11 · **Status:** Accepted · **Scope:** T30 router, M4 reasoning layer

## Context

T30 built `src/agent/router.ts`: an escalate-on-depth heuristic that started
every turn on the Haiku-class model and switched to Sonnet-class once the
transcript held 2+ tool results. Review the same day found the signal measured
the wrong thing: the count ran over the **whole persisted conversation**, not
the current turn, so any conversation with two historical tool uses pinned to
Sonnet until compaction reset the count — routing tracked compaction timing,
not turn complexity. Even with a per-turn count, the design has structural
costs: the cheap model makes the early tool decisions before the depth signal
can fire (exactly the "real reasoning" decision 6 assigns to Sonnet), and a
mid-turn tier switch forfeits the prompt cache on the model switched to,
working against the M4 cache-read gate.

Fixing the signal was cheap — and in fact landed (the T30 per-turn round-count
fix precedes this removal in history) — but the deeper question was whether v1
needs tiered turn routing at all; the structural costs above stand regardless
of the signal.

## Decision

**Remove the router; every turn-model call — including the forced final on
cap-hit — goes to the Sonnet-class model** through `makeCallModel` directly.
`router.ts` and its test are deleted, not parked: the `deps.callModel` seam in
`handleTurn` is already model-agnostic, so reintroducing a router later is a
contained change that needs none of the deleted code's shape.

Rationale: reliability beats sophistication (the project's standing v1 rule).
At two-user household volume the absolute spend difference is small, while a
tier switch inside a turn is a whole class of behavior to verify — escalation
timing, per-tier prompt caches, per-tier trace attribution. Sonnet-only makes
turn quality uniform and the M4 cost gate (T33) measures the *worst case*; if
that gate passes, routing was premature optimization.

**Scope: this narrows architecture decision 6, it does not reverse it.**
Haiku-class remains the model for *cheap classification* — the T29 compaction
summarizer and the T36 approval-relatedness classifier. What is removed is
only the cheap-vs-reasoning selection for turn reasoning.

## Consequences

- T31 tracing loses the per-tier cost tag (`onUsage` no longer receives a
  tier). Step names already distinguish the call sites (`callModel`,
  `callModelForcedFinal`, `summarizeContext`), which is enough attribution.
- The T33 cost gate (≤ $30/mo) is now measured Sonnet-only. **Reintroducing a
  cheap tier is the named contingency lever if the gate fails**, alongside the
  compaction threshold — PLAN's risk table updated accordingly. Any future
  router routes on the per-turn round index passed from `handleTurn` (or an
  upfront Haiku classification), never on transcript-wide message counts.
- SPEC Models row, cost criterion, PLAN M4, TASKS T30, CLAUDE.md, and README
  rescoped. The architecture doc (LOCKED) is superseded on this point by this
  ADR, per ADR-0001 precedent.
