# STATUS — what's open right now

**Last full reconcile: 2026-07-21** (validated against `git log`, `gh`, and the
source tree — not against the other docs). Secret scan clean the same day
(see Open item 2).

**Partial update 2026-08-05:** live-host check only (container logs + Postgres).
Added Open item 0 — **production is down** — and four defect records to
`docs/known-issues.md`. Items 1–5 below were not re-verified on this pass and
still carry their 2026-07-21 dates.

**Partial update 2026-08-10:** item 0 **resolved** — ezra is back up on
`v2.3.0`, verified live on the host. Item 7 (backoffice Langfuse reads — both
data screens measured broken on prod) **resolved** and live on `v2.3.3`,
verified on the host after the deploy. Added item 8, which corrects a
`/api/status` timing claim made under item 7 — and was itself refined after
`v2.3.4`, when the symptom stopped reproducing. `v2.3.4` shipped the
self-service sign-in, the auth-lockout fix and the doc-ref checker; auth
verified live on the host (valid token 200, credential-less 401 that does not
lock out, SPA shell now serving HTML rather than raw JSON). Added item 9 — the
lookback and retention ceilings the new TanStack chart layer cannot reach from
the client. Items 1–5 still carry their 2026-07-21 dates and were not
re-verified on this pass either.

**Partial update 2026-09-03:** item 8 **root-caused** on the host (the egress
allowlist was dropping the rotating `oauth2.googleapis.com` answer; the
"stopped reproducing" claim was wrong) and fixed at the egress, server and UI
layers. Nothing else re-verified on this pass.

This is the **single source of truth for current state**. Everything else is
history:

| File | Role |
|---|---|
| [`STATUS.md`](STATUS.md) *(this file)* | **Current state.** Rewritten freely. The only file that asserts what is open. |
| [`V2_NOTES.md`](V2_NOTES.md) | Append-only ops journal. `§N` anchors are stable and referenced from code + systemd units. Its heading markers are historical. |
| [`TASKS.md`](TASKS.md) | v1 build ledger, complete. T-numbers are stable anchors. |
| [`docs/adr-*.md`](docs) | Decisions. Immutable once Accepted. |
| [`docs/known-issues.md`](docs/known-issues.md) | Per-defect deep records. Open entries first, then the resolved ones. |
| [`docs/specs/archive/`](docs/specs/archive) | Shipped/executed specs. Archived, never deleted. |

**House rules.**

1. **Status lives only here.** Other docs describe *why* and *what happened*;
   they must not carry a status table. Two copies of the truth means one is
   always stale — that is exactly how §10 sat marked "gate — evaluate before
   flipping" for a week after the repo went public.
2. **Every claim carries a date and how it was verified.** An undated status
   line is a defect. "Probably done" is not a status.
3. **Never delete a spec** — archive it. `go-public-spec.md` was deleted in the
   pre-public trim and its audit record survived only in `0b4f008`.
4. **Update this file in the same PR as the work.** Branch protection is not
   enforcing that today, so it is discipline.
5. **Cite symbols, never line numbers.** <!-- refcheck:off --> `the
   wasSentByBot: () => false wiring in src/main.ts`, not `src/main.ts:431`.
   Earned immediately: this file shipped 2026-07-21 citing four line numbers,
   and PR #35 (socket-drop diagnostics) invalidated all four the *same day* —
   `main.ts:431`→446, `baileys.ts:142`→162, `:305`→345, `:228`→268. The facts
   were still true; only the pointers rotted. A grep-able symbol survives every
   refactor above it. <!-- refcheck:on -->
   Enforced by `pnpm check:docs` (`scripts/check-doc-refs.ts`), which also
   resolves every link and every cited path, and requires each `src/`/`tests/`
   path in this file to carry a symbol that still greps. It runs in **both** CI
   workflows on purpose — see the header comment in that script for why a
   docs-only trigger would have been green through the very failure above.

---

## Open

### 0. ✅ RESOLVED 2026-08-10 — WhatsApp socket was dead 2026-07-28 → 2026-08-10
**Status:** **resolved**, service restored on `v2.3.0` · **verified**
2026-08-10T17:05Z on the host: container `ghcr.io/shem86/hh-assistant:2.3.0`,
`status=running restarts=0`, log shows `[socket] open` +
`ezra up: … wa-version 2.3000.1043857760` + `[wa-version] pin is current`.
Firewall re-verified enforcing (the `policed` chain still ends in
`log … drop`), with GitHub's probe IPs resolved into the `allowed4` set.

**ezra was unable to send or receive WhatsApp for 12 days 19 hours**
(2026-07-28T22:12Z → 2026-08-10T17:02Z). The container was `running` with 0
restarts and the dead-man ping was green throughout — the *process* was
healthy, the *socket* was not. `sent_log` and `conversation_inbox` both topped
out at **2026-07-18**, with zero unprocessed rows.

Three separate defects had to line up, each filed in
[`docs/known-issues.md`](docs/known-issues.md):

| | Defect | Role | State |
|---|---|---|---|
| **cause** | `WA-VERSION-001` | egress blocks Baileys' version probe → frozen WA client version → WhatsApp rejects it (`405`) | ✅ **RESOLVED** in `v2.3.0` (ADR-0006) |
| **amplifier** | `SOCKET-DEAD-001` | adapter gives up permanently and never re-arms; process stays alive so Docker never restarts it | **open by decision** — see below |
| **blind spot** | `HEALTH-GRACE-001` | health monitor alerts **once** and latches; dead-man proves liveness, not connectivity | **open** |

**No data loss.** 13,825 workflows SUCCESS, 0 errored, 0 stranded, 0 overdue
reminders, 0 pending actions; the scheduled sweeps ran throughout. The outage
was deafness, not corruption.

**What shipped** (PRs #39 + #40, released as `v2.3.0` 2026-08-10): the pin
`WA_CLIENT_VERSION=2.3000.1043857760` so the connect path never probes the
network, `405` classified as its own `version-rejected` action that falls
forward to the current upstream version and reconnects, a daily out-of-band
staleness check with edge-triggered alerts, and `raw.githubusercontent.com`
allowlisted under a new `wa-version` category. Baileys stayed at rc13. No
re-pairing was needed — `401` never appeared.

**Deploy gotcha, worth remembering.** The *first* `v2.3.0` deploy **failed its
healthcheck and auto-rolled back to 2.2.9**, then an identical redeploy nine
minutes later came up on the first socket attempt. The release was not at
fault. Two things combined:

1. The deploy's readiness gate is the `ezra up:` marker, which is printed only
   *after* `await transport.connect()` resolves. So **while the WhatsApp socket
   cannot open, no deploy can ever pass** — including the deploy that fixes it.
   That is a genuine catch-22 in the gate and is worth revisiting (a marker
   printed before `connect()`, or a readiness signal that does not depend on a
   third party, would decouple "the release is good" from "WhatsApp is
   answering").
2. WhatsApp appears to have been in a short cooldown immediately after the
   retry burst — the same image and the same pinned version were refused at
   16:53Z and accepted at 17:02Z with no code change in between.

✅ **Fixed 2026-08-10** (same day, in the follow-up PR). Readiness deliberately
still means *the WhatsApp socket is open* — ezra **is** the WhatsApp connection,
so a green deploy with a dead socket would claim success while delivering
nothing. What changed is the failure branch: `on-host-deploy.sh` now samples the
outgoing container's socket state **before** the swap and rolls back only when
that socket was healthy, i.e. only when the new release is genuinely the
suspect. When the socket was already down, it keeps the newer image and says so
— reverting to an image with the same external dependency cannot restore
service and would discard the fix. The deploy still fails (ezra is down and must
not be reported healthy); it just no longer undoes the cure. `HEALTH_TIMEOUT`
also went 180s → 300s, since the reconnect ladder only fits ~8 attempts in 180s
and a WhatsApp cooldown can outlast that.

If a future deploy fails this gate, **re-run it before concluding the release
is bad**, and check the container's own `[spine]`/`[socket]`/`[wa-version]`
lines rather than the pipeline's verdict.

**Why `SOCKET-DEAD-001` is not fixed alongside it.** Both fix directions that
entry proposes were considered and rejected on the evidence (ADR-0006,
"Alternatives rejected"): retrying forever would not have helped, because a
`405` is a permanent rejection rather than a transient failure — it converts a
dead socket into a dead socket that also generates load; and restarting the
container on give-up would have crash-looped through this outage, since the
rejection follows the version and not the process. The give-up remains
deliberate. What was missing was a socket that could *change* what it announces,
which is what ADR-0006 adds.

**Diagnosed 2026-08-03, fixed on a branch 2026-08-05, shipped 2026-08-10.** The
root cause was worked out a week before it shipped; the fix then sat on an
unpushed local branch for five days. Twice now the delay was not the diagnosis
or the code but the work living somewhere the repo could not see it. That is
the reason for house rule 4.

**Still open from this outage:** only the `HEALTH-GRACE-001` *predicate* half —
the monitor cannot tell "climbing the retry ladder" from "gave up", so ordinary
self-healing blips can page while a real give-up waits out the grace. Fixing it
would mean fewer alerts, not more.

**Closed as won't-fix 2026-08-10:** repeat-alerting while down. One alert per
outage is the intended contract ("still down unless you hear otherwise"); the
12 days were operator time, not a missing signal. The deploy-gate catch-22 is
fixed — see below.

### 1. §5 — apply the cloud-layer SG egress to live prod
**Status:** open · **verified** 2026-07-21 (`git log` shows nothing under
`infra/` after 2026-06-28 except the ezra rename and backup CI).

Rules are authored in `infra/pulumi/components/host-environment.ts` (443/tcp,
80/tcp, 53 tcp+udp, 123/udp) but never applied. `V2_NOTES` §5 calls this "a
deliberate, careful step" — do it with AWS Console / Session-Manager access as
fallback, ideally validated on a §2 create-from-zero (`scratch`) env first.

*Not to be confused with the host-level nftables units, which **are** done:*
`infra/host/reconcile-host-config.sh` ran on prod 2026-06-27 and was verified
live. That run mattered — the adopted host never ran cloud-init, so the
`sudoers-hh-ops` drop-in was missing and **egress was silently failing open**.

### 2. Go-public: broad PII sweep still unrecorded
**Status:** partially closed · **verified** 2026-07-21.

- ~~**Tool-based secret re-scan**~~ ✅ **CLOSED 2026-07-21 — clean, zero
  findings.** gitleaks v8.30.1 over the **entire public history**, run twice:
  the local repo (294 commits) and, separately, a fresh clone with every GitHub
  PR head ref fetched (298 commits) — the second run because 21 branches were
  pruned in go-public Phase D, leaving **13 commits reachable only via
  `refs/pull/*/head`**, which are public on GitHub but invisible to a local
  scan. Both reports empty. Coverage is provably complete: 328 reachable
  commits = 294 scanned + 33 merges (no unique diff) + 1 empty commit
  (`844d6e1`). This retires §5 acceptance item 1 and confirms the original
  manual audit's conclusion.

  Repeat with:
  ```
  git clone https://github.com/shem86/ezra.git /tmp/prscan
  git -C /tmp/prscan fetch origin '+refs/pull/*/head:refs/remotes/pr/*'
  docker run --rm -v /tmp/prscan:/repo:ro zricethezav/gitleaks:latest \
    git /repo --redact --log-opts="--all"
  ```

- **Broad PII sweep — still not recorded.** §10 asks for a sweep of fixtures,
  tests, and committed logs for real phone numbers, JIDs, names, addresses, and
  calendar contents. What happened was two targeted redactions (a real group JID
  in `docs/ops-drills.md`, two `@lid` values in tests). No commit or doc records
  the broad sweep. **Note gitleaks does not cover this** — it detects
  credential-shaped strings, not household PII, so the clean scan above says
  nothing about it.

### 3. Ledger #14 — durable `wasSentByBot` (restart-surviving echo guard)
**Status:** open, builder decision (schema vs adapter-id) · **verified**
2026-07-21 by reading source.

Production hardcodes the guard off: the `wasSentByBot` constant in
`src/main.ts` is `() => false`. The real suppression is an **in-memory ring
buffer** — the `RecentIds` buffer in `src/transport/baileys.ts`, populated on
send and consulted on inbound — so it is **lost on restart**. The
`IngestionDeps.wasSentByBot` seam (declared and checked in
`src/orchestration/ingest.ts`) is therefore dead code in
prod. `sent_log` exists but is wired only to send-class dedup, not the echo
guard; no migration adds an echo/adapter-id table (`migrations/` tops out at
`0008-compaction-log.sql`).

Per `TASKS.md`, deliberately deferred unless a restart-echo is actually
observed. Note this interacts with testing on a personal number, where `fromMe`
echo filtering is already the known-fragile path.

### 4. Compaction summaries translate Hebrew → English
**Status:** open quality risk, no owner · **verified** 2026-07-21
(`docs/compaction-eval-spec.md` calibration section).

The calibration run's headline finding: **a model bump does not fix it**, and
boundary discipline is model-independent (a prompt-following gap, not a
capability gap). Scores were commitment preservation 96%/96% (Haiku/Sonnet),
faithfulness 96%/98%, boundary discipline 88%/89%, language failures 2/8 vs 1/8.

This matters more than the numbers suggest: the household is mixed
Hebrew/English by design, and the eval is **report-only** — no threshold is a
CI gate, so a regression here is silent.

### 5. §12 Phase 1 — untrusted-content boundary
**Status:** deliberately deferred to M5 · **verified** 2026-07-21 (`V2_NOTES` §12,
ADR-0005 Accepted).

Phase 0 shipped and is eval-ratified (fence-at-tool on calendar/recall/facts +
the system-prompt rule; injection evals hold). Phase 1 is the per-turn nonce
marker, web/Q&A fencing, and forwarded-message provenance. No urgency — ADR-0005
rules the current posture acceptable.

Also flagged-and-accepted in §12: no output moderation before send; the
relatedness classifier is guarded only by offline eval; the HITL park/resume
machinery is built but **unexercised in production** (soak it during the
calendar rollout).

### 6. ✅ RESOLVED 2026-08-10 — backoffice auth locked the operator out
**Status:** **resolved**, shipped in `v2.3.1` (lockout) + the self-service
sign-in that follows it · **verified** 2026-08-10 first by reproducing it
against live prod (`curl` over the tailnet returned
`429 too many attempts — locked out` while the host's own tailnet IP got a
normal `401`), then **against prod after the `v2.3.1` deploy**: 12 consecutive
credential-less requests all returned `401` with no lockout (under the old code
the 9th would have 429'd for 15 minutes), and a single wrong token produced
`backoffice auth: rejected header token from …` in the container log with the
presented value absent.

The operator's own machine was locked out of the read-only console for 15
minutes while every layer was healthy (host up, `tailscaled` up,
`tailscale serve` bound, container Up, ~90ms response). It reads as an outage.
Three defects in the auth gate conspired, all in `src/backoffice`:

| | Defect | Effect |
|---|---|---|
| **trigger** | credential-less requests counted as failed *attempts* | the dashboard fires 4 parallel `/api` calls on mount, so **two** stale-cookie page loads spent the whole 8-failure budget |
| **amplifier** | failure counter never decayed | rejects summed for the process's lifetime, so unrelated 401s days apart added up |
| **trap** | `isLocked` was checked *before* the token comparison | a **correct** token was refused too — the operator could not recover by presenting it, only by waiting |

Fixed by evaluating the credential first and consulting the lockout only once
it proves wrong (a valid token always wins — an attacker never holds one), by
not counting no-credential requests, and by sliding the failure window. The
throttle that matters is unchanged: 8 wrong tokens inside 15 minutes still
locks. Auth rejections and lockouts are now logged (the console had emitted
**two log lines in two weeks**, so nothing was diagnosable from the box).

Brute force was never the real risk here — `BACKOFFICE_TOKEN` is `min(32)`
random behind a tailnet, so the limiter's security value rounded to zero while
its availability cost was a real 15-minute outage. It is kept, but now it fires
on guessing rather than on the operator.

**Self-service sign-in (the follow-up, same day).** The lockout fix stopped the
console locking you out; it did not stop you *needing the URL bar* to get in.
Two things kept the incident's root cause alive:

- the SPA shell was token-gated too, so an unauthenticated visit rendered raw
  JSON and the only way in was hand-pasting `?token=` — no sign-in screen
  existed anywhere in the product;
- `bo_session` carried a fixed 30-day `Max-Age` set once at first sign-in, so it
  expired mid-use on a schedule. That expiry is the most likely trigger of the
  original incident (the tailnet exposure was rolled 2026-06-24, 47 days before).

Both are closed. The shell and its assets are now **public** (they carry no
household data — `/api/*` is the real gate), so an unauthenticated visit renders
a **sign-in form**; the token is exchanged for the cookie over
`GET /api/session` as a Bearer header, so it never enters the address bar or
browser history the way `?token=` did (that URL still works — old bookmarks are
unbroken). The cookie is **re-issued on every authenticated response**, making
it an idle timeout rather than a hard expiry. Any `401` **or `429`** from any
screen raises a window event that swaps the shell for the sign-in form, so an
expired session lands on a form instead of five identical error cards. There is
now a **sign out** in the sidebar, so revoking a session no longer means rotating
the token.

**A third shape of the same lockout, caught in review of that follow-up.** Making
the shell public re-opened the incident by a new route: after
`BACKOFFICE_TOKEN` is rotated, every browser replays the *old* token in its
cookie — on the shell, on each hashed asset, and on the four `/api` calls the
dashboard fires on mount. Counted as guesses, one page load spent the whole
8-failure budget, so the operator was `429`'d before the sign-in form could
render, every reload re-armed the lock, and `429` did not raise the window event
so the form was unreachable. Reproduced against the built server at the
production limiter settings (lock tripped on page load 1; loads 2 and 3 were
`429` across the board). Three changes close it: a rejected **cookie** is not an
attempt (it is discarded and cleared — only a *presented* header or `?token=` can
be a guess, and those still lock out after 8); a presented token now outranks a
stored cookie in `extractToken`, so a good token is compared instead of being
shadowed by the stale one; and `429` joins `401` in routing to the form, which
says the console is healthy. Also hardened while in there: `Secure` on the cookie
when the request arrives over HTTPS — which in prod is always, since
`tailscale serve` forwards `x-forwarded-proto: https` and the container port is
loopback-only; the conditional exists for the plain `http://localhost` origin the
vite dev server proxies through — and `X-Frame-Options: DENY` +
`frame-ancestors 'none'`, since a public page now renders a credential form.

Verified end-to-end in a real browser against the built server + built SPA
(`chromium`, `backoffice/scripts/verify-signin.mjs`, now at the production
limiter settings): unauthenticated visit renders the form and no raw JSON; a
wrong token stays on the form; the right token loads the console; the token never
appears in the URL; the cookie is httpOnly; a reload stays signed in; sign-out
returns to the form and survives a reload; and a stale cookie lands on the form
across three reloads without a single `429`, then signs in cleanly. The two
stale-cookie server tests were confirmed RED against the pre-fix code.

**Known fragility, not fixed here:** the SPA has no error boundary, so one
malformed API field blanks the whole console (found while building the
verification harness — a stub with a missing `dailyCost` produced a white
screen, not a degraded card). Worth an error boundary around the screen subtree.

### 7. ✅ RESOLVED 2026-08-10 — backoffice Langfuse reads (shipped in `v2.3.3`)
**Status:** **resolved**, live on `v2.3.3` · **verified** 2026-08-10T19:0xZ on
the host after the deploy: `/api/logs` **0.074s / 0.030s / 0.032s** with
`enriched:true` and 43 of 55 turns carrying tokens (was 30.05s and
`enriched:false` on every load), `/api/costs` **0.004s HTTP 200** returning
`$0.09` MTD / 31,644 tokens / 20% cache reads (was `503`). Spine healthy on the
same image — `[socket] open` + `ezra up:` + `[wa-version] pin is current`.

Both Langfuse-backed screens were broken in production, and neither was a
cold-cache effect — they failed on **every** load:

| | Measured on the host (2026-08-10) | Cause |
|---|---|---|
| **Logs** | **30.05s every load**, `enriched:false` every time — the token/cost/tier/tool columns had *never* rendered in prod | the legacy `/api/public/observations` endpoint is deprecated on Langfuse Cloud and answers an unfiltered page with a **server-side timeout** (HTTP 422, "Request timed out") after ~30s. The app's own 30s `AbortSignal` usually fired first. Because the fetch always threw, the 5-minute cache never populated, so every request paid the full 30s afresh. |
| **Costs** | 15–17s, then `503` for the rest of the day | `/api/public/metrics/daily` is capped at **10 requests per day** on this plan (`x-ratelimit-limit: 10`, ~24h reset). A 5-minute TTL burns that quota within the hour; after that it is `429` → `503`. |

Ruled out by measurement, *not* inference: the DBOS journal query is **35ms**
(`EXPLAIN ANALYZE`; a seq scan over 97,758 rows, fully cached — no index
needed). `/api/status` was also ruled out as a *cause of this defect*, but see
item 8 — the "0.45s, every probe ≤541ms" reading first recorded here was
incomplete, and the correction is its own entry rather than a footnote.

Fixed by collapsing both screens onto ONE shared read of the **v2** endpoint —
the `makeObservationsSource` factory in `src/backoffice/observations.ts` —
calling `/api/public/v2/observations` with
`fields=core,basic,usage,metadata`. The `fields` parameter is load-bearing —
without it v2 omits `usageDetails` and `metadata` entirely, which is every
column the console shows. Costs no longer touches `metrics/daily` at all; the
per-day series is folded from the same records, which also yields a *real*
per-day cache split instead of applying one sampled ratio to every day. The
source owns caching, in-flight de-duplication (the SPA fires four calls at
once) and a short **failure** cache, so a broken upstream can no longer cost a
full timeout on every request. Fetch ceiling dropped 30s → 8s.

Measured after the change, against live Langfuse: cold shared read **2.4s**
(606 records), warm **0ms**, `getCosts()` **1ms**, and **246 traces enriched**
where production had zero. The month-to-date figures reproduce independently
computed host-side numbers exactly (31,644 tokens, $0.0872, 20% cache reads).

Still estimated, deliberately: v2's `totalCost`/`costDetails`/`modelId` come
back 0/empty/null for this project, so BO-8's "Langfuse has no cost and no
model" still holds and the Sonnet-class price table stays.

**Not in this change:** the Overview still renders all-or-nothing (the
`useAsync` hook in `backoffice/src/api/use-async.ts` holds until all four calls
settle), so the page is as slow as its slowest card. That mattered enormously
at 30s and barely matters at ~1s, but progressive per-card rendering is still
the right shape. Also unaddressed: 97,540 of the 97,758 journal rows are
`reminderSweep`/`expirySweep` records versus 54 real turns — harmless at
today's 35ms, worth a retention policy before it isn't.

### 8. ⏳ REOPENED 2026-09-04 — `/api/status` 10.5s cold cost = egress allowlist dropping `oauth2.googleapis.com`
**Status:** the **original symptom is closed** — root-caused and fixed in PR
#50, released as **v2.3.6** (deploy run green 2026-09-04 00:22 UTC, all three
containers on `:2.3.6`); post-release verification on the host: cold
`/api/status` **0.52s / 0.44s**, the served bundle is the per-card Overview,
and the installed egress units + sudoers were byte-identical to the checkout,
so the `reconcile-host-config.sh` step was a no-op. **Reopened the same day**
by the third finding below: the accumulating refresh never survived the hour,
because `nft add element` does not restart an element timeout — an ~hourly
drop window against every *stable* destination, the dead-man ping included.
Fixed in **PR #52**, **live on the host** since 2026-09-04 01:32 UTC and
hardened after review 2026-09-05 (both verified below). ⚠️ That roll is a
hand-copied file, so the **next deploy's `git checkout --force` reverts the
host to whatever ships in the release** — until PR #52 is released a deploy
silently reinstates the hourly drop, and `reconcile-host-config.sh` after that
release is what makes the roll permanent · **verified**
2026-09-03 on the host — reproduced (`/api/status` **10.496s** cold, 0.002s
warm; every other Overview endpoint ≤0.7s), then the per-service JSON on the
slow call named the culprit exactly as this entry predicted: **`Google
Calendar: down — fetch failed`**, every other probe ≤211ms.

"No longer reproducing" was wrong; it reproduced on the first try. The chain:

1. The Overview's first paint waited on **all four** endpoints
   (`Promise.allSettled` in `OverviewScreen`, `backoffice/src/screens/overview.tsx`),
   so the page rendered at the speed of `/api/status`.
2. `/api/status` is one `Promise.all` over the probes (`runProbes` in
   `src/backoffice/probes.ts`), so it rendered at the speed of the slowest one.
3. The calendar probe (`pingCalendar` in `src/backoffice/cli.ts`) needs a
   service-account token from **`oauth2.googleapis.com`** (`accessToken` in
   `src/tools/calendar-client.ts`). Google serves that name as a **single A
   record with a ~200s TTL that rotates** across its `*-in-f95.1e100.net` pool
   (seen: 142.250.31.95 → 172.253.63.95 → 192.178.218.95 → 142.251.111.95),
   whereas `www.googleapis.com` answers 8 stable IPs.
4. The egress refresh (`refresh` in `infra/egress/nftables.sh`, every 15 min on
   `hh-egress.timer`) **flushed** the `allowed4` set and re-added whichever
   single answer it got. The container then resolved the *next* answer and its
   SYNs were dropped — `journalctl -k` showed 7 retransmits to
   `172.253.63.95:443` per call, and 14 drops to that IP + 7 to
   `192.178.218.95` over 7 days, while the set held only `142.250.31.95`.
5. 7 SYN retries ≈ 10s; undici's default 10s connect timeout then rejects with
   `fetch failed`. The old 12s `PROBE_TIMEOUT_MS` never fired first. Hence
   **10.5s, every time** — the number both earlier observations recorded.

Why it looked intermittent: the calendar client caches the token for ~59 min.
An exchange that happens to land while DNS and the set agree makes every
calendar call fast for an hour (the "447ms" fast-path readings); once the token
expires and the current answer is not in the set, nothing gets cached and
*every* cold `/api/status` costs 10.5s until DNS rotates back. Restarts and
deploys were never the variable — the earlier "container-scoped warming" and
"not in this repo's code" framings are withdrawn.

Fixed at all three layers, each with a failing test or on-host proof first:

- **Egress (root cause):** `refresh` no longer flushes — it re-adds the current
  answers on top of the loaded set, so the set accumulates every answer seen in
  the last hour and ages the stale ones out. `hh-egress.timer` runs every
  **3 min** (inside the 200s TTL) instead of 15. ⚠️ This bullet originally also
  claimed that "re-adding refreshes an element's 1h timeout in place (proven on
  the host kernel, 6.17, with a scratch table: `timeout 10m` → re-add →
  `expires 59m59s`)". **That claim is false** — see the third finding below.
  The scratch-table reading was never reproduced against the live set and is
  withdrawn; the accumulate behaviour above is unaffected.
  **Second finding, same day, from the first roll:** the set still did not
  accumulate — `held` equalled `resolved` on every tick and all elements
  carried one expiry. The journal showed why: **`hh-egress.service` (the full
  `apply`, table delete + rebuild) ran 1s before every refresh tick**, because
  `infra/egress/hh-egress-refresh.service` had `Wants=hh-egress.service` and
  the apply unit is a oneshot without `RemainAfterExit` (always "inactive"
  between runs, so `Wants=` re-runs it). So the V2_NOTES §11 claim that the
  apply is "boot-only" and refresh has "no fail-open window" was never true
  on the host — every 15-min tick deleted the table. Fixed by dropping the
  `Wants=` (the `After=` alone gives the boot ordering); `RemainAfterExit=yes`
  on the apply unit was rejected because the deploy re-applies with
  `systemctl start`, which would then be a silent no-op.
  **Third finding, 2026-09-04 — the accumulate never survived the hour.**
  Investigating a burst of 13 egress drops at 2026-09-03T23:55Z to four
  Hetzner addresses showed they were `hc-ping.com` / `healthchecks.io` — the
  **dead-man ping**, already allowlisted (`deadman`), dialled by the spine
  container `172.19.0.2`. The set held all four *at the time of the check*, and
  the timer was healthy, so the drop was not a policy gap: **`nft add element`
  does not restart the timeout of an element the set already holds.** Upstream
  is explicit that only the packet-path `update` operation refreshes a previous
  element timeout while `add` does not, and the live set agrees — 47s after a
  successful `refreshed allowed4 (+48 addresses resolved, 312 held)` tick at
  01:15:28Z, the four addresses read `expires 43m`, not 60m, and counted
  monotonically down through the next tick (43m03s at 01:16:15Z → 41m53s at
  01:17:24Z). So every element died exactly 1h after its **first** insertion
  and stayed dropped until a later tick re-created it: an ~hourly outage window
  one tick (≤3 min) wide. Drop windows 22:00Z, 23:55Z and 00:57–00:59Z — ~62
  min apart — and the spine log carried the matching `[deadman] ping failed:
  fetch failed`. It bit **stable** addresses hardest: a rotating name keeps
  producing new answers that enter as new elements with a full hour, whereas
  `hc-ping.com`'s four A records never change. The 3-day drop tally shows the
  same mechanism against Google (`172.253.63.95`, `142.250.31.95`) and Meta
  (`57.144.75.32`, `31.13.66.56`), and `allowed_nets4` (the static S3 backup
  CIDRs) was exposed identically. Fixed by making `refresh` emit
  **delete-then-add in one atomic `nft -f` batch** (`render_refresh_batch` /
  `refresh_set_elements` in `infra/egress/nftables.sh`); a batch is a single
  kernel transaction, so the element is never observably absent and the reset
  opens no drop window of its own. An empty resolve leaves the set untouched
  rather than rewriting it. The `renderBatch` cases in
  `tests/unit/egress-refresh.test.ts` pin the batch shape and the `refreshSet`
  cases pin what the function actually hands nft, both driving the script's
  `HH_EGRESS_LIB` source-only seam so they need no nft and no kernel — 11 cases,
  each guard verified RED by mutation on 2026-09-05 (disabling the delete fails
  4; removing the empty-resolve guard, the unreadable-set failure, the element
  validation, the trailing newline or the seam note each fail their own case).
  **Hardened 2026-09-05 after review of this PR**, all three closing the same
  class — a refresh that looks healthy while doing the wrong thing: (1) a
  failed `nft list set` is now a **hard failure** instead of being swallowed
  into an empty snapshot, which would have emitted no deletes and silently
  degraded the tick back to the add-only refresh this entry is about, still
  printing "refreshed …" and exiting 0; (2) every element is matched against an
  anchored IPv4/CIDR pattern before it can enter a batch, since `nft -f` reads
  a command language rather than an argv slot and the S3 ranges arrive as
  remote JSON (not attacker-reachable today — this keeps it so); (3) the
  `HH_EGRESS_LIB` seam announces itself on stderr, so the var leaking into the
  refresh unit's environment cannot turn the timer into a silent exit-0 no-op.
  **Rolled to the host 2026-09-04 01:32 UTC** (hand-copied over
  `/home/hh/hh-assistant/infra/egress/nftables.sh`, which was byte-identical to
  `origin/main` first — no local drift overwritten; prior file kept as
  `nftables.sh.bak-20260904`; the systemd units are unchanged by this fix).
  **Verified on the host:** the element timeout now resets, where before it
  decayed straight through every tick — `hc-ping.com` read `expires 27m53s` two
  minutes after the 01:29:18Z tick, and `expires 59m59s816ms` immediately after
  the first refresh on the new script. Then a clean sawtooth across three
  consecutive timer ticks (01:36:15Z, 01:39:18Z, 01:42:18Z): 59m23s → 58m23s →
  57m23s → **59m28s** → 58m28s → 57m28s → **59m31s** → … → **59m31s**. Over the
  37 min to 02:09:22Z: **0** `hh-egress-drop` entries — including across the
  ~01:57–02:00Z slot where the ~62-min cluster was next due — **0** refresh-unit
  failures, **0** `[deadman] ping failed` lines (they had been recurring), no
  `applied table` line before any `refreshed` line, and `held` still growing
  across ticks (299 → 315 → 320 → 323), so the accumulate behaviour survived
  the change. ⚠️ That hand-copied host file is the **2026-09-04 revision** —
  the delete-then-add fix as verified above, but *without* the 2026-09-05
  hardening; the three hardening items change only failure paths the sawtooth
  never exercised, so the host's behaviour is unchanged, and the release
  carrying this PR (or another hand-copy) supersedes it.
  **Host roll:** all three files are copies under `/etc/systemd/system` /
  the host checkout, so the durable path is `sudo bash
  infra/host/reconcile-host-config.sh` on the host after the release lands
  (the deploy's `git checkout --force` brings the script itself). Interim
  roll straight from the branch, 2026-09-03: script + timer installed 21:58
  UTC (`refreshed allowed4 (+47 addresses resolved, 55 held)`, timer at 3
  min), cold `/api/status` re-timed at **0.451s** with Google Calendar
  operational 439ms; the refresh-unit fix was found after that and rolled the
  same way at 22:55 UTC. Verified across a timer tick at 22:59: `refreshed
  allowed4 (+48 addresses resolved, 83 held)` with NO `applied table` line
  before it, `allowed4` holding both rotation answers (`142.250.31.95`,
  `172.253.63.95`), 0 egress drops in 10 min, cold `/api/status` **0.76s**.
  Verify after any future roll: the journal shows NO "applied table" line before a
  "refreshed" line, `held` grows past `resolved` across ticks, the container's
  current `oauth2.googleapis.com` answer is in `nft list set inet hh_egress
  allowed4`, and a cold `/api/status` is <1s. Since the third finding, also:
  a **resolved** element's `expires` must go back UP across a tick — read
  `nft list set inet hh_egress allowed4` for `hc-ping.com`'s addresses before
  and after a refresh; ~60m after each tick is the fix working, a monotonic
  countdown is the bug back. And 24h of `journalctl -k | grep hh-egress-drop`
  should show no hourly cluster.
- **Server:** `PROBE_TIMEOUT_MS` 12s → **3s** (`src/backoffice/probes.ts`), so a
  dropped SYN costs 3s and reads `down · timeout` rather than 10.5s and `fetch
  failed`. `tests/unit/backoffice/probes.test.ts` pins it with a hanging ping
  under fake timers.
- **UI:** each Overview card loads on its own `useSection` hook
  (`backoffice/src/screens/overview.tsx`); spend, approvals and recent turns
  paint as they land and only the status-backed cards show "Loading…".
  `backoffice/src/screens/overview.test.tsx` renders with a never-resolving
  `/api/status` and asserts the rest of the page is there.

Same-class side finding: the same 7-day drop log's top entries (57 drops) are
`57.144.75.32` / `31.13.66.56` = `whatsapp-cdn-*.fbcdn.net`, the WhatsApp media
CDN rotating the same way. Those addresses still led the 3-day tally on
2026-09-04, i.e. the accumulating refresh alone did **not** cover them — the
third finding above explains why, and its fix is what should. Worth confirming
media downloads in the spine log after that roll.

### 9. Backoffice charts — the two things the new chart layer can't reach yet
**Status:** open · **verified** 2026-08-10 by reading `makeCostClient` in
`src/backoffice/cost.ts` and `getLogs` in `src/backoffice/journal.ts` while
porting the console's charts to TanStack Charts
(`worktree-backoffice-tanstack-charts`; frontend `lint`/`build`/`test` green,
52 tests after merging main).

Distinct from item 7, and not in tension with it: that item was about the reads
being **broken and slow** and is fixed. This one is about how far back they can
*see* at all, which the v2 rewrite did not change — `makeCostClient` still
builds the same fixed 30-slot series it did before.

The chart layer landed and every hand-rolled widget is replaced, but two limits
are in the **server**, not the charts, so they were deliberately left alone:

| | Limit | Where |
|---|---|---|
| **lookback** | `/api/costs` takes no parameters and builds a fixed 30-slot daily series; `/api/logs` takes only `?limit` (≤200, always newest-first), so its level/search filters are client-side over a truncated window | `makeCostClient` · `getLogs` |
| **retention** | every token/cost figure comes from Langfuse Cloud. **Confirm the plan**: Hobby keeps a 30-day access window, Core 90 days, Pro 3 years. On Hobby, 30 days is all the cost history that exists anywhere — no API change reaches further back | `makeCostClient` in `src/backoffice/cost.ts` |

Journal-backed charts (turn volume, outcome, latency) have no such ceiling —
`dbos.workflow_status` is local and complete — but they currently render only
the fetched window because the endpoint can't be asked for more.

The durable fix for cost history is small and was scoped but **not built**
(schema changes are ask-first): `makeCallModel` in `src/agent/call-model.ts`
already reads exact per-call usage (input / output / cache-read / cache-write)
and hands it to `tracer.onModelUsage` in `src/main.ts` alone — nothing persists
it. An append-only `model_usage` row written inside the turn's existing
transaction would give unbounded history *and* retire the "estimated" label,
since the caller knows the model name that Langfuse lacks (the gap BO-8
recorded). `makeVoyageEmbedder` in `src/memory/embedder.ts` reports Voyage usage
through the same shape of `onUsage` hook and is likewise dropped, so the Costs
total under-reports by the whole embedding line.

Also unbuilt for the same reason: the Status screen's uptime strip and probe
latency trend need probe results persisted — `ServiceRow` carries latency and
uptime as *strings*, and no history exists to chart.

---

## Newly unblocked by going public (2026-07-14)

- **Branch protection is now available.** GitHub provides it free on *public*
  repos; it was unavailable while private, which is why `CLAUDE.md` says red CI
  is merge-blocking "by discipline." Worth enabling and then updating
  `CLAUDE.md`. *(Unverified against the live repo settings — 2026-07-21.)*
- **§1 README badge automation** — the private-repo badge workarounds can now be
  replaced with standard shields. Low value, low effort.
- **Phase E SSH hardening** was downgraded to post-flip defense-in-depth, and
  the host gaps are enumerated in the archived go-public spec: no `fail2ban`,
  no `AllowUsers`/`AllowGroups` scoping, host ingress firewall inactive (the SG
  is the sole gate). The host is key-only (`passwordauthentication no`,
  `permitrootlogin no`), so this is bot-noise and zero-day surface, not a
  credential-compromise risk. **That gap list is public regardless** — it is in
  git history at `0b4f008` — so closing the gaps is the real mitigation.

## Passive — no action needed

- **§6** — the initdb-bake / `hh_backup` role migration applies itself on the
  next full rebuild. Backups are otherwise fully wired on prod (timers enabled,
  freshness dead-man green, old crontab retired, 2026-06-28).
- **§3** — one-line confirmation that a release deploy log shows
  `secrets: .env materialized from ssm`. v2.2.8 deployed successfully
  2026-07-14, so the log exists; it just needs eyeballing.

## Watch list (from the `TASKS.md` deferred-decisions ledger)

- **#7** — kill-mid-flight flake under load. **No longer unreproduced:**
  it recurred in CI 2026-08-03 — run `30834016384` **attempt 1** (PR #38) —
  this time in the `handleTurn skeleton (T22)` suite in
  `tests/integration/handle-turn.test.ts`, not T19's file. Cite the attempt,
  never the run: the re-run below overwrote the run-level conclusion, so that
  run id now reports *success* and only attempt 1 still carries the failure.
  The mid-flight
  child never produced its first effect ("condition not met within 30000ms"),
  and because that test runs first *by design* (it must observe a PENDING
  workflow before `DBOS.launch()` triggers recovery), its failure meant launch
  never happened and the other 22 tests in the file cascaded with
  "`DBOS.launch()` must be called before running workflows". One re-run went
  fully green with no code change. Two things to carry: the blast radius is
  the **whole file**, not one test, so this reads far worse than it is; and
  the flake is not T19-specific. Watch in `test:recovery`.
- **#13** — `semantic.test.ts` "empty store" test races parallel suites on the
  shared dev DB. Fix if it recurs.
- **#16** — dev/prod prompt divergence on sender attribution; resolved for the
  gate (eval runs `makeProductionSystemPrompt`, 8/8). Full reconciliation is
  optional cleanup.
