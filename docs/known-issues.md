# Known issues

Tracked defects found in production/deploy that are filed for a deliberate fix
rather than hot-patched. Each links a repro test where one exists.

## PROX-SEND-001 — proactive sends dropped during the restart reconnect window

**Status: RESOLVED 2026-06-15** (fix option 1, refined). Severity was
launch-blocking (gated T46). Found during the T45 on-host sweep-self-heal drill
(2026-06-15), `docs/ops-drills.md`.

**Resolution.** A pure, injectable retry wrapper around the transport send —
`makeResilientSend` (`src/transport/send-class.ts`) — retries **only** the
transient `transport not connected` error with capped exponential backoff until
a time **budget** is spent (default `maxElapsedMs` 5min, `maxDelayMs` 5s cap),
then propagates. It is composed into the production send in `src/main.ts`
(`resilientSend` → `jitteringSend`), so BOTH the reply path (`deliverReply`'s
send) and the approval-prompt path (`sendApprovalPrompts`) inherit it. The
wrapper runs inside the send DBOS step, so its backoff timers are journaled like
the existing human jitter (elapsed is the sum of slept delays — no clock read —
so the loop stays deterministic and unit-testable). It deliberately does NOT
match permanent/unroutable errors (a bad jid — ledger #15), so a poison message
still propagates immediately instead of spinning the lane. The repro in
`tests/unit/send-class.test.ts` was relocated from a `deliverReply`-level
`it.fails` to a real `makeResilientSend` suite plus a composition test proving
exactly-once delivery + one `sent_log` row across a transient disconnect.

**Why a budget, not a few attempts.** The first fix used a fixed 8-attempt/~63s
budget. The on-host re-drill (2026-06-15, `docs/ops-drills.md`) showed the retry
firing perfectly but the WhatsApp reconnect taking **~85s** — WhatsApp throttles
rapid reconnections, so a restart-storm reconnect runs well over a minute. 63s
expired ~10s before the transport opened and the reminder dropped again. The
revised budget (5min, with a 5s delay cap so a long sleep can't overshoot the
reconnect moment) covers the measured ~85s with ~3.5× margin. **Re-drill PASS:**
the reminder delivered with an `at-least-once` `sent_log` row.

**Bonus self-heal (observed in the drill).** Even a reminder dropped by the old
code self-heals: its inbox item is never marked processed (the errored drain
never reached `markProcessed`), so the next `drainConversation` on that
conversation partition sweeps the backlog and re-delivers it — *provided* the
transport is reachable, which the resilient send now guarantees by waiting it
out. (Relevant to T44 reconciliation.)

**Residual (accepted).** A transport down *past* the 5-min budget still errors
the turn — the catastrophic case the T12 health monitor + dead-man ping surface.

---

### Original report

Found during the T45 on-host sweep-self-heal drill (2026-06-15),
`docs/ops-drills.md`.

**Symptom.** After an `ezra` restart, a reminder due during the restart fired
late (state `scheduled → fired`, self-heal worked) **but the reminder message
was never delivered.** No `sent_log` row; the `drainConversation` +
`processTurnBatch` workflows went to terminal `ERROR` with `transport not
connected` thrown at `deliverReply → baileys send` (`src/transport/baileys.ts`
→ `src/transport/send-class.ts`).

**Root cause.** On restart, DBOS launches and the reminder sweep fires the
overdue reminder **before Baileys finishes reconnecting**. The proactive turn's
send throws `transport not connected`; the send step is not resilient to a
transiently-disconnected transport, so the whole workflow errors terminally.
DBOS recovers `PENDING` workflows, not `ERROR` ones, so it is never retried and
the message is lost.

**Scope.** Hits the **proactive / at-least-once class specifically** —
reminders, nags, expiry notices — because those fire from the scheduled sweep
independent of any inbound message. Inbound *replies* are safe: a message can
only arrive once the transport is already connected. So the dropped class is
exactly the one the architecture says must never be dropped ("reliability beats
sophistication"; reminders are core).

**Evidence (drill).** reminder `f901c99d…` due 06:56:00Z; ezra down
06:53:31→06:56:25; on restart the reminder flipped to `fired` at ~06:57, two
ERROR workflows logged `transport not connected`, zero `sent_log` rows after
06:56. Bot reconnected seconds later and is otherwise healthy.

**Repro test.** `tests/unit/send-class.test.ts` — the `test.fails`-marked case
"at-least-once tolerates a transiently disconnected transport" encodes the
desired invariant (a transient send failure must not drop an at-least-once
message). It is green-while-broken via `.fails`; when the fix lands it flips
red, signalling removal of `.fails`.

**Fix options (decide at fix time).**
1. **Step-level retry (preferred, DBOS-native):** mark the proactive send step
   retryable on transient `transport not connected`, with bounded backoff — the
   step re-runs until the transport is `open`, then sends. Keeps the workflow
   alive instead of erroring it.
2. **Transport awaits connection:** `transport.send` waits for state `open` up
   to a timeout before sending (or the proactive lane gates on `open`).
3. **Startup gating:** defer the first sweep tick until the transport reports
   `open`. Narrower — doesn't cover a mid-run disconnect, so weaker than (1).

Recommendation: (1), because it also covers a disconnect that happens mid-run,
not just at startup, and the at-least-once contract already implies "retry
transient failures." Fix before T46; un-skip the repro and add an integration
test (kill transport mid-proactive-turn → message still delivered exactly once).
