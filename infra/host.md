# T15 — Host decision + evidence

**Decision (builder call, 2026-06-12): Oracle Cloud PAYG, A1.Flex, home region US East (Ashburn).**
Target $0/mo inside the Always Free window. Hetzner CX23 (below) stays the
pre-made fallback if A1 capacity blocks provisioning or the exemption check
in step 0 fails.

## Re-verification evidence (2026-06-12) and what the builder accepted

Architecture decision 7's rule: Oracle PAYG only if A1 provisions and the
reclamation policy still holds — re-verified the week of provisioning.

1. **Idle reclamation is live in current docs:** "Idle Always Free compute
   instances may be reclaimed by Oracle" — 7-day window, 95th-pct CPU < 20%,
   network < 20%, memory < 20% (A1).
   [Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) (fetched 2026-06-12).
2. **PAYG exemption:** Oracle's reclamation notices and FAQ say reclamation
   targets *Always Free customers only* and that converting to PAYG keeps
   idle instances from being stopped ([archived notice](https://blog.51sec.org/2023/02/oracle-cloud-cleaning-up-idle-compute.html)).
   The current policy doc is silent on account type and the
   [FAQ](https://www.oracle.com/cloud/free/faq/) blocks programmatic fetch —
   **step 0 below captures the FAQ wording in-browser as the missing
   evidence.** This matters here: a two-user agent sits under 20%
   CPU/network forever, so the exemption is load-bearing.
3. **A1 allotment (multiple 2026 sources, consistent):** 3,000 OCPU-hours +
   18,000 GB-hours/month free = **4 OCPU / 24 GB always-on**; 200 GB total
   boot+block storage; 10 TB egress/month. Free limits persist on PAYG —
   billing starts only above them. **Always Free resources provision in the
   home region only** (elsewhere bills at paid rates).
   [Grokipedia summary](https://grokipedia.com/page/Oracle_Cloud_Always_Free_Tier) · [fullmetalbrackets breakdown](https://fullmetalbrackets.com/blog/oci-free-tier-breakdown) · confirm live numbers in the console at create time.
4. **Accepted residual risks** (named in decision 7, accepted by builder
   2026-06-12): exemption lives in FAQ prose rather than the policy doc;
   A1 capacity lottery (much rarer on PAYG); Oracle account-termination
   opacity. Mitigations: step-0 evidence capture; budget alert makes any
   billing drift loud; M2's external dead-man switch detects a
   stopped/reclaimed box within minutes; T17's off-box encrypted backups +
   T44 runbook make host loss a drill, not a disaster.

## Provisioning guide (T15 [H] — builder)

**Step 0 — capture the exemption evidence (before paying anything).**
Open the [Free Tier FAQ](https://www.oracle.com/cloud/free/faq/) in a
browser. Find the idle-reclamation answer; confirm it still says PAYG
(upgraded) accounts' instances are not reclaimed. Paste the exact quote +
date into the evidence block below (screenshot optional, keep off-repo).
If the wording is gone, stop — fall back to Hetzner.

**Step 1 — account.** Sign up at signup.oraclecloud.com.
**Home region = US East (Ashburn) — permanent, cannot be changed**, and
Always Free capacity is home-region-locked. Identity + card verification.

**Step 2 — upgrade to PAYG.** Console → Billing & Cost Management →
Upgrade and Manage Payment → Upgrade to Pay As You Go. Can take up to a
day to process; wait for confirmation before provisioning (the exemption
and the paid capacity pool both hinge on the account class).

**Step 3 — budget tripwire.** Billing → Budgets → create: amount $5,
alert rule at 1% actual + forecast, email. Anything nonzero is a signal
something left the free window.

**Step 4 — create the instance.** Compute → Instances → Create:
- Name `hh-assistant`; image **Canonical Ubuntu 24.04** (aarch64 pairs
  automatically with the A1 shape).
- Shape: Ampere → **VM.Standard.A1.Flex → 4 OCPU / 24 GB** — first confirm
  the console still marks this sizing Always Free (see evidence note 3).
- Networking: create new VCN with the wizard defaults; **assign public
  IPv4**. Default security list (SSH 22 open, key-only) is fine for T15;
  T16 adds the egress allowlist — OCI security lists can enforce it at the
  cloud layer in addition to on-host rules.
- SSH: paste the public half of a fresh `ed25519` keypair (private key
  never leaves the Mac).
- Boot volume: default ~50 GB (≤200 GB free total; plenty — leave headroom).
- If **"Out of host capacity"**: try each availability domain, retry over a
  few hours (PAYG draws on the paid pool, so this is usually brief). If it
  persists past a day or two, that's the pre-made Hetzner trigger.

**Step 5 — first-login baseline** (image default user is `ubuntu`;
everything deeper is T16):
```sh
sudo adduser --disabled-password hh && sudo usermod -aG sudo hh
sudo install -d -m 700 /home/hh/.ssh && sudo cp /home/ubuntu/.ssh/authorized_keys /home/hh/.ssh/ && sudo chown -R hh:hh /home/hh/.ssh
# /etc/ssh/sshd_config.d/10-hardening.conf:
#   PasswordAuthentication no
#   PermitRootLogin no
sudo systemctl restart ssh
sudo apt-get update && sudo apt-get -y upgrade && sudo apt-get -y install unattended-upgrades
sudo hostnamectl set-hostname hh-assistant   # TZ stays UTC deliberately
```
Verify key-only login as `hh` from a second terminal **before** closing the
first session.

**Step 6 — record + close.** Fill the evidence and host blocks below, mark
T15 done in TASKS.md. T16 (hardening + egress) and T17 (backups → B2/R2,
restore drill) proceed against this box; B2-vs-R2 is decided at T17.

**ARM note:** the box is arm64; Node 22, Postgres + pgvector (PGDG), and the
Baileys tree all ship arm64. Dev/CI are x86, so any native-dep weirdness
surfaces only on the box — accepted; the T45 on-host drills are where it
would show.

## Fallback (pre-made): Hetzner CX23

EU-only (fsn1/nbg1), 2 vCPU Intel / 4 GB / 40 GB / 20 TB, €3.99/mo +
~€0.71/mo IPv4 (post-2026-04-01 pricing,
[Better Stack review](https://betterstack.com/community/guides/web-servers/hetzner-cloud-review/)).
US Ashburn floor is CPX22 at €7.99/mo with 1 TB — not worth it; latency is
irrelevant (reminders anchor to Eastern via config, never server time).
Hetzner auto-backups stay **OFF** — a box snapshot captures Baileys session
state and restoring it rolls back the Signal ratchet (SPEC "Never").

## Evidence captured at provisioning (fill at step 0)

- FAQ exemption quote: _pending_
- Quoted on (date): _pending_

## Provisioned host (fill at step 6)

- Provisioned on: _pending_
- PAYG upgrade confirmed on: _pending_
- Instance OCID / name: _pending_
- Shape as created: _pending_
- Public IPv4: _pending_
- Availability domain: _pending_
- Budget alert set: _pending_
