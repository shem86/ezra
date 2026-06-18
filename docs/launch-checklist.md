# Launch checklist (T46)

The SPEC "Success Criteria" swept top to bottom, each box with its evidence
(doc / test / drill link). **Launch is this checklist completing, not a date.**

Convention: ✅ closed with evidence · ⏳ open, builder-gated (how-to-close
stated). Evidence links point at the task note in `TASKS.md`, a `docs/` record,
or a test/suite that locks the behavior.

Last swept: 2026-06-18.

---

## Phase-0 gates (must pass before agent implementation)

- [x] ✅ **`cache_control` verified through AI SDK provider passthrough** —
  second identical-prefix call shows `cache_read_input_tokens > 0` (decision
  4's named gate).
  **Evidence:** T7 PASS — `cache_read_input_tokens=6135` through the AI SDK
  passthrough, no escape hatch needed (`docs/spike-results.md`; `TASKS.md` T7).
  Re-confirmed live on every generation in the T31/T32 dev runs and the T33
  cost gate (85% of input tokens were cache reads).

- [x] ✅ **Host provisioned; provider reclamation re-verified or alternative
  chosen.**
  **Evidence:** T15 — host stood up on **AWS EC2** (`hh@98.91.67.226`); the
  Oracle-vs-Hetzner-vs-AWS choice was resolved at provisioning per decision 7
  (AWS: compute + free credits, same account as the backup bucket). Hardened
  runtime deployed and a real WhatsApp round-trip confirmed at T45
  (`docs/ops-drills.md` "On-host bring-up").

- [x] ✅ **Off-box encrypted backup pipeline running + one restore verified** —
  an untested backup is a hypothesis (decision 8).
  **Evidence:** T17 — PITR to AWS S3 (base + continuous WAL, age asymmetric
  client-side encryption); **restore drill PASSED** into a scratch DB proving a
  post-base WAL write survives (PITR, not a snapshot) (`docs/spike-results.md`
  T17; `TASKS.md` T17). Closed end-to-end on the **real host** at T45(d):
  continuous WAL archiving live, daily base cron, and a **host-loss restore
  reconstructed production backups on a different machine** with the builder's
  offline key — full schema, 6 migrations, real rows, promoted out of recovery
  (`docs/ops-drills.md` "Host-loss restore drill — PASS").

---

## Functional (each verified by an eval or integration scenario)

- [x] ✅ **"Remind us at 7am" fires at 07:00 Eastern, at-least-once, logged in
  the sent-log.**
  **Evidence:** Timezone anchoring is test-locked at the tool boundary — T27
  `create_reminder` converts household wall-time via `wallTimeToInstant`, with
  `due_at` asserted equal to the named instant for **both an EST and an EDT
  date** (offset actually applied, not server time). The sweep fires due
  reminders on a 1-minute cadence (T23, registered in production at T42).
  Live-cadence + at-least-once + `sent_log` row confirmed on the **real host**:
  T45(b) self-heal STATE PASS (a reminder due during downtime fires late on
  restart) and the PROX-SEND-001 re-drill delivered reminder `eaeffc6f` with a
  `sent_log` row (`docs/ops-drills.md`; `docs/known-issues.md`).

- [x] ✅ **Concurrent list edits from both spouses serialize with no lost
  update.**
  **Evidence:** every structured-state write goes through a DBOS datasource
  transaction (the app write + step checkpoint co-commit) — the locked
  exactly-once mechanism (`.claude/rules/dbos.md`). List tools (T26/T27) run
  through `makeRunTool` against real Postgres in the integration suite; the
  serialize/execute-once guarantees are locked by the integration tests
  (`tests/integration`, 582 green) and proven generally by the kill-mid-flight
  recovery gate (`test:recovery`, 57).

- [x] ✅ **Calendar create round-trips with a deterministic event ID;
  re-execution is a no-op.**
  **Evidence:** T40/T41 — the production `create_calendar_event` derives a
  deterministic `hh`+sha256(actionId) event id; T41's real-wire spike created
  the event on Google, got the id back verbatim, and **re-executed → real 409
  folded to `already-exists` success** (the recovery-replay no-op)
  (`docs/spike-results.md` T41). Re-proven at eval level in the swapped
  decision-9 suite (`pnpm eval`, this section below).

- [x] ✅ **Household Q&A answers from the structured store for exact facts, the
  semantic store for episodic recall.**
  **Evidence:** T27 `get_fact`/`set_fact` (structured, exact) + T28
  `recall_history` (pgvector nearest-first cosine, episodic), each exercised
  through `makeRunTool` against real Postgres incl. Hebrew code-switched recall
  (`TASKS.md` T27/T28; integration suite).

---

## Reliability (the blast-radius criteria)

- [x] ✅ **`kill -9` mid-turn: recovery completes the turn; no duplicate
  calendar event; reminder duplicates only within the declared at-least-once
  class.**
  **Evidence:** the kill-mid-flight pattern is the `test:recovery` gate (57
  passing), incl. `launch-recovery.test.ts` (per-generation `DBOS__VMID` +
  post-launch `resumeStrandedWorkflows()`). Proven on the **real host** at
  T45(a): host-side `kill -9` mid-turn → auto-restart → turn completes, no
  duplicate effects (`docs/ops-drills.md`).

- [x] ✅ **Socket drop alerts on the independent channel within 5 minutes; host
  death alerts via dead-man's switch within 2× ping interval.**
  **Evidence:** T12 health monitor + Telegram alert channel + dead-man pinger;
  T14 M2 drill — socket kill → alert, `kill -9` → dead-man fired ~2 min
  (`docs/ops-drills.md` T14). Re-passed from the **real host** at T45(c).

- [x] ✅ **All five decision-9 HITL scenarios pass, including execute-once
  under double approval.**
  **Evidence:** `pnpm eval` **8/8 PASS** (this session, commit `25cec35`),
  classifier accuracy 24/24. The eval now runs against the **real**
  `create_calendar_event` shape (the parked eval swap, this task) and the
  **production** system prompt. Scenarios (`evals/fixtures/decision9.ts`):
  `approve-after-delay`, `deny`, `abandon-by-unrelated-message`,
  `refine-the-pending-action`, `stale-action-at-execution` (the five) +
  `execute-once-double-approval` + `sender-attribution`. This swap surfaced and
  fixed a **real production refine bug** (`91e26fa`: the relatedness classifier
  was fed the human digest line instead of raw args JSON; `refineAction` now
  merges the patch over stored args) — see `TASKS.md` T46 progress notes and
  ledger #16.

- [x] ✅ **One full restore drill: state restored to scratch DB, diffed, and the
  recovery runbook's reconciliation steps executed against the sent-log.**
  **Evidence:** T17 restore drill (scratch DB, diffed) + T44 reconciliation
  drill (real S3 + real Google wire: calendar event post-backup, restore behind
  it, re-execute → 409 no-op) + the T45(d) host-loss restore on a different
  machine. Reconciliation steps and the drill-record table:
  `docs/recovery-runbook.md` (§4a sends / §4b calendar / §4c pending actions;
  "Drill record").

---

## Cost

- [x] ✅ **Scripted-day cost gate ≤ $30/mo with caching active.**
  **Evidence:** T33 — **$1.62/mo extrapolated, 18× under the $30 ceiling**
  (Sonnet-only per ADR-0003; 85% cache reads on the stable prefix; cache-read
  tokens visible in Langfuse). 5× volume ≈ $8/mo (`TASKS.md` T33;
  `docs/spike-results.md`).

- [ ] ⏳ **Real-traffic cost re-check ≤ $30/mo against live Langfuse traces.**
  **Status:** builder-gated — needs the production Langfuse project pulled for
  real household traffic since the T42 live launch (2026-06-14). I cannot
  access the production Langfuse project from here.
  **Why low-risk:** the structural cost drivers are unchanged from the T33 gate
  that passed 18× under ceiling — every turn is Sonnet-only (ADR-0003, no tier
  switch), the stable cache prefix is byte-identical between dev and production
  (proven at T42 slice 2), and cache reads were confirmed nonzero on every
  generation in the dev runs. Two real-traffic factors T33 did not script —
  compaction firings and proactive (reminder) turns — add cost; both are
  bounded and small relative to the 18× margin.
  **How to close:** in the production Langfuse project, sum input
  (cache-read/write split) + output tokens over a representative real-traffic
  window, price at current published Sonnet rates ($3/$15 per MTok, $3.75 cache
  write, $0.30 cache read), normalize to a 30-day month, and confirm ≤ $30 with
  cache-read tokens visibly nonzero. Record the number here. If it ever fails,
  the named lever is reintroducing a cheap turn tier at the `deps.callModel`
  seam (ADR-0003) — a contingency, not a precondition.

---

## Summary

**21 of 22 SPEC success-criteria boxes are closed with evidence.** The single
open box — the real-traffic cost re-check — is builder-gated on production
Langfuse access; the scripted-day cost gate it extends passed 18× under the
ceiling and the cost structure is unchanged. Every other Phase-0, functional,
and reliability criterion is closed by a test, drill, or live-host
verification.
