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

**Phase A — Hygiene (safe, mechanical)**
1. Add `LICENSE` at repo root: **MIT**, `Copyright (c) 2026 Shem Mahluf`.
2. Add `.DS_Store` to `.gitignore` (currently untracked but un-ignored).
3. `README.md` — pass for public first-impression: what the project is, that it
   is a personal/learning project, architecture pointer, and an explicit "this
   documents a real deployment; operational identifiers shown are for a host
   that is firewalled — do not treat as an invitation" note. (Light edit; keep
   scope tight.)

**Phase B — Targeted redactions (identifying data, not topology)**
4. `docs/ops-drills.md:142` — replace the real WhatsApp **group JID**
   `120363426855017212@g.us` with a fabricated placeholder
   (`<household-group-jid>` or a clearly-synthetic value), preserving the
   drill's meaning.
5. `tests/unit/send-class.test.ts:30,327` (`232155984703662@lid`) and
   `tests/unit/transport-protocol.test.ts:120` (`67427329167522@lid`) —
   **verify** these are synthetic. If either is a real linked-device ID, replace
   with a fabricated value in the same shape and re-run the affected unit tests.
   If confirmed synthetic, leave and note it in the PR.

**Phase C — Showcase prose trim (presentation only)**
6. Trim **incidental** host-specific operational narrative from prose docs so the
   repo reads as a project, not an ops diary: the long host-build/firewall/IMDS
   detail in `TASKS.md` (esp. T44/T45), `V2_NOTES.md`, `docs/ops-drills.md`,
   `docs/backoffice-tasks.md`. Keep architecture and rationale; cut the
   step-by-step host minutiae and incidental identifier mentions in prose.
   **Load-bearing identifiers stay** (see §3) — they are config, not narrative.
   Explicitly acknowledged: because history is not rewritten, this trim improves
   *readability at HEAD only*; it does not hide anything already in history, and
   the spec does not pretend otherwise.

**Phase D — Branch hygiene**
7. Review the 45 remote branches. Delete stale/experimental/WIP remote branches
   that shouldn't be publicly visible. Every surviving branch's full history
   goes public — so this is a conscious keep-list, not a default.

**Phase E — Security hardening (the one real security action)**
8. Harden the SSH surface on `98.91.67.226` *before* flipping public, since the
   public IP + `ubuntu` login user become known: confirm key-only auth (no
   passwords), restrict inbound SSH in security group `sg-058d22ff56c01a528` to
   known source IPs (or move to SSM-only / no public SSH if feasible), and
   confirm `fail2ban`/equivalent or that SSH isn't broadly exposed. Record the
   resulting posture. **This is host work, done via `ssh ubuntu@98.91.67.226`
   (see host-sudo memory) or the AWS console — ask before changing prod SG
   rules.**

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
7. **SSH surface hardened** (Phase E) and its posture recorded — this is a
   pre-flip gate, not a post-flip nicety.
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
- Flip to public with `pnpm lint && pnpm test` red, or with the SSH surface
  unhardened.
- Treat the prose trim as a security control — it is presentation only.

---

## Appendix — audit provenance

Full pre-publication exposure audit (2026-07-13) covered working tree + entire
history via `git log -p --all` (310 commits, 45 branches), added/deleted-file
diff-filter, secret-pattern scan, and infra-identifier grep. Result: 0 hard
blockers (no secrets), several accept-vs-redact exposure decisions (resolved in
§2/§6), 1 hygiene gap (no LICENSE). The identifier locations enumerated in §3
come from that audit.
