#!/usr/bin/env bash
# Task 0.3 spike — compose a Codex CLI session VIEW using the two-bucket rule.
# Writes ONLY under $view_dir. Reads (never writes) the real ~/.codex config.
#
# Usage: compose_view_codex.sh <view_dir> <mcp_server_id> <codeword> <auth_standin>
#
# BUCKET 1 (pass-through to real auth so login survives):
#   - $view_dir/auth.json -> symlink to the REAL auth file.
#     Real ~/.codex/auth.json does NOT exist here (Codex is not logged in), so we
#     symlink to a STAND-IN to prove the mechanism: codex resolves auth at
#     $CODEX_HOME/auth.json and follows a symlink there. LIVE login pass-through
#     is UNTESTED because no Codex account is configured on this machine.
# BUCKET 2 (managed surfaces authored by us, disjoint per view):
#   - $view_dir/config.toml  [mcp_servers.<id>]   (isolated MCP set)
#   - $view_dir/AGENTS.md                          (isolated instructions)
#   - $view_dir/skills/agentenv-spike/SKILL.md     ($CODEX_HOME/skills — legacy, UNVERIFIED loader)
set -euo pipefail
view="${1:?need view_dir}"
server="${2:?need mcp server id}"
codeword="${3:?need codeword}"
standin="${4:?need auth standin path}"

mkdir -p "$view/skills/agentenv-spike"

# --- BUCKET 1: auth pass-through via symlink (mechanism test) ---
ln -sfn "$standin" "$view/auth.json"

# --- BUCKET 2: managed config.toml with a distinctive MCP server ---
cat > "$view/config.toml" <<EOF
# agentenv spike managed config for view ${codeword}
[mcp_servers.${server}]
command = "/bin/echo"
args = ["marker-${codeword}"]
EOF

# --- BUCKET 2: managed instructions ---
cat > "$view/AGENTS.md" <<EOF
# agentenv-spike environment marker
You are running inside the agentenv spike view. The secret codeword is ${codeword}.
This instruction belongs to exactly one view and must never leak to another.
EOF

# --- BUCKET 2: managed skill (legacy \$CODEX_HOME/skills location) ---
cat > "$view/skills/agentenv-spike/SKILL.md" <<EOF
---
name: agentenv-spike
description: Spike marker skill for view ${codeword}.
---
When invoked, state that the agentenv-spike codeword for this view is ${codeword}.
EOF

echo "composed codex view at $view (server=$server codeword=$codeword)"
