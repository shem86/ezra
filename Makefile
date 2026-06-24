# hh-assistant operator targets (V2_NOTES §4/§7).
#
# Purpose: stop hand-typing the load-bearing compose flags. With `-f infra/...`
# the compose project dir becomes infra/, so ${POSTGRES_PASSWORD} interpolation
# looks for infra/.env and misses the repo-root .env — `--env-file .env` points
# it back (runtime.md "Deploy"). Every target below bakes both flags in.
#
# Run from the repo root. Deploying is NOT here on purpose: cut a release with
# `pnpm release vX.Y.Z` (CI builds the image, the GitHub release fires the SSM
# deploy — CLAUDE.md "Deploying"). These targets are for on-host/manual ops.

COMPOSE := docker compose --env-file .env -f infra/docker-compose.prod.yml
# The egress bridge name is pinned STATICALLY in docker-compose.prod.yml
# (com.docker.network.bridge.name, V2_NOTES §5) — no `docker network inspect`
# derivation. Mirrors the hh-egress.service ExecStart's EGRESS_IFACE.
EG = hh-egress0

.PHONY: help pair up down ps logs restart config-smoke egress-apply egress-refresh

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

pair: ## One-time Baileys QR pairing INSIDE the container (mounts the session volume; needs a live TTY). Re-pair on any move — never restore session state.
	$(COMPOSE) run --rm --no-deps -it ezra node dist/transport/pair-cli.js

up: ## Start the hardened prod stack (detached)
	$(COMPOSE) up -d

down: ## Stop the stack
	$(COMPOSE) down

ps: ## Show stack status
	$(COMPOSE) ps

logs: ## Follow ezra logs
	$(COMPOSE) logs -f ezra

restart: ## Restart ezra (config/.env reload)
	$(COMPOSE) restart ezra

config-smoke: ## §8 pre-flight: validate compose interpolation + loadProductionConfig in the real image, no traffic
	$(COMPOSE) config -q
	$(COMPOSE) run --rm --no-deps ezra \
		node -e 'import("./dist/ops/config.js").then(m => { m.loadProductionConfig(); console.log("config OK"); })'

egress-apply: ## Boot-time egress ruleset (creates the nft table). Needs root (nft). Normally hh-egress.service does this.
	sudo EGRESS_IFACE="$(EG)" infra/egress/nftables.sh apply

egress-refresh: ## Re-resolve CDN IPs into the live nft sets (no fail-open window). Needs root. Normally the timer does this (§11).
	sudo EGRESS_IFACE="$(EG)" infra/egress/nftables.sh refresh
