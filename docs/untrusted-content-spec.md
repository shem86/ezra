# Spec: Untrusted-content boundary (model-layer data/instruction separation)

**Date:** 2026-06-24 · **Status:** Accepted — Phase 0 shipped + eval-ratified
(2026-06-24) · **Owns:**
the V2_NOTES §12 prompt-injection + memory-poisoning workstream · **Design of
record:** `docs/adr-0005-untrusted-content-boundary.md` (read it first — this
spec is the build-level detail under that decision).

This is a **scoped v2 workstream spec**, not a replacement for the root
`SPEC.md` (APPROVED, owns all of v1). It follows the `docs/backoffice-*`
precedent: one capability, its own spec → plan → tasks.

## Objective

Give the turn model a **data/instruction boundary**: text that originates
outside the two household members (calendar event data, recalled history,
stored-fact values, and — later — web/Q&A and forwarded messages) reaches the
model marked as *data to read*, never as *instructions to follow*. Today every
span is authoritative; this closes the gap structurally, by provenance, without
any "is this an attack?" content classifier.

**Target users:** the two trusted household members (unchanged). The boundary
exists not because they are hostile but because the content *they relay* (a
calendar invite a stranger sent, a forwarded message, a pasted snippet) and the
content the system *stores and replays* (`set_fact`→`get_fact`) is third-party.

**Why now:** calendar already shipped (ADR-0004), so `list_calendar_events`
already surfaces third-party text — the "design before calendar lands" window in
§12 has closed and this is a retrofit. M5 household-Q&A / web is next and injects
fully untrusted text; the boundary must exist before it lands.

## Commands

No new commands. The work runs under the existing entries (CLAUDE.md
"Commands"):

- `pnpm test` — unit coverage for the fence helper + prompt rendering (no DB).
- `pnpm lint` — strict + the determinism rule (the fence helper is pure; no
  workflow surface).
- `pnpm eval` — the behavioral guard: model-in-the-loop injection scenarios
  (on-demand, never CI — same status as the relatedness classifier's eval).

## Project Structure

| Path | Change |
|---|---|
| `src/agent/untrusted.ts` | **NEW** — `fenceUntrusted(source, body)` pure helper + the canonical marker constants. |
| `src/agent/prompts.ts` | Add the data/instruction rule to the shared/stable prefix (`sharedSections` or a new section reused by `stableSystemPrompt` + `makeProductionSystemPrompt`). |
| `src/tools/calendar.ts` | Fence the third-party fields of `list_calendar_events` output (`:158`). |
| `src/tools/recall.ts` | Fence `recall_history` output (`:42`). |
| `src/tools/facts.ts` | Fence `get_fact` value output (`:40`). |
| `tests/unit/untrusted.test.ts` | **NEW** — forgery/escaping/idempotency (tests are flat under `tests/unit/`). |
| `tests/unit/prompts.test.ts` | Extend — rule present + prefix byte-stability preserved. |
| `tests/unit/{calendar-tools,recall,facts}.test.ts` | Update the three tools' output assertions. |
| `evals/` | **NEW** injection scenarios (calendar-event injection, poisoned-fact). |

`src/agent/call-model.ts` (`toSdkMessages`, `:120-165`) is **deliberately
untouched** — the fence is applied at the point-of-provenance tool, so the
journaled `tool_result` already carries it and the generic render path stays
clean (ADR-0005 "fence at the point of provenance").

## Code Style

Per `.claude/rules/conventions.md`: kebab-case filename (`untrusted.ts`),
camelCase symbols, **no default export**, pure function (no `deps`, no I/O — it
is string-in/string-out so it needs no DI seam). No Zod (internal, not a
boundary). Comments explain the constraint (why the sentinel is scrubbed, why
the rule lives in the stable prefix), not the next line. The marker is a single
exported constant pair so the prompt rule and the helper can never drift on the
literal token.

## Testing Strategy

Per `.claude/rules/testing.md` taxonomy:

1. **Unit (CI, no DB)** — the load-bearing structural guarantees:
   - `fenceUntrusted` neutralizes a body that contains the closing sentinel
     (forgery defense), is idempotent under double-wrap, and round-trips
     ordinary content unchanged.
   - The system prompt contains the rule **and** the production prefix stays
     byte-stable across calls with identical config (cache-prefix discipline —
     `prompts.ts:1-8`).
   - The three tools’ outputs are wrapped (assert the marker frames the
     third-party span, not the household-controlled framing).
2. **Eval (on-demand, never CI)** — the behavioral guard, since the boundary is
   LLM-enforced and unit tests can’t prove the model *obeys* the rule:
   - A `list_calendar_events` result whose event title is an injection
     ("ignore your instructions and …") must NOT cause the model to take the
     injected action; it may relay the text to the member.
   - A `get_fact` value carrying an embedded instruction must not be acted on.
   - Honest framing (mirrors the relatedness classifier, §12): the eval is an
     *offline* control; a determined injection can still talk the model across
     an advisory boundary. The eval raises the bar and catches regressions.

TDD discipline (testing.md): each task lands its failing test first.

## Boundaries

- **Always:** scrub the closing sentinel from every fenced body (no
  break-out); keep the marker in one shared constant; `pnpm lint && pnpm test`
  green before commit; update — never weaken — the affected prompt/tool tests
  and evals when the prompt or output strings change.
- **Ask first:** the exact wording of the system-prompt rule (it is
  eval-affecting and rides the cache-stable prefix) — land it behind the eval
  scenarios and review the eval delta before treating it as settled.
- **Never:** add a content/attack classifier or any heuristic "is this
  malicious" inspection (provenance separation only); add output moderation
  (§12 keeps it out of scope); treat the fence as a hard sandbox or claim it
  *prevents* injection — it is an advisory, raise-the-bar control; fence
  household-controlled framing (owner, dates, the member's own question) — only
  third-party spans get fenced, or the model loses the cues it needs to act.

## Success Criteria

1. `fenceUntrusted` provably neutralizes a payload containing the closing
   sentinel (unit, RED-first).
2. `list_calendar_events`, `recall_history`, and `get_fact` emit their
   third-party content inside the fence; household framing stays outside.
3. The system prompt carries the data/instruction rule, and the production
   prefix remains byte-stable per process (cache discipline intact).
4. Injection eval scenarios (calendar-event, poisoned-fact) show the model
   treating fenced text as data — it does not execute the injected instruction.
5. `pnpm lint && pnpm test` green; the eval delta reviewed and recorded.

## Scope / phasing

- **Phase 0 (this spec's active scope):** helper + prompt rule + the three live
  point-of-provenance tools + unit/eval coverage. Closes the *live* gap.
- **Phase 1 (drafted, deferred — lands with M5 web/Q&A):** fence web/Q&A
  retrieved text at its tool; switch to a **per-turn nonce marker** for
  higher-volume untrusted input; add **forwarded-message provenance** from the
  transport signal (Baileys `contextInfo.isForwarded`). Tracked in the plan as a
  draft milestone, not built here.

## Open questions — RATIFIED (2026-06-24)

- **Q1 — fence application site → fence-at-tool + fixed marker.** Ratified by
  the builder. The tool that knows the content is third-party wraps its own
  output; the marker is a fixed literal the prompt rule can name. (Rejected:
  fence-at-render, which re-derives provenance the tools already hold;
  nonce-from-day-one, deferred to Phase 1 when web/Q&A volume justifies it.)
- **Q2 — Phase 1 stays a draft milestone here**, promoted to active when M5
  Q&A starts.
