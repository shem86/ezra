# infra/pulumi — provisioning as code (V2_NOTES §2)

Codifies the AWS footprint that was hand-built via CLI (T15/T17). The point is
**reproducibility as a capability**, not only the ~Oct-2026 Hetzner swap:
`pulumi up` with a different stack/region/provider stands up a *working* host
from zero. The migration is one instance of that capability.

Isolated workspace — own `package.json` + `tsconfig.json`, TypeScript pinned to
`5.9.3` (Pulumi's loader), outside the app's strict tsconfig and DBOS-determinism
ESLint scope (`eslint.config.js` ignores `infra/pulumi/`). Does not touch
`pnpm build`/`test`.

## Status (2026-06-23)

- **State backend live:** self-managed S3 `s3://hh-assistant-pulumi-state`
  (versioned, public-access-blocked), passphrase secrets provider.
- **prod adopt — APPLIED (2026-06-23).** `pulumi up` imported all 17 resources
  and applied only additive management tags; **0 replacements, 0 destroys**. The
  instance imported 🔒 protected with NO replacement (verified: same original
  2026-06-13 launch time, EIP still attached, Baileys/pgdata untouched). A
  post-apply `pulumi preview` shows **21 unchanged** — the empty-diff gate is met;
  prod is now fully under IaC management.
- **scratch create path PROVEN end-to-end (2026-06-23):** a billable `pulumi up`
  stood up a fresh box; cloud-init ran the full chain — Docker/Node install →
  **read-only deploy-key SSH clone of the private repo** → `provision-host.sh`
  baseline → synthetic secret from SSM → **GHCR private-image pull** → `compose
  up`. ezra came up with **0 restarts** (DBOS migrations applied, "DBOS
  launched!", conversation queue registered), sitting at the WhatsApp-pairing
  wait — the expected ceiling. Box then `pulumi destroy`ed (10 deleted, instance
  terminated). Four real fresh-box cloud-init bugs were found + fixed along the
  way — see **[Fresh-box cloud-init gotchas](#fresh-box-cloud-init-gotchas)**.
- **Clean unattended re-run (2026-06-23):** after the egress fix, a fresh
  `pulumi up` booted start-to-finish with **no manual intervention** —
  `cloud-init status: done` (`errors: []`), **0 `Job failed`** lines, **0 failed
  systemd units**, `hh-egress.timer` **active + enabled** firing
  `hh-egress-refresh.service` on its 15-min cadence (nft table loaded), ezra
  running with **0 restarts** (DBOS launched, queue registered). Box destroyed.
  This is the genuinely-clean run; the create path is now proven via the
  template itself, not patched-in steps.

## Two stacks

| Stack | What | Safety |
|---|---|---|
| `prod` | **Adopts** the live resources. Each resource carries an `import` id from `ezra:importIds` and is `protect`ed. | Empty-diff-modulo-benign-tags; instance + all adopted resources destroy-proof. |
| `scratch` | **Creates** a fresh env from zero (no importIds) to prove the create path, then `pulumi destroy`. | `protect=false`; billable while up. |

## How adopt works (the actual mechanism)

Resources are written create-shaped. On the prod stack, `ezra:importIds` (in
`Pulumi.prod.yaml`) maps each resource key → its live AWS id; the component's
`imp(key)` helper turns that into `{ import: <id>, protect: true }`. So a single
`pulumi up` imports the live resources into state and protects them. A fresh env
(scratch) has no `importIds`, so the same code creates instead.

## First-time setup (already done once)

```bash
cd infra/pulumi && pnpm install
aws s3 mb s3://hh-assistant-pulumi-state --region us-east-1   # versioned + PAB applied
pulumi login s3://hh-assistant-pulumi-state
export PULUMI_CONFIG_PASSPHRASE=…    # passphrase secrets provider; state holds NO secrets
                                     # (SSM params are not modeled), so it protects nothing today
```

## prod adopt — done. Day-2 ops:

```bash
cd infra/pulumi
export PATH="$HOME/.pulumi/bin:$PATH"; export PULUMI_CONFIG_PASSPHRASE=…
pulumi stack select prod
pulumi preview            # should report "N unchanged" (empty diff)
# make an infra change in code, then:
pulumi up                 # adopted resources are 🔒 protected against replace/destroy
```

## Prove the create path (scratch)

```bash
pulumi stack init scratch
pulumi up                 # BILLABLE (t3a.medium). Boots to a running ezra.
pulumi destroy --yes && pulumi stack rm scratch --yes
```

The private-repo clone is wired: cloud-init fetches a read-only **deploy key**
from SSM (`ezra:deployKeyParam` → `/hh-assistant/deploy-key`) and clones over
SSH. Scratch secrets are synthetic and live at `/hh-assistant/scratch-env`
(deliberately separate from the prod `/hh-assistant/env` name). Standing infra
left in place for future scratch runs: the repo deploy key `ezra-scratch-bootstrap`
and the two SSM params — remove them if you want zero standing surface.

**Ceiling:** the box reaches a running ezra (Postgres healthy, DBOS launched,
queue registered) and then waits at WhatsApp pairing — inherently interactive,
and the single household number can't be double-paired. That is the expected
stop, not a failure.

## Fresh-box cloud-init gotchas

Things that don't show up adopting an already-built box but bite a genuine
zero-state boot — all fixed in `cloud-init/user-data.yaml.tmpl`, kept here so a
future provider port (Hetzner) doesn't relearn them:

1. **`/run/sshd` missing in early boot** → `provision-host.sh`'s `sshd -t`
   validation fails. Bootstrap `mkdir -p /run/sshd` before calling it.
2. **`/home/hh` left root-owned** — the repo clone runs before the `hh` user
   exists, so `hh` can't write `~/.docker` (the GHCR login). `chown -R hh:hh
   /home/hh`, not just the repo dir.
3. **gpg keyring step prompts on re-run** — dearmor must be `gpg --batch --yes`
   or an unattended re-run blocks on the overwrite TTY prompt.
4. **Egress timer triggers a *different* unit than it installs.** `main` carries
   the apply/refresh split (V2_NOTES §11): `hh-egress.timer` has
   `Unit=hh-egress-refresh.service`, a separate unit from the boot-time
   `hh-egress.service`. Installing only `hh-egress.service` leaves the timer
   unable to start ("trigger unit not loaded") — it ends up enabled-but-inactive,
   so the 15-min re-resolve never runs and the nft set's 1h element TTL expires
   egress out from under the live process. Fix: glob-install **every**
   `hh-egress*.service`, and `systemctl start hh-egress.service` (boot apply,
   creates the table) **before** `enable --now hh-egress.timer` (whose refresh
   unit is `After=hh-egress.service` and needs the table loaded).

## Secrets delivery (§3)

`secretsMode=ssm` (chosen): the box reads its `.env` from an SSM SecureString
(`secretsParam`, default `/hh-assistant/env`) via the instance role. The
`sops` alternative (SOPS+age, portable) is the one-switch path in
`cloud-init/user-data.yaml.tmpl`. `POSTGRES_PASSWORD` is generated once into the
store, never edited inline (V2_NOTES §3/§9).

## Deferred (out of this pass)
SG-egress tightening (§5), declarative base-backup schedule (§6), a dedicated
VPC, a standing staging env, and the Hetzner provider impl (the component is
structured to accept it). The S3 `BucketV2`/`BucketVersioningV2`/
`BucketLifecycleConfigurationV2` types are deprecated in aws-provider v7 (favor
`Bucket`/`BucketVersioning`/`BucketLifecycleConfiguration`) — they import
cleanly today; switching is a low-risk follow-up after a fresh preview.
