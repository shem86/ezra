# V2 Notes — streamlining build, deploy & ops

Captured during the v1 production deploy (T45, 2026-06-15) while standing the
agent up on the EC2 host by hand. Each item is grounded in friction that
actually bit, not speculation. The north star: **one command (or one merged
PR) takes a clean commit to a running, hardened, monitored process — and the
~Oct-2026 Hetzner migration is a provider swap, not a re-derivation.**

## 1. CI/CD — the biggest gap

v1 has CI (build + lint + test with a pgvector service) but **no CD**, and CI
never builds the production image. Consequences and fixes:

- **CI must build the prod image.** A real Dockerfile bug shipped undetected to
  deploy: it never `COPY`'d `.npmrc`, so in-image pnpm used its default
  `auto-install-peers=true` against a lockfile recording `false`, and the
  frozen install failed (`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`). The T16 "image
  builds" claim had never been exercised. A `docker build -f infra/Dockerfile`
  job in CI catches this class before it reaches a host.
- **Use an image registry.** Build once in CI, push an immutable tag to GHCR
  (`ghcr.io/shem86/hh-assistant`); the host *pulls* a tag instead of building
  from rsynced source (slow, non-reproducible, needs the full toolchain on the
  box). v1 rsynced source and ran `docker build` on the t3a.medium.
- **A deploy workflow.** On a release tag: build+push → SSH/SSM to the host →
  `docker compose pull && up -d` → healthcheck gate → auto-rollback to the
  prior tag on failure. Or pull-based (a tiny on-host updater). Today every
  deploy step is hand-typed.
- **Migrations in the pipeline.** They currently apply at app startup (fine for
  one instance), but CD should run a `migrate`-only step and gate the image
  swap on it, so a bad migration fails the deploy instead of crash-looping the
  app.

## 2. Provisioning as code (IaC)

- The instance, EIP, security group, IAM user, and S3 backup bucket were all
  created by hand via AWS CLI (T15/T17). v2: Terraform or Pulumi — one `apply`,
  versioned, diffable. This is what makes the Hetzner migration cheap.
- `infra/provision-host.sh` (OS baseline) is already idempotent and
  provider-portable — keep it, but invoke it from **cloud-init/user-data** so a
  fresh box self-bootstraps the `hh` user + SSH lockdown without a manual SSH.

## 3. Secrets management

- v1: a hand-maintained `.env` scp'd to the host. Fragile and manual.
- **`POSTGRES_PASSWORD` is a footgun**: Postgres binds it at *first* data-dir
  init, so changing it in `.env` afterward silently breaks app auth (the deploy
  had to preserve the host-generated value across the `.env` load). Generate it
  **once** into a secret store, never inline per-deploy.
- v2 options: AWS SSM Parameter Store / Secrets Manager (the host already has an
  IAM identity), or **SOPS + age** committing an encrypted `.env.enc` to the
  repo (we already run `age` for backups, so the tooling is in place). Either
  gives auditable, reproducible secret delivery and removes the manual scp.

## 4. Compose / runtime ergonomics

- `--env-file .env` is **required but easy to forget**: `-f infra/...` makes the
  compose project dir `infra/`, so `${POSTGRES_PASSWORD}` interpolation looks
  for `infra/.env` and misses the repo-root file (fails confusingly). v2: a
  root `Makefile`/`justfile` (`make deploy`, `make pair`, `make egress`) or set
  `COMPOSE_FILE`/`COMPOSE_ENV_FILES` in the host shell profile so the flags are
  never typed by hand.
- **Node on the host only to render the egress allowlist** is awkward (the app
  is containerized). v2: render the allowlist to a static artifact at
  image-build time, or run the refresh as a tiny sidecar — drop the host Node
  dependency entirely.

## 5. Egress firewall automation

- The nftables apply is manual, needs root, and `hh` has no passwordless sudo
  (correct, but a friction point). v2: ship a **systemd unit + timer** that
  applies the ruleset on boot (after docker is up) and runs `refresh` on a
  schedule to re-resolve rotating CDN IPs. Add a **narrow sudoers entry scoped
  to `nft` only**, not `ALL`.
- The egress bridge name is dynamic (`br-<id>`, greped from `docker network
  inspect`). v2: pin it via compose (`com.docker.network.bridge.name`) so the
  firewall config is static and the timer needs no lookup.
- Cloud-layer defense-in-depth: the security-group egress is still default-open.
  v2: tighten SG egress (e.g. 443 + 53, plus a lane for host apt) as a coarse
  second layer — carefully, since SG rules also govern the host's own traffic.

## 6. Backups — close the open wiring

- The backup sidecar needs a replication `pg_hba` line; the stock pgvector image
  only trusts replication from localhost (the T17 open item). v2: bake a
  replication role + `pg_hba` entry into a Postgres init script
  (`/docker-entrypoint-initdb.d/`) so continuous WAL works on first boot, not as
  a manual post-step.
- Schedule base backups declaratively (host timer / compose-managed cron), and
  surface backup-freshness to the monitoring channel.

## 7. Pairing / session lifecycle

- Baileys pairing is interactive (QR) and must run **inside a container** with
  the session volume mounted and a live TTY — make it a first-class `make pair`
  target with the exact command, instead of reconstructing it each time.
- Re-pair on any move is correct (never restore session state). Keep that, but
  make re-pair one command.

## 8. Verification that would have caught v1 issues

- CI job that builds the prod image (§1).
- A compose smoke in CI: boot postgres + run `loadProductionConfig()` in a
  throwaway container (the `docker compose run --rm --no-deps ezra node -e …`
  trick used in the deploy) — catches config-wiring and `--env-file` problems
  without real traffic.

## 9. Footguns burned in v1 (don't relearn)

- Dockerfile **must** `COPY .npmrc` for frozen installs to honor
  `auto-install-peers=false`.
- `POSTGRES_PASSWORD` is fixed at first DB init — preserve it across `.env`
  edits or the app can't authenticate.
- `docker compose run --rm --no-deps <svc> node -e …` validates config and
  image wiring **without** starting the real service (no WhatsApp traffic) — a
  cheap, safe pre-flight.
- `--env-file .env` is load-bearing with `-f infra/...` (see §4).

## 11. Egress refresh: use `refresh`, not `apply`, on the timer

The v1 egress timer re-runs `nftables.sh apply` (delete table → re-resolve DNS →
reload), which leaves a ~1-2s window every 15min where the table is absent and
egress fails OPEN. The `refresh` subcommand instead flushes + re-adds only the
nft set elements while the table/chain stay loaded — no fail-open window (a brief
fail-CLOSED at worst). v2: timer triggers a refresh-only path; `apply` runs only
on boot to create the table. Even better: load the ruleset atomically so there's
no window at all.
