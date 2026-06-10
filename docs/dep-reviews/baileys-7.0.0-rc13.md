# Dependency review: baileys@7.0.0-rc13 (+ qrcode-terminal@0.12.0)

Date: 2026-06-09 · Reviewer: Claude (builder approved pin 2026-06-09)
Trigger: T11 — WhatsApp-adjacent packages get a full transitive review (SPEC "Ask first").

## Direct dependencies added

| Package | Version | Why | Notes |
|---|---|---|---|
| `baileys` | 7.0.0-rc13 (exact) | WhatsApp Web transport (architecture decision 1) | npm `latest`; same pin OpenClaw ships in production. Hermes pins a git commit slightly ahead of it. 6.7.23 ("legacy") was rejected: it pulls `libsignal` from a git URL, which defeats exact-pinning. |
| `qrcode-terminal` | 0.12.0 (exact) | Render pairing QR in the terminal | Zero transitive deps, no lifecycle scripts, ~200 LoC. Dormant since 2019 — low churn is acceptable for a pure renderer. Same renderer Hermes uses. **Added beyond the original pin approval — flagged to builder, awaiting veto/ok.** |

## Transitive surface (37 new packages)

async-mutex, atomic-sleep, cacheable, content-type, curve25519-js,
eventemitter3, file-type, hashery, hookified (×2 majors), ieee754, keyv,
libsignal, long, lru-cache, media-typer, music-metadata, on-exit-leak-free,
p-queue, p-timeout, pino, pino-abstract-transport, pino-std-serializers,
process-warning, protobufjs, qified, quick-format-unescaped, real-require,
safe-stable-stringify, sonic-boom, strtok3, thread-stream, token-types,
uint8array-extras, whatsapp-rust-bridge, win-guid. (`ws` was already in the
tree via DBOS; baileys reuses the same version.)

## Findings

1. **Lifecycle scripts: none execute.** pnpm 10 blocks build scripts by
   default and none were approved. Only two exist in the whole tree:
   `baileys` preinstall (a Node ≥20 version check, read in full) and
   `protobufjs` postinstall (its well-known version stamp). Both benign,
   both blocked anyway. `import('baileys')` verified working with scripts
   blocked — keep it that way; do **not** run `pnpm approve-builds`.
2. **No native binaries.** `whatsapp-rust-bridge@0.5.4` (crypto/binary
   protocol acceleration) is wasm-bindgen output: a 1.9 MB JS bundle with
   the WASM embedded base64, executed inside V8's WASM sandbox. No
   node-gyp, no `.node` files, no platform-specific optional deps.
   Publisher `jlucaso1` is an upstream Baileys-org contributor and the
   package is a declared dependency of Baileys itself.
3. **Crypto provenance.** `libsignal@6.0.0` is published to npm by the
   WhiskeySockets org's CI (repo: WhiskeySockets/libsignal-node) — an
   improvement over 6.x-legacy's unpinnable git dependency.
   `curve25519-js@0.0.4` is old (2019) but tiny and pure-JS.
4. **Maintainer clusters are established.** jaredwray (keyv, cacheable,
   hookified, qified, hashery), the pino ecosystem, and Borewit
   (music-metadata, strtok3, token-types, file-type) account for most of
   the tree.
5. **Optional media peers excluded.** `sharp`, `jimp`, `audio-decode`,
   `link-preview-js` are skipped via `auto-install-peers=false` (.npmrc) —
   v1 is text-only. Revisit (and re-review) when media support lands.
6. **Egress note for T16.** `fetchLatestBaileysVersion()` fetches the
   current WhatsApp Web version from the WhiskeySockets GitHub repo at
   startup. Either allowlist `raw.githubusercontent.com` on the host or
   pass a static `version` to `makeWASocket` — decide at T16.

## Verdict

**Accept.** Risk is concentrated in the unofficial-protocol nature of
Baileys itself (architecture decision 1 accepts this; ban-risk mitigations
live in T13/T16), not in the dependency tree's hygiene. Blocked lifecycle
scripts + WASM-only native surface + egress allowlist (T16) bound the
supply-chain blast radius as designed.
