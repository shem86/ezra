# Known issues

Tracked defects found in production/deploy that are filed for a deliberate fix
rather than hot-patched. Each links a repro test where one exists. **Open
entries come first**; current open/closed state is asserted only by
[`STATUS.md`](../STATUS.md).

## SOCKET-DEAD-001 — the adapter never re-arms after exhausting its retry budget

**Status: OPEN — production has been dead since 2026-07-28 and still is.**
Severity **P0**: ezra could not send or receive WhatsApp at all. The outage was
diagnosed 2026-08-03 (root cause: WA-VERSION-001) and **re-confirmed still
running, still unfixed on 2026-08-05** — this entry exists because the diagnosis
had not been written into the repo, so nothing tracked it. The disconnect
logging shipped in `v2.2.9` (#35) is what made the failure legible in the first
place.

**Problem.** `handleClose` (`src/transport/baileys.ts`) retries a dropped socket
with exponential backoff up to `policy.maxAttempts`. When the budget is spent it
reports `gaveUp: true`, emits state `closed`, **and stops** — nothing ever
re-arms it. The Node process stays alive and healthy, so:

- Docker's restart policy never fires (the container is `running`, exit code
  never happens).
- The dead-man ping keeps succeeding — it proves the *process* is up, not that
  the *socket* is up — so healthchecks.io stays green through a total outage.
- The health monitor alerts **once** (`downAlertSent` latches at
  `src/ops/health.ts:68`/`:71`) and never repeats, so a permanent outage looks
  identical to the transient blips that had been self-healing all week.

Net effect: a transient WhatsApp-side rejection is converted into a **permanent,
silent** outage that only a human noticing "ezra stopped answering" will catch.

**Evidence (prod, verified 2026-08-05 by `docker logs` + DB query).**
Container `hh-assistant-ezra-1`, image `2.2.9`, started `2026-07-21T14:05:49Z`,
**0 restarts**, same `node dist/start.js` PID throughout.

```
2026-07-28T21:53:01Z [socket] open           <- last time it ever worked
2026-07-28T22:03:27Z [socket] connecting
   … 12 retries, codes 405/408 …
2026-07-28T22:12:02Z [socket] disconnected: code=408 giving up after 12 retries
2026-07-28T22:12:02Z [socket] closed         <- last log line the container ever wrote
```

Nothing was logged for the following **7 days 18 hours** (checked at
2026-08-05T16:09Z). Corroborated in Postgres: `max(enqueued_at)` on
`conversation_inbox` and `max(created_at)` on `sent_log` are both **2026-07-18**,
with `0` unprocessed inbox rows — messages were not queuing up, they were never
arriving. Disconnect-code distribution across the container's life: `428`×17,
`503`×15, `405`×14, `408`×8, with exactly **one** `giving up`.

**Root cause of the drops themselves:** WA-VERSION-001 below. This entry is the
*amplifier* that turned it into an 8-day outage rather than a bad evening.

**Fix direction (decide at fix time).**
1. **Never give up permanently (preferred).** Cap the backoff (e.g. 5 min) and
   keep retrying forever. A household assistant has no scenario where "stop
   trying to reach WhatsApp until a human intervenes" is right — except `401`
   logged-out, which genuinely needs re-pairing and already has its own branch.
2. **Exit the process on give-up**, letting Docker's `restart: unless-stopped`
   restart the whole spine. Simple and uses existing machinery, but throws away
   in-memory state and loops noisily if the cause is persistent.
3. **Re-alert while down.** Independent of 1/2: make the health monitor repeat
   its alert on an interval instead of latching once, so a still-down socket
   keeps nagging. See HEALTH-GRACE-001.

Recommendation: (1) + (3). (1) removes the permanent-dead state; (3) removes the
single-alert blind spot that let it run 8 days unnoticed.

> **Recommendation revised 2026-08-05 (ADR-0006). (1) and (2) were both
> rejected on the evidence; this entry stays OPEN and the give-up stays
> deliberate.**
>
> - **(1) never give up** would not have helped here. A `405` is a *permanent
>   rejection*, not a transient failure: WhatsApp refused the client version we
>   announced, and no number of retries changes what we announce. Retrying
>   forever converts a dead socket into a dead socket that also generates load.
>   The premise "a household assistant has no scenario where stopping is right"
>   conflates *transient* failures (where it holds) with *rejections* (where it
>   does not).
> - **(2) exit on give-up** would have crash-looped straight through this
>   outage — the rejection follows the version, not the process — while tearing
>   down healthy DBOS state, the queue, the scheduled sweeps, and the in-memory
>   sent-id set that suppresses echoes. Its only real effect is resetting a
>   counter.
>
> What was actually missing was a socket that could **change what it
> announces**. WA-VERSION-001's fix adds exactly that: `405` becomes its own
> `version-rejected` action that falls forward to a newer version and *then*
> reconnects with a fresh budget. The bounded give-up remains correct for the
> case where no version change can help — and `no-upgrade` alerts a human at
> that point.
>
> **(3) re-alert while down** is untouched by this and still stands — see
> HEALTH-GRACE-001.

**Repro test to write first** (Prove-It): drive the adapter past
`maxAttempts` with a fake socket and assert it **still** schedules another
attempt (and that the monitor re-alerts while `closed`). `tests/unit/baileys-adapter.test.ts`
already has the give-up harness from #35 to build on.

---

## WA-VERSION-001 — egress blocks the Baileys version probe, freezing the WA client version

**Status: RESOLVED 2026-08-10, shipped in `v2.3.0` (ADR-0006).** Severity
**high** — this was the root cause of SOCKET-DEAD-001. **Diagnosed 2026-08-03**,
fix built and green 2026-08-05, released and deployed 2026-08-10. Verified on
the host at 17:05Z: `[socket] open`, `ezra up: … wa-version 2.3000.1043857760`,
`[wa-version] pin is current` — the last line also proves the probe host is
now reachable, since a blocked probe reports `probe failed` instead.

**Problem.** `fetchLatestBaileysVersion()` (called in `defaultCreateSocket`,
`src/transport/baileys.ts`) fetches the current WhatsApp Web version from
`raw.githubusercontent.com`. That host is **not in the egress allowlist**
(`src/ops/egress-allowlist.ts` / the mirrored nftables units), so on prod it
fails with `UND_ERR_CONNECT_TIMEOUT`.

The failure is silent by construction: it does **not throw** — it returns
`{ version: <bundled fallback>, isLatest: false, error }`, so the surrounding
`try/catch` never fires and the `error` / `isLatest` fields are ignored. The WA
client version is therefore frozen at whatever the installed release bundles
(`lib/Defaults/index.js`); `baileys@7.0.0-rc13` bundles `[2,3000,1035194821]`.

WhatsApp began rejecting that version on 2026-07-27 (a single `405`), then
wholesale on 2026-07-28. Here `405` is a server `<failure reason>` surfaced via
`ws.on('CB:failure')` → `Boom('Connection Failure')` — a **handshake rejection**,
not one of Baileys' named `DisconnectReason` codes — and its canonical trigger is
an obsolete client version. `classifyDisconnect` treats `405` as a generic
`retry`, so the adapter burned all 12 attempts against a server that was never
going to accept it.

**Why this appeared a month after the hardening that caused it.** Enforcing the
egress allowlist (2026-06-27, `reconcile-host-config.sh` — it had been silently
failing *open* before) converted a self-updating version pin into a frozen one.
The hardening was correct; it planted a time bomb that detonated when WhatsApp
next advanced.

**Evidence (verified 2026-08-05, from inside the prod container).**

```
$ docker exec hh-assistant-ezra-1 node -e 'fetch("https://raw.githubusercontent.com/...")'
FAIL TimeoutError The operation was aborted due to timeout
```

and in the give-up storm, `405` is the dominant code (14 occurrences, 10 of the
12 final retries) — the signature of a version the server won't accept.

Check bundled-vs-live at any time with:

```
docker exec hh-assistant-ezra-1 node -e \
  'require("baileys").fetchLatestBaileysVersion().then(r=>console.log(r))'
curl -s https://raw.githubusercontent.com/WhiskeySockets/Baileys/master/src/Defaults/baileys-version.json
```

**Fix direction.** Two independent options; they are not exclusive.
1. **Allowlist the probe host** — add `raw.githubusercontent.com` to
   `src/ops/egress-allowlist.ts` and the mirrored nftables rules (the drift test
   will hold them together). Lets Baileys self-update its version forever.
   Weigh against the allowlist's deliberately tight posture: it adds a GitHub
   CDN to the egress surface of a box that currently talks only to Anthropic,
   Voyage, Google, healthchecks.io, and WhatsApp.
2. **Bump the pin** — keep egress closed and treat the WA version as a normal
   dependency: upgrade `baileys` (and/or pass an explicit `version`) on a
   schedule. Zero new egress; costs a recurring manual step and will re-break on
   the same clock.

3. **Stop the probe failing silently (do this regardless).** `fetchLatestBaileysVersion()`
   returns its error instead of throwing, so today a blocked probe is invisible.
   Log `isLatest`/`error` and the resolved version at connect, and alert when
   `isLatest` is false. Whichever of 1/2 is chosen, this is what turns the next
   occurrence into a warning instead of an outage.
4. **Classify `405` as fatal-ish.** `classifyDisconnect` treats it as a generic
   `retry`, which is why 12 attempts were spent on a handshake the server would
   never accept. A handshake rejection should alert loudly (and, once
   SOCKET-DEAD-001 is fixed, back off far harder than a transient drop).

Recommendation: (1) + (3). Option 2's failure mode is exactly the outage we just
had, and the whole point of SOCKET-DEAD-001's fix is to stop depending on a human
noticing. If (1) is rejected on egress grounds, then (2) **must** be paired with
a version-age alert — (3) is that alert.

**Resolved 2026-08-05 — ADR-0006 (`docs/adr-0006-whatsapp-client-version.md`),
all four, arranged by job.** The measured churn decided the shape: upstream bumps
its version 4–8 times a year, but the version we ran was accepted for ~4.5 months
and then died **one day** after upstream published the replacement. A ~24-hour
warning window is too thin to rely on a human being reachable, which rules out
option 2 alone; and putting a third party on the connect path rules out option 1
alone.

- **(2), as the normal path.** `WA_CLIENT_VERSION` is an explicit pin in
  `src/ops/config.ts`, default `2.3000.1043857760`. **The connect path performs
  no probe at all**, so no firewall change can ever again decide what version we
  speak.
- **(1), narrowly.** `raw.githubusercontent.com` is allowlisted under a new
  `wa-version` category, used *only* by the out-of-band staleness check and the
  fall-forward after a rejection.
- **(3), as `interpretProbeResult()`** (`src/transport/wa-version.ts`): a probe
  result carrying `error`, or `isLatest !== true`, is a **failed probe**, never
  an answer. Directly unit-tested as the root-cause regression guard. A blind
  probe alerts after 7 consecutive failures.
- **(4), as its own action.** `classifyDisconnect(405)` returns
  `'version-rejected'`. The adapter fetches upstream and, if it differs from the
  version just rejected, adopts it, resets the retry budget, and reconnects
  immediately — so a deprecation self-heals. With nothing newer it degrades to
  the existing bounded retry and alerts `no-upgrade`.

Note this fixes the *cause* without adopting SOCKET-DEAD-001's proposed fixes;
that entry's recommendation was reconsidered on the evidence (see its own
section and ADR-0006 "Alternatives rejected").

---

## HEALTH-GRACE-001 — the down-alert predicate can't tell "retrying" from "dead"

**Status: OPEN.** Severity **medium** (alert quality, not availability). Filed
2026-07-21 from the alert investigation that produced #35; confirmed against
real disconnect data 2026-08-05.

**Problem.** `createHealthMonitor` (`src/ops/health.ts:59`) treats `'closed'`
and `'connecting'` identically — "down" means *not open past the grace*. That
was deliberate (a socket stuck in `connecting` **is** down), but it cannot
distinguish two very different states now that the adapter reports which one it
is in:

- *still climbing the retry ladder* — normal, self-healing, and **expected** to
  exceed the grace, because the ladder itself sleeps ~4.25 min before giving up
  (2000, 3600, 6480, 11664, 20995, then 30000×7);
- *gave up / permanently closed* — a real outage (SOCKET-DEAD-001).

With `downGraceMs: 180_000` (`src/main.ts:104`) the retry sleep alone outruns the
grace, so ordinary blips page the builder. Widening the grace is **not
available**: `SPEC.md:180` requires socket-drop alerting within 5 minutes, and
the ladder already eats 4.25 of those.

Second, independent defect in the same code: `downAlertSent` latches, so exactly
**one** alert fires per outage and a still-dead socket goes quiet — the blind
spot that hid SOCKET-DEAD-001 for 8 days.

**Fix direction.** Feed the `DisconnectInfo` the adapter already emits (#35) into
the monitor and split the predicate: alert **immediately** on `gaveUp` (no
grace — it is definitionally an outage), and keep the grace only for the
"connecting/retrying" case. Then make the alert **repeat** on an interval while
down instead of latching, with a recovery notice on `open`.

**Data now available.** `v2.2.9` has been emitting `[socket] disconnected:
code=… ` since 2026-07-21; the code distribution in SOCKET-DEAD-001 is the
calibration input this fix was waiting on.

---

## LOG-KEYS-001 — Baileys writes Signal session key material to container logs

**Status: OPEN.** Severity **medium** — cuts against a `CLAUDE.md` **Never**
("let operational credentials … into prompts/traces/semantic store"). Found
2026-07-18, re-confirmed on prod 2026-08-05.

**Problem.** Baileys' internal logger serializes Signal session state — objects
containing `privKey` and `rootKey` buffers — into stdout, which Docker captures
into the container log. Anyone with `docker logs` (i.e. host access) reads
ratchet key material, and it lands in any log shipping or host backup that
picks up container logs.

**Evidence (verified 2026-08-05).** `docker logs hh-assistant-ezra-1 | grep -c
privKey` → **11**; same count for `rootKey`. (Counts only — values deliberately
not read into a transcript.)

**Scope / what limits it.** Log retention is the container's lifetime (no
external shipping today) and host access is already the trust boundary that
holds the session files themselves, so this is a defence-in-depth failure, not
an active compromise. The Baileys session directory is correctly excluded from
backups (`infra/`, SPEC "Never"); container logs are simply a channel nobody
audited.

**Fix direction.** Pass Baileys a logger configured to redact or drop those
fields (its pino logger supports `redact` paths), or lower its log level in
production so session-state objects are never serialized. Verify with the same
grep returning `0`. Add a smoke assertion so it cannot regress silently.

---

## LEDGER-15 — undeliverable-send poison pill wedges the concurrency-1 lane

**Status: RESOLVED 2026-06-21** (T48). Severity post-launch hardening (the
pre-launch mitigation — keeping prod off the test DB — shipped at the T42 smoke).
Surfaced at the T42 smoke (2026-06-14) when leftover TEST reminders with fake
conversation ids (`conv-run-…`, no `@server`) fired from the shared dev DB and
`jidDecode` threw inside Baileys `relayMessage`.

**Problem.** An **at-least-once** send (reminder/nag/approval prompt) to a
destination the socket can never reach throws in the send step. Because the
class never drops, the inbox item is never marked processed and the next enqueue
re-drains the **same** poison item — so the throw repeats forever, wedging that
conversation's concurrency-1 lane. PROX-SEND-001's resilient send deliberately
did NOT match permanent errors (it only waits out a *transient* disconnect), so
a genuinely unroutable destination fell through to exactly this wedge.

**Resolution.** Classify the send error and give a permanent one a terminal
path. `isPermanentSendError` (`src/transport/send-class.ts`) matches only the
**owned**, stable `unroutable destination` signal — the same recipe as
`transport not connected` — so an unrecognized error defaults to NOT permanent
(ambiguity fails toward retry, never toward a silent drop). The transport
(`src/transport/baileys.ts`) detects a structurally malformed jid
(`isUnroutableDestination`) and throws that owned error before it reaches the
socket. On a permanent error, the at-least-once paths — `deliverReply`
(reminders/nags) and `sendApprovalPrompts` (approval prompts) — **dead-letter**
it (`makeSendDeadLetter`: alert via the T12/T14 channel + host-local log; the
household text stays off the external channel) and return WITHOUT throwing, so
the step completes, the inbox item marks processed, and the lane is freed. The
no-schema alert+log path was chosen over a dead-letter table (the entry decision
in T48) to avoid a schema change. Any non-permanent failure still re-raises —
the T12 health/dead-man case.

**Repro tests.** `tests/unit/send-class.test.ts` (classifier, `deliverReply`
dead-letter, `makeSendDeadLetter` never-throws), `tests/unit/baileys-adapter.test.ts`
(owned-error rejection, socket never called), `tests/integration/park.test.ts`
(approval-prompt dead-letter: action stays pending+unstamped, no `sent_log` row,
no throw).

**Residual (accepted).** A *well-formed* jid that is unroutable at runtime (a
chat deleted/blocked) is not structurally detectable, so it stays in the
default-transient bucket — waited out, then surfaced by the T12 health monitor —
rather than dead-lettered. A dead-lettered approval prompt leaves its action
pending+unstamped to TTL-expire; a new parked turn in the same conversation
re-attempts and re-alerts (bounded by TTL, not a tight loop).

---

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
match permanent/unroutable errors (a bad jid — ledger #15, now given a terminal
dead-letter path in T48; see the LEDGER-15 entry above), so the resilient send
never spins on a poison message. The repro in
`tests/unit/send-class.test.ts` was relocated from a `deliverReply`-level
`it.fails` to a real `makeResilientSend` suite plus a composition test proving
exactly-once delivery + one `sent_log` row across a transient disconnect.

**Why a budget, not a few attempts.** The first fix used a fixed 8-attempt/~63s
budget. The on-host re-drill (2026-06-15, `docs/ops-drills.md`) showed the retry
firing perfectly but the reconnect on that run taking **~85s**. Reconnect time
was measured to vary widely across restarts (~12s to ~85s); the slow tail is not
diagnosed (plausibly WhatsApp-side reconnect handling and/or Baileys session
resync — not proven), so the design tolerates it rather than depending on the
cause. 63s expired ~10s before the transport opened and the reminder dropped
again. The revised budget (5min, with a 5s delay cap so a long sleep can't
overshoot the reconnect moment) covers the observed worst case (~85s) with
~3.5× margin. **Re-drill PASS:** the reminder delivered with an `at-least-once`
`sent_log` row.

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
