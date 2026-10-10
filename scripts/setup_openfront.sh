#!/usr/bin/env bash
# Downloads only the parts of OpenFrontIO I actually run, at the commit pinned in
# config/openfront.lock.json: the four engine packages, two JSON resources and the Australia map
# Add more maps with: MAPS="australia europe" npm run setup
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK="$ROOT/config/openfront.lock.json"
REPO="$(node -p "require('$LOCK').repository")"
COMMIT="$(node -p "require('$LOCK').commit")"
DEST="$ROOT/vendor/OpenFrontIO"
MAPS="${MAPS:-australia}"

PATHS=(
  /LICENSE
  /LICENSE-ASSETS
  /packages/engine/src/
  /packages/engine-api/src/
  /packages/engine-lib/src/
  /packages/zbin/src/
  /resources/QuickChat.json
  /resources/tribeNameThemes.json
)
for map in $MAPS; do PATHS+=("/resources/maps/$map/"); done

if [ ! -d "$DEST/.git" ]; then
  mkdir -p "$DEST"
  git -C "$DEST" init -q
  git -C "$DEST" remote add origin "$REPO"
fi

# Sparse checkout + blob filter: git downloads only the files listed above.
git -C "$DEST" sparse-checkout set --no-cone "${PATHS[@]}"
if [ "$(git -C "$DEST" rev-parse -q --verify HEAD || true)" != "$COMMIT" ]; then
  echo "Fetching OpenFrontIO $COMMIT"
  git -C "$DEST" fetch -q --depth 1 --filter=blob:none origin "$COMMIT"
  git -C "$DEST" checkout -q --detach FETCH_HEAD
else
  git -C "$DEST" checkout -q --detach "$COMMIT"
fi

echo "OpenFrontIO $(git -C "$DEST" rev-parse --short HEAD) ready in vendor/OpenFrontIO ($(du -sh "$DEST" | cut -f1)), maps: $MAPS"
