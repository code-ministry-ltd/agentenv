#!/usr/bin/env bash
#
# Pack-and-install smoke test — the mechanical proof of Task 5.2's acceptance
# criterion:
#
#   "a stranger can install the GitHub checkout or release artifact and reach a
#    synced env on two harnesses using only the README."
#
# It does exactly what the README tells that stranger to do, against a REAL
# packed tarball installed into a clean prefix — not against the source tree:
#
#   1. npm pack                              → the release artifact
#   2. npm install -g <tgz> --prefix <tmp>   → a clean global install
#   3. machine A: init → create → add skill/instructions/mcp → remote → sync
#   4. machine B: init --remote → list
#   5. launch Codex through a composed private session view
#   6. use --global and assert TWO harnesses (Claude Code and Codex)
#   7. env-less drop --global and assert the surfaces were handed back
#
# SAFETY. Every agentenv invocation runs with BOTH `AGENTENV_HOME` and `HOME`
# pointed at throwaway temp directories, so:
#   - the real ~/.agentenv is never read or written;
#   - the real ~/.claude, ~/.claude.json, ~/.codex, ~/.config/opencode,
#     ~/.pi and ~/.cursor are never read or written — the adapters derive those
#     from homedir(), which follows $HOME;
#   - `$SANDBOX_HOME/.agentenv` is a TRAP: it is where a bug that ignored
#     AGENTENV_HOME would land, and the script fails if it ever appears. This is
#     the shell equivalent of test/helpers.ts `guardRealHome()`.
# npm itself runs with the real HOME so it keeps its cache; agentenv never does.
#
# No network: the sync remote is a local bare repo reached over file://.
#
# Usage: npm run smoke:install

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/agentenv-smoke-XXXXXX")"

PASSED=0
cleanup() {
  local status=$?
  if [ "$PASSED" = 1 ]; then
    rm -rf "$WORK"
  else
    echo ""
    echo "FAILED — sandbox left for inspection: $WORK"
  fi
  exit "$status"
}
trap cleanup EXIT

step() { echo ""; echo "=== $* ==="; }
ok()   { echo "  ok  $*"; }
die()  { echo "  FAIL  $*" >&2; exit 1; }

# --- assertions -------------------------------------------------------------

assert_exists() {
  [ -e "$1" ] || die "expected to exist: $1"
  ok "exists: ${1#"$WORK"/}"
}

assert_missing() {
  [ ! -e "$1" ] || die "expected NOT to exist: $1"
  ok "absent: ${1#"$WORK"/}"
}

assert_contains() {
  local file="$1" needle="$2"
  [ -f "$file" ] || die "expected a file at $file"
  grep -qF -- "$needle" "$file" || die "expected '$needle' in $file"
  ok "'$needle' in ${file#"$WORK"/}"
}

# --- the sandbox ------------------------------------------------------------

PREFIX="$WORK/prefix"
REMOTE="$WORK/remote.git"
A_AGENTENV="$WORK/machine-a/agentenv"; A_HOME="$WORK/machine-a/home"
B_AGENTENV="$WORK/machine-b/agentenv"; B_HOME="$WORK/machine-b/home"
mkdir -p "$PREFIX" "$A_AGENTENV" "$A_HOME" "$B_AGENTENV" "$B_HOME"

BIN="$PREFIX/bin/agentenv"

# Run the INSTALLED binary as a given simulated machine. HOME and AGENTENV_HOME
# are both sandboxed; a stable AGENTENV_SESSION stands in for the shell hook.
on_machine() {
  local agentenv_home="$1" home="$2"; shift 2
  HOME="$home" \
  AGENTENV_HOME="$agentenv_home" \
  AGENTENV_SESSION="smoke-$$" \
  PATH="$home/bin:$PREFIX/bin:$PATH" \
  GIT_CONFIG_GLOBAL="$home/.gitconfig" \
  GIT_CONFIG_SYSTEM=/dev/null \
  GIT_TERMINAL_PROMPT=0 \
  "$BIN" "$@"
}
a() { on_machine "$A_AGENTENV" "$A_HOME" "$@"; }
b() { on_machine "$B_AGENTENV" "$B_HOME" "$@"; }

# The guard: nothing may ever create <sandbox home>/.agentenv, because that is
# where resolvePaths() falls back when AGENTENV_HOME is ignored.
assert_no_home_fallback() {
  assert_missing "$A_HOME/.agentenv"
  assert_missing "$B_HOME/.agentenv"
}

# --- 1. pack ----------------------------------------------------------------

step "1. build and pack the release artifact"
cd "$REPO_ROOT"
npm run build >/dev/null
npm pack --pack-destination "$WORK" >/dev/null
TGZ="$(ls "$WORK"/code-ministry-agentenv-*.tgz)"
[ -f "$TGZ" ] || die "npm pack produced no tarball"
ok "packed $(basename "$TGZ")"

# The artifact must carry the built CLI, README, licence, and third-party notice
# — and NOT tests, docs, spike notes or CI config.
CONTENTS="$(tar -tzf "$TGZ" | sed 's|^package/||')"
TOP="$(echo "$CONTENTS" | cut -d/ -f1 | sort -u)"
for want in dist LICENSE README.md THIRD_PARTY_NOTICES.md package.json; do
  echo "$TOP" | grep -qx "$want" || die "tarball is missing $want"
done
for want in dist/bin.js dist/ui/server.js dist/ui-assets/index.html; do
  echo "$CONTENTS" | grep -qx "$want" || die "tarball is missing $want"
done
echo "$CONTENTS" | grep -qE '^dist/ui-assets/assets/.+\.(css|js)$' \
  || die "tarball is missing built UI assets"
for unwanted in test docs spike .github node_modules src ui tasks scripts; do
  if echo "$TOP" | grep -qx "$unwanted"; then die "tarball must not ship $unwanted/"; fi
done
echo "$TOP" | grep -qi 'ORCHESTRATE' && die "tarball must not ship orchestration notes"
ok "tarball contents: $(echo "$TOP" | tr '\n' ' ')"

# --- 2. install -------------------------------------------------------------

step "2. install the artifact into a clean prefix"
npm install -g "$TGZ" --prefix "$PREFIX" >/dev/null 2>&1
[ -x "$BIN" ] || die "no executable at $BIN after install"

EXPECTED_VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
GOT_VERSION="$("$BIN" --version)"
[ "$GOT_VERSION" = "$EXPECTED_VERSION" ] \
  || die "installed binary reports '$GOT_VERSION', package.json says '$EXPECTED_VERSION'"
ok "agentenv --version → $GOT_VERSION"

"$BIN" --help | grep -q 'agentenv - virtual environments for AI agents' \
  || die "--help does not look like agentenv"
ok "agentenv --help"

# --- 3. machine A: build an environment and push it --------------------------

step "3. machine A — init, build an environment, push it to a remote"
git init --bare -b main "$REMOTE" >/dev/null
ok "bare remote at file://$REMOTE"

a init >/dev/null
assert_exists "$A_AGENTENV/store/environments"
assert_exists "$A_AGENTENV/store/README.md"
assert_exists "$A_AGENTENV/state.json"
assert_exists "$A_AGENTENV/shims/claude"
assert_exists "$A_AGENTENV/shims/codex"

# The generated store README must explain the repo to whoever clones it.
assert_contains "$A_AGENTENV/store/README.md" 'environments/'
assert_contains "$A_AGENTENV/store/README.md" 'secrets.env'
assert_contains "$A_AGENTENV/store/README.md" 'never synced'

a create writing >/dev/null
a add skill writing tone-of-voice >/dev/null
a add instructions writing >/dev/null
a add mcp writing filesystem >/dev/null

# Make the content identifiable so machine B's assertions mean something.
SKILL_MD="$A_AGENTENV/store/environments/writing/skills/tone-of-voice/SKILL.md"
INSTR_MD="$A_AGENTENV/store/environments/writing/instructions/base.md"
printf -- '---\nname: tone-of-voice\ndescription: SMOKE-SKILL-MARKER\n---\n\nSMOKE-SKILL-MARKER\n' > "$SKILL_MD"
printf -- 'SMOKE-INSTRUCTIONS-MARKER\n' > "$INSTR_MD"

a show writing | grep -q 'Environment: writing' || die "show did not report the env"
ok "machine A built environment 'writing'"

a remote "file://$REMOTE" >/dev/null
a sync >/dev/null
ok "pushed the store to the remote"

assert_no_home_fallback

# --- 4. machine B: restore from the remote -----------------------------------

step "4. machine B — restore from the remote with nothing pre-existing"
b init --remote "file://$REMOTE" >/dev/null
assert_exists "$B_AGENTENV/store/environments/writing/env.yaml"

b list | grep -qx writing || die "machine B does not see the 'writing' environment"
ok "machine B cloned the store and sees 'writing'"

assert_contains "$B_AGENTENV/store/environments/writing/skills/tone-of-voice/SKILL.md" \
  'SMOKE-SKILL-MARKER'

# --- 5. activate in session mode, then assert TWO global harnesses ------------

step "5. machine B — launch a composed session from the installed artifact"
mkdir -p "$B_HOME/bin"
FAKE_CODEX="$B_HOME/bin/codex"
cat > "$FAKE_CODEX" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "${1:-}" = mcp ] && [ "${2:-}" = get ]; then
  printf '{"name":"%s"}\n' "${3:-}"
  exit 0
fi
if [ "${1:-}" = mcp ] && [ "${2:-}" = list ]; then
  printf '[]\n'
  exit 0
fi
: "${CODEX_HOME:?agentenv did not provide a private CODEX_HOME}"
grep -qF 'SMOKE-SKILL-MARKER' "$CODEX_HOME/skills/tone-of-voice/SKILL.md"
grep -qF 'SMOKE-INSTRUCTIONS-MARKER' "$CODEX_HOME/AGENTS.md"
grep -qF 'filesystem' "$CODEX_HOME/config.toml"
printf 'SESSION-PROBE-PASS\n'
EOF
chmod +x "$FAKE_CODEX"

SESSION_OUT="$WORK/session-probe.out"
b run writing -- codex > "$SESSION_OUT"
assert_contains "$SESSION_OUT" 'SESSION-PROBE-PASS'
ok "installed CLI launched Codex against a composed private session view"

step "6. machine B — activate globally and check two harnesses"
b use writing --global >/dev/null

echo "  -- harness 1: Claude Code"
assert_exists    "$B_HOME/.claude/skills/tone-of-voice"
assert_contains  "$B_HOME/.claude/skills/tone-of-voice/SKILL.md" 'SMOKE-SKILL-MARKER'
assert_contains  "$B_HOME/.claude/rules/base.md" 'SMOKE-INSTRUCTIONS-MARKER'
assert_contains  "$B_HOME/.claude.json" 'filesystem'

echo "  -- harness 2: Codex"
assert_exists    "$B_HOME/.agents/skills/tone-of-voice"
assert_contains  "$B_HOME/.agents/skills/tone-of-voice/SKILL.md" 'SMOKE-SKILL-MARKER'
assert_contains  "$B_HOME/.codex/AGENTS.md" 'SMOKE-INSTRUCTIONS-MARKER'
assert_contains  "$B_HOME/.codex/config.toml" 'filesystem'

b status | grep -q 'Global stack: \[writing\]' || die "status does not report the global stack"
ok "status reports the global stack"

assert_no_home_fallback

# --- 7. hand it all back ------------------------------------------------------

step "7. machine B — drop the stack and check the surfaces came back"
b drop --global >/dev/null

assert_missing "$B_HOME/.claude/skills/tone-of-voice"
assert_missing "$B_HOME/.agents/skills/tone-of-voice"
if grep -qF 'SMOKE-INSTRUCTIONS-MARKER' "$B_HOME/.codex/AGENTS.md" 2>/dev/null; then
  die "drop left the managed instructions region in ~/.codex/AGENTS.md"
fi
ok "managed surfaces handed back"

# Global COW deliberately retains every detached projection after drop: an
# unsupervised harness might still hold the old inode open. This smoke owns the
# whole sandbox, so it can assert quiescence explicitly and reconcile each one.
PROJECTION_IDS="$(b status | awk '/^  projection / { sub(":", "", $2); print $2 }')"
while IFS= read -r projection_id; do
  [ -n "$projection_id" ] || continue
  b resolve projection "$projection_id" --quiescent >/dev/null
done <<< "$PROJECTION_IDS"
ok "retired global projections reconciled under explicit quiescence"

# Dropping also leaves pre-mutation backups referenced by nothing. That is
# housekeeping, not damage: assert nothing structural is reported, then let
# `doctor --repair` collect orphaned backups and prove the machine ends clean.
DOCTOR_OUT="$(b doctor || true)"
if echo "$DOCTOR_OUT" | grep -qE '\[(journal-pending|dangling-symlink|store-drift|mangled-markers|reserialised-config|projection-pending)\]'; then
  echo "$DOCTOR_OUT" >&2
  die "doctor reports a structural problem after a clean drop"
fi
ok "doctor after drop: only orphaned backups (expected housekeeping)"

b doctor --repair >/dev/null || die "doctor --repair did not reach a clean state"
b doctor >/dev/null || die "doctor still reports problems after --repair"
ok "doctor --repair → clean"

assert_no_home_fallback

step "8. installed local UI — complete the core environment workflow"
node "$REPO_ROOT/scripts/smoke-ui-install.mjs" "$BIN" "$B_AGENTENV" "$B_HOME" "$WORK"
ok "installed UI browsed, created, copied, edited, imported, deleted, and shut down"

assert_no_home_fallback

step "PASS — the packed artifact completed CLI restore, harness, and local UI workflows"
PASSED=1
