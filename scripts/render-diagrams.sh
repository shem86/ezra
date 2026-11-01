#!/usr/bin/env bash
# Renders docs/diagrams/*.mmd → docs/assets/diagrams/*.png for the README.
# The README embeds PNGs, not ```mermaid blocks, because the GitHub mobile app
# never renders Mermaid — readers there saw raw source. White background so the
# image reads in both light and dark themes. mermaid-cli is run via a pinned
# npx (not a package.json dep) — it pulls puppeteer/Chromium, which has no
# place in the app's dependency tree.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p docs/assets/diagrams
for src in docs/diagrams/*.mmd; do
  out="docs/assets/diagrams/$(basename "${src%.mmd}").png"
  npx -y @mermaid-js/mermaid-cli@11.4.2 -i "$src" -o "$out" -s 2 -b white
done
