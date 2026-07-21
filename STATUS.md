# STATUS — what's open right now

**Last full reconcile: 2026-07-21** (validated against `git log`, `gh`, and the
source tree — not against the other docs). Secret scan clean the same day
(see Open item 2).

This is the **single source of truth for current state**. Everything else is
history:

| File | Role |
|---|---|
| [`STATUS.md`](STATUS.md) *(this file)* | **Current state.** Rewritten freely. The only file that asserts what is open. |
| [`V2_NOTES.md`](V2_NOTES.md) | Append-only ops journal. `§N` anchors are stable and referenced from code + systemd units. Its heading markers are historical. |
| [`TASKS.md`](TASKS.md) | v1 build ledger, complete. T-numbers are stable anchors. |
| [`docs/adr-*.md`](docs) | Decisions. Immutable once Accepted. |
| [`docs/known-issues.md`](docs/known-issues.md) | Per-defect deep records (both entries currently RESOLVED). |
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
5. **Cite symbols, never line numbers.** `the wasSentByBot: () => false wiring
   in src/main.ts`, not `src/main.ts:431`. Earned immediately: this file shipped
   2026-07-21 citing four line numbers, and PR #35 (socket-drop diagnostics)
   invalidated all four the *same day* — `main.ts:431`→446,
   `baileys.ts:142`→162, `:305`→345, `:228`→268. The facts were still true; only
   the pointers rotted. A grep-able symbol survives every refactor above it.

---

## Open

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

Production passes a hardcoded constant — the `wasSentByBot: () => false` wiring
in `src/main.ts`. The real suppression is an **in-memory ring buffer**: the
`sentIds = new RecentIds(SENT_ID_CAPACITY)` in `src/transport/baileys.ts`,
populated by `sentIds.add(messageId)` on send and consulted by `sentIds.has(id)`
on inbound — so it is **lost on restart**. The `IngestionDeps.wasSentByBot` seam
(declared and checked in `src/orchestration/ingest.ts`) is therefore dead code in
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
