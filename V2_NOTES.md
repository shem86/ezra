# V2 Notes — streamlining build, deploy & ops

Captured during the v1 production deploy (T45, 2026-06-15) while standing the
agent up on the EC2 host by hand. Each item is grounded in friction that
actually bit, not speculation. The north star: **one command (or one merged
PR) takes a clean commit to a running, hardened, monitored process — and the
~Oct-2026 Hetzner migration is a provider swap, not a re-derivation.**

## Status at a glance

Section numbers are stable anchors (code comments + systemd units reference
`V2_NOTES §N`) — they don't renumber as items close. Detail stays in each
section below; this table is the index.

| § | Item | State |
|---|---|---|
| 1 | CI/CD pipeline (build→GHCR→release→SSM deploy) | ✅ shipped — only README badge automation open (§10 dissolves it) |
| 2 | IaC (Pulumi TS) | ✅ shipped — prod adopted (0 replacements) + create-from-zero proven |
| 3 | App secrets → SSM/SOPS | ✅ shipped — both paths wired + prod param seeded (2026-06-24); only the next-deploy log check remains |
| 4 | Compose ergonomics (`Makefile`) | ✅ shipped — host-Node removal done (firewall reads a committed, drift-guarded artifact) |
| 5 | Egress firewall (units + static bridge pin) | ✅ shipped — cloud-layer SG egress now authored in Pulumi (apply pending — deliberate prod step) |
| 7 | Pairing (`make pair`) | ✅ shipped |
| 8 | CI verification smokes (image + config-load) | ✅ shipped |
| 11 | Egress refresh split (no fail-open window) | ✅ shipped |
| 6 | Backups automation (initdb bake + scheduled base + freshness) | ✅ shipped + fully wired on prod (2026-06-28): timers enabled, freshness dead-man green, old crontab retired; only the initdb-bake/`hh_backup` migration awaits the next full rebuild (passive) |
| 9 | Footguns burned in v1 | 📌 reference |
| 10 | Going public (secret/PII scrub, LICENSE) | ⏳ gate — evaluate before flipping |
| 12 | AI / model-layer guardrails | 🟢 spend limit ✅ set; untrusted-content boundary Phase 0 ✅ shipped + eval-ratified (ADR-0005 Accepted) — Phase 1 deferred to M5 |

**What's next, ranked:**

1. **§12 — set the Anthropic Console monthly spend limit** (dedicated
   workspace + key). Zero code, biggest risk-reduction-per-effort; the one
   "do this first" item.
2. **§12 — data/instruction + memory-poisoning boundary.** ✅ Phase 0 shipped +
   eval-ratified (`docs/adr-0005-untrusted-content-boundary.md`, Accepted):
   fence-at-tool on calendar/recall/facts + the system-prompt rule; injection
   evals hold. Phase 1 (nonce marker, web/Q&A, forwarded-message provenance)
   deferred to M5.
3. ~~**§6 — bake replication into initdb + schedule base backups + surface
   freshness**~~ ✅ shipped in-repo (initdb bake + `hh_backup` role + base/
   freshness timers + dead-man ping); the one operator step left is enabling the
   timers on the live host (the PR doesn't touch prod).
4. **§4 / §5 — drop host Node** (render the allowlist at image-build). The
   **cloud-layer SG egress** defense-in-depth is now authored in §2's Pulumi SG
   (443/80/53/123); applying it to live prod is the remaining deliberate step.
5. **§10 — the going-public gate** (history secret scan, PII audit, LICENSE);
   flipping dissolves the §1 badge workarounds and unlocks branch protection.

*(§3 closed 2026-06-24 — `.env`-from-SSM wired on both paths and the prod
param seeded; the only remainder is a one-line check that the next release's
deploy log shows `secrets: .env materialized from ssm`, not a build task.)*

## 1. CI/CD — ✅ BUILT (badge automation still open)

v1 had CI (build + lint + test with a pgvector service) but no CD, and CI never
built the production image. **Both gaps are now closed** (PRs #8–#10,
2026-06-23; the pipeline is documented in CLAUDE.md "Deploying" and
`infra/runtime.md`). What shipped:

- **✅ CI builds the prod image.** `ci.yml`'s `image` job builds
  `infra/Dockerfile` on every push/PR and pushes immutable tags to GHCR
  (`ghcr.io/shem86/hh-assistant`: `:sha-<short>`+`:main` on a main push,
  `:<version>`+`:latest` on a `v*` tag; PRs build+smoke but never push). This is
  the catch v1 lacked — the `.npmrc`/`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` bug
  (§9) had shipped undetected because the T16 "image builds" claim was never
  exercised in CI.
- **✅ Image registry in use.** The host *pulls* an immutable tag from GHCR
  (self-fetching the GHCR PAT from SSM Parameter Store) instead of rsyncing
  source and running `docker build` on the box.
- **✅ Deploy workflow.** `deploy.yml` fires on a published GitHub release (or
  `workflow_dispatch` with a `tag`), OIDC-assumes the deploy role, and SSM-runs
  `infra/deploy/on-host-deploy.sh` — no inbound SSH. It pulls → migrate-gate →
  `up -d` → healthcheck gate (waits for the `ezra up:` marker, 180s timeout) →
  **auto-rollback** to the prior tag on failure. `pnpm release vX.Y.Z`
  (`infra/deploy/release.sh`) is the one-command path off green `main`: guards,
  tags+pushes, blocks on the CI image build going green, then `gh release
  create`s (which fires the deploy) and follows it to its outcome.
- **✅ Migrations gated in the pipeline.** Migrations run on the *new* image
  *before* the image swap (forward-only), so a bad migration fails the deploy
  instead of crash-looping the app. Image-swap rollback reverts the app, not the
  schema.

**Still open in §1 — the README badge automation (a private-repo workaround;
§10 going-public dissolves it):**

- **CI status badge (private-repo caveat) — already in README.** It carries
  `actions/workflows/ci.yml/badge.svg`. On a **private** repo it 404s for anyone
  not authenticated with repo access — so it's blank for the public and only
  renders for us. It starts working anonymously the moment the repo goes public
  (§10); no action needed until then, just don't be surprised it's empty in an
  incognito window.
- **Auto-update the README lines-of-code badge.** The badge is currently a
  *static* shields.io badge (`lines of code | 7k`, counting `src/`) because
  the repo is private — tokei.rs / codetabs / shields dynamic endpoints all
  fetch over the public API and return nothing for a private repo. To make it
  live: a CI step counts `src/` LOC on push (e.g. `git ls-files 'src/**/*.ts' |
  xargs wc -l`, or `cloc`), writes the number to a **public gist**, and the
  README points at a shields.io *dynamic* badge that reads the gist
  (`schneegans/dynamic-badges-action` is the standard recipe). Needs a gist +
  a `GIST` token secret. Until then the static number goes stale and must be
  bumped by hand.
- **Test-count / coverage badges ride the same gist pipeline.** Once the LOC
  gist workflow exists, a `tests | N` badge is nearly free (vitest already
  reports the count — emit it to the gist in the same CI step). A `coverage |
  N%` badge additionally needs `vitest --coverage` wired up. Both face the same
  private-repo constraint as LOC, so fold them into the one gist workflow
  rather than standing up more static, hand-bumped numbers. If the repo goes
  public, **all** of these collapse to off-the-shelf dynamic services
  (tokei.rs for LOC, the native Actions/coverage badges) and the gist
  workaround can be deleted.

## 2. Provisioning as code (IaC) — ✅ BUILT (`infra/pulumi/`, Pulumi TS)

**Done (2026-06-23):** `infra/pulumi/` (Pulumi, TypeScript — stays in the
repo's one language; chosen over Terraform for reproducibility-as-a-capability,
scope **capability-only**, not a general AWS framework). Detail + the fresh-box
gotchas live in `infra/pulumi/README.md`. Two stacks:

- **`prod` adopts the live resources** — `pulumi up` imported all 17 with
  **0 replacements / 0 destroys** (additive management tags only; the instance
  is 🔒 `protect`ed, NOT replaced — original launch time, EIP, Baileys/pgdata all
  intact; post-apply preview = 21 unchanged, the empty-diff gate). The
  import-don't-replace requirement (recreating instance/EIP/bucket = outage +
  data loss) is met. Host `i-0a7e9f4767666ac9e`, acct `001467466089`, us-east-1.
- **`scratch` proves create-from-zero** — a billable `pulumi up` ran cloud-init's
  full chain (Docker/Node → deploy-key clone → `provision-host.sh` → SSM secret →
  GHCR pull → compose up) to a running ezra (0 restarts) at the pairing ceiling,
  then `destroy`ed; re-proven by a clean unattended boot. `provision-host.sh` is
  now invoked from **cloud-init/user-data** (no manual SSH), and cloud-init also
  installs+enables every egress unit the repo ships (§5/§11). This is what makes
  the ~Oct-2026 Hetzner migration a provider swap, not a re-derivation.

**Cloud-layer SG egress (tracked in §5):** now authored on the Pulumi-managed
security group (`components/host-environment.ts` — the SG already creates/adopts
its egress, so this swaps the single allow-all rule for a coarse 443/80/53/123
allowlist). Apply to live prod is still pending as a deliberate, careful step
(SG rules govern the host's own traffic — see §5).

## 3. Secrets management — ✅ SSM chosen + wired both paths (prod cutover = one put-parameter)

- v1: a hand-maintained `.env` scp'd to the host. Fragile and manual. §1's CD
  set the precedent — the GHCR PAT lives at `/hh-assistant/ghcr-pat` and the
  host self-fetches it via its IAM identity — and §2's Pulumi extended it to the
  whole `.env`.
- **Decision: AWS SSM Parameter Store** (`secretsMode=ssm`, the testable-now
  default; the host already has the instance role and the role's
  `hh-read-ghcr-param` policy already covers `parameter/hh-assistant/*`). **SOPS
  + age stays modeled as a one-switch portable alternative** (`secretsMode=sops`,
  for the ~Oct-2026 Hetzner/non-AWS host) — wired in both cloud-init and
  `on-host-deploy.sh`, inert until selected.
- **Done (2026-06-24): `.env` materialized from SSM on *both* paths.** The
  create path (`cloud-init/user-data.yaml.tmpl`) already did it; this pass added
  the matching seam to **steady-state CD** — `infra/deploy/on-host-deploy.sh`
  self-fetches `.env` from `SECRETS_PARAM` (`/hh-assistant/env`) before every
  swap, gated by `SECRETS_MODE` (`deploy.yml` sets `ssm`; default `none` keeps
  the on-disk file so the script stays provider-portable). Atomic write (temp →
  require non-empty → `mv`), so a failed fetch aborts *before* any pull/swap and
  leaves the running container untouched. `POSTGRES_PASSWORD` footgun handled by
  design: the stored `.env` must carry the same host-generated value the data
  dir was initialized with (commented at the seam) — so the param is seeded
  *from* the live `.env`, never regenerated.
- **Done (2026-06-24): prod param seeded.** `/hh-assistant/env` now holds the
  live `.env`, seeded once from the host's canonical file (`ssh ubuntu@<host>
  'sudo cat .../.env'` → `put-parameter`). **Advanced tier**, because the full
  `.env` exceeds SSM Standard's 4096-char cap — `GOOGLE_SA_KEY_B64` (base64 SA
  key, ~2–3 KB) alone dominates it. ~$0.05/param/month; the alternative free
  paths (SOPS+age, or splitting the SA key into its own Standard param) were
  weighed and declined for one-flag simplicity. Rotation is just `put-parameter
  --overwrite` (stays Advanced); no host touch. The next release deploys
  SSM-sourced — verify the deploy log shows `secrets: .env materialized from ssm`.
- **Caveat for create-from-zero:** the cloud-init path reads the *same* single
  `/hh-assistant/env`, so a real prod rebuild inherits the Advanced-tier param
  (fine — it already exists). A *fresh provider* (Hetzner) has no SSM at all and
  should use `secretsMode=sops` (no size cap, no standing cost, already wired) —
  that's the natural moment to migrate off Advanced-tier SSM.

## 4. Compose / runtime ergonomics — ✅ Makefile built (host-Node removal deferred)

- **Done (2026-06-23): root `Makefile`** bakes in the load-bearing
  `--env-file .env -f infra/docker-compose.prod.yml` flags so they're never
  hand-typed (`make up/down/ps/logs/restart`, `make pair` §7, `make config-smoke`
  §8, `make egress-apply`/`make egress-refresh`). `--env-file .env` is required
  because `-f infra/...` makes the compose project dir `infra/`, so
  `${POSTGRES_PASSWORD}` interpolation would otherwise look for `infra/.env` and
  miss the repo-root file. **Deploy is deliberately NOT a make target** — §1's CD
  dissolved that friction (`pnpm release vX.Y.Z` → CI image → release → SSM
  deploy), so the old `make deploy` idea is obsolete. Chose `Makefile` over
  `just` to avoid a new host tool (zero-dependency; `make` is universal).
- **Done — host Node removed from the egress path.** `nftables.sh` no longer
  shells out to host `node render-allowlist.ts`; it reads a **committed static
  artifact** `infra/egress/allowlist.generated.txt` (apex hosts + a `#`-comment
  header the script skips, fails closed if the artifact is missing).
  `render-allowlist.ts` stays the source-of-truth *generator*, now run at
  author/CI time (`--write` regenerates, `--check` gates), and a unit drift test
  (`tests/unit/egress-allowlist-artifact.test.ts`) fails CI if the committed
  bytes diverge from `src/ops/egress-allowlist.ts` — the same anti-drift
  discipline as the v1 egress test. Chose the committed artifact over (a)
  image-build-only baking — the firewall is a **host** process, so a file inside
  the container image isn't where it can read it; or (b) a refresh sidecar — more
  moving parts for no benefit, and the CD checkout already lands the repo (hence
  the artifact) on the box. Cloud-init (`user-data.yaml.tmpl`) no longer installs
  Node 22 for egress; every remaining `node` invocation on the host runs *inside*
  the container.

## 5. Egress firewall automation — ✅ units + static bridge pin shipped (SG egress authored in Pulumi; apply pending)

- **systemd unit + timer — authored in-repo and installed (2026-06-23, with
  §11):** `hh-egress.service` applies on boot (after docker, creates the table),
  `hh-egress-refresh.service` re-resolves rotating CDN IPs on `hh-egress.timer`.
  §2's cloud-init now **installs+enables every egress unit on a fresh box**
  (`user-data.yaml.tmpl`), so the old "host install is a manual step" no longer
  holds for the create-from-zero path.
- **Narrow sudoers — already exists** (`infra/host/sudoers-hh-ops`): NOPASSWD
  scoped to `systemctl {start,stop,restart,status}` of the three egress units
  only (not `nft` directly, not blanket `systemctl`, never `ALL`). Updated with
  §11's refresh unit.
- **✅ Done (2026-06-23) — pinned the egress bridge name.** Was dynamic
  (`br-<id>` greped from `docker network inspect`); now `hh-egress0`, fixed via
  `com.docker.network.bridge.name` in `docker-compose.prod.yml`. The two unit
  ExecStarts and the `Makefile` `EG` var drop the `docker network inspect`
  derivation and pass a static `EGRESS_IFACE` (also simplifies cloud-init's
  `systemctl start`). Takes effect on the next `compose down && up` (network
  recreate). `nftables.sh`'s `print` default + the `infra/runtime.md` recipe
  follow the same static name.
- **✅ Authored — cloud-layer defense-in-depth (apply pending as a deliberate
  prod step).** The security-group egress was default-open (`protocol:"-1"`,
  `0.0.0.0/0`). §2's Pulumi already creates/adopts the SG, so this swaps that
  single allow-all rule for a **coarse, port-based allowlist** in
  `infra/pulumi/components/host-environment.ts` — an SG with any explicit egress
  rule loses the implicit allow-all, so it enumerates **every** port the host
  legitimately needs outbound (the SG governs the host's OWN traffic *and* the
  container's, which NATs out the same ENI):
  - **443/tcp** — the workhorse: SSM agent + the no-inbound-SSH CD channel,
    `aws ssm get-parameter` (SSM+KMS), GHCR pulls, AWS S3 backups, and ALL
    container HTTPS (every host in `src/ops/egress-allowlist.ts` is 443 —
    Anthropic, Voyage, Google, Langfuse, Telegram, healthchecks, WhatsApp/fbcdn).
  - **80/tcp** — stock Ubuntu apt (`archive`/`security.ubuntu.com` serve HTTP) +
    unattended-upgrades. The Docker/NodeSource repos are HTTPS (covered by 443).
  - **53/tcp + 53/udp** — DNS (TCP for large/fallback responses).
  - **123/udp** — NTP: Eastern-anchored reminders/compaction need an accurate
    clock, so the host's time-sync must reach out.

  This is a **coarse** second layer under the hostname-aware host nftables
  allowlist — the SG can't filter by hostname (IP/port only). **Applying it to
  live prod is a deliberate, careful step** (a missed port cuts host
  connectivity): do it with AWS Console / Session-Manager access available as a
  fallback, and ideally validate on a §2 create-from-zero (`scratch`) env first.

- **✅ Done (2026-06-24) — egress re-apply is no longer silent + adopted-host
  reconcile.** The v2.2.0/v2.2.1 deploys exposed a real gap: after a network
  recreate (the bridge-name pin), `on-host-deploy.sh` re-applies the host nftables
  allowlist via `sudo systemctl start hh-egress.service`, but that runs as `hh`
  and needs the `sudoers-hh-ops` NOPASSWD drop-in — which **cloud-init installs
  only on a *fresh* box**. The prod host is **adopted** (§2), never ran cloud-init,
  so the drop-in was missing → the sudo was denied → the firewall stayed unbound:
  **fail-OPEN egress**, surfaced only as a soft "note". Two fixes:
  - **Hardening:** `reapply_egress()` in `on-host-deploy.sh` now uses `sudo -n`
    (fails fast, no hang) and on denial emits a structured `EGRESS-REAPPLY-FAILED`
    marker + the one-line fix; `deploy.yml` greps the SSM output and raises a
    GitHub `::warning::` (the app is healthy so the deploy still succeeds —
    **degraded, never silent**).
  - **Reconcile:** `infra/host/reconcile-host-config.sh` reproduces the cloud-init
    host-config baseline (sudoers drop-in + egress/backup units + enable/apply)
    **idempotently** for an adopted/drifted host. Run once on prod
    (`ssh ubuntu@<host> 'sudo bash …/reconcile-host-config.sh'`) and the deploy's
    auto re-apply works thereafter. **✅ Run on prod 2026-06-27 (after v2.2.3
    put the script on the host) and verified live:** the `/etc/sudoers.d/hh-ops`
    drop-in installed + validated, and `hh` can now `sudo -n systemctl start
    hh-egress.service` (the exact call `reapply_egress` makes, as the exact user)
    with **no denial** — the fail-OPEN path is closed; the firewall re-binds on
    any future bridge recreate. (`systemctl is-active` reads `inactive` — correct
    for the `Type=oneshot` apply-and-exit unit; the nft rules load into the
    kernel and persist.) It mirrors the cloud-init block (cross-noted
    in both); a future cleanup can DRY cloud-init against it once a `scratch`
    re-validation is run (the adopted prod is unaffected by that refactor).

## 6. Backups — ✅ automated in-repo + fully wired on prod (2026-06-28)

The pipeline (PITR base + continuous WAL, encrypted to S3, restore + drill)
already existed (T17/T45, `infra/backup/`). This pass closed the three open
automation items so continuous WAL survives a rebuild with **no hand-run step**.
All artifacts are in-repo; nothing here touched the live host.

- **✅ Replication baked into initdb.** `infra/backup/initdb-replication.sh` is
  mounted into the postgres service (`docker-compose.prod.yml`, into
  `/docker-entrypoint-initdb.d/`). On a FRESH data dir it creates a
  **least-privilege `hh_backup` role** (`REPLICATION LOGIN`, *not* the `hh`
  superuser) and appends `host replication hh_backup samenet scram-sha-256` to
  `pg_hba.conf`, so a rebuild / create-from-zero box streams WAL on first boot —
  no `enable-replication.sh` post-step. **It runs ONLY on an empty PGDATA** (the
  entrypoint's initdb contract), so it helps rebuilds and **cannot** mutate the
  already-initialized live prod data dir — that box stays wired for `hh` by the
  T45 `enable-replication.sh` (kept, idempotent, for the existing box +
  reattached volumes). The role password defaults to `POSTGRES_PASSWORD` (no new
  secret; `POSTGRES_PASSWORD` is never regenerated — §3/§9 footgun respected),
  overridable via `BACKUP_ROLE_PASSWORD`. The sidecar's role is `BACKUP_PGUSER`
  (defaults to `hh` for the existing box; set `hh_backup` on a rebuilt one).
- **✅ Base backups scheduled declaratively.** `hh-backup-base.{service,timer}`
  (daily 03:00 UTC) mirrors the egress systemd-unit pattern and replaces the
  hand-installed crontab line — runs `docker compose … run --rm backup
  backup.sh base` as the `hh` operator via the docker group (no sudo, so no
  sudoers entry needed).
- **✅ Freshness surfaced to the monitoring channel.** `infra/backup/freshness.sh`
  reads the latest base age from S3 and pings a **second** healthchecks.io
  dead-man — `BACKUP_FRESHNESS_PING_URL` (distinct from the process
  `DEADMAN_PING_URL`): `<url>` when within `BACKUP_MAX_AGE_HOURS` (default 30h),
  `<url>/fail` when stale/missing. `hh-backup-freshness.{service,timer}` (hourly)
  drives it inside the sidecar image; the external check alerts when the fresh
  ping stops — catching a stalled base cron the WAL stream can't.
- **✅ Sidecar image is now CI-built + pulled from GHCR (2026-06-28).** The
  backup sidecar image was the **lone exception** to the CI→GHCR→pull lifecycle:
  it was hand-built on the host (`docker compose build backup`) and silently
  drifted. `freshness.sh` shipped in-repo (2026-06-24) but the prod image was
  never rebuilt — *and* `.dockerignore` excluded `freshness.sh` from the build
  context, so any rebuild failed at `COPY` (`freshness.sh: not found`, exit 127).
  Net effect: the freshness timer failed **every hour** from the moment the §5
  reconcile enabled it (2026-06-27), surfaced only when we went to verify it.
  Fix (this pass): `.dockerignore` re-includes `freshness.sh`; `ci.yml` builds +
  pushes `ghcr.io/shem86/hh-assistant-backup` with the **same immutable tags** as
  the app (matched app+backup pair per release); the overlay references the GHCR
  image (`${EZRA_TAG:-latest}`, `build:` kept for dev/drill); and
  `on-host-deploy.sh` pulls + recreates the sidecar each deploy (the slot retains
  WAL across the brief `receivewal` reconnect). The host no longer builds images.
- **Cloud-init (create-from-zero)** installs + enables both timers and starts the
  sidecar on a fresh box (`user-data.yaml.tmpl`).
- **Operator wiring — ✅ done on prod (2026-06-28).** The sequence, for the
  record:
  - **Timers enabled (2026-06-27)** as a side effect of the §5
    `reconcile-host-config.sh` run (it created the `hh-backup-base.timer` +
    `hh-backup-freshness.timer` symlinks under `timers.target.wants`).
  - **Freshness dead-man wired + green (2026-06-28).** `BACKUP_FRESHNESS_PING_URL`
    set in the **SSM `/hh-assistant/env` blob** (the durable source — a host-only
    `.env` edit would be wiped by the next §3 deploy materialization) and on the
    live `.env`. This surfaced the latent break that made it worth it: the prod
    sidecar image predated `freshness.sh` *and* `.dockerignore` excluded the
    script, so the hourly timer failed exit-127 from the moment it was enabled —
    fixed by moving the sidecar image to CI→GHCR (see the bullet above), shipped
    in **v2.2.7**, after which `freshness.sh` runs clean (`FRESH: latest base
    within 30h`) and pings the second healthchecks.io check.
  - **Old crontab retired (2026-06-28).** The hand-installed `0 3 * * * … backup.sh
    base` line is removed (`crontab -r`; a `.bak` is kept on the host), so base
    now runs **once** daily via `hh-backup-base.timer` (confirmed firing on its
    own at 03:03) instead of twice. `systemctl list-timers` shows the two timers
    as the sole schedulers.
  - **Remaining (passive, not an operator action):** the initdb bake + the
    least-priv `hh_backup` role land on the next full rebuild; until then the
    existing box keeps streaming WAL as `hh` (`BACKUP_PGUSER` unset). Steps in
    `infra/backup/README.md` "Automated wiring".

## 7. Pairing / session lifecycle — ✅ BUILT (`make pair`)

- **Done (2026-06-23):** `make pair` (§4 Makefile) is the captured one-command
  containerized pairing: `docker compose --env-file .env -f
  infra/docker-compose.prod.yml run --rm --no-deps -it ezra node
  dist/transport/pair-cli.js`. It runs **inside the `ezra` container** so the
  Baileys session writes to the mounted session volume, with `-it` for the live
  QR TTY and `--no-deps` (pairing is transport-only, no Postgres). The exact
  command lived only in operators' heads before; now it's a target.
- Re-pair on any move is correct (never restore session state) — `make pair` is
  that one command.

## 8. Verification that would have caught v1 issues — ✅ BUILT (in §1's CI)

Both smokes ship in `ci.yml`'s `image` job (PRs run them too, before any push):

- ✅ **CI builds the prod image** (`infra/Dockerfile`) — caught the missing
  `COPY .npmrc` class by construction (§1/§9).
- ✅ **Compose config + config-load smokes:** `docker compose --env-file .env -f
  infra/docker-compose.prod.yml config -q` (interpolation / `--env-file` wiring),
  then `run --rm --no-deps ezra node -e 'import("./dist/ops/config.js")…
  loadProductionConfig()'` in the real image — config-wiring caught without real
  traffic. `make config-smoke` (§4) runs the same pair locally/on-host.

## 9. Footguns burned in v1 (don't relearn)

- Dockerfile **must** `COPY .npmrc` for frozen installs to honor
  `auto-install-peers=false`. *(Now caught in CI — §1/§8 build the image on every
  push/PR.)*
- `POSTGRES_PASSWORD` is fixed at first DB init — preserve it across `.env`
  edits or the app can't authenticate.
- `docker compose run --rm --no-deps <svc> node -e …` validates config and
  image wiring **without** starting the real service (no WhatsApp traffic) — a
  cheap, safe pre-flight. *(Now a CI smoke + `make config-smoke` — §8/§4.)*
- `--env-file .env` is load-bearing with `-f infra/...` (see §4). *(Now baked
  into every `Makefile` target — §4.)*

## 10. Going public — implications to evaluate first

Several badge/CI workarounds above exist only because the repo is **private**
(`shem86/hh-assistant`). Going public would dissolve most of them — but it's a
one-way-ish door (history stays public once indexed), so audit before flipping,
in roughly this order of risk:

- **Scrub history for secrets before anything else.** Policy is never to commit
  secrets or Baileys session state, but *verify the whole history*, not just
  HEAD — `git log --all` + a scanner (gitleaks / trufflehog) over every commit.
  A secret committed once and later deleted is still public in history; flipping
  visibility publishes the entire past. If anything turns up, rotate it and
  rewrite history (or don't go public). `.env*` is gitignored (except
  `.env.example`) — confirm no `.env` ever slipped in.
- **Audit for household PII.** This is a real two-person household assistant:
  check fixtures, tests, and committed logs for real phone numbers, WhatsApp
  JIDs, names, addresses, calendar contents, or anything personal. Code-switched
  Hebrew/English fixtures are exactly where a real message could hide. Scrub or
  synthesize before exposure.
- **Add a LICENSE.** No license today ⇒ default all-rights-reserved (others
  can view but not legally reuse). Decide intent — permissive (MIT/Apache-2.0)
  if it's a portfolio/learning showcase, or deliberately none — *before*
  publishing, and then the license badge becomes worth adding.
- **Upsides that land for free when public:** GitHub Actions minutes become
  unlimited; **branch protection becomes available on the free plan** (CLAUDE.md
  notes it's unavailable while private — going public is the cheapest way to get
  real merge gating instead of red-CI-by-discipline); and every badge workaround
  in §1 collapses to off-the-shelf dynamic services.
- **Think about the exposed attack surface.** Publishing reveals infra shape —
  the egress allowlist, provisioning scripts, the deploy recipe. None of it is
  secret-by-design, but skim it as an attacker would (e.g. does any sample
  config hint at host/EIP, bucket names, internal endpoints) before it's
  searchable.

## 11. Egress refresh: use `refresh`, not `apply`, on the timer — ✅ BUILT

The v1 egress timer re-ran `nftables.sh apply` (delete table → re-resolve DNS →
reload), which left a ~1-2s window every 15min where the table was absent and
egress failed OPEN. The `refresh` subcommand instead flushes + re-adds only the
nft set elements while the table/chain stay loaded — no fail-open window (a brief
fail-CLOSED at worst).

**Done (2026-06-23):** the `refresh` subcommand already existed in
`nftables.sh`; what was missing was the systemd wiring. Split into two units:
`hh-egress.service` now applies **boot-only** (creates the table;
`WantedBy=multi-user.target`), and the new `hh-egress-refresh.service` runs
`refresh` on the timer. `hh-egress.timer` now carries `Unit=
hh-egress-refresh.service` so it triggers refresh, not the destructive apply;
the refresh unit is ordered `After=hh-egress.service` (refresh needs the table
to exist). These are in-repo artifacts — installing/enabling them on the host
is the remaining manual step (folds into the §5 systemd-unit deferral).
**Future nicety (not done):** load the ruleset atomically (`nft -f` of a full
ruleset in one transaction) so even `apply` has no window at all.

## 12. AI / agent guardrails — gaps in the model layer

v1's guardrails are strong on durability (determinism lint + recovery replay),
the tool layer (risk tiers, confirm-before with execute-time revalidation, the
fire-and-fold park), and the credential boundary. The *model* layer is thinner.
Ranked against this project's actual threat model — two trusted members on a
burner number — so "low-risk today" is stated where it's true, along with the
trajectory that changes it.

- **Spend ceiling — the real backstop is a provider-side limit, not app code
  (reassessed 2026-06-23).** `maxRounds=8` caps a single turn; nothing in the
  app caps *cumulative* spend. But the right control is the **Anthropic Console
  customer-set monthly spend limit** (Settings → Limits → Spend limits), ideally
  on a **dedicated non-default workspace with its own API key** so this project's
  spend is ring-fenced from the rest of the org (you can't limit the *default*
  workspace, so isolation needs a named one). That backstop is enforced
  provider-side on the **dollar total**, regardless of code path, process count,
  or app health — so it still holds in the one case a code counter can't: a
  **crash-loop** re-making the un-journaled resume call each retry, where the
  counter may be the very thing failing to commit. Zero code, zero schema, no
  pricing drift. Set it near the T33 budget ($30/mo) or a comfortable multiple;
  the Tier-1 ceiling is $500/mo, so a customer-set limit well below that is the
  knob. **Action: set this in the Console — do this first.**
  - Verified specifics (platform.claude.com/docs/en/api/rate-limits, 2026-06-23):
    spend limits are **calendar-month granularity only** (no daily option), and
    when the limit is reached the API simply **stops serving until next month**
    (no graceful degradation — ezra would start erroring).
  - **What durable execution already covers (so it is NOT the counter's job):**
    a *recovery storm* costs nothing — every `callModel` round is a journaled
    `DBOS.runStep`, so replay returns the cached output without re-calling the
    API (decision 3). `maxRounds=8` caps spend *within* a turn. So the counter
    is not needed for replay or within-turn runaway.
  - A code-level daily counter is therefore **optional and demoted to polish**.
    Its *only* genuine job is a forward cap on **new cumulative** spend across
    turns (debounce storm / chatty day / model calls in ungated paths) at
    **daily** granularity, plus a graceful "daily limit reached, back tomorrow"
    reply + ops alert instead of raw API errors. For a trusted two-person
    household on a low dollar cap, minor — defer unless the monthly cap is set
    high enough that a single bad day matters. Design if built: per-Eastern-day
    counter in structured state, accumulated via a `(workflowID, round)`-
    idempotent datasource transaction (the idempotency is **bookkeeping
    accuracy** — stopping the counter over-counting itself on replay — not spend
    prevention), checked before each model call. **Gate every model + embedding
    call site, not just the main rounds** — `summarize` (compaction), the
    relatedness classifier, and the Voyage embedder bypass a rounds-only gate, so
    a rounds-only counter would miss the "runaway compaction" case it is meant to
    catch. `callModel` (and those sites) must return usage in journaled output
    (today usage only escapes via the non-durable `onUsage` tracer tap).
- **Prompt-injection / untrusted-content fencing → ✅ Phase 0 shipped
  (`docs/adr-0005-untrusted-content-boundary.md`, Accepted 2026-06-24).** The
  gap: WhatsApp message text, recalled history, semantic-memory hits, and the
  digest all reached the model as authoritative, with no "this is data, not
  instructions" boundary. **Calendar had already shipped (ADR-0004), so this was
  a retrofit, not a pre-build.** Phase 0 added one canonical fence helper
  (`src/agent/untrusted.ts`) + a stable system-prompt data/instruction rule,
  applied at the point-of-provenance tools (calendar, recall, facts); an
  injection eval proved the model treats fenced third-party text as data. Phase 1
  (per-turn nonce marker, web/Q&A fencing, forwarded-message provenance) is
  deferred to M5. One workstream with memory-poisoning (below).
- **Memory-poisoning → ✅ closed by ADR-0005 Phase 0.** `set_fact` writes flowed
  back into later turns via `get_fact`/`recall` with no validation on the read
  path — a crafted value re-entering context (self-injection). Phase 0 fences
  `get_fact` and `recall_history` output as untrusted, and the poisoned-fact
  injection eval holds. Same "gets worse as the surface grows" trajectory as the
  injection gap — Phase 1 covers the growth.
- **No output moderation before send.** Nothing inspects the assistant's text
  between the model and WhatsApp. Acceptable for a trusted group — flagged only
  to record that the count is zero, not minimal.
- **Relatedness classifier is guarded only by an offline eval.** The
  architecture explicitly accepts the refine-vs-unrelated error modes for v1
  with eval coverage as the control — but that's an *offline* guard; a
  misclassification can still mis-route an approval at runtime. v2: consider a
  runtime confidence threshold that falls back to "ask the user which prompt you
  mean" rather than acting on a low-confidence classification.
- **HITL machinery is built but unexercised in production.** All eight v1 tools
  are `autonomous`; `notify-after` is unused and `confirm-before` +
  revalidation only gets real coverage when calendar arrives. The guardrail
  exists and is integration-tested, but its production behaviour (revalidation,
  execute-once, TTL expiry) is unproven on real traffic — fold a deliberate
  soak of the park/resume path into the calendar rollout.

Deliberately **out of scope, not gaps** (recorded so they aren't re-litigated):
per-member authorization (shared household by design — "no secrecy between
them"), transport warming / number provisioning, and real-traffic / real-model
testing in CI (excluded by policy).
