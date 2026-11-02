#!/usr/bin/env bash
# Renders docs/diagrams/*.mmd → docs/assets/diagrams/*.png for the README, and
# records each source's sha256 in docs/assets/diagrams/manifest.json.
#
# Why images, not ```mermaid blocks: the GitHub mobile app never renders
# Mermaid, and the README is what an interviewer opens from a link on their
# phone — raw source there reads as broken. White background so the image
# reads in both light and dark themes.
#
# Why the manifest: `pnpm check:docs` (assertion F) fails when a source's hash
# no longer matches, so editing a .mmd without re-running this goes red in CI.
# CI never renders — it only compares hashes.
#
# mermaid-cli runs via a pinned npx, not a package.json dep: it pulls
# puppeteer/Chromium, which has no place in the app's dependency tree.
set -euo pipefail
cd "$(dirname "$0")/.."
out_dir=docs/assets/diagrams
mkdir -p "$out_dir"
for src in docs/diagrams/*.mmd; do
  npx -y @mermaid-js/mermaid-cli@11.4.2 -i "$src" -o "$out_dir/$(basename "${src%.mmd}").png" -s 2 -b white
done
node -e '
const { createHash } = require("node:crypto");
const { readFileSync, readdirSync, writeFileSync } = require("node:fs");
const manifest = {};
for (const f of readdirSync("docs/diagrams").filter((f) => f.endsWith(".mmd")).sort())
  manifest[f.replace(/\.mmd$/, "")] = createHash("sha256").update(readFileSync("docs/diagrams/" + f)).digest("hex");
writeFileSync(process.argv[1] + "/manifest.json", JSON.stringify(manifest, null, 2) + "\n");
' "$out_dir"
