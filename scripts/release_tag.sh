#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: ./scripts/release_tag.sh vX.Y.Z" >&2
  exit 1
fi
TAG="$1"

git status --porcelain | grep -q . && { echo "Working tree not clean" >&2; exit 1; }

git tag "$TAG"
git push origin "$TAG"

echo "Pushed tag $TAG"
