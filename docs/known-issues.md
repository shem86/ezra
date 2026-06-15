# Known issues

Tracked defects found in production/deploy that are filed for a deliberate fix
rather than hot-patched. Each links a repro test where one exists.

## PROX-SEND-001 — proactive sends dropped during the restart reconnect window

**Severity: launch-blocking (gates T46).** Found during the T45 on-host
sweep-self-heal drill (2026-06-15), `docs/ops-drills.md`.

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
