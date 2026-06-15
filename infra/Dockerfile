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

# Drop to the stock unprivileged `node` user; the rootfs is mounted read-only
# at runtime, so the process can only write the volumes compose grants it.
USER node

# start.ts sets a per-generation DBOS__VMID before importing the SDK, then
# hands off to main.ts (the dbos.md launch-recovery recipe).
CMD ["node", "dist/start.js"]
