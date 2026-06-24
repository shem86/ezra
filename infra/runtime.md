# T16 — Production runtime sandbox + egress allowlist

**Decision (2026-06-14, resolving the open T16 question in infra/host.md):
Docker Compose for the process sandbox + host-level nftables for egress.**

The alternative was a systemd unit with its own sandbox directives
(`ProtectSystem`, `ReadOnlyPaths`, `IPAddressAllow`). Compose wins for v1
because the app and its co-located Postgres already deploy as containers, the
read-only-rootfs + cap-drop + non-root story is one declarative file, and dev
already runs Compose — one fewer thing that differs between dev and prod.
Egress stays OFF the container layer: Docker manages its own iptables rules, so
a hostname allowlist inside the container fights that; the firewall lives on
the host, scoped to the docker egress bridge.

## What this layer is (and is not)

This is the **application runtime** sandbox only. The **login/OS baseline**
(the `hh` user, SSH lockdown, patching, hostname) is `infra/provision-host.sh`
from T15 and runs first, once, on a fresh box. T45 deploys this layer on top of
that baseline and runs the on-host drills.

## Files

| File | Role |
|---|---|
| `infra/Dockerfile` | Multi-stage prod image; non-root `node` user; no secrets baked in |
| `infra/docker-compose.prod.yml` | Hardened `ezra` + `postgres` services, networks, volumes |
| `.dockerignore` | Keeps `.env`, `.wa-session`, tests out of the build context |
| `src/ops/egress-allowlist.ts` | **Single source of truth** for allowed egress hosts (unit-tested) |
| `infra/egress/render-allowlist.ts` | Generator: emits the allowlist as data; `--write` regenerates the artifact, `--check`/`--table` for CI/humans (author/CI time, not host) |
| `infra/egress/allowlist.generated.txt` | Committed static artifact the host firewall reads (drift-guarded; no host Node — V2_NOTES §4) |
| `infra/egress/nftables.sh` | Host egress ruleset, rendered from the committed artifact |

## Process hardening (the `ezra` service)

- **non-root**: runs as uid 1000 (`node`); `user: "1000:1000"`.
- **read-only rootfs**: `read_only: true`. The only writable surfaces are a
  `tmpfs` `/tmp` and the `wa-session` volume.
- **writable volumes, minimal**: `wa-session` (Baileys session — the one
  app-writable persistent surface; **never** backed up/restored, SPEC "Never")
  and `pgdata` (Postgres data, on the postgres service).
- **no privilege escalation**: `cap_drop: [ALL]` + `no-new-privileges:true`.
- **secrets at runtime**: injected from `../.env` via `env_file` — never in the
  image (`.dockerignore` excludes `.env*` except the example). Compose-internal
  `DATABASE_URL`/`WA_SESSION_DIR` are set in `environment` (overrides `.env`).

Postgres is deliberately **not** `read_only` (it needs many writable paths);
its sensitive surface is the `pgdata` volume, its port is **not published**, and
it sits on an `internal: true` network with no route to the internet. The app
attaches to both `internal` (to Postgres) and `egress` (to the world, filtered
by host nftables).

## Egress allowlist

The allowlist is declared in `src/ops/egress-allowlist.ts` and covers every
host the v1 surface dials — model (`api.anthropic.com`), embeddings
(`api.voyageai.com`), calendar (`*.googleapis.com`), tracing
(`*.cloud.langfuse.com`), alerts (`api.telegram.org`), dead-man
(`hc-ping.com`), WhatsApp (`*.whatsapp.net`, `*.whatsapp.com`), and the T17
backup target (B2/R2, slot reserved). `tests/unit/egress-allowlist.test.ts`
scans `src/` for outbound host literals and fails if any is unlisted — so a new
dependency that dials a fresh host is caught in CI, not in production.

`infra/egress/nftables.sh` renders that list into a default-deny ruleset on the
container egress bridge (DNS + established + resolved allowlist IPs accepted,
everything else logged + dropped), re-resolving the rotating CDN names on a
timer (`refresh` subcommand). Because the names sit behind rotating IPs, the
firewall resolves them into nft sets rather than pinning addresses.

The host firewall reads the **committed static artifact**
`infra/egress/allowlist.generated.txt` (apex hosts, one per line, plus a
`#`-comment header the script skips) — **no host Node** (V2_NOTES §4). The app
is containerized; baking the list into the image alone wouldn't put it where a
*host* process can read it, so the list is committed to the repo (the CD
checkout already lands it on the box). `render-allowlist.ts` stays the
source-of-truth renderer, now run at author/CI time: regenerate with
`node infra/egress/render-allowlist.ts --write`. Drift is CI-guarded by
`tests/unit/egress-allowlist-artifact.test.ts` (and `--check` for a script
gate), so the committed artifact can never silently diverge from
`src/ops/egress-allowlist.ts`.

## Deploy (T45 runs this on the host)

All commands run from the repo root (`~/hh-assistant`) as the `hh` user.
`--env-file .env` is **load-bearing**, not optional: with `-f infra/...` the
compose *project directory* becomes `infra/`, so interpolation looks for
`infra/.env` and `${POSTGRES_PASSWORD}` comes up missing. `--env-file .env`
points interpolation back at the repo-root `.env` (the same file the ezra
service loads via `env_file: ../.env`).

```
# 0. host tooling (fresh box): Docker engine + compose plugin. The egress
#    firewall reads the committed allowlist.generated.txt — no host Node needed
#    (V2_NOTES §4; nft + curl/jq for the S3 CIDRs still come from provision-host).
#    add hh to the docker group so it runs docker without sudo.

# 1. login/OS baseline (T15), once on a fresh box
sudo bash infra/provision-host.sh

# 2. .env on the host (gitignored; carries POSTGRES_PASSWORD + all secrets)
#    DATABASE_URL/WA_SESSION_DIR are set by compose, not needed in .env.

# 3. bring up the hardened process
docker compose --env-file .env -f infra/docker-compose.prod.yml up -d --build

# 4. egress allowlist. The bridge name is pinned to hh-egress0 in
#    docker-compose.prod.yml (com.docker.network.bridge.name) — no inspect.
sudo EGRESS_IFACE=hh-egress0 infra/egress/nftables.sh apply
```

## Verification — split between here and T45

Provable in this repo (and CI): the allowlist source of truth + its drift test;
`docker compose -f infra/docker-compose.prod.yml config` validates; the image
builds.

On-host only (the T45 drill, `docs/ops-drills.md`): "process runs hardened"
(read-only rootfs honored, non-root, no extra caps) and **"blocked egress to a
non-listed host confirmed"** — `curl https://example.com` from inside the
container times out while `https://api.anthropic.com` succeeds. Host nftables
cannot be exercised from the dev Mac, so T16 delivers the artifacts and the
unit-tested allowlist; T45 confirms enforcement on the real box.

## CI/CD (V2_NOTES §1) — build once, deploy on release

The host **no longer builds** the image. CI (`.github/workflows/ci.yml`) builds
`infra/Dockerfile`, runs the two §8 smokes (compose-config + `loadProductionConfig`
in the real image), and pushes immutable tags to GHCR
(`ghcr.io/shem86/hh-assistant`): `:sha-<short>` + `:main` on a `main` push, and
`:<version>` + `:latest` on a `v*` release tag. The prod compose pulls that tag
via `EZRA_TAG` (default `:latest`); `infra/docker-compose.build.yml` is the
local-dev override that restores an in-place `build:`.

**Deploy** (`.github/workflows/deploy.yml`) fires on a published GitHub release:
it assumes an AWS role via OIDC and sends an SSM `AWS-RunShellScript` to the
instance, which syncs the host checkout to the release ref, reads the GHCR PAT
from Parameter Store, and runs `infra/deploy/on-host-deploy.sh` with
`SECRETS_MODE=ssm`. That script: **materialize `.env`** (self-fetch it from the
`/hh-assistant/env` SSM SecureString via the instance role — V2_NOTES §3, so the
host no longer relies on a hand-scp'd file; atomic, aborts the deploy if the
fetch is empty/fails before any swap) → record prior tag → `pull` →
**migrate-gate** (run migrations with the NEW image
before swapping, so a bad migration fails the deploy rather than crash-looping a
swapped app — forward-only, so image-swap rollback reverts the app, not the
schema) → `up -d` → healthcheck (wait for the `ezra up:` launch marker, no
crash-loop) → **auto-rollback** to the prior tag on failure. The deploy can be
re-run manually via the workflow's `workflow_dispatch` input.

**Cutting a release** is one command from green `main`: **`pnpm release vX.Y.Z`**
(`infra/deploy/release.sh`). It guards (clean main matching origin, new tag),
`git tag`s + pushes, **blocks until the CI image build for the tag goes green**
(so GHCR has the image before we publish — the deploy doesn't wait for it),
`gh release create`s to fire the deploy, then follows the deploy run to its
outcome. A `-rc.N` suffix cuts a `--prerelease` (still fires the deploy — an rc
dry-run). Redeploying or rolling an **already-released** tag is the
`workflow_dispatch` path above, not `pnpm release`.

### One-time prerequisites (provisioned outside the repo)

| Prereq | Where | Notes |
|---|---|---|
| AWS IAM role for GitHub OIDC | repo variable `AWS_DEPLOY_ROLE_ARN` | trust the repo's OIDC subject; allow `ssm:SendCommand` on `i-0a7e9f4767666ac9e` + `ssm:GetCommandInvocation` |
| Instance profile on the host | EC2 `i-0a7e9f4767666ac9e` | The instance already carries the `hh-assistant-backup-ec2` profile (one per instance), so SSM perms were added to **that existing role** — `AmazonSSMManagedInstanceCore` + an inline `hh-read-ghcr-param` (`ssm:GetParameter` on `/hh-assistant/*` + scoped `kms:Decrypt`). The backup S3 policy is untouched. |
| GHCR read PAT | SSM Parameter Store `/hh-assistant/ghcr-pat` (SecureString) | A **classic** PAT with `read:packages` — fine-grained PATs have no Packages permission for *user-owned* packages (org-owned only). The on-host `docker login` uses it; CI's `GITHUB_TOKEN` covers the push side automatically. See rotation below. |
| App `.env` | SSM Parameter Store `/hh-assistant/env` (SecureString) | The whole app `.env` (V2_NOTES §3). Seed once from the live file: `aws ssm put-parameter --region us-east-1 --name /hh-assistant/env --type SecureString --value file://.env --overwrite`. Covered by the same `hh-read-ghcr-param` policy (`/hh-assistant/*`). Must carry the host-generated `POSTGRES_PASSWORD` unchanged (Postgres binds it at first init). Rotate any secret by editing `.env` and re-running the same `put-parameter`. |
| Host git checkout + read-only fetch | `/home/hh/hh-assistant` | the SSM step `git checkout`s the release ref so compose/script match the image; private repo needs a read-only deploy token/key for `git fetch` |

Steady-state post-deploy regressions (a process that wedges after the gate
passes) are caught by the hc-ping.com **dead-man** (`src/ops/deadman.ts`), not
this pipeline. A proper HTTP `/health` readiness endpoint is a clean follow-up.

### Rotating the GHCR PAT

The pull token (`/hh-assistant/ghcr-pat`) is a classic `read:packages` PAT and
expires (90-day default). Expiry fails **loud and at deploy time** — the next
deploy's `docker pull` errors, `on-host-deploy.sh` exits non-zero, the workflow
goes red, and the **running container keeps serving** (no swap). It is never a
silent production outage, so a bounded expiry is preferred over a non-expiring
token. To rotate (proactively, or after a red deploy blamed on auth):

1. GitHub → Settings → Developer settings → **Tokens (classic)** → regenerate
   (or new) with scope **`read:packages`** only.
2. Overwrite the SSM parameter (keep the token out of shell history):
   ```
   read -rs T   # if your shell is interactive; else paste inline once
   aws ssm put-parameter --region us-east-1 --name /hh-assistant/ghcr-pat \
     --type SecureString --value "$T" --overwrite
   unset T
   ```
3. No host or workflow change is needed — the next deploy reads the new value.
   Verify length without printing the secret:
   `aws ssm get-parameter --name /hh-assistant/ghcr-pat --region us-east-1 --with-decryption --query 'Parameter.Value' --output text | wc -c`

A classic `read:packages` token can read *all* packages the account sees; the
only way to a per-package-scoped token is to move the image to a GitHub **org**
and use a fine-grained org PAT (then update `IMAGE`/`GHCR_USER` everywhere).

## Backoffice (read-only console) — exposure + one-time host roll

The read-only operations console (`src/backoffice` + `backoffice/` SPA, served
by `pnpm backoffice` / `dist/backoffice/cli.js`) ships in the same image as the
spine and runs as a separate `backoffice` service (`docker-compose.prod.yml`),
bound to **loopback only** (`127.0.0.1:8787`). It is exposed over a **Tailscale**
tailnet — no public ingress (the SG stays SSH-only).

### One-time host roll (Tailscale) — done 2026-06-24 on the live box
A fresh env does this automatically via cloud-init (`infra/pulumi/cloud-init`).
The existing prod box (userData is `ignoreChanges`) was rolled out-of-band:

```bash
ssh ubuntu@98.91.67.226
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --auth-key="$(aws ssm get-parameter --name /hh-assistant/tailscale-authkey --with-decryption --region us-east-1 --query Parameter.Value --output text)" --hostname=ezra-backoffice
sudo tailscale serve --bg --https=443 http://127.0.0.1:8787
```

Reachable at `https://ezra-backoffice.<tailnet>.ts.net` (valid `*.ts.net`
Let's Encrypt cert; MagicDNS + HTTPS must be enabled in the tailnet admin
console). **Admin-console follow-up:** disable key expiry on the `ezra-backoffice`
node so it never drops off the tailnet.

### SELECT-only DB role
The console connects through the `hh_readonly` role (migration
`0007`, created passwordless at ezra launch). Its password is set out-of-band
from the SSM `BACKOFFICE_DATABASE_URL` (never in git):

```bash
ssh ubuntu@98.91.67.226
sudo -iu hh bash -c 'cd ~/hh-assistant; \
  RO_PW=$(grep "^BACKOFFICE_DATABASE_URL=" .env | sed -E "s#.*hh_readonly:([^@]+)@.*#\1#"); \
  docker exec hh-postgres-prod psql -U hh -d hh_assistant_prod -c "ALTER ROLE hh_readonly LOGIN PASSWORD '"'"'$RO_PW'"'"'"'
```

### Deploy note — network-definition changes
`on-host-deploy.sh` detects an egress-network bridge-name drift up front and,
when present, deploys via a clean full-stack `down`/`up` (both compose files, so
the backup sidecar + shared network are handled; named volumes preserved) — the
in-place migrate-gate/swap can't apply a network `driver_opts` change to a live
stack. This is a one-time event per such change; afterwards deploys take the
fast in-place path. (2026-06-24: the egress bridge pin `hh-egress0` was applied
this way during the v2.2.2 deploy.)
