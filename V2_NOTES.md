# V2 Notes — streamlining build, deploy & ops

Captured during the v1 production deploy (T45, 2026-06-15) while standing the
agent up on the EC2 host by hand. Each item is grounded in friction that
actually bit, not speculation. The north star: **one command (or one merged
PR) takes a clean commit to a running, hardened, monitored process — and the
~Oct-2026 Hetzner migration is a provider swap, not a re-derivation.**

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

## 2. Provisioning as code (IaC) — decision locked: Pulumi TS

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
> (empty-diff gate met). **scratch create path PROVEN end-to-end:** a billable
> `pulumi up` ran cloud-init's full chain (Docker/Node → deploy-key SSH clone of
> the private repo → provision-host → SSM synthetic secret → GHCR private pull →
> compose up) to a running ezra (DBOS launched, 0 restarts) at the WhatsApp-
> pairing ceiling, then `destroy`ed. **Re-proven by a clean unattended boot of
> the fixed template (2026-06-23):** cloud-init done/errors:[], 0 failed units,
> egress timer active on cadence, ezra 0 restarts — no manual touch. Four
> fresh-box cloud-init bugs found+fixed (/run/sshd, /home/hh ownership, gpg
> --batch, and the egress timer triggering the §11 refresh unit the bootstrap
> didn't install). See **Fresh-box cloud-init gotchas** in `infra/pulumi/README.md`.

- The instance, EIP, security group, IAM user, and S3 backup bucket were all
  created by hand via AWS CLI (T15/T17) — plus the §1 deploy additions (the
  OIDC deploy role `AWS_DEPLOY_ROLE_ARN`, the instance role, and the
  `/hh-assistant/ghcr-pat` SSM parameter). v2: **Pulumi (TypeScript)** — one
  `pulumi up`, versioned, diffable. Chosen over Terraform for reproducibility +
  same-language-as-the-app; scope is **capability-only** (the resources we
  actually run), not a general AWS framework. This is what makes the
  ~Oct-2026 Hetzner migration a provider swap, not a re-derivation.
- **Import, don't replace.** Prod is live; the Pulumi program must `pulumi
  import` the existing resources into state and converge to a no-op diff —
  never recreate them (recreating the instance/EIP/bucket would be an outage +
  data loss). The host is `i-0a7e9f4767666ac9e`, account `001467466089`,
  region us-east-1. Sequence: scaffold the program from the live resource
  shapes (AWS CLI describe-*) → `pulumi import` each → run `pulumi up` until the
  diff is empty → only then is the hand-built infra under management.
- `infra/provision-host.sh` (OS baseline) is already idempotent and
  provider-portable — keep it, but invoke it from **cloud-init/user-data** so a
  fresh box self-bootstraps the `hh` user + SSH lockdown without a manual SSH.

## 3. Secrets management (SSM precedent set by §1; app `.env` still manual)

- v1: a hand-maintained `.env` scp'd to the host. Fragile and manual. **Still
  the case for the app secrets** — but §1's CD established the **SSM Parameter
  Store** path: the GHCR PAT now lives at `/hh-assistant/ghcr-pat` and the host
  self-fetches it at deploy time via its IAM identity. That's the precedent to
  extend the rest of the `.env` onto.
- **`POSTGRES_PASSWORD` is a footgun**: Postgres binds it at *first* data-dir
  init, so changing it in `.env` afterward silently breaks app auth (the deploy
  had to preserve the host-generated value across the `.env` load). Generate it
  **once** into a secret store, never inline per-deploy.
- v2 options: lean into **AWS SSM Parameter Store / Secrets Manager** (already
  proven for the GHCR PAT; the host has the IAM identity), or **SOPS + age**
  committing an encrypted `.env.enc` to the repo (we already run `age` for
  backups, so the tooling is in place). Either gives auditable, reproducible
  secret delivery and removes the manual scp. *(Deferred: prod-touching infra.)*

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
- **Still open — Node on the host only to render the egress allowlist** is
  awkward (the app is containerized). `nftables.sh` shells out to host `node
  render-allowlist.ts`. v2: render the allowlist to a static artifact at
  image-build time, or run the refresh as a tiny sidecar — drop the host Node
  dependency entirely. *(Deferred: firewall-adjacent infra, needs host
  coordination; folds into the §5 systemd workstream.)*

## 5. Egress firewall automation (units authored; host install + 2 items open)

- **systemd unit + timer — authored in-repo (2026-06-23, with §11):**
  `hh-egress.service` applies on boot (after docker, creates the table),
  `hh-egress-refresh.service` re-resolves rotating CDN IPs on
  `hh-egress.timer`. Installing/enabling them on the host is the remaining
  manual step (deferred infra).
- **Narrow sudoers — already exists** (`infra/host/sudoers-hh-ops`): NOPASSWD
  scoped to `systemctl {start,stop,restart,status}` of the three egress units
  only (not `nft` directly, not blanket `systemctl`, never `ALL`). Updated with
  §11's refresh unit.
- **Still open — pin the egress bridge name.** It's dynamic (`br-<id>`, greped
  from `docker network inspect`); pin it via compose
  (`com.docker.network.bridge.name`) so the firewall config is static and the
  units need no lookup (drops the re-derivation in both ExecStarts + the
  Makefile). Small, but touches the prod compose network.
- **Still open — cloud-layer defense-in-depth.** The security-group egress is
  default-open; tighten it (e.g. 443 + 53, plus a lane for host apt) as a coarse
  second layer — carefully, since SG rules also govern the host's own traffic.
  *(Lands with §2 IaC, handled separately.)*

## 6. Backups — close the open wiring (manual script exists; automation open)

- The backup sidecar needs a replication `pg_hba` line; the stock pgvector image
  only trusts replication from localhost (the T17 open item).
  `infra/backup/enable-replication.sh` exists and closes this **as an idempotent
  manual post-step** (appends `host replication hh samenet scram-sha-256`,
  reloads). Still open: bake the line (+ ideally a least-priv `hh_backup
  REPLICATION` role rather than reusing the `hh` superuser) into a Postgres init
  script (`/docker-entrypoint-initdb.d/`) so continuous WAL works on **first
  boot**, not as a hand-run step after every rebuild.
- **Still open:** schedule base backups declaratively (host timer /
  compose-managed cron), and surface backup-freshness to the monitoring channel.
  *(Deferred: prod-touching DB infra.)*

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
