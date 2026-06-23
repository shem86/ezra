#!/usr/bin/env bash
# infra/deploy/release.sh — cut a release in one push-button step.
#
#   tag vX.Y.Z  →  push  →  WAIT for the CI image build to go green  →
#   gh release create  (publishing fires .github/workflows/deploy.yml → SSM deploy)
#
# The sequencing matters and is the whole reason this script exists: the deploy
# does NOT wait for the image (publishing the release fires it independently),
# so the image must already be green in GHCR before we publish. Doing this by
# hand means watching Actions and remembering to come back — easy to publish
# early and deploy a tag whose image doesn't exist yet. This blocks on the build.
#
# Usage:
#   pnpm release v2.1.0           # or: bash infra/deploy/release.sh v2.1.0
#   pnpm release v2.1.0-rc.1      # prerelease (still fires the deploy — rc dry-run)
#
# Redeploys / rollbacks of an ALREADY-released tag don't go through here — use
# Actions → Deploy → Run workflow (workflow_dispatch with the tag), per CLAUDE.md.
#
# The CD gate is by discipline (branch protection is unavailable while private,
# §10): this refuses to cut unless you're on a clean main that matches origin.
set -euo pipefail

VERSION="${1:?usage: release.sh vX.Y.Z   (e.g. v2.1.0, or v2.1.0-rc.1)}"
REMOTE="${RELEASE_REMOTE:-origin}"
CI_WORKFLOW="ci.yml"
DEPLOY_WORKFLOW="deploy.yml"

# vX.Y.Z with an optional -prerelease suffix. CI's metadata-action strips the
# leading v for the image tag; the git tag and the GitHub release keep it.
if [[ ! "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "error: '$VERSION' is not vX.Y.Z (optionally -rc.N)" >&2
  exit 1
fi
# A '-suffix' means prerelease — mark the GitHub release as such so it sorts
# below stable, but it still publishes and still fires the deploy (rc dry-run).
# Plain string, not an array: macOS ships bash 3.2, where expanding an empty
# array under `set -u` throws. A single space-free flag is safe unquoted.
PRERELEASE_FLAG=""
[[ "$VERSION" == *-* ]] && PRERELEASE_FLAG="--prerelease"

# --- guards: clean, up-to-date main; tag is new ------------------------------
branch="$(git rev-parse --abbrev-ref HEAD)"
[[ "$branch" == "main" ]] \
  || { echo "error: on '$branch', not main — only cut releases off green main (§10)" >&2; exit 1; }
[[ -z "$(git status --porcelain)" ]] \
  || { echo "error: working tree is dirty — commit or stash first" >&2; exit 1; }
git fetch --quiet "$REMOTE" main
[[ "$(git rev-parse HEAD)" == "$(git rev-parse "$REMOTE/main")" ]] \
  || { echo "error: local main != $REMOTE/main — pull/push so the tag matches what's built" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/$VERSION" >/dev/null \
  && { echo "error: tag $VERSION already exists — bump the version or delete the tag" >&2; exit 1; } || true

echo "==> tagging $VERSION on $(git rev-parse --short HEAD) and pushing to $REMOTE"
git tag "$VERSION"
git push "$REMOTE" "$VERSION"

# --- wait for the CI image build on this tag to go green ----------------------
# A tag push starts a CI run whose head_branch is the tag name, which isolates
# it from the same-SHA main run. Give Actions a moment to register it.
echo "==> waiting for the CI build on $VERSION (image push to GHCR) to go green"
run_id=""
for _ in $(seq 1 30); do
  run_id="$(gh run list --workflow "$CI_WORKFLOW" --event push --branch "$VERSION" \
    --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)"
  [[ -n "$run_id" ]] && break
  sleep 2
done
[[ -n "$run_id" ]] \
  || { echo "error: no CI run found for $VERSION after 60s — check Actions; the tag is pushed, so publish manually once green: gh release create $VERSION $PRERELEASE_FLAG" >&2; exit 1; }
echo "    watching CI run $run_id (Ctrl-C is safe — the tag is already pushed)"
gh run watch "$run_id" --exit-status --compact

# --- publish the release → fires the deploy ----------------------------------
echo "==> CI green; publishing release $VERSION (this fires the SSM deploy)"
# $PRERELEASE_FLAG is intentionally unquoted: empty → no arg; else --prerelease.
gh release create "$VERSION" --generate-notes --title "$VERSION" $PRERELEASE_FLAG

# --- follow the deploy to its outcome (best-effort) --------------------------
echo "==> released $VERSION — following the deploy"
deploy_id=""
for _ in $(seq 1 30); do
  deploy_id="$(gh run list --workflow "$DEPLOY_WORKFLOW" --event release \
    --limit 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)"
  [[ -n "$deploy_id" ]] && break
  sleep 2
done
if [[ -n "$deploy_id" ]]; then
  gh run watch "$deploy_id" --exit-status --compact
  echo "==> $VERSION is live."
else
  echo "    (couldn't resolve the deploy run — track it in Actions → Deploy)"
fi
