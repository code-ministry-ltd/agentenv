# Task 0.3 — Two-shell falsification spike: FINDINGS

**Date:** 2026-07-31
**Scope:** Claude Code (`claude` 2.1.220) and Codex CLI (`codex-cli` 0.146.0) only.
**Method:** hand-rolled probes, no engine/product code. Every harness call hard-timed-out;
no interactive TUI launched; no `login`/`logout`; no writes to real `~/.claude`, `~/.claude.json`,
`~/.codex`. All spike artefacts live under `~/.agentenv-spike/` and `spike/` in the repo.

---

## VERDICT (up top)

| Harness | Session-primary isolation | One-line reason |
|---|---|---|
| **Claude Code** | **PASS** | `CLAUDE_CONFIG_DIR` fully relocates the config root **including `~/.claude.json`**; MCP + instructions + skills isolate per view; auth passes through via a single `.credentials.json` symlink; project-static config still visible; zero real-config mutation. |
| **Codex CLI** | **PASS** (one caveat, one unverified) | `CODEX_HOME` fully relocates `config.toml` + `auth.json`; MCP isolates per view; the auth-symlink **mechanism** is proven (empty->`none`, symlinked->`api_key`); project-static config visible when the view grants trust; `~/.codex` byte-identical. **Caveat:** live-login pass-through is UNTESTED (no Codex account on this machine). **Unverified:** `$CODEX_HOME/skills` loader (see open questions). |

**The central bet holds:** two shells at the same repo root, each with its harness's config-root
env var pointed at a privately-composed view, simultaneously held **contradictory** environments —
Claude viewA answered `ALFA` and viewB answered `BRAVO` to the same prompt from the same directory,
and each Codex view listed only its own MCP server. Neither engine engineering nor design change
is required by this spike; two follow-on design notes are recorded below.

---

## Settled open questions

### Q1 — Does `CLAUDE_CONFIG_DIR` relocate `~/.claude.json`? -> **YES. Settled.**
This was flagged UNVERIFIED in the harness matrix. Confirmed relocated:
- Pointing `CLAUDE_CONFIG_DIR` at an empty dir made the real user MCP server (`context7`, which lives
  in `~/.claude.json` top-level `mcpServers`) **disappear** from `claude mcp list`.
- Claude **created `$CLAUDE_CONFIG_DIR/.claude.json`** (plus `$CLAUDE_CONFIG_DIR/backups/...`) inside the
  empty dir. So `mcpServers`, `oauthAccount`, onboarding flags and project state all read/write from
  `$CLAUDE_CONFIG_DIR/.claude.json`, not `~/.claude.json`.

Design consequence: `~/.claude.json` is a **mixed, unsplittable file** (managed `mcpServers` +
auth-metadata `oauthAccount` + host state). It cannot be a bucket-1 symlink (would kill MCP isolation)
nor blindly reused — BUT see B-mechanism below: **auth does not need `oauthAccount`**, so the view can
freshly author `.claude.json` (managed `mcpServers` + `hasCompletedOnboarding:true`) and pass auth through
with a **single** `.credentials.json` symlink.

### Q2 — Does `$CODEX_HOME/skills` load? -> **STILL UNVERIFIED (could not settle non-interactively).**
`codex doctor` does not report a skills section, and there is no non-interactive skills lister. Proving
the loader requires either an interactive TUI or an inference run (`codex exec`), and Codex is **not logged
in** on this machine, so neither is available without credentials. The view places `$CODEX_HOME/skills/...`
per design, but whether Codex 0.146.0 loads that legacy location is unproven. **Recommend settling in the
Codex adapter task against a logged-in install.** (Codex's *documented* skills location is `~/.agents/skills`,
a global-mode-only surface — not usable for session isolation, per the matrix.)

### Q3 (bonus) — Does `CODEX_HOME` relocate `config.toml` and `auth.json`? -> **YES. Settled.**
`codex doctor` prints the resolved paths: `config.toml -> $CODEX_HOME/config.toml`,
`auth file -> $CODEX_HOME/auth.json`. Both track the override.

---

## Evidence — Claude Code

### (A) Managed-surface isolation — two contradictory shells, same repo root `~/.agentenv-spike/repo`
`viewA/claude` composed with MCP server `agentenv-spike-A-only` + rule/skill codeword `ALFA`;
`viewB/claude` with `agentenv-spike-B-only` + codeword `BRAVO`.

```
# MCP surface — each view sees ONLY its own server; real `context7` gone from both:
$ CLAUDE_CONFIG_DIR=viewA/claude claude mcp list   -> agentenv-spike-A-only   (no context7, no *-B-only)
$ CLAUDE_CONFIG_DIR=viewB/claude claude mcp list   -> agentenv-spike-B-only   (no context7, no *-A-only)

# Instructions surface (live inference, same cwd) — contradictory environments simultaneously:
$ CLAUDE_CONFIG_DIR=viewA/claude claude -p "...codeword?..."  -> ALFA
$ CLAUDE_CONFIG_DIR=viewB/claude claude -p "...codeword?..."  -> BRAVO

# Skills surface (live inference) — the view's own skill loads:
$ CLAUDE_CONFIG_DIR=viewA/claude claude -p "use your agentenv-spike skill..."  -> ALFA
```
All three managed surfaces (MCP, instructions, skills) relocate and isolate. PASS (A).

### (B) Auth pass-through — PROVEN LIVE (zero inference cost)
Claude's live OAuth token is `~/.claude/.credentials.json` (`claudeAiOauth.{accessToken,refreshToken,...}`),
which relocates under `CLAUDE_CONFIG_DIR`. The view symlinks `$view/.credentials.json -> real`.
Proof is a controlled differential using the account's **remote claude.ai MCP servers**, which only
appear when authenticated:

```
viewA (creds symlink present)              -> claude.ai Gmail/Drive/Calendar/Theologai = Connected  (LOGGED IN)
viewA-noauth (symlink removed)             -> those servers GONE                                   (NOT logged in)
viewA-credsonly (symlink, no oauthAccount) -> Connected                                            (token alone authenticates)
empty CLAUDE_CONFIG_DIR                     -> "No MCP servers configured"                          (NOT logged in)
```
Removing the symlink de-authenticates the view; the token file **alone** authenticates (the `oauthAccount`
copy is not required). PASS (B) — auth passes through via one bucket-1 symlink.

### (C) Project-static config still visible
Repo root has project-static `.mcp.json` with server `agentenv-spike-project`. Under both viewA and viewB
it appears as `Pending approval` — i.e. **seen** by the harness while the user config-root is overridden. PASS (C).

### (D) Zero-mutation — PASS  (see shared section below)

### Two-bucket composition that works for Claude (validated)
- **Bucket 1 (pass-through, symlink):** `$view/.credentials.json -> ~/.claude/.credentials.json` (live token). That is the ONLY pass-through needed.
- **Bucket 2 (managed, authored):** `$view/.claude.json` (`mcpServers` + `hasCompletedOnboarding:true`), `$view/rules/*.md`, `$view/skills/*/SKILL.md`, `$view/settings.json` (minimal, no host hooks).

---

## Evidence — Codex CLI

### (A) Managed-surface isolation — two contradictory shells, same repo root
`viewA/codex` `config.toml` -> `[mcp_servers.agentenv_spike_A_only]`; `viewB/codex` -> `agentenv_spike_B_only`.
```
$ CODEX_HOME=viewA/codex codex mcp list   -> agentenv_spike_A_only   (no context7, no *_B_only)
$ CODEX_HOME=viewB/codex codex mcp list   -> agentenv_spike_B_only   (no context7, no *_A_only)
$ CODEX_HOME=empty codex mcp list         -> "No MCP servers configured yet"
$ CODEX_HOME=viewA/codex codex doctor     -> config.toml = $CODEX_HOME/config.toml ; MCP servers 1
```
MCP surface relocates and isolates. PASS (A) for MCP. Instructions/skills isolation not inference-verifiable
without login (see Q2); structurally they live under the relocated `$CODEX_HOME`.

### (B) Auth pass-through — MECHANISM proven, LIVE login UNTESTED
Real `~/.codex/auth.json` does not exist (not logged in). Mechanism test: `$view/auth.json -> standin`.
`codex doctor` auth section transitioned decisively:
```
CODEX_HOME=empty       -> "no Codex credentials were found";  auth mode = none
CODEX_HOME=viewA/codex -> auth storage mode = File; auth file = $CODEX_HOME/auth.json;
                          stored auth mode = api_key;  auth mode = api_key   (READ THROUGH the symlink)
```
So a symlink at `$CODEX_HOME/auth.json` is transparently followed and its credential loaded. mechanism PASS.
**UNTESTED:** an actual logged-in token round-trip (no Codex account available). Must be re-verified in the
Codex adapter task on a logged-in install.

### (C) Project-static config still visible
Repo root `.codex/config.toml` -> `[mcp_servers.agentenv_spike_project]`. With the view granting trust
(`[projects."<repo>"] trust_level="trusted"` in the view's managed `config.toml`), from the repo root:
```
$ CODEX_HOME=view codex mcp list  -> agentenv_spike_A_only + agentenv_spike_project   (project-static merged)
$ CODEX_HOME=view codex doctor    -> "project source: project config"; MCP servers 2
```
PASS (C). **Design note:** project-static config only merges for *trusted* projects, so the Codex adapter
must write the repo's trust entry into the view's managed `config.toml`.

### (D) Zero-mutation — PASS (clean/uncontaminated)
`~/.codex` is byte-for-byte identical across the whole spike (see below). This is the cleanest of all
proofs because the live host session is Claude, never Codex.

### Two-bucket composition for Codex (validated, modulo live login)
- **Bucket 1 (pass-through, symlink):** `$view/auth.json -> ~/.codex/auth.json`.
- **Bucket 2 (managed, authored):** `$view/config.toml` (`[mcp_servers.*]` + repo `trust_level`), `$view/AGENTS.md`, `$view/skills/*/SKILL.md` (loader UNVERIFIED).

---

## Zero-mutation proof (property D) — PASS for both harnesses

**Constraint:** this spike ran inside a *live* Claude Code session that continuously rewrites its own
host-owned state under `~/.claude` — including `~/.claude.json` itself (it writes periodic
`~/.claude/backups/.claude.json.backup.*`, observed at 00:30, 00:31, 00:32, 00:34 during/after the window).
That churn is the host app, not the spike. agentenv's mechanism never references the real config path:
composition writes only under the view, and probes point `CLAUDE_CONFIG_DIR`/`CODEX_HOME` at the view.

**Snapshot tool:** `spike/snapshot.sh` (sha256 + perms/size/mtime listing of `~/.claude`, `~/.claude.json`,
`~/.codex`, plus a leak-safe managed-keys digest of `~/.claude.json`). **Classifier:** `spike/zero_mutation_check.sh`.

Result of a controlled before/after around the override probes:
```
Strict managed-surface changes (must be 0):           0
  (checks: ~/.codex/**, ~/.claude/.credentials.json, settings.json, skills/**, rules/**)
~/.claude.json managed-KEYS changed (must be 0):      0   (mcpServers still {context7}; oauthAccount, userID intact)
Host-session churn under ~/.claude (informational):   8   (all attributable to THIS session, e.g.
    ~/.claude/projects/-home-jim-obsidian-headless/.../subagents/agent-*.jsonl  <- this very agent's transcript)
VERDICT(D): PASS
```
- `~/.codex`: **zero** changes (uncontaminated control).
- All strict Claude managed surfaces: **zero** changes; the credential symlink was followed **read-only**.
- The only non-volatile delta is `~/.claude.json`'s whole-file hash, whose **managed keys are unchanged** —
  it is host-owned churn from the concurrent Claude app, not a spike write.

---

## Harness-matrix corrections / additions (do NOT edit the vault — recorded here)

1. **Matrix row "Per-process config-root override ... Claude Code":** the parenthetical
   "(lightly documented — spike must confirm it relocates `~/.claude.json`)" is now **CONFIRMED YES**.
   `CLAUDE_CONFIG_DIR` relocates the entire config root including `.claude.json`.

2. **NEW finding — claude.ai account MCP servers are auth-scoped, not config-scoped.** When a Claude view
   passes auth through, the logged-in account's **remote** MCP servers (Gmail, Drive, Calendar, Theologai)
   appear in **every** view identically and cannot be isolated or suppressed per-view without separate logins
   (which would break auth pass-through). This does **not** break session-primary (they are a shared constant,
   not a cross-shell contradiction), but the design must state: *an agentenv Claude environment governs LOCAL
   `mcpServers` only; it cannot hide/override the user's claude.ai-account remote MCP servers.*

3. **Claude auth needs only `.credentials.json`.** The `oauthAccount` object in `.claude.json` is NOT required
   for the token to authenticate — bucket-1 for Claude is a single `.credentials.json` symlink, and the view's
   `.claude.json` can be freshly authored. Simpler than the matrix implies.

4. **Codex project-static config is trust-gated.** The view's managed `config.toml` must carry the repo's
   `[projects."<repo>"] trust_level="trusted"` entry, or project `.codex/config.toml` MCP/keys are ignored.

5. **Codex `$CODEX_HOME/skills` loader remains UNVERIFIED** (Q2) — settle in the Codex adapter task on a
   logged-in install.

---

## What could NOT be tested, and why
- **Codex live-login pass-through:** no Codex account is configured on this machine (`~/.codex/auth.json`
  absent). Only the file-resolution mechanism was proven (empty->`none`, symlinked->`api_key`).
- **`$CODEX_HOME/skills` loading:** requires interactive TUI or a logged-in `codex exec`; neither available.
- **Claude skills/instructions isolation** was proven with 3 minimal `claude -p` inference calls (ALFA/BRAVO/ALFA);
  there is no non-interactive skills/rules lister, so an inference probe was the only option.

## Reproduce
```
spike/snapshot.sh B0 ~/.agentenv-spike/snap/B0      # baseline
spike/compose_view_claude.sh ~/.agentenv-spike/viewA/claude agentenv-spike-A-only ALFA
spike/compose_view_codex.sh  ~/.agentenv-spike/viewA/codex  agentenv_spike_A_only ALFA <standin-auth>
# ... run probes with CLAUDE_CONFIG_DIR / CODEX_HOME pointed at the views ...
spike/snapshot.sh B1 ~/.agentenv-spike/snap/B1
spike/zero_mutation_check.sh ~/.agentenv-spike/snap/B0 ~/.agentenv-spike/snap/B1
```
Mechanical, offline, CI-safe subset encoded in `test/spike.env-override.test.ts`
(`npm test -- -t "spike"`; skips cleanly when the `claude`/`codex` binaries are absent).
