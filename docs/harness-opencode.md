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

## MCP shape transform (`compileConfigKeys`)

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
`secretFields` so the drift sweep sees the placeholder, never a baked literal (D6).

The flow is **one-way**: canonical → OpenCode. `mcp/servers.yaml` is the single source of
truth and agentenv never writes it on your behalf.

## MCP drift is REPORTED, not applied (`describeConfigKeysDrift`)

If you edit a server in `opencode.json`, agentenv does **not** fold that edit back into
`mcp/servers.yaml`. On the next command it names the server and the canonical fields that
differ, names both files, and says plainly that the canonical store was NOT changed.

**To make a harness-side change permanent, edit `mcp/servers.yaml` yourself** — in
canonical D6 shape (`transport`/`command`/`args`/`url`/`auth`, `${VAR}` placeholders), not
OpenCode's `{env:}`/`type:"local"`/command-array shape. Until you do, the next launch
composes the canonical value again. The report carries field names and env-var names only,
never values.

**Why report rather than apply.** The forward shape is **not injective**:

- `type:"remote"` maps from BOTH `transport: http` and `transport: sse`;
- `command:[cmd, ...args]` maps from BOTH `{command:"a", args:["b"]}` and
  `{command:["a","b"]}`.

So an inverse cannot be computed; it has to be RECONSTRUCTED from (harness value, prior
canonical def, branch identity). agentenv did exactly that for three review rounds, and
each round fixed the reconstruction defects it was shown and introduced new ones at the
next boundary the reconstruction lattice did not cover — twice with a security
consequence. The lattice is adequate to DESCRIBE a difference and was never adequate to
DECIDE what to do about one, so the decision is now yours.

**The lattice survives as CLASSIFICATION.** `unshapeOpenCodeServer` still runs
(`{env:VAR}`→`${VAR}`, the single `command` array split back into `command`+`args`,
`type:'local'|'remote'`→`transport`, `Authorization: Bearer {env:VAR}`→`auth.bearer_env`)
so the report names the CANONICAL field you must edit rather than the OpenCode field you
touched. What it produces is diffed against the prior canonical def and thrown away; only
the field NAMES and change kinds reach you. In particular:

- Everything the OpenCode shape cannot express (`timeout`, any field a future release
  adds) is simply not mentioned — an edit to `url` reports `url` and nothing else.
- The prior `command`/`args` split is recognised when the flattened array is unchanged, so
  a URL edit does not falsely report a command-line change.

**`transportAuthority` scopes the transport claim to the shapes that can make it.** It is
OpenCode's `type:"remote"` (and Codex's bare `url` table) that cannot record http-vs-sse,
so an unrelated edit there reports NO transport change — claiming one would send you to
"fix" an SSE endpoint into HTTP. Claude and Cursor record the distinction NATIVELY in
their own `type`, so for them a `type` edit IS reported as a `transport` change. Each
branch declares `native` | `inferred` | `verbatim` | `ambiguous` explicitly, rather than
deciding from the transport family, which is not a sound discriminator for this.

**Where NO prior canonical entry exists** (a server you added straight into
`opencode.json`), there is nothing to diff against and the `http`/`sse` ambiguity is
irreducible — so the report says the entry is missing from `mcp/servers.yaml` and stops,
rather than guessing its canonical fields. That is exactly the action you must take.

**Ambiguity is flagged, never resolved.** Two cases reach that rule from OpenCode, and
both are reported as a NOTE against the field rather than as a resolved change:

- an `Authorization` header that no longer matches the one agentenv compiled from
  `auth.bearer_env` — it could be a credential replacement or an unrelated header, and the
  two have opposite consequences in a harness you are not looking at;
- a hand-written canonical `transport` sitting beside OpenCode's own `type` — the two
  discriminators disagree, so neither is claimed (reading both shapes at once used to
  duplicate an argument and leak `type`/`enabled` into the store).

`enabled` follows the same principle: OpenCode's shape always carries one, so it is only
reported when it DIFFERS from what the shaper emitted for the prior def — otherwise a
hand-authored non-boolean `enabled` would look like a change you never made.

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
