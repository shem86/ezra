# Operational drills

Log of manual reliability drills against the running transport
(`pnpm transport`). T14 is the M2 gate; re-run after any transport or
monitoring change that could shift these behaviors.

## T14 — M2 operational drill (pending)

Setup: `pnpm transport` running on the dev Mac, paired to the builder's
number; Telegram alert bot + healthchecks.io check live (period 1 min,
grace 1 min).

| # | Drill | Expected | Observed | Pass |
|---|---|---|---|---|
| 1 | Forced reconnect: type `reconnect` at the prompt | `connecting` → `open` within seconds; no alert (flap inside 60s grace); sends still work after | | |
| 2 | Socket kill: cut the Mac's network (Wi-Fi off), keep the process running | Telegram down-alert after the 60s grace (≤5 min SPEC bound); on network restore: reconnect + recovery alert | | |
| 3 | Process kill: `kill -9` the runner (no graceful shutdown) | healthchecks.io flips down and alerts within ~2 min (2× ping interval); NO Telegram alert (process is dead — that's the point of the external check) | | |
| 4 | Restart after kill: `pnpm transport` again | reconnects WITHOUT re-pairing; healthchecks recovers to up | | |

Notes:
