# Plan — Jev-routed turn model selection (Haiku / Sonnet / Opus)

**Date:** 2026-10-29 · **Status:** lives in [STATUS.md](../../STATUS.md) item 16
(house rule 1, which keeps no status here). · **Reverses in part:**
[ADR-0003](../adr-0003-remove-turn-router.md)

## 1. Goal, and an honest motivation

Route each turn to an Anthropic model tier from an **upfront** judgment of the
incoming messages. The judgment comes from TypeSafe's **Jev**, a System One
model that answers typed questions with calibrated probabilities. The tiers:

| Tier | Intended for |
|---|---|
| `fast` (Haiku-class) | trivial single-intent edits: "add milk", "תוסיף חלב", "thanks" |
| `standard` (Sonnet-class) | today's default, and the fallback whenever anything is unsure or fails |
| `deep` (Opus-class) | open-ended planning, multi-constraint scheduling, advice that weighs options |

**Cost is not the reason.** T33 measured $1.62/mo and T46 measured $8.89/mo on
live traffic (Sonnet-only, with caching), against a $30 ceiling. Haiku savings are
cents. The real reasons:

1. **Quality headroom on hard turns.** Opus on the few turns that benefit from it,
   such as planning a week around both calendars.
2. **Latency on trivial turns.** Haiku replies faster to "add milk".
3. **Learning value.** The project's dual goal. A typed, calibrated, auditable router
   (the decision lives in a code truth table) is the kind of agentic-systems
   pattern this repo exists to exercise.

If reason 1 doesn't hold up in Phase 5's comparison, the right outcome is
`fast`/`standard` only, or no router at all. Being able to reach that verdict is
part of the plan.

## 2. Why this does not repeat ADR-0003's failure

ADR-0003 removed the T30 router for three structural reasons. Each one is
addressed:

| ADR-0003 objection | This design |
|---|---|
| The signal measured the wrong thing (a transcript-wide tool count) | The signal is a judgment about **this turn's batch** plus a short tail, made before round 0. ADR-0003 explicitly allows "an upfront Haiku classification", and this is that shape with Jev in place of Haiku. |
| The cheap model makes the early tool decisions before escalation can fire | No escalation inside a turn. The tier is chosen **once** and every round uses it, including the forced final. A turn that will need reasoning is routed there before the first call. |
| A mid-turn switch forfeits the prompt cache | No mid-turn switch. Each tier keeps its own stable-prefix cache, and in-turn rounds (where T33's 85% cache reads come from) still hit it. |

## 3. Decision logic first (the truth table)

Following the TypeSafe guidance, **Jev supplies judgments and code makes the
decision.** We never ask Jev "which model should handle this?" or "how complex is
this?".

### 3a. Code-only pre-rules. Jev is not called for these.

These are facts code already knows. Each forces `standard`, which matches today's
behavior, so HITL paths stay byte-for-byte on the model they were evaluated
against (`pnpm eval` 8/8):

- Routing mode is `off` (see §6).
- Any pending action exists, or the batch held a quoted approval reply. HITL turns
  stay on the T38-proven model.
- The refine re-prompt path. It makes no model call at all.
- The batch carries no extractable text (media only).

### 3b. Jev questions: one request per turn, all sharing one state

| id | type | question (draft wording, tuned in Phase 1) |
|---|---|---|
| `asks_anything` | Noul | Does `latest_messages` ask the assistant to do something or answer something? *(the companion null case for `intent`)* |
| `intent` | Choice | What is `latest_messages` mainly asking for? — `list_edit` · `reminder` · `calendar` · `household_fact` · `planning_or_advice` · `social` (thanks, greetings, acknowledgements) |
| `several_requests` | Noul | Does `latest_messages` contain more than one separate request? |
| `refers_back` | Noul | Does `latest_messages` refer to something earlier in `recent_conversation` that must be looked up to understand it? (e.g. "move it to Thursday") |
| `weighs_options` | Noul | Does `latest_messages` ask the assistant to make a plan or to recommend one option over others? *(v2 — Phase 1: v1's "plan around constraints" pulled "find a time we're both free" to `deep`; the slot search is now the named `false` case)* |
| `schedule_reasoning` | Noul | Does `latest_messages` ask to find a time, check availability, or resolve a clash between schedules? |

One more question rides along in the same request: speculative, with no extra
round trip, and **not** read by `decideTier`. It exists only for monitoring
(§5b):

| id | type | question |
|---|---|---|
| `corrects_previous` | Noul | Does `latest_messages` say the assistant's last reply in `recent_conversation` was wrong or misunderstood? |

Criteria name the confusing case concretely. For example, for `weighs_options`:
*"…like the time of an event, adding an item, or finding a slot when both are free"*
is its `false` criterion. Every `false`
criterion is written as a situation, not as "not X".

### 3c. The table (code: `src/agent/turn-route.ts`, a pure function)

Thresholds start at the guidance defaults: **yes > 0.7, no < 0.3**, with the band
in between counting as *unsettled*.

| Condition (evaluated top-down) | Tier |
|---|---|
| any §3a pre-rule | `standard` |
| Jev call failed or timed out | `standard` (recorded as `source: 'fallback-error'`, **not** as an answer) |
| `weighs_options` yes **or** (`schedule_reasoning` yes **and** `several_requests` yes) | `deep` |
| `asks_anything` no **and** `intent` = `social` | `fast` |
| `intent` ∈ {`list_edit`, `social`} **and** `several_requests` no **and** `refers_back` no **and** `schedule_reasoning` no | `fast` |
| anything else, including every unsettled band | `standard` |

Properties to unit-test: every combination has an outcome; an unsettled answer
never selects `fast` or `deep`; `deep` and `fast` can't both fire (the `deep` rows
come first); and the function is pure, so replaying it on journaled answers is
deterministic.

## 4. State design (the human test)

```jsonc
{
  "household": "Two adults (husband, wife) messaging their home assistant on WhatsApp, mixed Hebrew and English.",
  "assistant_can": "edit shared lists, set reminders, store/recall household facts, read and propose calendar events",
  "recent_conversation": "<renderForSummary(last 4 msgs), member labels not JIDs>",
  "latest_messages": [{ "from": "wife", "text": "…" }]   // the whole batch, in order
}
```

- **Member labels, never JIDs.** This matches the production prompt's attribution
  contract and keeps phone numbers out of the third-party call.
- No tool-result bodies and no calendar contents in the state. The routing
  questions don't need them, and leaving them out narrows the privacy surface (§7).
- The questions refer to fields by backticked path.
- `recent_conversation` is rendered from the same pre-batch snapshot T36 already
  takes (`recentContext`), cut to 4 messages.

## 5. Where it plugs in

- **`src/agent/turn-route.ts`** (new). All question wording, criteria and
  thresholds live here and nowhere else: the auditable surface. It exports
  `turnRouteQuestions`, `renderRouteState(...)`, a Zod schema for the Jev
  response, and the pure `decideTier(answers, preRules)`.
- **`src/agent/jev-client.ts`** (new). A zero-dependency `fetch` client for
  `POST https://api.typesafe.ai/v1/systemone`, following the ADR-0002 Voyage and
  T31 Langfuse precedent, so **no new npm dependency** and no SDK supply-chain
  review. It takes an injected `fetch`, a hard timeout (start at 1.5s), and a
  pinned model `jev-1.14.0` (**not** `jev-latest`, for the same reason the WA
  client version is pinned: a silent upstream swap would change routing with no
  deploy). Errors throw; the caller maps a throw to `fallback-error`.
- **`handleTurn`** gains an optional `deps.routeTurn`. It is called **once**, after
  the digest render and before the round loop, as
  `DBOS.runStep(..., { name: 'routeTurn' })`. Its journaled output is
  `{ tier, source, answers }`, and the workflow body only *reads* it. That makes
  it replay-deterministic and keeps it inside the `hh/no-nondeterminism-in-workflow`
  rule. When `routeTurn` is absent, the step sequence is identical to today's.
- **`ModelCallOptions`** gains `tier`. **`makeCallModel`** takes
  `models: Record<Tier, LanguageModel>` instead of a single `model`. The forced
  final uses the turn's tier.
- **`src/main.ts`** and **`src/dev/main.ts`** wire three `anthropic(...)` models from
  config.
- **`src/ops/config.ts`** adds `TYPESAFE_API_KEY` (secret class),
  `TURN_ROUTING=off|shadow|on` (default `off`), and `FAST_MODEL_ID` /
  `DEEP_MODEL_ID`. `standard` keeps `REASONING_MODEL_ID`.
- **Tracing and payload capture.** These are split by where content is allowed to
  live. This follows the precedent set by the compaction-eval capture
  ([compaction-eval-spec](../compaction-eval-spec.md)).
  - **Langfuse** (a third-party cloud; T31 keeps it metadata-only) gets the
    `routeTurn` span: `tier`, `source` (`jev` | `pre-rule:<name>` |
    `fallback-error:<kind>`), every probability, Jev's latency and
    `input_tokens`, the answering model id from the response, and
    `questionsVersion`, a hash of the `turn-route.ts` question set, so wording
    changes are attributable. `onUsage` gets the tier back (ADR-0003 removed it).
  - **Postgres `turn_route_log`** (a new forward-only migration, *ask-first
    schema change*) stores the **exact request payload as sent**, the raw
    response, the tier, and `questionsVersion`. It's keyed by workflow id and
    written by an idempotent datasource transaction, like `writeCompactionLog`.
    This is what makes any routing decision re-runnable, and it's the source for
    the real-traffic eval set (§8a). Message text stays inside our own Postgres
    and never enters a trace. TypeSafe already sees it; Langfuse doesn't need to.
- **Egress:** add `api.typesafe.ai` to `src/ops/egress-allowlist.ts` under a new
  `routing` category, mirrored in the nftables set, with the drift test updated.
  Check its DNS behavior first (`dig` it repeatedly: TTL, record count). PR #50
  made the refresh accumulate rotating answers, but a host that isn't in the set
  yet still gets its SYN **dropped**, not rejected, and our 1.5s timeout fires
  long before the ~10.5s egress fingerprint shows up. Mitigations:
  - A startup probe logs `[route] jev ok` or `[route] jev unreachable: <kind>`,
    and the fallback rate appears on the §5b health panel. A dead router
    otherwise degrades to today's behavior and nobody would ever notice.

### 5a. Debugging: where content lives (the existing split, unchanged)

Message text never goes to Langfuse. It's the T31 boundary, locked by the
credential sweep in `tests/unit/tracing.test.ts`. A turn is debugged by joining
three places on the **DBOS workflow id**, which is also the Langfuse trace id:

| Where | What | How you read it |
|---|---|---|
| Langfuse | timing, tokens, cost, tool names, errors per step | Langfuse UI / backoffice Costs+Logs screens |
| Postgres | the content: `conversation_context` (transcript), `conversation_inbox`, `sent_log`, DBOS step outputs; now `turn_route_log` | backoffice Database screen (`src/backoffice/queries.ts`), `psql` |
| container log | lifecycle lines: `[spine]`, `[socket]`, `[wa-version]`, now `[route]` | `docker logs` on the host |

Content stays out of Langfuse on purpose. It's a third-party cloud, and the
household's messages would then sit in a second vendor's retention for no
debugging gain that a join can't give. The gap is ergonomic: the join is manual
today. Phase 4 adds a backoffice **turn view**: a workflow id shows its Langfuse
spans, its `turn_route_log` row (payload, probabilities, tier) and the
transcript slice side by side.

### 5b. Knowing when it goes wrong (router health — pulled, not paged)

The fallback makes a broken router *harmless*; this section makes it *visible*,
**without new Telegram traffic.** Telegram stays reserved for service up/down,
and a router failure isn't an outage: every turn still runs on `standard`, which
is exactly today's behavior. A page for it would train the channel to be
ignored, the same reasoning `wa-version-watch` gives for its edge-triggering.

Router health is **pulled**, from two places, both reading our own Postgres
(`turn_route_log`), not Langfuse:

- **Backoffice "Router" panel** on the Status screen. Each row is computed from
  `turn_route_log` and shown green/amber against the starting thresholds, which
  are tuned in shadow:

  | Row | Amber when |
  |---|---|
  | Last routed turn | no rows in 24h while turns ran (wiring broke, or the mode was silently off) |
  | Fallback rate | > 20% of the last 20 routed turns, or ≥ 3 in a row |
  | Jev latency p95 | > 1s over the last 20 (the timeout is 1.5s) |
  | Tier mix (24h) | `deep` > 40% (cost / injection) or unsettled > 50% |
  | Corrections per tier (7d) | a tier's `corrects_previous` > 0.7 rate exceeds `standard`'s |

  Clicking a row lists the offending `turn_route_log` rows in the §5a turn view.
  A flagged correction is a ready-made eval candidate for the builder to label
  (§8a), so production mistakes feed the eval set.
- **`[route]` log lines:** the startup probe result, plus one line per state
  change (fallback streak started or ended). They're grep-able on the host next
  to `[socket]` / `[spine]`.

When it gets looked at: during Phase 5 shadow, daily. After that, whenever
ezra's answers feel off, and as a standing item in the periodic STATUS.md
reconcile. If one condition later proves worth a push, the candidate is a
fallback streak lasting longer than a day. Add it then, deliberately, and not
as part of this plan.

**Don't bundle a model upgrade.** The current defaults are `claude-haiku-4-5` and
`claude-sonnet-4-6`. Moving tier ids to newer models is a separate change.
Bundling it would confound the Phase 5 comparison.

## 6. Rollout: three modes behind `TURN_ROUTING`

- `off`: no Jev call, Sonnet-only, identical to today.
- `shadow`: Jev is called and the tier is computed and traced, but the turn still
  runs on `standard`. This gives real-traffic routing data at zero quality risk.
- `on`: the tier is honored.

## 7. Risks and boundary questions

1. **A new third party sees household message text.** TypeSafe states it doesn't
   train on requests; zero data retention is enterprise-only. This is the same
   class of decision as Voyage (ADR-0002), which sees compaction summaries. Jev
   would see *every* non-HITL batch plus a 4-message tail. **Ask first.**
2. **Hebrew and code-switched accuracy are unknown.** The Jev docs say nothing
   about Hebrew. This is the gating probe in Phase 1. If Jev can't judge
   code-switched text, the feature stops there.
3. **Latency is added to every routed turn.** No published figure. Measure it in
   Phase 1, and cap it with the timeout. A Jev outage degrades to today's behavior
   and never to a failed turn.
4. **Prompt injection can only change the tier.** The worst case is a forced
   `deep` (cost) or `fast` (quality). Jev's answers carry no authority over tools.
   The spend backstop is the provider-side Console limit (V2_NOTES §12).
5. **Per-tier cache warmth.** At ~9 turns/day, cross-turn cache hits are rare on
   any tier. In-turn hits stay. Re-measure cache-read share per tier in Phase 5.
   Check each tier model's minimum cacheable prefix against the production
   prompt's size: if a tier is below its minimum, its prefix silently never
   caches.
6. **Haiku on tool use.** `fast` turns still carry the full tool set. Only
   confirm-before tools (the calendar write) park. **Autonomous tools — lists,
   reminders, facts — execute directly**, so a misrouted `fast` turn can produce a
   *wrong effect*: a reminder at the wrong time, the wrong list item. That is why
   `fast` is gated hardest and rolls out last (§7b).

### 7b. Per-turn tier: trade-offs, failure modes, alternatives

**Trade-offs of choosing the tier once per turn:**
- **It commits before the turn shows what it needs.** The router sees only text.
  A calendar clash the model discovers in round 2 doesn't upgrade the tier.
  That's the price of keeping one cache and making no mid-turn switches.
- **Errors are asymmetric.** `deep` on an easy turn costs money and latency. `fast`
  on a hard turn costs quality and can cause wrong autonomous effects (risk 6).
  Thresholds and rollout order reflect that.
- **Consistency across turns.** One conversation will be answered by different
  models turn to turn: tone, verbosity, Hebrew register. The household may notice
  the voice change.
- **The prompt is tuned on Sonnet.** The production prompt and `pnpm eval` 8/8
  were proven on Sonnet only. Each tier needs its own eval pass (§8a).
- **Added serial latency.** The Jev round trip sits before the first token on
  every non-pre-ruled turn.
- **Cache split.** There are three prefix caches, and each has a minimum
  cacheable length.

**Failure modes and what catches each:**

| Failure | Effect | Caught by |
|---|---|---|
| Jev down, slow, or blocked at egress | every turn on `standard` = today's behavior | startup probe `[route]` line + Router panel fallback row (§5b) |
| Short context-dependent message ("כן, את השני", "do that") routed `fast` | wrong item / wrong effect | `refers_back` Noul + eval hard cases |
| Hebrew judged worse than English | biased routing by language | per-language eval slices; Phase 1 stop rule |
| Jev model swap upstream | routing shifts silently | pinned `jev-1.14.0`; eval re-run is the bump gate |
| Wording edit regresses routing | same | `questionsVersion` in traces + the eval-on-change agent rule (§8a) |
| Injection forces `deep` | cost only | provider-side spend limit |
| Opus latency on a WhatsApp reply | slow answer to a "big" ask | measured in Phase 5; acceptable or `deep` dropped |
| Crash between `routeTurn` and `callModel` | — | journaled tier; recovery test (Phase 3) |

**Alternatives considered:**
- **Sonnet-only (status quo).** It's the honest baseline, and Phase 6 may land
  back here.
- **Haiku as the router (an LLM classifier).** No new vendor, and Hebrew is
  certain to work. But it gives uncalibrated JSON verdicts, it's slower and
  pricier per call, and it teaches less. It's the fallback design if Jev fails
  Phase 1 on Hebrew.
- **Effort routing on one model.** Keep the model fixed and vary
  thinking/effort per turn. That gives one persona and one prompt surface. Open
  question: whether a per-turn thinking change invalidates the message cache
  (verify against current docs before choosing). It's a strong
  "deep without Opus" variant.
- **Model self-escalation.** Sonnet gets an `escalate` tool, and the turn re-runs
  on Opus. This has real signal, but it wastes a round and is a mid-turn switch
  in disguise.
- **Explicit user override.** A keyword such as "תחשוב טוב" or "think hard"
  forces `deep`. It's code-only and zero-risk, and it can be added alongside the
  router as a pre-rule.
- **Sticky tier with hysteresis.** Keep the tier for N minutes of a conversation.
  It reduces voice changes but misroutes topic switches. Not now.

**Recommendation:** keep the once-per-turn upfront router and stage it.
Upgrade-only (`standard` → `deep`) ships first, because its errors only cost
money. `fast` follows only if Phase 5 shows a real latency win *and* the eval
shows no wrong autonomous effects. Add the explicit-override pre-rule in both
stages.

## 8. Phases and tasks

**Phase 0 — decisions (builder), 2026-10-29:**
- (a) Household text to TypeSafe: ✅ approved.
- (b) New egress host and (c) superseding ADR-0007: ✅ approved.
- (d) Opus tier: ✅ approved.
- (e) `TYPESAFE_API_KEY` and probe budget: builder obtaining it (≈ $1 covers tens
  of thousands of probe requests at $0.042/M input tokens).
- (f) The `turn_route_log` migration (an ask-first schema change; §5): ✅ approved.
- (g) The staged rollout in §7b (`standard`/`deep` first, `fast` later): ✅ approved.

### 8a. Evals — Jev is a model; it gets its own eval suite

The router follows the same pattern as the T36 relatedness classifier: fixtures
are structure-checked in CI, and accuracy is report-only and on-demand.

- **Fixtures:** `evals/fixtures/turn-route.ts`, with each case
  `{ state, expected tier, expected per-question answers, language, split }`.
  Seeded from Phase 1's synthetic set. Later it's extended from real
  `turn_route_log` rows the builder labels, copied into fixtures only after
  review, never automatically.
- **Two splits.** `tune` is for wording work. `holdout` is never looked at while
  tuning and is the only split the gate reads. This is the guard against
  fitting criteria to failing cases.
- **Two levels of scoring.**
  - **Per question:** agreement with the labels at the 0.7/0.3 bands, plus the
    unsettled rate.
  - **Per tier:** a confusion matrix through `decideTier`. The gate is
    asymmetric: **zero `fast`-on-should-be-`standard`/`deep`** in holdout, and a
    tolerance for `standard`-on-`deep` misses.
  - Every slice is reported by language (English / Hebrew / code-switched).
- **End-to-end:** `pnpm eval` decision-9 scenarios run with `TURN_ROUTING=on` and
  must stay 8/8. Plus a small per-tier scenario set (the same household asks
  forced onto each tier) that checks the *effects*, such as reminder time and
  list item, not just the text. This is what proves the Sonnet-tuned prompt
  works on Haiku and Opus.
- **CI:** coverage only. Every tier × language has holdout cases, and every
  `decideTier` row is exercised. **No live Jev calls in CI**, the same rule as
  for model calls.
- **Re-runs are an agent rule, not a mechanism.** Only coding agents work on this
  repo, so the instruction goes where every agent reads it. That's enough; no
  fingerprint and no CI gate, by the builder's call on 2026-10-29.
  - **`.claude/rules/testing.md`** gets a "Routing evals" entry. Run
    `pnpm eval:route` (router accuracy, plus the per-tier end-to-end scenarios)
    before committing any change to:
    - `src/agent/turn-route.ts` (wording, criteria, thresholds, `decideTier`);
    - the Jev pin;
    - a tier model id, **including a host env override** (`FAST_MODEL_ID` /
      `DEEP_MODEL_ID`);
    - `evals/fixtures/turn-route.ts`.

    The result goes into the PR description: per-language holdout scores and
    the asymmetric gate verdict.
  - **CLAUDE.md** Commands section lists `pnpm eval:route` with a one-line
    pointer to that rule.
  - **`turn-route.ts` header comment** repeats it, so an agent editing the file
    sees it without loading the rules.
  - Out of reach: upstream drift *under* a pinned Jev version, and a shift in
    what the household asks. Those show up in production on the §5b router
    health panel (correction rate, tier mix), not in the eval.

**Phase 1 — live probe, synthetic data only.** ✅ PASS 2026-10-29: holdout 15/15, Hebrew at parity, p95 ≤ 369 ms. Verdict in [spike-results](../spike-results.md).
- About 40 hand-written cases, a third each English, Hebrew, and code-switched,
  built on the T32/T38 fixture style. They cover each tier plus hard cases ("move
  it to Thursday", "remind me AND add eggs", "what should we do Saturday given
  both calendars") and null cases ("👍", "ok").
- Wording variants go in one request as sibling questions over the same state.
- Keep every payload in `evals/fixtures/turn-route/` so any result can be rerun.
- Exit: per-language agreement with builder labels, measured latency (p50/p95),
  and the final wording. **Stop here** if Hebrew is materially worse than English.

**Phase 2 — pure core (TDD, unit, no network).** `turn-route.ts`: the questions
module, the state renderer, the Zod response schema, and the `decideTier` truth
table with full combination coverage. `jev-client.ts` with an injected `fetch`:
timeout, non-2xx, malformed body, and a credential-sweep test that the key never
appears in thrown errors.

**Phase 3 — durable wiring (integration, real Postgres).** The `routeTurn` step in
`handleTurn`; multi-model `makeCallModel`; a kill-mid-flight test killed *after*
`routeTurn` journals and before `callModel`, where replay must reuse the
journaled tier with exactly one Jev call. That joins `pnpm test:recovery`.
Separately: the absent-dep path keeps today's step sequence exactly, and the
pre-rules skip Jev entirely (assert zero client calls).

**Phase 4 — ops.**
- Config plus `.env.example`.
- The egress allowlist and nftables mirror, plus the drift test.
- Tracing tags.
- `TURN_ROUTING=shadow` in `pnpm dev`.
- The startup probe and `[route]` log lines (§5b).
- The backoffice Router panel and turn view (§5a/§5b). Panel derivations are
  unit-tested against fake `turn_route_log` rows.
- `pnpm eval:route`.
- The agent rule lines (§8a).
- Update STATUS.md in the same PR.

**Phase 5 — shadow on prod (~2 weeks), then evaluate.**
- Pull the tier distribution and `fallback-error` rate from Langfuse.
- Sample `deep` and `fast` picks and have the builder label them.
- Replay ~20 shadow-`deep` turns offline on Sonnet vs Opus, compared blind.
- Run `pnpm eval` with `TURN_ROUTING=on`. It must stay 8/8, which the §3a
  pre-rules should guarantee.

**Phase 6 — enable, staged, or decide not to.** If §7b is accepted:
- **6a.** `on` with tiers `standard`/`deep` only.
- **6b.** Enable `fast` only after a second shadow window plus a clean §8a
  holdout.

At any point the outcome can instead be "deep didn't earn its place" or `off`.
Either way, the outcome and its numbers go into ADR-0007.

## 9. Out of scope

- Mid-turn escalation, which ADR-0003 rejected.
- Routing the classifiers (T29 summarizer, T36 relatedness). They stay Haiku-class.
- Replacing the T36 relatedness classifier with Jev. It's plausible, since
  approve/deny/refine/unrelated is a Choice plus Nouls, but it's a separate plan.
  It touches a confirm-before path and is listed only as a follow-up.
- Non-Anthropic models.
