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
- **scratch create-graph VALIDATED:** `pulumi preview` plans 10 resources to
  create from zero (default-VPC subnet + latest-Ubuntu-AMI lookups resolve). A
  billable `pulumi up` is deferred and needs the private-repo deploy key (below).

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
pulumi stack select scratch
pulumi preview            # validated: 10 resources to create from zero
pulumi up                 # BILLABLE (t3a.medium). NEEDS the deploy key below.
pulumi destroy && pulumi stack rm scratch
```

**Open gap for a real scratch `up`:** the repo is **private**, so cloud-init's
`git clone` needs a read-only deploy key. Wire it like the SSM secret: add a
repo deploy key, store its private half in SSM (`/hh-assistant/deploy-key`), and
have `cloud-init/user-data.yaml.tmpl` fetch it (the clone step is already marked
with this caveat). Until then a scratch box provisions the cloud resources but
cloud-init stops at the clone. The create *graph* is proven; the full-chain
on-box bootstrap needs this one seam.

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
