# Harness note — Claude Code (adapter `claude-code`, Task 1.8)

Live re-verification of the `[[harness-matrix]]` **Claude Code row** against the
installed binary, done at the start of Task 1.8. This is the adapter's ground
truth; the vault matrix is research and is not edited (per task).

- **Binary:** `claude` **2.1.220** (matrix recorded 2.1.215).
- **Method:** every probe pointed `CLAUDE_CONFIG_DIR` at a **copy** of the real
  `~/.claude` under a scratch dir. The real `~/.claude`, `~/.claude.json`, and
  `~/.claude/.credentials.json` were only ever READ. Every `claude` call was
  hard-timed (`timeout 30`); no interactive session, no `login`/`logout`, no
  `claude -p`. Re-verified live on 2026-07-31.

## Confirmed / corrected cells

1. **`CLAUDE_CONFIG_DIR` relocates the config root INCLUDING `~/.claude.json`** —
   **CONFIRMED** (was the matrix's flagged UNVERIFIED, and spike Q1; re-confirmed
   live on 2.1.220). Pointing `CLAUDE_CONFIG_DIR` at an **empty** dir made the
   user's `context7` server disappear from `claude mcp list` ("No MCP servers
   configured"), and `claude` created `$CLAUDE_CONFIG_DIR/.claude.json` + a
   `backups/` dir inside it. So `mcpServers` reads/writes from
   `$CLAUDE_CONFIG_DIR/.claude.json`, never `$HOME/.claude.json`, under the override.

2. **`claude mcp list` reads the managed MCP surface from the relocated root** —
   **CONFIRMED.** An authored view listing only `agentenv-probe` showed exactly
   that server and NOT the real `context7`.

3. **"MCP-list change requires restart" (matrix UNVERIFIED cell) — REFINED.**
   Every FRESH `claude` process reads `mcpServers` from `.claude.json` at startup:
   adding a second server to a view mid-flight and re-running `claude mcp list`
   showed BOTH servers immediately. So a shim-launched process (agentenv's actual
   path) always sees current MCP state. The "needs a restart" caveat applies only
   to an ALREADY-RUNNING interactive session picking up an edit (the running TUI
   re-reads on `/mcp` reconnect, not on file change) — which is not testable
   non-interactively and was not tested (no TUI launched). For `agentenv use`,
   MCP is "live for the next launch", never stale for a new process.

4. **Surface paths — CONFIRMED.** Config root holds `skills/`, `agents/`,
   `commands/`, `rules/` (dir-merge targets); MCP lives at the **top-level
   `mcpServers`** object of `.claude.json`. Global instructions are a **symlink
   into `rules/`** (D2), never a file-block on `CLAUDE.md`.

5. **Auth pass-through — CONFIRMED (spike (B) re-confirmed).** A view whose
   `.credentials.json` resolves to the real (copied) token lists the account's
   **remote** claude.ai MCP servers (Gmail / Drive / Calendar / Theologai) as
   `✔ Connected`; an empty root lists none. The token file alone authenticates.

## Adapter-shaping findings (these drove `src/adapters/claude.ts`)

- **`claude mcp list` lists a server by NAME regardless of connect status.** A
  fake stdio server (`command: /bin/echo`) appears as
  `agentenv-probe: /bin/echo - ✘ Failed to connect` — LISTED, just not connected.
  So the adapter's `selfCheck` matches the server **name** in the output, never a
  "Connected" status. This keeps the probe cheap and offline-robust (no dependence
  on a server actually starting).

- **Account remote MCP servers are auth-scoped, not config-scoped** (spike finding
  #2, re-confirmed). Gmail/Drive/Calendar/Theologai appear in EVERY authenticated
  view identically and cannot be isolated per-view. `selfCheck` therefore keys off
  a **local** injected server (from the view's `.claude.json` `mcpServers`), and
  excludes the account remotes from its match set. An agentenv Claude env governs
  LOCAL `mcpServers` only.

- **`.claude.json` is a mixed state+config file** (D15). The composer seeds it from
  the real file (carrying `context7`, `oauthAccount`, onboarding flags, host state)
  and injects the env's `mcpServers`; env-owned keys follow drift write-back, other
  drift is discarded at session end. `.credentials.json` is the single bucket-1
  pass-through that keeps the view logged in.

## MCP shape transform (`compileConfigKeys` / `syncBackConfigKeys`)

Canonical `mcp/servers.yaml` (D6) → Claude `.claude.json` `mcpServers.<name>`:

| canonical | Claude |
|---|---|
| `transport: stdio` + `command`/`args`/`env` | `{ type:"stdio", command, args?, env? }` |
| `transport: http`\|`sse` + `url`/`headers` | `{ type, url, headers? }` |
| `auth: { bearer_env: VAR }` | header `Authorization: "Bearer ${VAR}"` |

`${VAR}` placeholders are KEPT (rung-1 passthrough — Claude interpolates them
natively) and every `${VAR}`-bearing field is recorded in `secretFields` so
write-back restores the placeholder, never a baked literal (D6).

`servers.yaml` is **always D6-canonical** (F1): `syncBackConfigKeys` reverse-maps a
drifted server via `unshapeClaudeServer` (the inverse of the forward transform —
`type`→`transport`, `Authorization: Bearer ${VAR}`→`auth.bearer_env`, placeholders
restored) and writes the **canonical** shape, NEVER Claude's `type`/`headers` shape.
This keeps the shared store readable by every OTHER adapter's `compileConfigKeys` and
is round-trip stable — `compile(syncBack(v)) === v` — proving spec criterion 4. See
the freeze note below.

The un-shape is an OVERLAY onto the prior canonical def (see `mcp-canonical.ts`), so
anything Claude cannot express survives. Two Claude-specific points:

- **`type` is NATIVE here.** Claude records the http-vs-sse distinction itself, so a
  `"type"` the user edits in `.claude.json` PROPAGATES to canonical `transport`. Only the
  harnesses whose shape cannot record it (OpenCode `type:"remote"`, Codex's bare `url`
  table) fall back to the prior canonical value.
- **Ambiguity is warned, never guessed (F6).** An `Authorization` header that no longer
  matches the one agentenv compiled from `auth.bearer_env` leaves `auth` UNCHANGED and
  warns; so does a hand-written canonical `transport` sitting beside Claude's own `type`.
  A value that looks like a resolved secret literal is never persisted into the
  git-backed `servers.yaml` — the one deliberate exception to round-trip stability.

## Interface-freeze finding (reported to the owner)

The frozen `Adapter` interface expressed Claude with **no missing field** — every
surface, the override, the two-bucket split, MCP compile + reverse-sync, and the
self-check all landed on existing shapes. Two points of friction worth recording:

- **`syncBack` writes the D6-canonical shape (F1 decision).** Earlier this adapter
  wrote the drifted server back in Claude's normalised (`type`/`headers`) shape, which
  *poisoned* the shared `mcp/servers.yaml` for every OTHER harness (they read one
  canonical store). The fix: `unshapeClaudeServer` reverse-maps back to
  `transport`/`auth.bearer_env` (mirroring Codex's `unshapeCodexServer`), so
  `servers.yaml` stays canonical and each adapter's `compileConfigKeys` only ever reads
  canonical. The reverse transform is unambiguous here because the forward transform is
  the only writer of the `Authorization: Bearer ${VAR}` header we recognise.

- **Instructions-as-dir-merge routes store files by their RAW store name.** The
  composer/engine place `environments/<env>/instructions/*` into `rules/` by
  filename. The canonical store names are `base.md` + `<harness>.md` (D2), which are
  NOT env-namespaced — two envs both shipping `base.md` collide in `rules/`, and the
  matrix's envisioned `rules/agentenv-<env>.md` naming has to come from how
  `add instructions` names the store file (Task 1.9/1.10), not from the adapter.
  Not blocking for 1.8, but the naming convention must be settled there.
