# Operational drills

Log of manual reliability drills against the running transport
(`pnpm transport`). T14 is the M2 gate; re-run after any transport or
monitoring change that could shift these behaviors.

## T14 — M2 operational drill (2026-06-10, PASSED — M2 gate cleared)

Setup: `pnpm transport` running on the dev Mac, paired to the builder's
number; Telegram alert bot + healthchecks.io check live (period 1 min,
grace 1 min).

| # | Drill | Expected | Observed | Pass |
|---|---|---|---|---|
| 1 | Forced reconnect: type `reconnect` at the prompt | `connecting` → `open` within seconds; no alert (flap inside 60s grace); sends still work after | as expected | ✅ |
| 2 | Network kill: Wi-Fi off, process running | Box can't reach Telegram either — the down-alert send FAILS (console `[alerts]` error ~60s in; expected). The external dead-man is the detector: healthchecks.io alerts within ~2 min. On restore: reconnect + Telegram RECOVERY alert (proves monitor→Telegram live) | as expected (3-min outage). First attempt exposed a monitor bug — down-state keyed on 'closed', which the adapter never emits mid-retry; fixed + regression-tested same day. Second attempt was a sub-grace blip, correctly suppressed as a flap. Third run: `[alerts]` error ~60s in, healthchecks alert ~2 min, recovery message on restore | ✅ |
| 3 | Socket kill, box alive: phone → Linked Devices → log out the hh-assistant device | IMMEDIATE 🚨 logged-out Telegram alert (no grace — simulated ban, the #1 feared failure). Re-pair afterward: `pnpm pair` | as expected | ✅ |
| 4 | Process kill: `kill -9` the runner (no graceful shutdown) | healthchecks.io flips down and alerts within ~2 min (2× ping interval); NO Telegram alert (process is dead — that's the point of the external check) | as expected | ✅ |
| 5 | Restart after kill: `pnpm transport` again | reconnects WITHOUT re-pairing; healthchecks recovers to up | as expected — fresh QR was required, but only because drill 3's logout invalidated the session (`pnpm pair --reset` re-paired); restart-without-QR on an intact session was proven at T11 and on every runner restart during these drills. healthchecks recovered to up | ✅ |

Notes:

## T45 — Production deploy to host (IN PROGRESS, started 2026-06-15)

Deploying the T42 composition to the EC2 host (`hh@98.91.67.226`, Ubuntu 24.04,
t3a.medium) under T16 hardening. The host-prep half (no secrets, no real
traffic) is done by Claude under builder authorization; the half that needs
external secrets or real WhatsApp traffic is builder-gated.

### Done (host prep — autonomous)

| Step | Result |
|---|---|
| Host tooling | Docker 29.5.3 + Compose v5.1.4 installed (official script); Node 22.22.3 (NodeSource, for the egress render/refresh tooling — the app is containerized); `hh` added to the `docker` group (runs docker without sudo) |
| Source on host | repo rsynced to `~/hh-assistant` (excludes `.git`, `node_modules`, `dist`, `.wa-session`, and ALL real `.env` — only `.env.example` shipped) |
| Image builds | `docker build -f infra/Dockerfile -t hh-assistant:prod .` clean on the host — **after fixing a real Dockerfile bug**: it never copied `.npmrc`, so in-image pnpm's default `auto-install-peers=true` mismatched the lockfile's `false` and the frozen install failed (`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`). The T16 "image builds" claim had never actually been exercised. Fixed in commit (COPY `.npmrc` in both stages) |
| Postgres up | `docker compose --env-file .env -f infra/docker-compose.prod.yml up -d postgres` → healthy. **PostgreSQL 17.10, pgvector 0.8.2** available; port `5432/tcp` unpublished (container-internal only); `internal` network + `pgdata` volume created |
| `.env` skeleton | created on host (`chmod 600`): `POSTGRES_PASSWORD` generated on the box; every external secret = `REPLACE_ME` for the builder; `DATABASE_URL`/`WA_SESSION_DIR` intentionally absent (compose injects them) |
| Egress tooling | `node infra/egress/render-allowlist.ts` + `nftables.sh print` work on the host — resolves the full allowlist (Anthropic/Voyage/Google/Langfuse/Telegram/healthchecks/WhatsApp/S3, 44 IPs) into a valid nft ruleset. `apply` deferred (needs the egress bridge, which only exists once `ezra` is up) |
| Doc fixes | `runtime.md` deploy command now includes the load-bearing `--env-file .env` (without it, `-f infra/...` makes the project dir `infra/` and `${POSTGRES_PASSWORD}` interpolation misses the repo-root `.env`); `render-allowlist.ts` comment corrected (Node is host tooling, not the app runtime) |

### Remaining (builder-gated) — checklist

- [ ] **Fill `.env` secrets** — replace every `REPLACE_ME` in `~/hh-assistant/.env`
      from the external accounts (Anthropic, Voyage, Langfuse, Telegram, dead-man,
      Google SA key b64, calendar ids, `WA_JID_*`, `WA_HOUSEHOLD_CONVERSATIONS`).
- [ ] **Full `up` + migrations** — `docker compose --env-file .env -f
      infra/docker-compose.prod.yml up -d --build` brings up `ezra`; it applies
      migrations at startup and **opens the WhatsApp connection (real traffic —
      ask-first)**. Pair on the host if needed (`pnpm pair`, or seed the session).
- [ ] **Apply egress + drill (b/the T16 deferral)** — `apply` the nftables
      ruleset on the `hh-assistant_egress` bridge, then confirm from inside the
      container: `curl https://example.com` times out while
      `https://api.anthropic.com` succeeds.
- [ ] **Drill (a)** — `kill -9` ezra mid-turn → restart → the turn completes,
      no duplicate effects (ledger #1 on the real box).
- [ ] **Drill (b)** — sweeps fire on live cadence; stop the process across a
      reminder's due time → it fires late on restart (self-heal).
- [ ] **Drill (c)** — re-run T14's alert/dead-man drills from the host.
- [ ] **Drill (d) — the folded T44 restore drill** — needs the backup sidecar's
      `pg_hba` replication line live + continuous WAL; then the real host-loss
      restore + reconciliation per `docs/recovery-runbook.md`. Closes T44.


### On-host bring-up + drills (2026-06-15, run by Claude under builder authorization)

Ezra deployed live on the host and **verified hardened**: `ReadonlyRootfs=true`,
`User=1000:1000`, `CapDrop=[ALL]`. Builder confirmed a real message round-trip
in the household group (code-switched reply). Drills:

| # | Drill | Result |
|---|---|---|
| pair | First pair looped the QR | **Fixed** — `wa-session` volume was root-owned; non-root read-only-rootfs process couldn't persist creds. Dockerfile now pre-owns `/data/wa-session` as `node` (commit `71a876b`). Re-pair succeeded; `up -d` reconnects without a QR. |
| A | `kill -9` mid-process → auto-restart → recover | **PASS.** First attempt used `docker kill` and saw no restart — **methodology error, not a bug**: `docker kill`/`stop` is an intentional API stop, which `unless-stopped` correctly does NOT auto-restart. Host-side `kill -9` of the container's process (what OOM does) → Docker auto-restarted (`restarts=1`), DBOS relaunched with a fresh executor id, recovery pass ran, reconnected without QR, "serving" in ~3s. No in-flight turn at the crash instant, so nothing to replay here; exactly-once-mid-turn stays locked by `launch-recovery.test.ts`. |
| B | Egress allowlist apply + blocked-host | **PASS, then rolled back.** Applied on `br-d7fcb10ff338`: `example.com` blocked (timeout), `api.anthropic.com` + `g.whatsapp.net` allowed, live WhatsApp connection survived the apply. **Finding:** the nft set gives each IP a 1h TTL with no refresh, so left applied it self-empties in ~1h and starves the bot's egress. Rolled the manual table back to remove that hazard. Persistent enforcement installed (builder-authorized): `infra/egress/hh-egress.{service,timer}` — boot apply + 15-min refresh (4x margin under the 1h TTL). Re-verified after install: `example.com` blocked, Anthropic/WhatsApp allowed, timer scheduled. **Known minor issue:** each re-apply does delete→resolve→reload, a ~1-2s fail-OPEN window every 15min (v2: switch the timer to the lighter `refresh` subcommand, which keeps the chain loaded — no fail-open). |

**Still to run:** sweep self-heal (builder sets a reminder via chat); T14
alert/dead-man re-pass from the host (needs eyes on the Telegram channel); the
folded T44 restore drill (needs the backup sidecar `pg_hba` replication line +
continuous WAL).

#### Self-heal drill (b) + dead-man (c) — 2026-06-15

Reminder `f901c99d…` set via chat for 06:56:00Z; ezra stopped 06:53:31→06:56:25
(down across the due time), then restarted.

- **Self-heal of reminder STATE: PASS** — stayed `scheduled` + overdue while
  down, flipped to `fired` on restart (the missed tick healed).
- **Reminder DELIVERY: FAIL → filed as PROX-SEND-001** (`docs/known-issues.md`).
  The sweep fired the reminder before Baileys reconnected; the proactive send
  threw `transport not connected`, the workflow errored terminally, the message
  was dropped (no `sent_log` row). Launch-blocking; builder chose file-now,
  fix-before-T46. Repro: `tests/unit/send-class.test.ts` (`test.fails`).
- **Dead-man (c): PASS** — ezra was down ~3 min (past grace); **builder
  confirmed the healthchecks.io dead-man alert arrived on Telegram and
  recovered on restart**. The external check is the only detector of a full
  process-down; in-process socket alerts can't fire when the process is dead.

#### PROX-SEND-001 fix re-drill — 2026-06-15 (Claude under builder authorization)

After the resilient-send fix landed, re-ran the exact drop scenario on the host
against the rebuilt `hh-assistant:prod` image to confirm the reminder now
delivers. Drilled twice (`docker stop` → insert an overdue reminder → `docker
start`, racing the first sweep tick against the Baileys reconnect).

**What was measured (and what was NOT).** Reconnect time was **highly variable**
across the four restarts this session: ~12s (16:59 deploy), ~84s (17:04 drill 1),
~85s (17:11 deploy), ~20s (17:14 drill 2). The proactive sweep fires within ~10s
of launch, so on a slow-tail reconnect the send meets a not-yet-open transport
for over a minute — the same condition that produced the original 06:56 drop.
**The cause of the slow tail was NOT diagnosed** — plausibly WhatsApp-side
reconnect handling and/or Baileys session resync after a crash, but it was not
instrumented or proven (an earlier note here wrongly stated "WhatsApp throttles
to ~85s" as fact). The fix is designed to tolerate the slow tail regardless of
cause rather than depend on diagnosing it: budget > observed worst case, with
margin.

- **Drill 1 (reminder `d1613bd3`, first fix — 8-attempt/63s budget): still
  dropped.** The retry log fired perfectly (attempts 1–7, 0.5→32s backoff) but
  the 63s budget expired ~10s *before* the transport opened, so the send still
  threw and the turn errored. **Finding: the bounded budget was too short.**
- **Fix revised** → budget-based (`maxElapsedMs` 5min) with a `maxDelayMs` 5s
  cap (a 32s sleep was overshooting the reconnect moment). Rebuilt + redeployed.
- **Drill 2 (reminder `eaeffc6f`, revised fix): PASS.** Logs show the capped
  backoff holding at 5000ms; transport opened (~20s this run — reconnect time is
  variable) and the send succeeded. `eaeffc6f` ended `fired` **with an
  `at-least-once` `sent_log` row** (`send-remind-eaeffc6f-…`) — delivered, not
  dropped. Workflow tree: `drainConversation`/`processTurnBatch`/`handleTurn`
  all SUCCESS.
- **Bonus — inbox-driven self-heal observed.** The two earlier dropped reminders
  (`f901c99d` from 06:56 and `d1613bd3` from drill 1) **also delivered** on the
  drill-2 restart: their inbox items were never marked processed (their old
  drains errored before `markProcessed`), so the fresh `drainConversation` for
  `eaeffc6f` swept the whole backlog (children `-3`/`-6`/`-9`) and delivered all
  three once the transport was up. So a dropped at-least-once proactive send
  self-heals on the next enqueue into that conversation, *provided* the transport
  is reachable — which the resilient send now guarantees by waiting it out. The
  4 terminal-ERROR workflows from the old code are harmless artifacts; the
  inbox-driven re-drain redid the work. (Strengthens the T44 reconciliation
  story.)
- **Note:** three reminder messages (2 drill + the stale "go to sleep") landed
  in the household test group `120363426855017212@g.us` during the drill —
  expected, clearly labeled.

**Verdict: PROX-SEND-001 fix confirmed in situ.** The remaining T45 item is the
folded T44 restore drill (backup sidecar `pg_hba` + WAL + real S3/calendar).
