# Go-Public Spec — `shem86/hh-assistant` private → public

Status: **DRAFT — awaiting approval.** Owner: Shem. Created 2026-07-13.

This is a one-time operational spec for flipping the repo from private to
public safely. It is *not* a build spec and does **not** touch the locked
`SPEC.md`. It is grounded in a full pre-publication audit of the working tree
and the entire git history (310 commits, 45 branches, `git log -p --all`).

---

## 1. Objective

Take `shem86/hh-assistant` public as a **clean showcase** of a production-grade
agentic system, without (a) leaking any credential, or (b) needlessly widening
the live prod host's attack surface.

**Audience:** engineers evaluating the work + the builder's own learn-in-public
record. The architecture and reasoning are the value; the host-specific ops
journal is not.

**Key audit finding (drives the whole approach):** there are **zero real
secrets** in the tree or anywhere in history — every key-shaped string is a test
fixture, no `.env` was ever committed, no Baileys session state was ever tracked.
**Therefore no git-history rewrite is required.** The remaining work is
presentation, hygiene, and one deliberate security hardening step, all against
`HEAD` on a normal branch → PR → merge, then flip the GitHub visibility switch.

**Non-goals:** rewriting history; rotating credentials (none are exposed);
purging the non-secret AWS/host identifiers (decision: accept them — see §6).

---

## 2. Commands / execution steps

Ordered. Each is a discrete, reviewable unit. Nothing here flips visibility
until §5 acceptance passes.

**Phase A — Hygiene (safe, mechanical)** — ✅ DONE
1. ✅ Added `LICENSE` at repo root: **MIT**, `Copyright (c) 2026 Shem Mahluf`.
2. ✅ Added `.DS_Store` to `.gitignore` (was untracked but un-ignored).
3. ✅ `README.md` — **assessed, no change needed.** It already frames the repo as
   a personal, live, learn-in-public system with no secrets. Deliberately did
   **not** add a "the host is firewalled, don't attack it" note: naming/pointing
   at the prod IP in the README advertises the target — worse than silence. The
   real control is Phase E hardening, not a disclaimer.

**Phase B — Targeted redactions (identifying data, not topology)**
4. ✅ **DONE.** `docs/ops-drills.md:142` — removed the real WhatsApp **group JID**
   `120363426855017212@g.us`. The prose already names it "the household test
   group," so dropping the raw JID and keeping that label preserves the drill's
   meaning with no awkward placeholder and no lost information. Confirmed it was
   the only occurrence in the repo.
5. ✅ **DONE.** The two oddly-specific `@lid` values in `send-class.test.ts` and
   `transport-protocol.test.ts` were replaced with clearly-synthetic values
   (`100000000000001@lid`, `100000000000002@lid`) rather than investigated —
   the assertions only exercise format/routing, so the digits are semantically
   irrelevant and the swap is behavior-preserving. Removes the real-vs-fake
   question permanently. `pnpm lint` clean, 505 unit tests pass. (Also renamed a
   test from "accepts a *real* @lid" → "well-formed" to drop the misleading word.)

**Phase C — Showcase readability** — ✅ DONE (light-touch, revised from original plan)
6. ✅ **Reading-note headers only; no body content removed.** The original plan
   was to gut host-specific narrative. Reading the four target docs revised that:
   - `TASKS.md` — T-numbers are indexed by commit messages **and code comments**
     (CLAUDE.md); trimming entries breaks that "why" trail.
   - `V2_NOTES.md` — its own header declares section numbers are **stable anchors
     that code comments and systemd units reference as `V2_NOTES §N`**;
     restructuring breaks live references. (§10 *is* the going-public gate.)
   - `docs/ops-drills.md` — the drill logs are the evidence behind the reliability
     story the README advertises.
   - `docs/backoffice-tasks.md` — kept as-is (owner decision): forward-planning
     for the Phase-3 backoffice; non-secret.

   Combined with the *accept-identifiers* topology decision (§6), there was no
   sensitive-data reason left to trim — only working-ledger verbosity, whose
   removal is low-value (history keeps every word — not rewritten) and risks the
   T-number/§N cross-references. So Phase C became a **light-touch** pass: a brief
   "reading note" added atop `TASKS.md` and `V2_NOTES.md` orienting a public
   visitor (these are raw working ledgers; start at README/SPEC) without removing
   any body content or disturbing any anchor. Decisions confirmed with owner.

**Phase D — Branch hygiene** — ✅ DONE (2026-07-13)
7. ✅ Pruned. After `git fetch --prune`, the real count was **23** (not 45 —
   stale). Deleted **21**: 18 fully merged into `main` (zero risk — content is in
   `main`, GitHub retains PR history) + 3 unmerged-but-superseded
   (`v2-s4-host-node-egress` superseded by merged `v2-s4-host-node-clean`;
   `worktree-readme-refresh` landed another way; `claude/agent-message-indication-ulfmlf`
   an unadopted `🤖`-on-wire experiment). Remote now holds only `main` and the
   active PR branch `worktree-go-public-spec` (deletes on merge). Owner approved
   the full prune.

**Phase E — SSH hardening — DEFERRED to future hardening (not a pre-flip gate)**
8. **Assessed 2026-07-14 (read-only). The host is already key-only, so the flip
   creates no urgent hole — Phase E is downgraded from a hard pre-flip gate to
   post-flip defense-in-depth.**

   *Current-state assessment (only the SSH surface — WhatsApp is unaffected; it
   runs over an outbound socket the host initiates, governed by the egress
   allowlist, not by any ingress rule):*
   - **Security group `sg-058d22ff56c01a528`** — its **only** ingress rule is TCP
     **22 open to `0.0.0.0/0`**. No inbound HTTP/HTTPS or WhatsApp rule at all
     (app is outbound-only + Tailscale for the backoffice).
   - **`sshd` effective config** — `passwordauthentication no`,
     `pubkeyauthentication yes`, `permitrootlogin no`,
     `kbdinteractiveauthentication no`, `permitemptypasswords no`,
     `maxauthtries 6`. **Key-only; no password vector to brute-force.**
   - **Gaps:** `fail2ban` not installed; host ufw/nft ingress inactive (SG is the
     sole gate); no `AllowUsers`/`AllowGroups` scoping.

   *Why deferring is safe:* with password auth off, a world-open port 22 is not a
   credential-compromise risk — only a holder of a valid private key gets in.
   Residual risk from publishing the IP is bot noise on 22, an OpenSSH-zero-day
   surface, and a future misconfig going instantly internet-facing.

   *Chosen future hardening (owner decision 2026-07-14):* **SSH over Tailscale,
   then close public port 22.** Tailscale is already on this host (backoffice), so
   move admin SSH onto the tailnet and remove the `0.0.0.0/0` rule → the public IP
   becomes fully inert (zero inbound). **Sequencing to avoid lockout:** verify
   tailnet SSH end-to-end *before* removing the SG rule; keep a break-glass path
   (SSM Session Manager / EC2 serial console) ready. Live-prod work, **ask-first**
   on any SG or sshd change, and best done with the operator at the keyboard.
   Does **not** touch egress, so WhatsApp connectivity is unaffected throughout.

**Phase F — Flip visibility (irreversible-ish; do last, explicit go)**
9. After §5 acceptance passes and with explicit user go-ahead:
   `gh repo edit shem86/hh-assistant --visibility public --accept-visibility-change-consequences`
   (or via GitHub Settings UI). Confirm the repo is public and CI/CD still green.

---

## 3. Project structure — what changes

Files **added:**
- `LICENSE` (MIT)

Files **edited:**
- `.gitignore` (+ `.DS_Store`)
- `README.md` (public framing)
- `docs/ops-drills.md` (JID redaction + prose trim)
- `TASKS.md`, `V2_NOTES.md`, `docs/backoffice-tasks.md` (prose trim)
- `tests/unit/send-class.test.ts`, `tests/unit/transport-protocol.test.ts` (only
  if `@lid` values prove real)

**Load-bearing identifiers that STAY (do not touch — they are functional config,
not disclosure to scrub):**
- Instance ID `i-0a7e9f4767666ac9e` in `.github/workflows/deploy.yml:25`
- SSM path `/hh-assistant/ghcr-pat` in `deploy.yml` and Pulumi cloud-init
- AWS account ID / ARNs / bucket names in `infra/pulumi/Pulumi.prod.yaml`,
  `infra/pulumi/components/host-environment.ts`, `.env.example:71`
- GHCR image path `ghcr.io/shem86/hh-assistant` (inherent to a public repo)
- EIP/SG/AMI IDs in `infra/host.md` (reference config)

Rationale: these are non-secret identifiers the deploy/IaC actually depends on;
removing them breaks the pipeline for cosmetic gain, and they'd remain in history
anyway. Decision (§6) is to accept them and harden instead.

---

## 4. Style / conventions for this work

- **Redaction placeholder style:** clearly-synthetic, self-describing tokens
  (`<household-group-jid>`), never a real-looking substitute that could be
  mistaken for live data.
- **Prose trim:** delete or condense; do not rewrite meaning. Preserve the
  architecture-and-decision content that is the showcase's value. When in doubt
  about whether a paragraph is "narrative minutiae" vs "load-bearing rationale,"
  keep it.
- **Honesty about history:** any PR/commit message for Phase C states plainly
  that the trim is presentation-only and history retains prior values — no
  implication that redaction-in-HEAD removes anything from the public record.
- Each phase is its own commit with a clear message; the whole set lands as one
  reviewable PR (this doc's branch) *except* Phase E (host) and Phase F (flip),
  which are actions outside the PR.

---

## 5. Verification / acceptance criteria

Publication is gated on ALL of these passing:

1. **Secret re-scan clean:** re-run a secrets scan over the tree (and spot-check
   history) — 0 real credentials. (Baseline audit already 0; this is a
   regression guard after edits.)
2. **`pnpm lint && pnpm test` green** after any test-file edits (Phase B) — the
   `@lid` changes must not break unit tests.
3. **LICENSE present** and correct (MIT, right name/year).
4. **WhatsApp group JID gone** from the tree (`git grep 120363426855017212`
   returns nothing).
5. **`@lid` values confirmed** synthetic or replaced.
6. **Branch keep-list applied** — remote branch list reviewed, stale ones
   deleted, survivors are intentional.
7. ✅ **SSH surface assessed and posture recorded** (Phase E) — host is key-only,
   so this is **no longer a pre-flip gate**; the Tailscale-only hardening is
   deferred to post-flip defense-in-depth.
8. **Explicit user go-ahead** for the visibility flip (§2 Phase F).
9. **Post-flip:** repo confirmed public, CI green, deploy pipeline still
   functional (GHCR/SSM unaffected by visibility).

---

## 6. Boundaries

**Always:**
- Keep the flip (Phase F) last and behind an explicit go-ahead — it is
  outward-facing and hard to walk back (clones/caches/indexers).
- Re-run `pnpm lint && pnpm test` after touching any test file.
- State plainly, in commits and to the user, that no history rewrite is done and
  history retains prior identifier values.

**Ask first:**
- Any change to the prod security group `sg-058d22ff56c01a528` or SSH config on
  `98.91.67.226` (Phase E) — this is live prod.
- Deleting any remote branch (Phase D) — confirm the keep-list with the user.
- The visibility flip itself (Phase F).

**Never:**
- Rewrite git history for this task (decision: unnecessary — no secrets — and
  disruptive). If a *real* secret is ever found, that overrides this and history
  surgery + rotation becomes mandatory before any flip.
- Remove load-bearing identifiers from deploy/IaC config for cosmetic reasons
  (§3) — breaks the pipeline for no security gain.
- Flip to public with `pnpm lint && pnpm test` red. (The SSH surface being
  world-open is acceptable at flip time *only because* auth is key-only — if that
  ever regresses to password auth, hardening becomes a hard gate again.)
- Treat the prose trim as a security control — it is presentation only.

---

## Appendix — audit provenance

Full pre-publication exposure audit (2026-07-13) covered working tree + entire
history via `git log -p --all` (310 commits, 45 branches), added/deleted-file
diff-filter, secret-pattern scan, and infra-identifier grep. Result: 0 hard
blockers (no secrets), several accept-vs-redact exposure decisions (resolved in
§2/§6), 1 hygiene gap (no LICENSE). The identifier locations enumerated in §3
come from that audit.
