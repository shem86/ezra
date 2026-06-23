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
- **Auto-update the README lines-of-code badge.** The badge is currently a
  *static* shields.io badge (`lines of code | 6.6k`, counting `src/`) because
  the repo is private — tokei.rs / codetabs / shields dynamic endpoints all
  fetch over the public API and return nothing for a private repo. To make it
  live: a CI step counts `src/` LOC on push (e.g. `git ls-files 'src/**/*.ts' |
  xargs wc -l`, or `cloc`), writes the number to a **public gist**, and the
  README points at a shields.io *dynamic* badge that reads the gist
  (`schneegans/dynamic-badges-action` is the standard recipe). Needs a gist +
  a `GIST` token secret. Until then the static number goes stale and must be
  bumped by hand.
- **CI status badge (private-repo caveat).** The README now carries
  `actions/workflows/ci.yml/badge.svg`. On a **private** repo it 404s for
  anyone not authenticated with repo access — so it's blank for the public and
  only renders for us. It starts working anonymously the moment the repo goes
  public (§10); no action needed until then, just don't be surprised it's empty
  in an incognito window.
- **Test-count / coverage badges ride the same gist pipeline.** Once the LOC
  gist workflow exists, a `tests | N` badge is nearly free (vitest already
  reports the count — emit it to the gist in the same CI step). A `coverage |
  N%` badge additionally needs `vitest --coverage` wired up. Both face the same
  private-repo constraint as LOC, so fold them into the one gist workflow
  rather than standing up more static, hand-bumped numbers. If the repo goes
  public, **all** of these collapse to off-the-shelf dynamic services
  (tokei.rs for LOC, the native Actions/coverage badges) and the gist
  workaround can be deleted.

## 2. Provisioning as code (IaC)

> **In progress → `infra/pulumi/` (Pulumi, TypeScript).** Decision: **Pulumi**
> (stays in the repo's one language). Goal reframed with the builder —
> reproducibility as a *capability* (stand up a new env easily), not just the
> Hetzner swap. Two stacks: `prod` adopts the live resources (each carries an
> `import` id + `protect`) and `scratch` proves create-from-zero. cloud-init runs
> `provision-host.sh` for a full-chain bootstrap (this note's second bullet).
> **prod adopt APPLIED (2026-06-23):** state backend live (S3); `pulumi up`
> imported all 17 resources with **0 replacements / 0 destroys** (additive
> management tags only; instance 🔒 protected, NOT replaced — same original launch
> time, EIP intact, Baileys/pgdata untouched). Post-apply preview = 21 unchanged
> (empty-diff gate met). scratch create-graph plans 10 from zero. **Remaining:** a
> private-repo deploy key for a real scratch full-chain `up`. See
> `infra/pulumi/README.md`.

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

## 11. Egress refresh: use `refresh`, not `apply`, on the timer

The v1 egress timer re-runs `nftables.sh apply` (delete table → re-resolve DNS →
reload), which leaves a ~1-2s window every 15min where the table is absent and
egress fails OPEN. The `refresh` subcommand instead flushes + re-adds only the
nft set elements while the table/chain stay loaded — no fail-open window (a brief
fail-CLOSED at worst). v2: timer triggers a refresh-only path; `apply` runs only
on boot to create the table. Even better: load the ruleset atomically so there's
no window at all.

## 12. AI / agent guardrails — gaps in the model layer

v1's guardrails are strong on durability (determinism lint + recovery replay),
the tool layer (risk tiers, confirm-before with execute-time revalidation, the
fire-and-fold park), and the credential boundary. The *model* layer is thinner.
Ranked against this project's actual threat model — two trusted members on a
burner number — so "low-risk today" is stated where it's true, along with the
trajectory that changes it.

- **No runtime cost/spend ceiling — the one genuinely-missing control for the
  system as it stands today.** `maxRounds=8` caps a single turn's model calls,
  but nothing caps *cumulative* spend: no daily token budget, no dollar ceiling,
  no circuit breaker on the metered Console key. A debounce storm, a runaway
  compaction, or just a chatty day has no kill-switch — the blast radius is a
  surprise bill. Asymmetric with how much the architecture already cares about
  cost (prompt-caching is gated, yet there's no runtime backstop). Cheap to
  close: a per-day token/cost counter in structured state with a hard stop +
  alert to the monitoring channel. Do this first.
- **No prompt-injection / untrusted-content fencing.** WhatsApp message text,
  recalled history, semantic-memory hits, and the digest all reach the model as
  authoritative — no provenance separation, no "this is data, not instructions"
  boundary anywhere. Low-risk while both senders are trusted, but that ends the
  moment the tool surface grows: **calendar invites, forwarded messages, and
  pasted list items are third-party content**, and the M5 household-Q&A / any
  web path injects fully untrusted text. Design the data/instruction boundary
  *before* calendar + Q&A land, not as a retrofit after.
- **Memory-poisoning is unguarded.** `set_fact` writes flow back into later
  turns via `recall` and the digest, with no validation on the recall path — a
  crafted fact value persists and re-enters context (a self-injection vector).
  Same trust caveat and same "gets worse as the surface grows" trajectory as the
  injection gap; treat them as one workstream.
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
