# Harness note — Pi (adapter `pi`, Task 4.3)

Live re-verification of the `[[harness-matrix]]` **Pi row** against the installed
binary, done at the start of Task 4.3. This is the adapter's ground truth; the
vault matrix is research and is not edited (per task).

- **Binary:** `pi` **0.80.3** (`@earendil-works/pi-coding-agent`, pi.dev). The
  matrix recorded 0.83.0; the reference machine has 0.80.3 — no adapter-relevant
  cell diverged.
- **Method:** every probe pointed `PI_CODING_AGENT_DIR` at a **copy** of the real
  `~/.pi/agent` under a scratch dir. The real `~/.pi` was only ever READ; a whole
  `find ~/.pi | stat | sha256sum` snapshot was byte-identical before and after the
  full live run. Every `pi` call was hard-timed (`timeout 30`) and offline
  (`PI_OFFLINE=1`); no interactive session, no `login`/`logout`. Re-verified
  2026-07-31.

## Confirmed / corrected cells

1. **Config root is `~/.pi/agent/`, NOT `~/.pi/`** — **CONFIRMED.** A bare
   `~/.pi/skills/` exists on the machine but is dead weight (not a load location).
   The adapter's `realConfigRoot` returns `~/.pi/agent`.

2. **`PI_CODING_AGENT_DIR` relocates the config root** — **CONFIRMED.** `pi list`
   pointed at a relocated root printed exactly that root's `settings.json`
   `packages` (`User packages:\n  <name>`), and an empty relocated root printed
   `No packages installed.` So `settings.json` (and the resources it references) is
   read from `$PI_CODING_AGENT_DIR`, never `$HOME/.pi/agent` under the override.

3. **Skills load from the relocated `skills/`, symlinks followed** — **CONFIRMED.**
   `pi config`'s resource list, run against a relocated root containing one plain
   skill dir and one **symlinked** skill dir, showed BOTH under
   `User (<relocated root>)` → Skills, with the symlinked one enabled (`[x]`). So a
   per-item symlink in `$PI_CODING_AGENT_DIR/skills` is discovered AND loaded — the
   dir-merge surface works. Pi also reads `~/.agents/skills/` (shown as a separate
   `User (~/.agents/)` group), the shared static-global pass-through — env skills go
   IN-ROOT only (D15), never `~/.agents/`.

4. **`settings.json` resource ARRAYS, element-level** — **CONFIRMED.** Top-level
   arrays (`packages`, `skills`, `prompts`, `themes`, `extensions`) hold resource
   references; `pi list` enumerates `packages` by name; toggling a resource in
   `pi config` writes an element into the corresponding array. The adapter owns
   these as config-keys **array-element** (by value, order-independent, D3).

5. **`auth.json` + `trust.json` pass-through** — **bucket-1, mechanism CONFIRMED.**
   A composed view symlinks both through to the (copied) real files; reads and
   writes reach the real location, so the view stays authenticated and project
   trust is intact. Project trust is a **pass-through agentenv does not manage** —
   `trust.json` records which projects the user approved; `status` surfaces its
   presence but never writes it. (The reference machine's real `auth.json` is `{}`
   — not logged in — so the token-refresh path is exercised structurally, not with
   a real credential.)

6. **MCP — no native support** — **CONFIRMED.** Pi has no native MCP (explicit
   design stance; zero SDK refs). The adapter declares the surface
   `supported: false`; `agentenv status` renders
   `mcp  config-keys  UNSUPPORTED (Pi has no native MCP …)` per D6, and the
   composer/engine skip it. Third-party MCP-adapter extensions exist but are out of
   the v1 surface.

## Adapter-shaping findings (these drove `src/adapters/pi.ts`)

- **`selfCheck` uses `pi list --no-approve`.** It is offline, exits 0, prints one
  indented line per `settings.json` package, and does NOT mutate the file — the Pi
  analog of `claude mcp list`. The probe reads the view's `packages`, runs
  `pi list` under `PI_CODING_AGENT_DIR=<view>` + `PI_OFFLINE=1`, and matches a
  package NAME (never health). No local package → fall back to the exit-code
  mechanism check (same documented caveat as the Claude adapter).

- **`pi config` is an interactive TUI that MUTATES `settings.json`** — feeding it a
  non-TTY stdin still rendered the TUI and wrote a resource element into the
  `skills` array. It is therefore **never** a probe: all `pi config` observation was
  copy-only. `pi list` is the safe non-interactive reader.

## Interface-freeze findings (reported to the owner — LOUD)

Two points of friction with the FROZEN `Adapter` interface, neither blocking (both
worked around inside the adapter), recorded for the owner:

- **An UNSUPPORTED surface must still declare a MANAGED-classifying
  `rootRelativePath`.** `validateAdapter` runs its "surface target must be
  `managed`, path must be safe/non-empty" check over EVERY surface, with no
  exemption for `supported: false`. Pi's MCP surface has no file, so the adapter
  declares a sentinel `rootRelativePath` (`.agentenv-mcp-unsupported`) and
  classifies it `managed`. The sentinel names no real Pi entry, so classifying it
  managed has zero runtime effect, and `composeBucketOne` excludes it from
  pass-through by name anyway. It works cleanly — the UNSUPPORTED-MCP surface +
  `status` reporting need nothing from the interface — but the interface could let
  an unsupported surface omit its path. **The MCP-unsupported + status path is
  clean; no interface gap blocks it.**

- **`config-keys` array-element is DATA-preserving, not BYTE-preserving.** The
  shared `config-keys.ts` array-element path rewrites the touched array literal
  compactly (`jsonc-parser modify` with no formatting options), so a user's
  multi-line `packages: [\n  "x"\n]` comes back single-line `packages: ["x"]` after
  an inject→remove cycle. `drop --global` is therefore byte-identical for the
  dir-merge and file-block surfaces but only **data-identical** (parsed-equal, no
  residue, ownership fully removed) for the settings.json array surface. This is a
  mechanism property (out of scope for this task), not a Pi-adapter bug; the Pi
  global AC test asserts byte-identity for every other surface and data-identity
  for settings.json. Pi itself writes multi-line arrays (observed from `pi config`),
  so the normalisation is user-visible — worth a `config-keys.ts` follow-up to pass
  `formattingOptions` derived from the file if strict byte-identity is wanted.
