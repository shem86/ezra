# backoffice/scripts — running and debugging the console locally

Three scripts, one shared fixture set:

| script | what it's for | needs a backend? |
|---|---|---|
| `mock-api.mjs` | **browse the console yourself**, in a real browser | no — it *is* the backend |
| `mock-shots.mjs` | regenerate the README screenshots | no — intercepts `/api` in-page |
| `ui-debug.mjs` | headless sweep for errors, for agents | yes — a live console |

`fixtures.mjs` holds the fabricated, non-PII data the first two share, so the
screenshots and the browsable app can never drift apart. Its timestamps are
absolute rather than relative to now — screenshots have to be byte-stable or
every regeneration produces a diff.

## Just show me the console

```bash
pnpm -C backoffice install    # once
pnpm -C backoffice dev:mock   # fixtures on :8787 + vite on :5173
```

Open **http://localhost:5173** — no Postgres, no Langfuse, no prod host, no
household data. Vite already proxies `/api` to `:8787` (see `vite.config.ts`);
`dev:mock` just starts both and shuts them down together. `pnpm -C backoffice
mock-api` runs the fixture server alone if you'd rather drive vite yourself.

The chart motion is **update-only** by design, so it shows where the data
actually changes: on **Logs**, the level filter and the search box re-derive both
charts and the marks tween between shapes. A fresh page load has nothing to
animate from.

## ui-debug

`ui-debug.mjs` is a headless screenshot + inspection sweep of the read-only
console, built so an **agent can debug the UI with no computer-use and no human
clicking**. The SPA is hash-routed, so every page is a distinct URL; the script
loads each one, screenshots it full-height, and captures console errors, uncaught
page errors, failed requests, and HTTP≥400 responses from the `/api` calls each
screen depends on. Output is a set of PNGs plus a `report.json` the agent reads
back.

It drives the **installed Google Chrome** (`channel:'chrome'`) — no bundled
browser download (that's why `infra/Dockerfile` sets
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`).

## Run

```bash
# Against a local boot (see below). No token → exercises the 401/error states.
pnpm -C backoffice ui:debug

# Against the live tailnet console, authed. Keep the token OUT of the URL/history:
BACKOFFICE_URL=https://ezra-backoffice.<tailnet>.ts.net \
BACKOFFICE_TOKEN="$(your-secret-source)" \
pnpm -C backoffice ui:debug
```

PNGs + `report.json` land in `backoffice/artifacts/ui/` (git-ignored). Exit code
is non-zero when any page has errors (so it doubles as a CI smoke gate); set
`UI_DEBUG_SOFT=1` to always exit 0.

## Env

| var | default | meaning |
|---|---|---|
| `BACKOFFICE_URL` | `http://localhost:8787` | target origin |
| `BACKOFFICE_TOKEN` | — | bearer token; sent as `Authorization` header, never in the URL |
| `UI_DEBUG_OUT` | `backoffice/artifacts/ui` | output dir |
| `UI_DEBUG_ROUTES` | all five | comma list, e.g. `costs,status` |
| `UI_DEBUG_VIEWPORT` | `1440x960` | `WxH` |
| `UI_DEBUG_SOFT` | — | `1` → always exit 0 |

## Local boot target

The console runs as its own process (`dist/backoffice/cli.js`). To point the
script at a populated local instance against the dev DB:

```bash
docker compose up -d                      # dev Postgres
pnpm build && pnpm -C backoffice build    # compile server + SPA
# Reuse the dev .env for the shared data-source keys (Langfuse/Anthropic/etc.);
# set a throwaway token + the dev DB as the SELECT-only URL for the console.
env $(grep -vE '^\s*#' .env | xargs) \
  BACKOFFICE_TOKEN=local-dev-token-string-at-least-32-chars-long \
  BACKOFFICE_DATABASE_URL="$DATABASE_URL" \
  node dist/backoffice/cli.js
```

Then in another shell, run `ui:debug` with the same `BACKOFFICE_TOKEN`.
