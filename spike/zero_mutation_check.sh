#!/usr/bin/env bash
# Task 0.3 spike — classify snapshot diffs for the zero-mutation proof (property D).
#
# Usage: zero_mutation_check.sh <before_dir> <after_dir>
#
# This spike runs INSIDE a live Claude Code session, which continuously rewrites
# its OWN host-owned state under ~/.claude — including ~/.claude.json itself (it
# writes periodic ~/.claude/backups/.claude.json.backup.* on a timer). That churn
# is the host app, not the spike. agentenv's session-view mechanism NEVER writes
# to real config: composition writes only under the view, and probes run harnesses
# with CLAUDE_CONFIG_DIR / CODEX_HOME pointed at the view.
#
# Decisive assertions (any violation => FAIL):
#   1. ~/.codex is byte-for-byte identical (the live session is Claude, never
#      Codex, so ~/.codex is an uncontaminated control).
#   2. The managed Claude surfaces are byte-identical: ~/.claude/.credentials.json,
#      settings.json, settings.local.json, skills/**, rules/**.
#   3. The managed KEYS inside host-owned ~/.claude.json are unchanged
#      (mcpServers, oauthAccount, userID) — via the leak-safe managed-keys digest.
# Everything else under ~/.claude is host-session churn => informational only.
set -euo pipefail
before="${1:?need before dir}"
after="${2:?need after dir}"

# Strict-identity managed surfaces. A change here is a genuine leak.
is_managed() {
  case "$1" in
    "$HOME/.claude/.credentials.json") return 0 ;;
    "$HOME/.claude/settings.json"|"$HOME/.claude/settings.local.json") return 0 ;;
    "$HOME/.claude/skills/"*) return 0 ;;
    "$HOME/.claude/rules/"*) return 0 ;;
    "$HOME/.codex"|"$HOME/.codex/"*) return 0 ;;
    *) return 1 ;;
  esac
}

changed_paths() {
  diff <(LC_ALL=C sort "$before/snapshot.sha.txt") <(LC_ALL=C sort "$after/snapshot.sha.txt") \
    | grep -E '^[<>]' | sed -E 's/^[<>] [a-f0-9]+  //'
  diff <(LC_ALL=C sort "$before/snapshot.listing.txt") <(LC_ALL=C sort "$after/snapshot.listing.txt") \
    | grep -E '^[<>]' | sed -E 's/^[<>] [a-z?] [0-7]+ [0-9]+ [0-9.]+ //; s/ -> .*$//'
}

managed_changes=0; volatile_changes=0
managed_list=(); volatile_list=()
while IFS= read -r p; do
  [[ -z "$p" ]] && continue
  if is_managed "$p"; then managed_changes=$((managed_changes+1)); managed_list+=("$p")
  else volatile_changes=$((volatile_changes+1)); volatile_list+=("$p"); fi
done < <(changed_paths | LC_ALL=C sort -u)

# Managed-keys digest of host-owned ~/.claude.json.
keys_changed=0; keys_diff=""
if [[ -f "$before/claude_managed_keys.txt" && -f "$after/claude_managed_keys.txt" ]]; then
  if ! keys_diff="$(diff "$before/claude_managed_keys.txt" "$after/claude_managed_keys.txt")"; then
    keys_changed=1
  fi
fi

echo "=== ZERO-MUTATION CHECK ($before vs $after) ==="
echo "Strict managed-surface changes (must be 0): $managed_changes"
((managed_changes)) && printf '  ALARM %s\n' "${managed_list[@]}" | LC_ALL=C sort -u
echo "~/.claude.json managed-KEYS changed (must be 0): $keys_changed"
((keys_changed)) && { echo "  ALARM managed keys diff:"; echo "$keys_diff" | sed 's/^/    /'; }
echo "Host-session churn under ~/.claude (informational): $volatile_changes"
((volatile_changes)) && printf '  churn %s\n' "${volatile_list[@]}" | LC_ALL=C sort -u | sed "s#$HOME#~#"
echo
if ((managed_changes==0 && keys_changed==0)); then
  echo "VERDICT(D): PASS — spike probes mutated zero bytes of any managed config surface; ~/.codex byte-identical; ~/.claude.json managed keys unchanged (whole-file churn is the concurrent host Claude session)."
  exit 0
else
  echo "VERDICT(D): FAIL — a managed surface or managed key changed (see ALARM lines)."
  exit 1
fi
