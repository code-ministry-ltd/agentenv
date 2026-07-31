#!/usr/bin/env bash
# Task 0.3 spike — zero-mutation snapshot tool.
# Snapshots the REAL user config (read-only) so we can prove the spike probes
# mutate ZERO bytes outside the view/spike root.
#
# Usage: snapshot.sh <label> <out_dir>
#   label   e.g. B0 (before) / B1 (after)
#   out_dir where the snapshot files are written
#
# Targets: ~/.claude (dir), ~/.claude.json (file), ~/.codex (dir).
# For each: a listing (perms/size/mtime/path/symlink-target) + a sha256 map of
# every regular file. Symlinks are recorded by target, never followed for sha.
set -euo pipefail

label="${1:?need label}"
out="${2:?need out_dir}"
mkdir -p "$out"

targets=("$HOME/.claude" "$HOME/.claude.json" "$HOME/.codex")

listing="$out/snapshot.listing.txt"
shafile="$out/snapshot.sha.txt"
: > "$listing"
: > "$shafile"

for t in "${targets[@]}"; do
  if [[ ! -e "$t" ]]; then
    echo "MISSING $t" >> "$listing"
    continue
  fi
  # Listing: type, perms, size, mtime(epoch), path, -> symlink target
  # -print0 + sort -z keeps it stable across runs.
  find "$t" -printf '%y %m %s %T@ %p -> %l\n' 2>/dev/null | LC_ALL=C sort >> "$listing"
  # sha256 of every regular file (not symlinks), stable-sorted by path.
  while IFS= read -r -d '' f; do
    sha256sum "$f"
  done < <(find "$t" -type f -print0 2>/dev/null) | LC_ALL=C sort -k2 >> "$shafile"
done

# Leak-safe managed-keys digest of ~/.claude.json. This file is host-OWNED (the
# running Claude app rewrites it on its own cadence), so its whole-file hash is
# not a spike signal. What matters is that the surfaces agentenv would manage are
# untouched, so we digest ONLY those keys (hashes, never raw secret values).
if [[ -f "$HOME/.claude.json" ]]; then
  python3 - "$HOME/.claude.json" "$out/claude_managed_keys.txt" <<'PY'
import json, sys, hashlib
d = json.load(open(sys.argv[1]))
def dig(x): return hashlib.sha256(json.dumps(x, sort_keys=True).encode()).hexdigest()
lines = [
    "mcpServers.names " + ",".join(sorted((d.get("mcpServers") or {}).keys())),
    "mcpServers.sha " + dig(d.get("mcpServers")),
    "oauthAccount.present " + str("oauthAccount" in d),
    "oauthAccount.sha " + dig(d.get("oauthAccount")),
    "userID.sha " + dig(d.get("userID")),
]
open(sys.argv[2], "w").write("\n".join(lines) + "\n")
PY
fi

echo "snapshot[$label] listing=$(wc -l < "$listing") files, sha=$(wc -l < "$shafile") files -> $out"
