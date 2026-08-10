# STATUS — what's open right now

**Last full reconcile: 2026-07-21** (validated against `git log`, `gh`, and the
source tree — not against the other docs). Secret scan clean the same day
(see Open item 2).

**Partial update 2026-08-05:** live-host check only (container logs + Postgres).
Added Open item 0 — **production is down** — and four defect records to
`docs/known-issues.md`. Items 1–5 below were not re-verified on this pass and
still carry their 2026-07-21 dates.

**Partial update 2026-08-10:** item 0 **resolved** — ezra is back up on
`v2.3.0`, verified live on the host. Items 1–5 still carry their 2026-07-21
dates and were not re-verified on this pass either.

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
   enforcing that today (see below), so it is discipline.

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

Production passes a hardcoded constant: `src/main.ts:431` →
`wasSentByBot: () => false`. The real suppression is an **in-memory ring
buffer** — `src/transport/baileys.ts:142` (`RecentIds`), populated at `:305`,
consulted at `:228` — which is **lost on restart**. The `IngestionDeps.wasSentByBot`
seam (`src/orchestration/ingest.ts:56`, checked at `:88`) is therefore dead code
in prod. `sent_log` exists but is wired only to send-class dedup, not the echo
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

### 6. Backoffice auth lockout — fixed on a branch, not yet deployed
**Status:** open (awaiting deploy) · **verified** 2026-08-10 by reproducing it
against live prod (`curl` over the tailnet returned
`429 too many attempts — locked out` while the host's own tailnet IP got a
normal `401`), then by the regression suite on
`worktree-backoffice-lockout-fix` (`pnpm lint && pnpm build && pnpm test` green
— 578 unit + 10 backoffice integration).

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

**Deliberately not in that branch** (a UX change to the sign-in flow, worth
landing separately): the SPA shell is still token-gated, so an unauthenticated
visit returns raw JSON instead of a sign-in screen — the only way in is
hand-pasting `?token=` into the URL bar; and the `bo_session` cookie is a fixed
30-day `Max-Age` with no renewal, a recurring cliff whose failure mode is this
incident. Serving the shell publicly (it holds no data; `/api/*` is the real
gate) and renewing the cookie on each success would close both.

### 7. Backoffice charts — the two things the new chart layer can't reach yet
**Status:** open · **verified** 2026-08-10 by reading `src/backoffice/cost.ts`
and `journal.ts` while porting the console's charts to TanStack Charts
(`worktree-backoffice-tanstack-charts`; frontend `lint`/`build`/`test` green,
35 tests).

The chart layer landed and every hand-rolled widget is replaced, but two limits
are in the **server**, not the charts, so they were deliberately left alone:

| | Limit | Where |
|---|---|---|
| **lookback** | `/api/costs` takes no parameters and hard-codes 30 slots (`for (let i = 29; i >= 0; i--)`); `/api/logs` takes only `?limit` (≤200, always newest-first), so its level/search filters are client-side over a truncated window | `src/backoffice/cost.ts:189` · `journal.ts:48,185` |
| **retention** | every token/cost figure comes from Langfuse Cloud. **Confirm the plan**: Hobby keeps a 30-day access window, Core 90 days, Pro 3 years. On Hobby, 30 days is all the cost history that exists anywhere — no API change reaches further back | `src/backoffice/cost.ts` |

Journal-backed charts (turn volume, outcome, latency) have no such ceiling —
`dbos.workflow_status` is local and complete — but they currently render only
the fetched window because the endpoint can't be asked for more.

The durable fix for cost history is small and was scoped but **not built**
(schema changes are ask-first): `call-model.ts:59–62` already reads exact
per-call usage (input / output / cache-read / cache-write) and `main.ts:133`
hands it to the Langfuse tracer alone — nothing persists it. An append-only
`model_usage` row written inside the turn's existing transaction would give
unbounded history *and* retire the "estimated" label, since the caller knows the
model name that Langfuse lacks (the gap BO-8 recorded). `src/memory/embedder.ts:81`
reports Voyage usage through the same shape of hook and is likewise dropped, so
the Costs total under-reports by the whole embedding line.

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

- **#7** — T19 kill-mid-flight flake under triple-suite load (1 in ~9,
  unreproduced). Watch in `test:recovery`.
- **#13** — `semantic.test.ts` "empty store" test races parallel suites on the
  shared dev DB. Fix if it recurs.
- **#16** — dev/prod prompt divergence on sender attribution; resolved for the
  gate (eval runs `makeProductionSystemPrompt`, 8/8). Full reconciliation is
  optional cleanup.
