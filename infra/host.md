# T15 — Host decision + evidence

**Decision (2026-06-12): Hetzner Cloud CX23, EU (Falkenstein or Nuremberg), Ubuntu 24.04 LTS.**
~€3.99/mo + ~€0.71/mo IPv4 ≈ **€4.70/mo**. Pending builder confirmation at
provision time (spending money is ask-first); the evidence below is the
re-verification the architecture (decision 7) required the week of
provisioning.

## Why not Oracle PAYG — the verification failed, per the pre-made rule

Architecture decision 7 made the rule: *Oracle PAYG if you can provision A1
and the current reclamation policy still holds; otherwise Hetzner* — and
flagged the PAYG-exempts-from-reclamation claim as "a vendor-policy assertion
to re-verify at provisioning time, not a locked fact."

Re-verified 2026-06-12:

1. **The idle-reclamation policy is live in Oracle's current docs.** "Idle
   Always Free compute instances may be reclaimed by Oracle" when, over a
   7-day window: 95th-percentile CPU < 20%, network < 20%, and (A1 only)
   memory < 20%.
   Source: [Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) (fetched 2026-06-12).
2. **The current docs do NOT state that PAYG accounts are exempt.** The
   exemption claim traces to Oracle's 2023 reclamation-notice emails and FAQ
   wording ("reclaiming idle Always Free compute resources from Always Free
   customers only"; "you can keep idle compute instances from being stopped
   by converting your account to Pay As You Go" — secondhand via
   [51sec.org's archive of the notice](https://blog.51sec.org/2023/02/oracle-cloud-cleaning-up-idle-compute.html)).
   The [official FAQ](https://www.oracle.com/cloud/free/faq/) could not be
   fetched programmatically (403) and the docs page is silent on account
   type. **This is exactly the silent-failure shape decision 7 warned
   about**: the exemption lives in deletable FAQ prose, not the policy doc.
3. **This workload reads as "idle" under Oracle's definition.** A WhatsApp
   socket plus DBOS queue-polling for a two-person household will sit far
   under 20% CPU/network/memory essentially every week of its life. The
   exemption is therefore load-bearing, not theoretical — if it quietly
   stops applying, the box hosting a live Baileys session gets reclaimed,
   and Baileys session loss means re-pair (never restore) plus reconnect
   churn, the exact ban-signal the architecture works to avoid.
4. **Residual Oracle frictions still present (2026 reports):** A1 "out of
   host capacity" remains a known provisioning lottery in popular regions
   (PAYG improves but does not guarantee it), and account-termination
   opacity is unchanged.

Net: the condition the rule requires ("current reclamation policy still
holds" — verifiable against current docs) is **not met**, so the pre-made
fallback applies. At €4.70/mo the cost is noise against the reliability of
the foundation (decision 7's own words), and SPEC's "reliability beats
sophistication" settles any remaining pull toward $0.

**What would reopen Oracle:** the exemption stated in Oracle's current docs
(not FAQ prose), plus same-week successful A1 provisioning in the home
region. Not worth re-litigating below that bar.

## Why this Hetzner shape

| Choice | Pick | Why |
|---|---|---|
| Plan | CX23 (2 vCPU Intel, 4 GB RAM, 40 GB SSD, 20 TB traffic) | Cheapest adequate shape. 4 GB comfortably fits Node + Postgres(+pgvector) at two-user scale; 40 GB dwarfs the data. €3.99/mo post-April-2026 pricing. |
| Arch | x86, not CAX/ARM | CAX is ~equal price but ARM is one more variable under the Baileys transitive tree (native deps). Boring wins; CI is x86 Linux too. |
| Location | Falkenstein (fsn1) or Nuremberg (nbg1) | CX and CAX are **not sold in US locations**; Ashburn's cheapest is CPX22 at €7.99/mo with 1 TB traffic — ~2× for nothing this workload needs. Latency is irrelevant: async messaging, and reminders anchor to Eastern wall time in config by hard rule, never server time. Server TZ stays UTC. |
| IPs | IPv4 + IPv6 | IPv4 (~€0.71/mo) kept for v1 — WhatsApp/Google endpoint IPv6 coverage is not something to debug at launch. |
| Hetzner auto-backups/snapshots | **OFF** | A whole-box snapshot captures Baileys session state; restoring it would roll back the Signal ratchet — the exact restore-hostile failure the SPEC "Never" forbids. T17's WAL+base-backup pipeline (which deliberately excludes Baileys state) owns durability. |

Pricing evidence: [Hetzner new-CX press release](https://www.hetzner.com/pressroom/new-cx-plans/),
[Better Stack Hetzner review](https://betterstack.com/community/guides/web-servers/hetzner-cloud-review/)
(documents the 2026-04-01 price adjustment, CX23/CPX22 current pricing, EU-only
cost-optimized tier, IPv4 €0.00097/hr). Fetched 2026-06-12; confirm the live
price in the console at order time.

## Provisioning checklist (T15 [H] — builder clicks)

1. Hetzner account + payment method; create project `hh-assistant`.
2. Console → Security → add SSH **public** key (generate a fresh
   `ed25519` keypair for this host; private key never leaves your Mac).
3. Create server: location **fsn1** (or nbg1), image **Ubuntu 24.04**, type
   **CX23**, public IPv4 ✓ + IPv6 ✓, your SSH key selected, backups **off**,
   no volumes (T16 defines the writable mounts), cloud-init empty (keep the
   first boot inspectable; hardening is T16's scripted layer).
4. First login as root, minimal baseline (everything deeper is T16):
   ```sh
   adduser --disabled-password hh && usermod -aG sudo hh
   install -d -m 700 /home/hh/.ssh && cp /root/.ssh/authorized_keys /home/hh/.ssh/ && chown -R hh:hh /home/hh/.ssh
   # /etc/ssh/sshd_config.d/10-hardening.conf:
   #   PasswordAuthentication no
   #   PermitRootLogin no
   systemctl restart ssh
   apt-get update && apt-get -y upgrade && apt-get -y install unattended-upgrades
   hostnamectl set-hostname hh-assistant   # TZ stays UTC deliberately
   ```
   Verify key-only login as `hh` from a second terminal **before** closing
   the root session.
5. Record below: server IP, server ID, datacenter, price as billed, date.
6. Mark T15 done in TASKS.md; T16 (hardening + egress allowlist) and T17
   (backups → B2/R2, restore drill) proceed against this box. T17's B2-vs-R2
   pick is still open — decide there, not here.

## Provisioned host (fill at T15 completion)

- Provisioned on: _pending_
- Server ID / name: _pending_
- IPv4 / IPv6: _pending_
- Datacenter: _pending_
- Billed: _pending_
