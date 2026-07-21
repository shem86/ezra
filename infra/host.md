# T15 — Host decision + evidence

**Decision (builder call, 2026-06-12): AWS EC2 on free-tier credits — t3a.medium, us-east-1, account `001467466089`.**
Provisioned same day (details below). Supersedes two earlier candidates the
same week: Oracle PAYG (chosen, then dropped when its load-bearing policy
fact failed verification) and Hetzner (the architecture's named fallback,
retained below as the planned post-credits destination).

## Decision trail (all 2026-06-12)

1. **Oracle PAYG** — architecture decision 7's preferred $0 path, conditional
   on week-of verification that PAYG exempts instances from idle
   reclamation. Verification FAILED: the current
   [Always Free docs](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
   still carry the 7-day idle-instance reclamation policy with no account-type
   carve-out, and the current [Free Tier FAQ](https://www.oracle.com/cloud/free/faq/)
   (full text read by builder 2026-06-12) no longer contains the PAYG
   exemption wording at all — its only idle language is a 30-day *account*
   abandonment clause ending in suspension/termination. A two-user agent
   sits under the idle thresholds permanently, so the unwritten exemption
   would have been the only thing keeping the box alive. Dropped per the
   pre-made stop condition.
2. **Hetzner CX23** — the pre-made fallback (~€4.70/mo, fsn1/nbg1, details
   in the fallback section). Recommended; builder chose AWS instead to use
   expiring credits.
3. **AWS on credits** — builder call. Evidence from the account (via CLI,
   2026-06-12): $0.00 spend MTD against the existing "My Zero-Spend Budget"
   ($1/mo); **$134.65 free-tier credits remaining** (new-style post-2025-07
   plan: credits only, NO free instance-hours allowance); account opened
   ~2025-10-29, and credits expire **2026-10-29** (confirmed by builder in
   console Billing → Credits, 2026-06-12). At ~$31/mo the credits exhaust
   ~mid-Oct 2026 — almost exactly when they expire anyway, so generous
   sizing costs nothing either way.

## Accepted trade-off: the ~mid-Oct 2026 decision point

Credits cover ~4.3 months (exhaustion ~mid-Oct ≈ expiry 2026-10-29). After
that, this box bills ~**$31/mo**
(t3a.medium ~$25 + EBS ~$2.5 + IPv4 $3.65) — 4–7× Hetzner. The standing
plan: **migrate to Hetzner CX23 before the credits run out**, using
the T44 runbook — host loss is a drilled scenario: restore base backup +
WAL into fresh Postgres, re-pair WhatsApp (NEVER restore Baileys session),
reconcile via sent_log + deterministic calendar ids. The host baseline on
the new box is one run of `infra/provision-host.sh` (see completion record
below); T16's runtime layer + egress allowlist redeploy on top. The existing
zero-spend budget is the tripwire: actual spend stays ~$0 while credits
cover, so its first alert ≈ credits stopped covering. Calendar reminder for
~2026-10-01 recommended regardless.

Shape rationale: **x86 (t3a) over ARM (t4g)** — both fully covered until
expiry and leftover credits evaporate, so eliminating the ARM variable
(dev/CI are x86; Hetzner migration target is x86) costs nothing.
**Elastic IP** — same price as any public IPv4 while attached to a running
instance; keeps SSH + the T16 egress story stable. **IMDSv2 enforced** at
launch. 4 GB RAM fits Node + Postgres(+pgvector) with headroom; 40 GB gp3
dwarfs the data.

## Provisioned host (2026-06-12, via CLI by Claude under builder authorization)

- Account / region: `001467466089` / us-east-1 (us-east-1d)
- Instance: `i-0a7e9f4767666ac9e` (`hh-assistant`), t3a.medium,
  AMI `ami-0f8a61b66d1accaee` (Canonical Ubuntu 24.04 amd64), 40 GB gp3,
  IMDSv2 required
- Elastic IP: **98.91.67.226** (`eipalloc-0cc8398f5489537b7`)
- Security group: `sg-058d22ff56c01a528` (`hh-assistant-ssh`) — ingress
  tcp/22 from 0.0.0.0/0 only; egress default-open until T16's allowlist
  (SG egress rules give cloud-layer enforcement alongside on-host rules)
- Key pair: `hh-assistant` (ed25519; private key `~/.ssh/hh-assistant-aws`
  on the builder's Mac — never in repo or backups). The host authorizes
  **only** this key, so pin it per-host in `~/.ssh/config`:

  ```
  Host ezra-prod 98.91.67.226
    HostName 98.91.67.226
    User ubuntu
    IdentityFile ~/.ssh/hh-assistant-aws
    IdentitiesOnly yes
  ```

  Placement is load-bearing: ssh tries `IdentityFile`s in the order it
  encounters them, so this block must sit **above** any `Host *` that sets
  one (a `Host *` pinning `~/.ssh/id_ed25519` is a common default and is
  what's on the builder's Mac). Unpinned, a bare `ssh ubuntu@98.91.67.226`
  succeeds only while the agent happens to be holding the key and fails with
  `Permission denied (publickey)` once it doesn't — an *intermittent* failure
  that reads as a host outage rather than local key selection. Verify the fix
  with the agent disabled: `SSH_AUTH_SOCK= ssh ezra-prod` (2026-07-21, cost a
  detour mid-deploy).
- Budget: pre-existing "My Zero-Spend Budget" ($1/mo) doubles as the
  credit-expiry tripwire (see above)

### Builder completion record

1. First-login baseline — **done 2026-06-12** (`hh` user, key-only +
   no-root sshd, apt upgrade + unattended-upgrades, hostname
   `hh-assistant`; TZ stays UTC deliberately — reminders anchor Eastern
   in config). **Codified 2026-06-12 as `infra/provision-host.sh`**
   (idempotent, Ubuntu 24.04, AWS+Hetzner portable) so re-applying it on a
   fresh box is one run — this is the migration tool below. The script is
   the LOGIN/OS baseline only; the application runtime sandbox + egress
   allowlist are T16 (`infra/` compose + host nftables).
2. Credit expiry: **2026-10-29** (console Billing → Credits, read
   2026-06-12).
3. Still open: calendar reminder ~2026-10-01 for the migrate-vs-pay call
   (recommend: book it now).

## Fallback / post-credits destination (pre-made): Hetzner CX23

EU-only (fsn1/nbg1), 2 vCPU Intel / 4 GB / 40 GB / 20 TB, €3.99/mo +
~€0.71/mo IPv4 (post-2026-04-01 pricing,
[Better Stack review](https://betterstack.com/community/guides/web-servers/hetzner-cloud-review/)).
US Ashburn floor is CPX22 at €7.99/mo with 1 TB — not worth it; latency is
irrelevant (reminders anchor to Eastern via config, never server time).
Auto-backups stay **OFF** on any host — a box snapshot captures Baileys
session state, and restoring it rolls back the Signal ratchet
(SPEC "Never"). T17's WAL + base-backup pipeline owns durability and
excludes that state by design. The same rule applies to EBS snapshots of
the AWS box.
