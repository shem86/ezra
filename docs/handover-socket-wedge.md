# Handover — the socket that never finishes connecting

**Status of this doc:** briefing for whoever fixes `SOCKET-DEAD-001`. Written
2026-09-05, after the outage below. The bug is **unfixed**; service was restored
by a container restart only. Current state lives in [`STATUS.md`](../STATUS.md),
not here.

Baileys can enter `connecting` and stay there forever. Nothing retries, nothing
errors, nothing restarts. A container restart cures it; only a watchdog prevents
a recurrence.

| | |
|---|---|
| **Deaf for** | 17h 03m — 2026-09-04T20:12:56Z → 2026-09-05T13:16:17Z |
| **Restored by** | `docker restart hh-assistant-ezra-1` (socket open in ~5s, backlog redelivered) |
| **Code** | `startSocket` / `handleClose` / `scheduleRetry` in `src/transport/baileys.ts` |
| **Alerted by** | `createHealthMonitor` in `src/ops/health.ts` (Telegram) |

## Evidence

The container stayed `Up` with `RestartCount 0` throughout. After the wedge it
emitted **exactly one** further line — a scheduled version check — proving the
process was alive and only the socket was dead.

```
20:12:54Z  [socket] disconnected: code=408 retry #1 in 1784ms
20:12:56Z  [socket] connecting
           ← no open, no disconnected, no error. 16h48m of silence.
00:22:14Z  [wa-version] pin is current (2.3000.1043857760)
```

Note `retry #1`. The counter never advanced — that is the tell.

## Root cause

All in `src/transport/baileys.ts`. The order is load-bearing:

1. `startSocket` calls `setState('connecting')`, then awaits `loadAuthState()`
   and `createSocket()`, then registers a `connection.update` handler.
2. That handler is the *only* caller of `handleClose`, and only when
   `update.connection === 'close'`.
3. `handleClose` is the *only* caller of `scheduleRetry`.
4. So a connect attempt yielding neither `open` nor `close` schedules nothing.
   `retryAttempts` stays at 1 and the transport sits in `connecting` until a
   human restarts it.

**There is a second door into the same wedge.** `startSocket` is invoked as
`void startSocket()` and inside `scheduleRetry`'s `.then()`. If
`loadAuthState()` or `createSocket()` *rejects*, that is an unhandled rejection
and again no retry is scheduled. Fix both doors or it recurs through the other.

## The job — a connect watchdog

- If the socket is still not `open` after a bound, tear down the half-open
  socket and re-enter the existing `scheduleRetry` path. Do **not** add a
  parallel retry loop, or the bounded backoff budget and give-up semantics stop
  meaning anything.
- Put the bound on `ReconnectPolicy` beside `maxAttempts`, so it is injectable
  and testable the way `computeReconnectDelay` already is.
- Respect `intentionalClose` — a deliberate shutdown must not trip the watchdog
  into reconnecting.
- Cancel it on every exit from `connecting`, including `logged-out`, and ensure
  it cannot fire twice for one attempt.
- Keep the bound well under `DEFAULT_DOWN_GRACE_MS` in `src/ops/health.ts`, so
  the system self-heals before it pages a human.

**One decision left open on purpose:** whether a watchdog-triggered retry should
consume the `maxAttempts` budget or reset it. Both are defensible — decide it
deliberately and write down why.

## Tests — both doors, no real WhatsApp

TDD: the failing test comes first. Everything needed is already injectable
through `deps` — `createSocket`, `sleep`, `random`, `reconnectPolicy`,
`sessionStore`, `versionSource`.

- **Silent socket:** inject a `createSocket` whose socket never emits
  `connection.update`. Assert the transport retries after the bound instead of
  resting in `connecting`.
- **Rejecting connect:** inject a `createSocket` that rejects. Assert a retry is
  scheduled and nothing escapes as an unhandled rejection.
- **Budget intact:** assert watchdog retries respect `maxAttempts` and give up
  rather than looping forever.

Tests mirror src under `tests/unit/`. Never real WhatsApp traffic in a test.

## Ruled out — do not re-investigate

| Suspect | Why it is not the cause |
|---|---|
| egress firewall | **Zero** `hh-egress-drop` entries across 35h, including the disconnect window. The version probe succeeded *after* the wedge, through the same allowlist. |
| version rejection | Not ADR-0006. The disconnect was **408**, and `wa-version` logged **pin is current**. |
| logged out (401) | Never entered `logged-out`. No re-pairing needed; on-disk session state was fine. |
| the dead-man | Structurally blind here — the process is alive and pinging, so healthchecks.io stays green. Do not "fix" it there. |

This is the same *shape* as the 2026-07-28 outage (running but deaf, `STATUS.md`
item 0) but a different cause. That one was `WA-VERSION-001`; this one is the
amplifier filed as `SOCKET-DEAD-001` in
[`docs/known-issues.md`](known-issues.md).

## Before you ship

- `pnpm lint && pnpm test` before every commit. Never weaken a failing test or
  lint rule to get green.
- Update [`STATUS.md`](../STATUS.md) in the **same** PR, with a date and how you
  verified it. Status lives only there.
- DI via `deps`, no module-level singletons, no default exports, Zod at
  boundaries.
- Ask first: new dependencies (WhatsApp-adjacent ones get a full transitive
  review) and any real WhatsApp traffic.

**Verifying on the host.** A wedge is `[socket] connecting` with no following
`open` or `disconnected`. After the fix, `retry #` must climb past 1. Note a
restart sends **no** ✅ all-clear to Telegram — `downAlertSent` in
`createHealthMonitor` is in-process state the restart resets, so silence is not
evidence of still-down.
