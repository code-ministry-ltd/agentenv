#!/usr/bin/env bash

# Run the packed-artifact two-machine restore proof inside a clean Node 22 Linux
# container. The checkout is copied to a temporary context so neither npm nor
# the smoke test can mutate the caller's working tree.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/agentenv-container-XXXXXX")"

cleanup() {
  rm -rf "$WORK"
}
trap cleanup EXIT

if ! command -v docker >/dev/null 2>&1; then
  echo "test:restore:container requires Docker" >&2
  exit 1
fi

git -C "$REPO_ROOT" archive --format=tar HEAD | tar -xf - -C "$WORK"

# Include working-tree changes when the gate is run before commit.
git -C "$REPO_ROOT" diff --binary HEAD | git -C "$WORK" apply --allow-empty

docker run --rm \
  --mount "type=bind,src=$WORK,dst=/workspace" \
  --workdir /workspace \
  --env GIT_CONFIG_GLOBAL=/dev/null \
  --env GIT_CONFIG_SYSTEM=/dev/null \
  node:22-bookworm \
  bash -lc 'node --version; npm ci; npm run smoke:install'
