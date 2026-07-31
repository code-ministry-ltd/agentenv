# Harness note — OpenCode (adapter `opencode`, Task 4.2)

Live re-verification of the `[[harness-matrix]]` **OpenCode row** against the
installed binary, done at the start of Task 4.2. This is the adapter's ground
truth; the vault matrix is research and is not edited (per task). The matrix
OpenCode section was previously **docs-only** ("no live install"); this note
records the first live verification and **corrects the config-relocation cell**.

- **Binary:** `opencode` **1.18.5** (matrix overview row recorded 1.18.10),
  installed UNAUTHENTICATED. `opencode debug paths` reports
  `config ~/.config/opencode`, `data ~/.local/share/opencode`,
  `state ~/.local/state/opencode` (standard XDG).
- **Method:** every probe pointed `XDG_CONFIG_HOME` (and, where noted,
  `OPENCODE_CONFIG_DIR`) at a **scratch** config tree; the real
  `~/.config/opencode` was only ever READ. Every `opencode` call was hard-timed
  (`timeout ≤ 60`); no interactive TUI, no `login`/`logout`, no `mcp auth`.
  Re-verified live on 2026-07-31. The real config was hashed before/after — the 8
  non-`node_modules` files were byte-identical afterward.

## Confirmed / corrected cells

1. **`OPENCODE_CONFIG_DIR` does NOT isolate the config root — CORRECTED (was the
   matrix's assumed session mechanism).** Setting `OPENCODE_CONFIG_DIR=<dir>`
   leaves `opencode debug paths` reporting `config ~/.config/opencode` unchanged,
   and `opencode mcp list` shows the real `~/.config/opencode` servers
   (`librarian`, `context7`) **plus** the dir's `opencode.json` servers — i.e.
   `OPENCODE_CONFIG_DIR` is an **additive merge layer** (an "alternate config
   tree" escape hatch), not a relocation. It also does **not** add a
   skills/agents/commands scan dir (a symlinked skill placed under it was not
   discovered). Using it as the session override would LEAK the user's real MCP
   servers, instructions and plugins into every view — breaking isolation (spec
   criteria 1 and 9).

2. **`XDG_CONFIG_HOME` IS the real relocation + isolation lever — CONFIRMED.**
   With `XDG_CONFIG_HOME=<base>`, `opencode debug paths` reports
   `config <base>/opencode`, and `opencode mcp list` shows **only** the
   `<base>/opencode/opencode.json` servers — the real `librarian`/`context7` are
   gone. OpenCode reads its global config from `$XDG_CONFIG_HOME/opencode`
   (default `~/.config/opencode`). The private-view config dir must therefore be
   named **`opencode`** and `XDG_CONFIG_HOME` must be its **parent**.

3. **Auth lives OUTSIDE the config root — CONFIRMED.** OpenCode stores provider
   credentials under `$XDG_DATA_HOME` (`~/.local/share/opencode/`), not under the
   config dir. `XDG_CONFIG_HOME` relocation does **not** touch `XDG_DATA_HOME`, so
   auth **passes through automatically** (the view stays logged in) with **no
   bucket-1 pass-through entry needed under the config root**. `classifyEntry`
   therefore needs no special auth case.

4. **Skills — config-root `skills/` loads, and OpenCode FOLLOWS SYMLINKED skill
   dirs — CONFIRMED (was matrix UNVERIFIED).** A skill placed as a **symlink**
   (`<view>/opencode/skills/<name> -> /external/<name>`) was advertised to the
   model identically to a directly-placed skill: asking the built-in free model
   (`opencode/big-pickle`, usable offline) to enumerate skills returned BOTH the
   symlinked and the direct skill by name. So the skills surface uses
   `mode:'symlink'` (the D1 default), NOT the copy fallback. (Note: `opencode
   debug skill` lists only built-in + external `~/.agents`/`~/.claude` skills, not
   config-root ones — it is not a reliable probe for config-root skills; the
   permission-pattern generation and the model enumeration are.)

5. **Instructions — ABSOLUTE paths in the `instructions[]` array LOAD —
   CONFIRMED (was matrix UNVERIFIED).** A config with
   `"instructions": ["/abs/path/marker.md"]` caused the free model to echo the
   marker text that existed only in that absolute-path file. So global
   instructions use **config-keys array-element** on the `instructions` array
   (append the store instruction file's absolute path) — the matrix's preferred
   mechanism. The **file-block-on-AGENTS.md fallback is NOT needed.** (`opencode
   debug config` echoes but does not resolve `instructions`, and does not warn on
   a missing path, so it cannot prove loading — the model echo does.)

   **Array-element formatting note (config-keys mechanism property, not
   adapter-specific):** the `instructions` surface uses array-element injection,
   which rewrites the whole target array via jsonc-parser. An **inline**-authored
   `"instructions": [...]` round-trips byte-identical on `use`→`drop`; a
   **multiline**-authored array comes back **inline** (its own formatting is
   normalised — the rest of the file stays surgical). This is inherent to the
   frozen `config-keys` array-element mechanism (shared with Pi's settings arrays),
   not the OpenCode adapter. The keyed `mcp` surface and dir-merge surfaces restore
   byte-identical regardless.

6. **MCP shape — CONFIRMED against the live `~/.config/opencode/opencode.json` and
   the built-in `customize-opencode` schema skill.** `mcp` is an object keyed by
   server name; each server is discriminated by `type`:
   - local: `{ "type":"local", "command":[cmd, ...args], "enabled":true, "env"?:{} }`
     (`command` is a **single array** combining command + args).
   - remote: `{ "type":"remote", "url":..., "enabled":true, "headers"?:{} }`.
   String values support **`{env:VAR}`** interpolation (and `{file:path}`); the
   shell-style `${VAR}` is **not** substituted. The user's real config confirms a
   live `"Authorization": "Bearer {env:LIBRARIAN_AGENT_TOKEN}"` header.

7. **Agent/command/skill dir names — plural loads.** `agents/`, `commands/` and
   `skills/` all load under the config root (both singular `agent(s)`/`command(s)`
   are accepted; the adapter standardises on **plural**, matching the user's real
   `commands/`). MCP + instructions both live in **`opencode.json`** (grouped by
   the composer into one config-keys file).

## Session override design (the interface-friction point — LOUD)

The frozen `Adapter` contract and its `validateAdapter` require
`overrideEnv(root)[configRootEnv] === root` — i.e. the override var must point
**AT** the config root. Every other v1 harness satisfies this (`CLAUDE_CONFIG_DIR`,
`CODEX_HOME`, `PI_CODING_AGENT_DIR` each point at the root itself). **OpenCode is
the exception:** its only isolation lever, `XDG_CONFIG_HOME`, points at the
**PARENT** of an `opencode`-named dir. The composer already builds the view at
`live/<session>/<adapter.id>/`, and `adapter.id === 'opencode'`, so
`basename(viewRoot) === 'opencode'` holds — but `overrideEnv` must set
`XDG_CONFIG_HOME = dirname(viewRoot)`, which `validateAdapter` forbids for the
*declared* `configRootEnv`.

Resolution (no interface change — `validateAdapter` is frozen and out of scope):

- `configRootEnv = 'OPENCODE_CONFIG_DIR'` and `overrideEnv(root)` returns
  **both** `{ OPENCODE_CONFIG_DIR: root, XDG_CONFIG_HOME: dirname(root) }`.
  - `XDG_CONFIG_HOME = dirname(viewRoot)` is the **real** isolation lever — the
    harness reads `dirname(viewRoot)/opencode == viewRoot`.
  - `OPENCODE_CONFIG_DIR = viewRoot` satisfies `validateAdapter` and is a
    **redundant, verified-idempotent** re-merge of the *same* `viewRoot/opencode.json`
    already read via `XDG` (tested with multi-entry arrays: `instructions` stayed
    length 2, `mcp` stayed 2 keys — OpenCode replaces arrays across layers, never
    concatenates, so the double-read cannot duplicate).
- `realConfigRoot(env) = join(env.XDG_CONFIG_HOME ?? ~/.config, 'opencode')` — the
  source the view is composed from, matching `debug paths`.

**Coupling recorded:** correctness relies on `basename(viewRoot) === 'opencode'`
(true because `adapter.id === 'opencode'` and the composer names the view after
the id). If a future composer change stops naming the view after the id, this
adapter's isolation breaks silently (harness would read a non-existent
`dirname/opencode`). This is the one place OpenCode does not fit the "override var
points at the root" assumption baked into the frozen `validateAdapter`.

## MCP shape transform (`compileConfigKeys` / `syncBackConfigKeys`)

Canonical `mcp/servers.yaml` (D6) → OpenCode `opencode.json` `mcp.<name>`:

| canonical | OpenCode |
|---|---|
| `transport: stdio` + `command`/`args`/`env` | `{ type:"local", command:[command, ...args], enabled, env? }` |
| `transport: http`\|`sse` + `url`/`headers` | `{ type:"remote", url, enabled, headers? }` |
| `auth: { bearer_env: VAR }` | header `Authorization: "Bearer {env:VAR}"` |
| `enabled: false` | `enabled: false` (defaults to `true` when canonical says nothing) |
| `${VAR}` (any string) | `{env:VAR}` (OpenCode's native syntax) |

A canonical `enabled: false` is **carried through**: a deliberately disabled server must
never be silently switched back on. A HAND-AUTHORED harness-shaped entry (no
`transport`, an OpenCode/Claude-style `type`) keeps its `type` as the transport hint
rather than being re-inferred from the bare `url` — otherwise `{ type: sse, url }` would
compile to an HTTP server and the SSE endpoint would break.

Canonical `${VAR}` placeholders are **compiled to OpenCode's `{env:VAR}` form and
KEPT** (rung-1 passthrough — OpenCode interpolates `{env:VAR}` natively,
`substitutePlaceholders:false`); every `{env:VAR}`-bearing field is recorded in
`secretFields` so drift write-back restores the placeholder, never a baked literal
(D6).

`servers.yaml` is **always D6-canonical** (F1): `syncBackConfigKeys` folds a drifted
server back via `unshapeOpenCodeServer` (`{env:VAR}`→`${VAR}`, the single `command`
array split back into `command`+`args`, `type:'local'|'remote'`→`transport`,
`Authorization: Bearer {env:VAR}`→`auth.bearer_env`) and writes the **canonical** shape,
NEVER OpenCode's `{env:}`/array shape. This keeps the shared store readable by every
OTHER adapter and is round-trip stable — `compile(syncBack(v)) === v`.

**OVERLAY-AND-PRESERVE, not reconstruction.** The un-shape is applied as an overlay onto
the PRIOR canonical def read from `servers.yaml`, never as a fresh reconstruction,
because the forward shape is **not injective**:

- `type:"remote"` maps from BOTH `transport: http` and `transport: sse`;
- `command:[cmd, ...args]` maps from BOTH `{command:"a", args:["b"]}` and
  `{command:["a","b"]}`.

With a prior canonical def in hand, both ambiguities resolve exactly: the prior
`transport` is kept verbatim while the entry stays in the same family, and the prior
`command`/`args` split is kept whenever the flattened array is unchanged. Everything the
OpenCode shape cannot express (`timeout`, any field a future release adds) survives from
the prior def, and everything the user adds in `opencode.json` is carried over verbatim
— there is no whitelist.

**Where NO prior canonical entry exists** (a server the user added straight into
`opencode.json`), the `http`/`sse` ambiguity is **irreducible** — OpenCode's config
simply does not record the difference — and the write-back infers `http`. Codex has the
same irreducible gap (a bare `url` table). Claude and Cursor do not: they keep a native
`type`, so they recover `sse` exactly. This is a property of OpenCode's schema, not a
bug we can fix.

**Round-trip note (`use --global` → `drop`).** Keyed config-keys (this MCP surface)
and file-block surfaces restore byte-identically. The **array-element** surface —
OpenCode's `instructions` array — is **data-identical, not byte-identical**: the
shared `config-keys.ts` rewrites the touched array literal compactly, so a user's
multi-line `instructions: [\n  "…"\n]` returns single-line `instructions: ["…"]`
after an inject→remove cycle. This reflow is design-sanctioned (parsed-equal, no
residue, ownership fully removed), not a bug.

## selfCheck

`opencode mcp list` (offline, deterministic — connects nothing itself to LIST) is
the probe, exactly like Claude's. It prints one `● ✓|✗ <name>` line per server in
the view's `opencode.json` `mcp` object, **regardless of connect status** (a local
`/bin/echo` server appears as `✗ failed` but is still listed). The adapter matches
a view server by **name** under the applied overrides
(`XDG_CONFIG_HOME`+`OPENCODE_CONFIG_DIR`). With no view server it falls back to an
exit-code mechanism check. Live-login is deferred (binary is unauthenticated).
