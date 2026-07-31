#!/usr/bin/env bash
# Task 0.3 spike — compose a Claude Code session VIEW using the two-bucket rule.
# Writes ONLY under $view_dir. Reads (never writes) the real ~/.claude config.
#
# Usage: compose_view_claude.sh <view_dir> <mcp_server_name> <codeword>
#
# BUCKET 1 (pass-through to real auth/state so login survives):
#   - $view_dir/.credentials.json  -> symlink to real ~/.claude/.credentials.json  (LIVE oauth token)
#   - identity/onboarding keys (oauthAccount,userID,hasCompletedOnboarding) copied
#     into the authored .claude.json (stable metadata; the volatile token stays a symlink)
# BUCKET 2 (managed surfaces authored by us, disjoint per view):
#   - $view_dir/.claude.json  mcpServers = {<mcp_server_name>}   (isolated MCP set)
#   - $view_dir/rules/agentenv-spike.md                          (isolated instructions)
#   - $view_dir/skills/agentenv-spike/SKILL.md                   (isolated skill)
#   - $view_dir/settings.json                                    (minimal, no host hooks)
set -euo pipefail
view="${1:?need view_dir}"
server="${2:?need mcp server name}"
codeword="${3:?need codeword}"
real_home="$HOME/.claude"
real_json="$HOME/.claude.json"

mkdir -p "$view/skills/agentenv-spike" "$view/rules"

# --- BUCKET 1: live token via symlink (never copied) ---
ln -sfn "$real_home/.credentials.json" "$view/.credentials.json"

# --- BUCKET 1 + BUCKET 2: authored .claude.json (identity carried, mcpServers managed) ---
python3 - "$real_json" "$view/.claude.json" "$server" "$codeword" <<'PY'
import json, sys
real_path, out_path, server, codeword = sys.argv[1:5]
real = json.load(open(real_path))
carry = {k: real[k] for k in (
    "oauthAccount","userID","machineID","firstStartTime","migrationVersion",
    "opusProMigrationComplete","sonnet1m45MigrationComplete",
) if k in real}
carry["hasCompletedOnboarding"] = True     # avoid interactive onboarding in a fresh root
carry["numStartups"] = real.get("numStartups", 1)
# BUCKET 2 managed surface: a single distinctive server, disjoint per view.
carry["mcpServers"] = {
    server: {"type": "stdio", "command": "/bin/echo", "args": [f"marker-{codeword}"]}
}
json.dump(carry, open(out_path, "w"), indent=2)
print(f"authored {out_path}: mcpServers={list(carry['mcpServers'])} oauthAccount={'oauthAccount' in carry}")
PY

# --- BUCKET 2: managed instructions (rules dir supports symlinks; here a plain file) ---
cat > "$view/rules/agentenv-spike.md" <<EOF
# agentenv-spike environment marker
You are running inside the agentenv spike view. The secret codeword is ${codeword}.
This instruction belongs to exactly one view and must never leak to another.
EOF

# --- BUCKET 2: managed skill ---
cat > "$view/skills/agentenv-spike/SKILL.md" <<EOF
---
name: agentenv-spike
description: Spike marker skill for view ${codeword}. Reveals the view's codeword.
---
When invoked, state that the agentenv-spike codeword for this view is ${codeword}.
EOF

# --- BUCKET 2: minimal settings (no host hooks/plugins) ---
cat > "$view/settings.json" <<'EOF'
{ "theme": "dark" }
EOF

echo "composed view at $view"
