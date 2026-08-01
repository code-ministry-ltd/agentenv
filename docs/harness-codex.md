# Harness note — Codex CLI (adapter `codex`, Task 4.1)

Live re-verification of the `[[harness-matrix]]` **Codex CLI row** against the
installed binary, done at the start of Task 4.1. This is the adapter's ground
truth; the vault matrix is research and is not edited (per task).

- **Binary:** `codex` **0.146.0** (matrix recorded 0.146.0-alpha.3.1). UNAUTHENTICATED
  on this machine (`~/.codex/auth.json` absent) — config isolation is fully
  verifiable unauth; live-login pass-through is **deferred** (no account).
- **Method:** every probe pointed `CODEX_HOME` at a **COPY** of the real `~/.codex`
  under a scratch dir, or at a hand-authored synthetic view. The real `~/.codex`
  was only ever READ (byte-identical before/after, sha256
  `3be7069e58e8a572787ad96170cc177287b47c3d74193b8c4f46f455117cce7b`). Every
  `codex` call was hard-timed (`timeout 30`); only non-interactive subcommands
  (`--version`, `doctor`, `mcp list`, `mcp get`); no `login`/`logout`, no TUI,
  no `exec`. Re-verified live on 2026-07-31.

## Confirmed / corrected cells

1. **`CODEX_HOME` relocates the config root INCLUDING `config.toml` + `auth.json`**
   — **CONFIRMED** (spike Q3 re-confirmed live on 0.146.0). `codex doctor` prints
   `config.toml → $CODEX_HOME/config.toml` and `auth file → $CODEX_HOME/auth.json`;
   both track the override. `MCP servers N` is read from the relocated `config.toml`.

2. **`codex mcp list` reads the managed MCP surface from the relocated root** —
   **CONFIRMED.** A synthetic view listing only the injected servers showed exactly
   those and NOT the real `context7`. Output is two tables (stdio / streamable_http),
   each with the server **name** in the first column — the adapter's `selfCheck`
   matches the name, offline and login-independent (a not-logged-in / "Unsupported"
   server is still LISTED).

3. **MCP native indirections — CONFIRMED live** (drove `compileConfigKeys`). A view
   config.toml with all three parsed clean (`config.toml parse ok`) and each surfaced
   in `codex mcp list` / `codex mcp get`:
   - `env_vars = ["GITHUB_TOKEN", "PATH"]` (stdio) → listed as `Env: GITHUB_TOKEN=*****, …`.
   - `bearer_token_env_var = "LINEAR_TOKEN"` (http) → its own **"Bearer Token Env Var"**
     column; `codex mcp get` prints `bearer_token_env_var: LINEAR_TOKEN`.
   - `[mcp_servers.x.env_http_headers]` (http) → accepted, server listed.
   So the adapter compiles the canonical `mcp/servers.yaml` to these FIRST and only
   falls back to a `${VAR}` placeholder + `substitutePlaceholders` (substitute rung)
   where no indirection fits (secret embedded in `url`, a renamed env var, or a
   `Bearer ${VAR}`-style header). `codex doctor` also *validates* that the referenced
   env vars are set (warns "Set the missing MCP env vars" when absent) — a `5.x`
   doctor hook could surface this, but it is out of scope here.

   **`bearer_token_env_var` is NOT emitted when an `Authorization` header shadows it**
   (F6/3, SECURITY). The header is what the server actually receives, so writing the
   bearer beside it would have Codex go on authenticating with a credential the user may
   believe they replaced — in a harness they were not looking at. The shaper refuses and
   warns instead.

   **`type` is honoured as the transport hint**, exactly as Claude/Cursor/OpenCode honour
   it, so a hand-authored `{ type: websocket, url }` in `servers.yaml` passes through as
   bespoke here too rather than being silently compiled to a plain HTTP table. And a
   Codex table is just a `url`: `http` and `sse` are indistinguishable, so the write-back
   NEVER writes its inferred `http` over a prior canonical `sse` — while superseding any
   stale `type`, which would otherwise sit beside the inferred `transport` and contradict
   it. Where a drift is genuinely ambiguous (an `Authorization` header that no longer
   matches the compiled one, or a value that looks like a resolved secret literal), the
   write-back leaves the canonical field unchanged and warns rather than guessing (F6).

4. **Trust-gating — CONFIRMED** (spike #4 re-confirmed). A view config.toml carrying
   `[projects."/home/jim/some/repo"]  trust_level = "trusted"` parsed clean and did
   not perturb MCP resolution. The adapter emits this keyed injection when the launch
   has a `projectRoot` (`ConfigKeysContext.projectRoot`), so a trusted project's
   `.codex/config.toml` merges; global mode (no project context) emits none.

5. **`$CODEX_HOME/skills` loader — STILL UNVERIFIED** (spike Q2 not settled here).
   `codex doctor` has no skills section and there is no non-interactive skills lister;
   proving the loader needs an interactive TUI or a logged-in `codex exec`, neither
   available unauthenticated. The adapter keeps the **skills** surface `supported:true`
   with `rootRelativePath: 'skills'` (in-root `$CODEX_HOME/skills`, symlink mode —
   Codex documents symlinked skill folders as supported), placed per the design.
   `~/.agents/skills` is Codex's *documented* user location but is `$HOME`-derived and
   would leak the env into every session, so it is a global-mode-only surface
   (`agents-standard`) and is deliberately NOT used for session isolation.
   **Matrix correction / open item:** the `$CODEX_HOME/skills` legacy location remains
   UNVERIFIED on 0.146.0; settle on a logged-in install. If it proves NOT to load,
   flip the skills surface to `supported:false` (+ `unsupportedReason`) — a one-line
   change; the composer already reports an unsupported surface via `status`.

## Adapter-shaping findings (these drove `src/adapters/codex.ts`)

- **Codex does NOT interpolate `${VAR}` in `[mcp_servers.*]` values** (matrix; #7521).
  Hence native indirections first, then the substitute rung (rung 3): the MCP surface
  declares `substitutePlaceholders: true`, so any placeholder the indirections could
  not remove is resolved to a literal in the EPHEMERAL view only; the manifest keeps
  the placeholder, so drift write-back restores `${VAR}` and never bakes a secret.

- **`config.toml` reserialisation.** The engine's config-keys mechanism injects each
  MCP server as a whole **marked `[table]`** and removes it by marker-splice, so a
  `use`/`drop` cycle is byte-identical (verified in `adapter.codex.global.test.ts`).
  The session composer reserialises the WHOLE `config.toml` via `smol-toml` — safe
  because the view is ephemeral and discarded at session end. (Task 4.1 enabled TOML
  seeding in `src/session/composer.ts`, which previously recorded a `TOML_SKIP`.)
  NOTE for 5.x: if a future doctor pass reserialises the *real* config.toml (not just
  the view), it must stay surgical / comment-preserving — recorded, not built here.

- **`codex doctor` truncates the MIDDLE of long paths** (`…`), so a self-check must
  NOT try to match the full view path in doctor output; `codex mcp list` name-matching
  is the robust signal.

- **Running under `/tmp`:** `codex` warns "Refusing to create helper binaries under
  temporary dir /tmp" and proceeds (exit 0). Harmless for `doctor` / `mcp list`; the
  self-check reads stdout+stderr and name-matches, so the warning does not break it.

## Two-bucket composition for Codex (validated, modulo live login)

- **Bucket 1 (pass-through, symlink):** `$view/auth.json → ~/.codex/auth.json` (when
  present). `classifyEntry('auth.json') === 'state'`; the mechanism was proven in the
  spike (empty→`none`, symlinked→`api_key`). Live-login token round-trip is **deferred**
  (no Codex account on this machine).
- **Bucket 2 (managed, authored):** `$view/config.toml` (`[mcp_servers.*]` + a
  `[projects."<root>"]` trust entry when a projectRoot is present), `$view/AGENTS.md`
  (file-block, inline region), `$view/skills/*` (dir-merge; loader UNVERIFIED).

## Deferred / out of scope

- **Live-login MCP/auth pass-through** — needs a logged-in Codex install.
- **`$CODEX_HOME/skills` loader** — needs interactive TUI / logged-in `exec`.
- **Real-config `config.toml` doctor reserialisation** — a 5.x concern; noted above.
