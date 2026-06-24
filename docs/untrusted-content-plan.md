# Plan: Untrusted-content boundary

**Spec:** `docs/untrusted-content-spec.md` · **Design:**
`docs/adr-0005-untrusted-content-boundary.md` · **Tasks:**
`docs/untrusted-content-tasks.md`

Phase 0 is small and mostly sequential — one primitive (the fence + the rule
that references it) that three thin tool changes depend on, then coverage. The
risk is not size; it is **touching the eval-locked prompt and exact tool-output
strings**, so the plan front-loads the primitive and gates the prompt wording
behind the eval scenarios.

## Components & dependency graph

```
UC-A  fence primitive + prompt rule  ──┐  (the marker constant is shared by both;
   (src/agent/untrusted.ts,            │   the rule names the literal token)
    src/agent/prompts.ts)              │
                                       ▼
UC-B  apply at point-of-provenance ──► calendar / recall / facts
   (each independent once UC-A lands; can land in parallel)
                                       │
                                       ▼
UC-C  coverage  ── unit (forgery, prefix stability) + eval (injection scenarios)
                                       │
                                       ▼
UC-D  Phase 1 (DRAFT only — deferred to M5 web/Q&A; not built here)
```

UC-A blocks everything (the marker + rule are the contract). UC-B's three tools
are mutually independent. UC-C's unit tests are written RED-first *inside* each
UC-A/UC-B task (TDD); the eval scenarios are the one genuinely new artifact and
get their own task because they gate the prompt wording.

## Milestones

### UC-A — Fence primitive + prompt rule *(sequential; the contract)*

The `fenceUntrusted(source, body)` helper, the shared marker constant, and the
data/instruction rule added to the stable prefix. RED-first: the forgery and
prefix-byte-stability unit tests fail before the code exists. **Gate:** unit
suite green; the production prefix is byte-stable across two builds with the
same config (asserted, per `prompts.ts:1-8`).

### UC-B — Apply at the point-of-provenance tools *(parallel: 3 thin slices)*

Wrap the third-party span of each live entry point — `list_calendar_events`
(`calendar.ts:158`), `recall_history` (`recall.ts:42`), `get_fact`
(`facts.ts:38`) — leaving household framing (owner/dates/key, the member's
question) outside the fence. Each updates its tool's output-string test.
**Gate:** the three tools emit fenced third-party content; `pnpm test` green.

### UC-C — Coverage: eval scenarios + review *(sequential; the behavioral guard)*

Add injection eval scenarios (calendar-event injection, poisoned-fact) under
`evals/`, run `pnpm eval`, and review the delta — this is where the prompt
wording is judged (Q1/Q2 ratified or adjusted here, not before). **Gate:** the
model treats fenced text as data in the scenarios; eval outcome recorded. This
is the milestone that *ratifies* the §12 boundary as working.

### UC-D — Phase 1 *(DRAFT only — human-gated, lands with M5 web/Q&A)*

Per the backoffice-B4 precedent (draft, apply human-gated): per-turn nonce
marker, web/Q&A retrieved-text fencing, forwarded-message provenance via the
transport `isForwarded` signal. **Not built in this workstream** — recorded so
it isn't re-derived when M5 starts.

## Risks & mitigations

- **Prompt wording shifts other eval outcomes.** The rule is new text in the
  cached prefix; it could perturb unrelated behaviors. *Mitigation:* land it in
  UC-A but treat UC-C's full eval pass as the gate, not just the injection
  scenarios — review the whole delta before calling the wording settled.
- **Over-fencing starves the model of cues.** Fence the household framing by
  mistake and the model can't attribute or act. *Mitigation:* the spec boundary
  ("only third-party spans"); UC-B asserts the framing stays outside the fence.
- **False confidence.** The fence is advisory, not a sandbox. *Mitigation:*
  every doc states this plainly (ADR-0005, spec, §12) so it isn't mistaken for a
  guarantee; the §12 "gets worse as the surface grows" line is the revisit
  trigger.
- **Cache-prefix regression.** A rule accidentally placed in a per-turn slot
  would thrash the cache. *Mitigation:* UC-A's byte-stability assertion.

## Parallelization summary

- Sequential spine: **UC-A → UC-B → UC-C**.
- Within UC-B: the three tool slices are independent (parallelizable).
- UC-D is out-of-band (deferred).

Small enough for a single focused session; no autonomous `/goal` run needed
(unlike backoffice). If run by an agent, UC-A must complete and go green before
any UC-B slice starts.
