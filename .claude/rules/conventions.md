# Code conventions and tooling quirks

## TypeScript / style

- Strict TS; no `any` at module boundaries. Zod at every boundary: inbound
  messages, tool args, model outputs, env.
- kebab-case filenames, camelCase symbols, **no default exports**.
- Dependency injection via a `deps` object — no module-level singletons in
  `src/` (workflow testability requirement). Spikes (`spikes/`) are exempt.
- `src/ops/config.ts` is the ONLY module that reads `process.env` or secrets.
  Everything else receives a `Config` through `deps`.
- Comments explain constraints the code can't show (e.g. why an order of
  operations is load-bearing), not what the next line does.

## Module layout (SPEC "Project Structure")

`src/transport` (Baileys, send classes, sent-log) · `src/orchestration`
(workflows, queues, debounce, scheduled) · `src/agent` (handleTurn, prompts,
compaction) · `src/tools` (defineTool: Zod schema, risk tier, idempotency,
revalidation) · `src/memory` (structured + semantic stores) · `src/hitl`
(pending_actions, approval binding) · `src/ops` (health, alerts, config).
Tests mirror `src/` under `tests/unit` and `tests/integration`.

## Dependencies

- pnpm with `save-exact` (`.npmrc`) — every dep pinned, lockfile committed in
  any commit touching deps.
- Adding a dependency is **ask-first** (SPEC); WhatsApp-adjacent packages get
  a full transitive review.

## Tooling quirks (verified on this repo — don't rediscover)

- **TypeScript 6 no longer auto-includes `node_modules/@types`** — tsconfig
  carries an explicit `"types": ["node"]`. If a new global type is missing,
  extend that array; don't drop it.
- `tsconfig.json` `include` is `src/` only. `tests/`, `spikes/`, and
  `eslint-rules/` are transformed by vitest / Node type-stripping, not by
  `pnpm build` — type errors there surface in the editor and at runtime, not
  in the build.
- Node 22.18+ strips types by default: `.ts` files run directly with `node`
  (used by spikes and by `eslint.config.js` importing the custom rule).
  Erasable-syntax only (no enums/namespaces) in files run this way.
- `eslint.config.js` is flat config; the custom determinism rule is wired for
  `src/**` as `hh/no-nondeterminism-in-workflow`, severity error.
- `.gitignore` ignores `.env.*` but excepts `.env.example` — keep the
  exception when touching ignore rules.
