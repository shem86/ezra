# Production image for the Ezra process (T16). Multi-stage: a build stage with
# the full toolchain compiles dist/, a slim runtime stage carries prod deps
# only and runs as a non-root user. No secrets are ever baked in — they arrive
# at runtime via env_file (see docker-compose.prod.yml); .dockerignore keeps
# .env and the Baileys session out of the build context.
#
# Pinned to the locked stack: Node 22, pnpm 10.33.2 (package.json
# packageManager). The host firewall — not this image — enforces egress
# (infra/egress/nftables.sh, rendered from src/ops/egress-allowlist.ts).

# --- build -------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
# Lockfile-first for layer caching; --frozen-lockfile fails on any drift.
# .npmrc is load-bearing here, not optional: it carries auto-install-peers=false,
# which the lockfile records under settings.autoInstallPeers. Without it in the
# build context, in-image pnpm uses its default (true) and the frozen install
# rejects the mismatch (ERR_PNPM_LOCKFILE_CONFIG_MISMATCH).
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build

# Build the isolated backoffice SPA (its own lockfile + Vite/React toolchain,
# kept out of the app's deps — same isolation pattern as infra/pulumi). Emits
# backoffice/dist, which the runtime stage serves via dist/backoffice/cli.js.
COPY backoffice ./backoffice
# PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: the ui-debug script (backoffice/scripts) is
# a dev/ops tool that drives the *installed* Chrome (channel:'chrome') and never
# runs in the image — so skip Playwright's browser download here to keep the
# image build lean. The npm package (driver only) still installs from the lockfile.
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 pnpm -C backoffice install --frozen-lockfile && pnpm -C backoffice build

# --- runtime -----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
COPY package.json pnpm-lock.yaml .npmrc ./
# Prod deps only — no typescript/vitest/eslint in the running image.
# .npmrc copied for the same frozen-lockfile reason as the build stage.
RUN pnpm install --prod --frozen-lockfile && pnpm store prune
# Compiled output + the forward-only migrations the process applies at startup
# (migrate.ts resolves ../../migrations relative to dist/memory — a sibling of dist/).
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
# The built read-only console SPA — static assets the backoffice entry serves.
# (The backoffice server is app code in dist/backoffice; this is just its UI.)
COPY --from=build /app/backoffice/dist ./backoffice/dist

# Pre-create the Baileys session mount point owned by `node`. Load-bearing: the
# wa-session named volume mounts here, and Docker copies THIS directory's
# ownership into an empty volume on first use. Without it the fresh volume is
# root-owned, and the non-root (uid 1000) read-only-rootfs process cannot
# persist the session — Baileys then loops the pairing QR forever ("logging
# in…" never completes) because creds never save.
RUN mkdir -p /data/wa-session && chown -R node:node /data

# Drop to the stock unprivileged `node` user; the rootfs is mounted read-only
# at runtime, so the process can only write the volumes compose grants it.
USER node

# start.ts sets a per-generation DBOS__VMID before importing the SDK, then
# hands off to main.ts (the dbos.md launch-recovery recipe).
CMD ["node", "dist/start.js"]
