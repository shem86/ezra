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
| `infra/egress/render-allowlist.ts` | Emits the allowlist as data the firewall consumes |
| `infra/egress/nftables.sh` | Host egress ruleset, rendered from the allowlist (v0) |

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

## Deploy (T45 runs this on the host)

```
# 1. login/OS baseline (T15), once on a fresh box
sudo bash infra/provision-host.sh

# 2. .env on the host (gitignored; carries POSTGRES_PASSWORD + all secrets)
#    DATABASE_URL/WA_SESSION_DIR are set by compose, not needed in .env.

# 3. bring up the hardened process
docker compose -f infra/docker-compose.prod.yml up -d --build

# 4. egress allowlist (find the bridge, then apply)
EG=br-$(docker network inspect hh-assistant_egress -f '{{slice .Id 0 12}}')
sudo EGRESS_IFACE="$EG" infra/egress/nftables.sh apply
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
