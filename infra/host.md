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
   ~2025-09-30 (budget start date), so credits expire **~2026-09-30**
   (12-month rule) — exact date to be confirmed in console Billing →
   Credits. Credits are expiry-bound, not exhaustion-bound, at this burn
   rate — so sizing generously is free.

## Accepted trade-off: the ~Sep 2026 decision point

Credits cover ~3.5 months. When they expire, this box bills ~**$31/mo**
(t3a.medium ~$25 + EBS ~$2.5 + IPv4 $3.65) — 4–7× Hetzner. The standing
plan: **migrate to Hetzner CX23 before credit expiry** (~Sep 2026), using
the T44 runbook — host loss is a drilled scenario: restore base backup +
WAL into fresh Postgres, re-pair WhatsApp (NEVER restore Baileys session),
reconcile via sent_log + deterministic calendar ids. The existing
zero-spend budget is the tripwire: actual spend stays ~$0 while credits
cover, so its first alert ≈ credits stopped covering. Calendar reminder for
mid-Sep 2026 recommended regardless.

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
  on the builder's Mac — never in repo or backups)
- Budget: pre-existing "My Zero-Spend Budget" ($1/mo) doubles as the
  credit-expiry tripwire (see above)

### Remaining builder steps (then tick T15)

1. First-login baseline (user `ubuntu`): create `hh` user + copy key,
   sshd drop-in (`PasswordAuthentication no`, `PermitRootLogin no`),
   `apt upgrade` + `unattended-upgrades`, hostname `hh-assistant`
   (TZ stays UTC deliberately — reminders anchor Eastern in config).
   Verify key-only login as `hh` before closing the root-capable session.
2. Console Billing → Credits: record the exact credit expiration date here:
   - Credit expiry: _pending_
3. Drop a calendar reminder ~2 weeks before expiry for the
   migrate-vs-pay call.

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
