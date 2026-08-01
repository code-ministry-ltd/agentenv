# Harness note — Cursor (adapter `cursor`, Task 4.4)

Live re-verification of the `[[harness-matrix]]` **Cursor row** against the installed
`cursor-agent`, done for Task 4.4. This is the adapter's ground truth; the vault matrix
is research and is not edited (per task). It **reconciles** with the matrix: every claim
below was re-observed live, and all three matrix questions resolved the same way.

- **Binary:** `cursor-agent` **2026.07.23-e383d2b** (matches the matrix), UNAUTHENTICATED.
- **Method (SAFE):** the real `~/.cursor` was only ever **READ**. Every probe ran against
  a **temp copy** or a **`HOME` override** pointing at a temp dir; every `cursor-agent`
  call was hard-timed (`timeout 30`), non-interactive, with **no `login`/`logout`**.
  A before/after content hash of the user's real config (`~/.cursor/cli-config.json`)
  was **byte-identical** across the whole probe run.
  - ⚠️ **Side-effect worth recording:** `cursor-agent` writes its own **statsig
    telemetry cache** into `~/.cursor` whenever it runs (a `statsig-cache.json.*.tmp`
    file), even for a read-only `mcp list`. This is the CLI's own write, not agentenv's;
    the user's actual config is untouched. Run future probes with `HOME` pointed at a
    temp dir to avoid it entirely.

## Live matrix re-verification (the three questions the task asked)

### 1. Does `CURSOR_CONFIG_DIR` isolate the CLI? → **NO** (→ `sessionSupported: false`)

`cursor-agent mcp list` reads MCP config from `~/.cursor/mcp.json` (home-derived) **or**
the project `./.cursor/mcp.json` only. `CURSOR_CONFIG_DIR` is **inert** for that resolution:

| Probe | Setup | `mcp list` result |
|---|---|---|
| A | `CURSOR_CONFIG_DIR=T`, server at `T/mcp.json`, run from empty CWD | `No MCP servers configured` — **ignored** |
| B | as A, also at `T/.cursor/mcp.json` | `No MCP servers configured` — **ignored** |
| Positive control | project `./.cursor/mcp.json` in CWD, no env | `agentenv-probe-project: not loaded (needs approval)` — **loaded** |
| `CURSOR_CONFIG_DIR`=empty **+** project file present | | project server still **loaded** (env had no effect) |
| `HOME`=temp with `~/.cursor/mcp.json` | | `agentenv-global-probe: …` — **loaded** (home-derived) |

So the CLI's config root is **`$HOME`-derived**, not `CURSOR_CONFIG_DIR`-derived. A config-root
override cannot relocate `mcp.json` away from `~/.cursor`, so **session mode cannot isolate a
private view** — and an IDE inherits no shell env anyway (D11/D15). The adapter marks
`sessionSupported: false` with a `--global` notice, and declares `configRootEnv:
'CURSOR_CONFIG_DIR'` / `realConfigRoot = CURSOR_CONFIG_DIR ?? ~/.cursor` only for interface
consistency (global mode materialises into `~/.cursor`, which the CLI **does** read).

*(HOME-override "works" but is NOT a viable session mechanism — it would relocate ALL
home-derived state/auth and is not the declared override. Out of scope; recorded only.)*

### 2. `mcp.json` whole-file rejection? → **YES** (→ `validateConfigFile`)

A **single** malformed server entry makes `cursor-agent` drop **every** server, including
the valid siblings:

| Test | `mcpServers` content | Result |
|---|---|---|
| T1 | `good:{command}` + `bad:"not-an-object"` | **No servers** — whole file rejected |
| T2 | `good:{command}` + `bad:{}` (no command/url) | **No servers** — whole file rejected |
| T3 | `good:{command}` with a **trailing comma** | `good` **loaded** — JSONC-lenient parse |
| T4 | `mcpServers` is an **array** | No servers |
| T5 | top level is `[1,2,3]` | No servers |

So a valid entry is a **non-null object with a `command` (stdio) OR a `url` (http/sse)**;
anything else takes the whole file down. `validateConfigFile(absPath, content)` therefore
whole-file-validates: parse leniently (`allowTrailingComma`, matching T3), require
`mcpServers` (if present) to be an object, and reject if **any** entry is not a valid
server — returning `{ ok:false, detail }` so the composer rolls the write back rather than
silently nuking the user's whole MCP set. Also confirmed: `mcp list` lists a configured
server **by name regardless of connect status** (`not loaded (needs approval)` /
`Error: Connection failed`), like Claude — useful if a global probe is ever added.

### 3. Do commands load? → **UNVERIFIABLE non-interactively** (→ skills-only)

There is no `cursor-agent commands` subcommand (it falls through to top-level help).
Cursor commands (`~/.cursor/commands/*.md`) surface only in the interactive TUI `/`-menu,
which the safety rules forbid probing. **Not live-verified ⇒ not a v1 surface**; the
adapter is **skills-only** for user-authored prompt bundles (the matrix's recommendation).

## Surfaces the adapter declares (global mode)

| Surface | id | Mechanism | Target | Supported | Notes |
|---|---|---|---|---|---|
| Skills | `skills` | dir-merge | `~/.cursor/skills` | ✅ | Per-item symlink beside the user's; Cursor reads it. Also covered by the shared `agents-standard` pseudo-surface **when that lands** (see below). |
| Instructions (global) | `instructions` | (dir-merge, nominal) | — | ❌ | **The global-instructions gap.** User Rules are an app+cloud settings DB (`state.vscdb`), not a file — no clean surface. `status` reports it; skills are the substitute. |
| MCP | `mcp` | config-keys, keyed | `~/.cursor/mcp.json` `mcpServers` | ✅ | Passthrough `${env:VAR}` (rung-1, D6) — no secret literal ever written. Whole-file validated. |
| Commands | — | — | — | — | Not a v1 surface (unverifiable — see Q3). |
| Project `.cursor/rules` + `AGENTS.md` | — | — | — | read-only inputs (D8) | Declared, never composed — project files are inputs, not agentenv surfaces. |

`classifyEntry`: `skills` / `mcp.json` / `rules` → **managed**; credentials/auth,
`cli-config.json`, `hooks.json`, `commands`, sessions, worktrees, statsig caches, and any
future entry → **state** (bucket-1 pass-through, the safe unknown, D15).

## MCP shape transform (`compileConfigKeys`)

Canonical `mcp/servers.yaml` (D6) → Cursor `mcp.json` `mcpServers.<name>`:

| canonical | Cursor |
|---|---|
| `transport: stdio` + `command`/`args`/`env` | `{ command, args?, env? }` (no `type` — Cursor infers stdio) |
| `transport: http`\|`sse` + `url`/`headers` | `{ type, url, headers? }` |
| `auth: { bearer_env: VAR }` | header `Authorization: "Bearer ${env:VAR}"` |
| placeholder `${VAR}` | rewritten to Cursor's `${env:VAR}` (idempotent; `${userHome}`/`${workspaceFolder}` left as-is) |

**Placeholder / secret handling (D6, secret-safety):** Cursor interpolates `${env:VAR}`
natively, so the surface is **passthrough** (`substitutePlaceholders: false`) — the compiled
`${env:VAR}` is written verbatim and Cursor resolves it; no secret value ever leaves the env.
`secretFields` records the **Cursor-syntax** placeholder (e.g. `Bearer ${env:LINEAR_TOKEN}`),
so the drift sweep sees the INDIRECTION and never a baked literal, and the real `mcp.json`
keeps `${env:VAR}` (which Cursor interpolates) even after a user edit.

The flow is **one-way**: canonical → Cursor. `mcp/servers.yaml` is the single source of
truth and agentenv never writes it on your behalf.

## MCP drift is REPORTED, not applied (`describeConfigKeysDrift`)

If you edit a server in `~/.cursor/mcp.json`, agentenv does **not** fold that edit back
into `mcp/servers.yaml`. On the next command it names the server and the canonical fields
that differ (`url` changed, `auth.bearer_env` added, …), names both files, and says
plainly that the canonical store was NOT changed.

**To make a harness-side change permanent, edit `mcp/servers.yaml` yourself** — in
canonical D6 shape (`transport`/`command`/`url`/`auth`, `${VAR}` placeholders), not
Cursor's `${env:}` shape. Until you do, the next `use --global` puts the canonical value
back. The report carries field names and env-var names only, never values.

`unshapeCursorServer` still runs, but only to CLASSIFY: it maps `${env:VAR}`→`${VAR}`, a
bare `command`→stdio and `Authorization: Bearer ${VAR}`→`auth.bearer_env`, so the report
names the CANONICAL field you must edit rather than the Cursor field you touched.

Like Claude, Cursor records the http-vs-sse distinction NATIVELY in `type`, so a `type`
you edit in `mcp.json` is reported as a `transport` change; the harnesses whose shape
cannot record it do not report one for an unrelated edit. Cursor's *stdio* shape carries
no `type` at all, so a hand-written canonical `transport` on a stdio entry has nothing to
contradict it and is reported plainly — on a REMOTE entry the two disagree, and the report
flags `transport` with a note instead of resolving it. An `Authorization` header that no
longer matches the compiled one is likewise flagged against `auth.bearer_env` with a note,
because a credential replacement and an unrelated header edit have opposite consequences
in a harness you are not looking at.

Why report rather than apply: see the same section in `harness-claude.md` — the forward
transform is not injective, so the inverse must be reconstructed, and three review rounds
of that reconstruction each produced a fresh defect at the next uncovered boundary.

## Interface-freeze findings (reported to the owner — LOUD)

- **`sessionSupported:false` + `validateConfigFile` expressed Cursor cleanly.** The two
  Cursor-motivated additions to the frozen contract did their jobs: session-unsupported
  captured "no isolatable config root", and the optional whole-file hook captured
  "one bad entry rejects the whole file". No new field was needed to declare Cursor.

- **⚠️ GAP 1 — `validateConfigFile` has NO engine call site yet.** The hook is declared on
  the interface and implemented here, but nothing in `src/` invokes it: the global
  config-keys path (`engine.ts` `materialiseConfigKeys` → `injectKeyed`) writes `mcp.json`
  and never whole-file-validates afterwards. So the **guard is unit-tested but not wired**.
  Wiring it (call `adapter.validateConfigFile(file, newContent)` after the config-keys
  transaction writes a file, roll back on `{ok:false}`) is a **~few-line engine change**,
  deliberately left out of this task's file scope (`cursor.ts` + `index.ts` + docs + tests).
  Until wired, a malformed composed `mcp.json` would ship and Cursor would drop all servers.

- **⚠️ GAP 2 — `status` does not render adapter-level `sessionSupported`.** `describeGlobal`
  / `status` render **per-surface** support only (so the global-instructions gap **does**
  appear, via the unsupported `instructions` surface). Session-unsupported is surfaced at
  **launch** instead (`launch.ts` emits the `--global` notice). A one-line
  `status.ts`/`describeGlobal` addition would also show it in `status`; left out of scope.

- **Note — `agents-standard` coverage (future).** The shared global-skills pseudo-surface
  (`~/.agents/skills`, matrix §"the `~/.agents/` standard") is **not yet implemented** in the
  engine, so declaring `skills → ~/.cursor/skills` is the correct working v1 behaviour today.
  When `agents-standard` lands, Cursor's `skills` surface should be marked **covered by it**
  to avoid the duplicate-name warnings the matrix flags (materialising into both dirs).
