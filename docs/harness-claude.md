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
  and injects the env's `mcpServers`. A later edit to an env-owned key is REPORTED, not
  folded back (see below); other drift is discarded at session end. `.credentials.json`
  is the single bucket-1 pass-through that keeps the view logged in.

## MCP shape transform (`compileConfigKeys`)

Canonical `mcp/servers.yaml` (D6) → Claude `.claude.json` `mcpServers.<name>`:

| canonical | Claude |
|---|---|
| `transport: stdio` + `command`/`args`/`env` | `{ type:"stdio", command, args?, env? }` |
| `transport: http`\|`sse` + `url`/`headers` | `{ type, url, headers? }` |
| `auth: { bearer_env: VAR }` | header `Authorization: "Bearer ${VAR}"` |

`${VAR}` placeholders are KEPT (rung-1 passthrough — Claude interpolates them
natively) and every `${VAR}`-bearing field is recorded in `secretFields` so the drift
sweep sees the placeholder, never a baked literal (D6).

The flow is **one-way**: canonical → Claude. `mcp/servers.yaml` is the single source of
truth and agentenv never writes it on your behalf.

## MCP drift is REPORTED, not applied (`describeConfigKeysDrift`)

If you edit a server in `.claude.json` — change a URL, add a header, delete `env` —
agentenv does **not** fold that edit back into `mcp/servers.yaml`. On the next command it
tells you, per server, which canonical fields differ and how:

```
agentenv: mcp drift — 'linear' differs between the claude-code config and env 'work':
    harness config:  /home/you/.claude/.claude.json
    canonical store: /home/you/.agentenv/store/environments/work/mcp/servers.yaml
  changed url
  added   headers.X-Api-Key
  agentenv has NOT changed …/mcp/servers.yaml — edit it yourself to make the
  harness-side change permanent.
```

**To make a harness-side change permanent, edit `mcp/servers.yaml` yourself** (in
canonical D6 shape — `transport`/`command`/`url`/`auth`, not Claude's `type`/`headers`),
then run any agentenv command to re-materialise. Until you do, the next `use` will put
the canonical value back.

The report names FIELDS and env-var NAMES only, never values, so a credential you pasted
into `.claude.json` can never reach a terminal or a log through it.

Why report rather than apply: the forward transform is not injective (`transport: http`
and `transport: sse` both compile to shapes other harnesses cannot tell apart), so an
inverse has to be *reconstructed* rather than computed. Three adversarial review rounds
each fixed the reconstruction defects they were shown and introduced new ones at the next
uncovered boundary, twice with a security consequence. Classification is good enough to
DESCRIBE a difference and was never good enough to DECIDE what to do about one — so the
decision is yours. See `src/adapters/mcp-canonical.ts`.

Claude-specific classification points:

- **`type` is NATIVE here.** Claude records the http-vs-sse distinction itself, so a
  `"type"` you edit in `.claude.json` is reported as a `transport` change. The harnesses
  whose shape cannot record it (OpenCode `type:"remote"`, Codex's bare `url` table) do
  not report a transport change for an unrelated edit.
- **Ambiguity is flagged, never resolved.** An `Authorization` header that no longer
  matches the one agentenv compiled from `auth.bearer_env` is reported against
  `auth.bearer_env` with a note saying agentenv cannot tell whether you replaced the
  credential or changed an unrelated header; so is a hand-written canonical `transport`
  sitting beside Claude's own `type`.

## Interface-freeze finding (reported to the owner)

The frozen `Adapter` interface expressed Claude with **no missing field** — every
surface, the override, the two-bucket split, MCP compile + drift classification, and the
self-check all landed on existing shapes. Two points of friction worth recording:

- **The reverse hook was cut to a classifier (v1 decision).** It began as
  `syncBackConfigKeys`, returning store mutations; that is gone. `describeConfigKeysDrift`
  returns a report — an entry name, a store-relative location and named fields, with no
  content and no writable path — so no adapter can write the shared `mcp/servers.yaml`.
  `unshapeClaudeServer` survives as the classifier that maps Claude's `type`/`headers`
  shape back onto canonical field NAMES, so the report tells you which canonical field to
  edit rather than which Claude field you touched.

- **Instructions-as-dir-merge routes store files by their RAW store name.** The
  composer/engine place `environments/<env>/instructions/*` into `rules/` by
  filename. The canonical store names are `base.md` + `<harness>.md` (D2), which are
  NOT env-namespaced — two envs both shipping `base.md` collide in `rules/`, and the
  matrix's envisioned `rules/agentenv-<env>.md` naming has to come from how
  `add instructions` names the store file (Task 1.9/1.10), not from the adapter.
  Not blocking for 1.8, but the naming convention must be settled there.
