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
| 2 | Network kill: Wi-Fi off, process running | Box can't reach Telegram either — the down-alert send FAILS (console `[alerts]` error ~60s in; expected). The external dead-man is the detector: healthchecks.io alerts within ~2 min. On restore: reconnect + Telegram RECOVERY alert (proves monitor→Telegram live) | | |
| 3 | Socket kill, box alive: phone → Linked Devices → log out the hh-assistant device | IMMEDIATE 🚨 logged-out Telegram alert (no grace — simulated ban, the #1 feared failure). Re-pair afterward: `pnpm pair` | | |
| 4 | Process kill: `kill -9` the runner (no graceful shutdown) | healthchecks.io flips down and alerts within ~2 min (2× ping interval); NO Telegram alert (process is dead — that's the point of the external check) | | |
| 5 | Restart after kill: `pnpm transport` again | reconnects WITHOUT re-pairing; healthchecks recovers to up | | |

Notes:
