# ADR-0006: WhatsApp client version — pin, watch, fall forward

**Date:** 2026-08-05 · **Status:** Accepted · **Scope:** `src/transport`
(`wa-version.ts`, `baileys.ts`, `protocol.ts`), `src/ops` (`config.ts`,
`wa-version-watch.ts`, `egress-allowlist.ts`), the production spine wiring.
Closes the decision deferred at T16 in `docs/dep-reviews/baileys-7.0.0-rc13.md`
item 6.

## Context

Two things called "version" are easy to conflate, and only one of them is ours
to choose:

- The **Baileys npm package** (`7.0.0-rc13`). Pinned in `package.json`, ours
  for as long as we like — nobody can take it away.
- The **WhatsApp Web protocol version** — a `[2, 3000, N]` triple announced
  during the handshake. WhatsApp **enforces this server-side** and retires old
  web builds on its own schedule. For an unofficial client there is no
  negotiation and no grace period.

Baileys resolves the second one at connect time by fetching
`src/Defaults/baileys-version.json` from its GitHub repo
(`fetchLatestBaileysVersion()`), falling back to a value bundled in the
release. The T16 dependency review flagged exactly this and left a choice open:

> **Egress note for T16.** `fetchLatestBaileysVersion()` fetches the current
> WhatsApp Web version from the WhiskeySockets GitHub repo at startup. Either
> allowlist `raw.githubusercontent.com` on the host or pass a static `version`
> to `makeWASocket` — decide at T16.

T16 shipped the egress allowlist and made **neither** choice. That is the
decision this ADR finally makes.

### What went wrong (the 2026-07-28 outage)

1. `raw.githubusercontent.com` was never on the allowlist. While the host
   firewall was still failing open this was invisible; enforcing it
   (2026-06-27, `reconcile-host-config.sh`) turned the probe into a
   `UND_ERR_CONNECT_TIMEOUT` against a terminal nftables `drop`.
2. **The probe does not throw.** It resolves with
   `{version: <bundled fallback>, isLatest: false, error}`. The adapter's
   `try/catch` therefore never fired, and `isLatest`/`error` were discarded.
   The announced version silently froze at rc13's bundled
   `[2, 3000, 1035194821]`.
3. WhatsApp bumped its web build. Upstream published the replacement
   **2026-07-26**; our first `405` came **2026-07-27T23:21Z**, then wholesale
   rejection on **07-28**.
4. `classifyDisconnect` treated `405` as a generic transient `retry`, so the
   adapter burned all 12 attempts against a rejection that could never clear,
   then went terminally `closed` with no supervisor.
5. Deaf for **5.7 days**. The process stayed alive, so both Docker's restart
   policy and the dead-man pinger correctly stayed green — they monitor process
   liveness, which was never the thing that failed.

A hardening step planted a time bomb that detonated a month later. No data was
lost (13,825 workflows SUCCESS, 0 errored, 0 stranded, 0 overdue reminders).

### What the churn actually looks like

Measured from the upstream version file's commit history:

| Year | Bumps |
|---|---|
| 2022 | 7 (from Jul) |
| 2023 | 5 |
| 2024 | 4 |
| 2025 | 8 |
| 2026 | 6 (through Jul) |

Roughly **4–8 bumps a year**. Recent intervals in days:
`35, 76, 7, 59, 3, 41, 34, 97, 3, 20, 13, 21, 133` — median ~34, but wildly
irregular.

**The decisive number is the warning window, not the median.** The version we
ran was introduced ~2026-03-15 and accepted until 2026-07-27 — about 4.5
months — then died **one day** after upstream published its replacement. The
maintainers appear to bump *reactively*, at or just after the moment WhatsApp
forces it. A pure staleness alert would have been silent for that entire
133-day stretch and then fired with roughly **24 hours** of usable warning.

That single fact drives the decision below: 24 hours is not enough margin for a
household system with one operator who is sometimes away — which is exactly the
condition under which this outage ran to 5.7 days.

## Decision

**Pin the version in config, watch upstream out of band, and fall forward
automatically when WhatsApp rejects the pin.**

1. **The pin is authoritative.** `WA_CLIENT_VERSION` (default
   `2.3000.1043857760`, the reviewed known-good value) lives in
   `src/ops/config.ts` — in git, reviewable, deterministic. It is what every
   socket announces on an ordinary day. **The connect path performs no network
   probe**, so no firewall change can ever again decide what version we speak.
2. **Upstream is consulted out of band.** A daily staleness check compares the
   pin to upstream and *reports*; it never swaps. Edge-triggered, like the
   health monitor — one alert per distinct upstream version, re-armed when the
   pin catches up.
3. **A rejection falls forward.** `405` is classified as its own
   `version-rejected` action rather than a generic retry. On it, the adapter
   fetches upstream and, if it differs from the version just rejected, adopts
   it, resets the retry budget, and reconnects immediately. If upstream offers
   nothing newer, it degrades to the ordinary bounded retry.
4. **Every version event is loud.** Adoption always alerts (the running version
   no longer matches the pin in git). A rejection with no upgrade available
   alerts. A probe failure logs, and alerts once it has been blind for 7
   consecutive checks — a blind check is what hid the freeze for a month.
5. **`raw.githubusercontent.com` is allowlisted**, under its own `wa-version`
   category, for the staleness check and the fall-forward only.

### Why not pure pinning with an alert

It is the option most likely to reproduce this outage. With a measured ~24-hour
warning window, it makes every deprecation an event requiring a human to be
available within a day, indefinitely. That is a bad trade for this system, and
the failure mode is total: the socket goes deaf until someone notices.

### Why not pure auto-fetch

It would have self-healed this specific outage — by 2026-07-28 upstream already
carried the working version, so the first retry would have picked it up. But it
puts a third party on the connect path, makes "what are we running?" unanswerable
without a network call, and lets protocol behaviour change under an unofficial
client with no review. The hybrid keeps the self-healing without any of that:
upstream is consulted only when the pin is *proven* dead.

### Why we did not bump Baileys

rc14 was published 2026-07-29, three days after the version bump — but the
entire rc13→rc14 delta is **Android client support**: a `platform: ANDROID`
branch in `validate-connection.js`, an `android` browser preset in
`browser-utils.js`, and a 4-line experimental warning in `socket.js`. All of it
is gated on `browser[1]` containing `'android'`, and ours is
`['hh-assistant', 'Desktop', '1.0.0']`. Every changed branch is inert for our
configuration, so rc13 speaks the new version number unchanged.

Staying on rc13 therefore keeps the existing transitive dependency review valid
and avoids an ask-first WhatsApp-adjacent dependency bump for no behavioural
gain. (Verified on the handshake, socket, and browser-utils diffs specifically,
not a line-by-line audit of the whole release.)

## Consequences

- Restoring service is a config value, not a dependency change.
- The expected operator load is one advisory alert every month or two, matching
  the churn table and the builder's stated tolerance. Most will be
  precautionary — "upstream moved" — not urgent.
- The pin in git drifts from what is running after a fall-forward. That is why
  adoption always alerts and says which value to write back. A restart before
  the pin is updated returns to the rejected version and falls forward again —
  degraded but self-correcting, not an outage.
- A `405` that no version change can fix still exhausts the retry budget and
  goes terminally `closed`. That is unchanged and deliberate: retrying forever
  against a permanent rejection is not self-healing, it is a busy loop. The
  `no-upgrade` alert is what escalates it to a human.
- The staleness check depends on GitHub reachability. If it goes blind the pin
  keeps working; the blindness alert (7 consecutive failures) is the guard
  against that becoming invisible again.

## Alternatives rejected

- **Restart the container on give-up.** Would have crash-looped through this
  outage — the rejection follows the version, not the process — while tearing
  down healthy DBOS state, the queue, the sweeps, and the in-memory sent-id set
  that suppresses echoes. Its only real effect is resetting a counter.
- **Never permanently give up.** Would not have helped: a 405 is a permanent
  rejection, not a transient failure. Retrying it forever changes a dead socket
  into a dead socket that also generates load.
- **Alert on `gaveUp`.** Reasonable on its face, but redundant here — the
  edge-triggered health monitor already alerts on the transition to `closed`,
  and it fired correctly during this outage. The alert channel worked; there
  was simply nothing it could say that would have fixed the version.
