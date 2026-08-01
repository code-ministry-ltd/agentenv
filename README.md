# agentenv

Virtual environments for AI agents.

`agentenv` gives you named, switchable bundles of agent context — skills,
instruction files, MCP servers, subagents and slash commands — and activates a
bundle across whichever AI coding harness you happen to be using. One store,
kept in git, synced between your machines.

```
$ agentenv use writing --global
Materialised [writing] globally (15 item(s)).
Global stack: [writing].
```

It is harness-agnostic. The same `writing` environment lands as
`~/.claude/skills/…` + `~/.claude/rules/…` + `~/.claude/.claude.json` for Claude
Code, as `~/.codex/skills/…` + a managed block in `~/.codex/AGENTS.md` +
`~/.codex/config.toml` for Codex, and so on for OpenCode, Pi and Cursor.

**Status:** v1. Five harnesses ship. Read
[Known limitations](#known-limitations) before you rely on it — that section is
deliberately blunt.

---

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Quickstart](#quickstart)
- [Concepts](#concepts)
- [Command reference](#command-reference)
- [Session mode vs `--global`](#session-mode-vs---global)
- [Syncing across machines](#syncing-across-machines)
- [Secrets](#secrets)
- [`doctor`](#doctor)
- [Supported harnesses](#supported-harnesses)
- [What lives where](#what-lives-where)
- [Known limitations](#known-limitations)
- [Development](#development)

---

## Requirements

- **Node.js >= 20** (`engines.node` in `package.json`).
- **git**, if you want to sync your store between machines. Everything else
  works offline without it — `agentenv init` warns and carries on.

No other runtime dependencies. `agentenv` never needs a harness to be installed
to manage its config; it composes files and directories.

## Install

`agentenv` is distributed **from GitHub only**.

> The npm name `@code-ministry/agentenv` is a parked placeholder and is **not**
> the tool. Do not `npm install @code-ministry/agentenv`.

### From a release artifact

Every [release](https://github.com/code-ministry-ltd/agentenv/releases) attaches
a packed tarball. Download it and install globally:

```sh
gh release download --repo code-ministry-ltd/agentenv --pattern '*.tgz'
npm install -g ./code-ministry-agentenv-*.tgz
agentenv --version
```

The tarball ships pre-built JavaScript (`dist/`), so this needs no toolchain
beyond npm.

### From a GitHub checkout

```sh
git clone https://github.com/code-ministry-ltd/agentenv.git
cd agentenv
npm ci
npm run build
npm install -g .
agentenv --version
```

Or straight from the repo URL — npm clones it and runs the `prepare` build for
you:

```sh
npm install -g github:code-ministry-ltd/agentenv
```

### Uninstall

```sh
agentenv drop --all --global   # hand every managed surface back first
npm uninstall -g @code-ministry/agentenv
```

Uninstalling the CLI does **not** delete `~/.agentenv`. Remove that directory by
hand if you want the store gone too.

## Quickstart

Five minutes from nothing to a working environment on two harnesses.

**1. Set up.** Creates `~/.agentenv/`, makes the store a git repo, installs one
PATH shim per supported harness, and prints the shell hook.

```sh
agentenv init
```

**2. Enable session mode** by adding the hook to your `~/.zshrc` or `~/.bashrc`,
then opening a new shell:

```sh
eval "$(agentenv shell-init)"
```

**3. Create an environment and put something in it.**

```sh
agentenv create writing
agentenv add skill        writing tone-of-voice   # scaffolds skills/tone-of-voice/SKILL.md
agentenv add instructions writing                 # scaffolds instructions/base.md
agentenv add agent        writing reviewer        # scaffolds agents/reviewer.md
agentenv add mcp          writing filesystem      # scaffolds an mcp/servers.yaml entry
```

Each `add` scaffolds a file in the store and tells you it did. Edit the files
themselves — they are plain Markdown and YAML:

```sh
$EDITOR "$(agentenv add skill writing tone-of-voice --print-path)"
$EDITOR "$(agentenv add mcp   writing filesystem   --print-path)"
```

**4. Check it.**

```sh
agentenv show writing
```

```
Environment: writing
Version:     1.0
Description: (none)
Contents:
  skills: 1
  mcp: 1
```

**5. Activate it.**

```sh
agentenv use writing            # this shell + this project only
agentenv use writing --global   # every harness, machine-wide
```

`--global` writes to the real config paths, so a GUI app (Cursor) or a harness
launched outside your shell picks it up. Session mode touches no real config at
all — see [Session mode vs `--global`](#session-mode-vs---global).

**6. See where you stand.**

```sh
agentenv status
```

```
agentenv status

Session:
  project:    /home/you/code/novel
  session id: 48219-host-2913
  mode:       bound → [writing]

Global stack: [writing]

Harnesses (global surfaces):
  claude-code
    skills        dir-merge    supported — 1 owned
    agents        dir-merge    supported — 1 owned
    commands      dir-merge    supported — 0 owned
    instructions  dir-merge    supported — 1 owned
    mcp           config-keys  supported — 1 owned
  codex
    skills        dir-merge    supported — 1 owned
    instructions  file-block   supported — 1 owned
    mcp           config-keys  supported — 1 owned
  …
```

**7. Put it back.**

```sh
agentenv drop writing            # unbind this shell
agentenv drop --all --global     # hand every global surface back
```

**8. Sync it to another machine.**

```sh
agentenv remote git@github.com:you/agentenv-store.git   # on machine A
agentenv sync

agentenv init --remote git@github.com:you/agentenv-store.git   # on machine B
agentenv use writing --global
```

## Concepts

**Environment** — a named directory in the store holding the content you want a
harness to see. Names are lowercase letters, digits, `-` and `_`; they must
start and end alphanumeric; 1–64 characters.

**Stack** — you can activate several environments at once
(`agentenv use base writing`). Later environments win item-name conflicts.

**Surface** — one thing inside a harness's config root that `agentenv` manages.
There are exactly three mechanisms:

| Mechanism     | What it does                                                             | Example                                    |
|---------------|--------------------------------------------------------------------------|--------------------------------------------|
| `dir-merge`   | One symlink (or copy) per item, beside your own items                    | `~/.claude/skills/tone-of-voice`            |
| `file-block`  | A marked region inside an instruction file, layered with your content    | `~/.codex/AGENTS.md`                        |
| `config-keys` | Specific keys injected into a structured config file, at a recorded path | `mcpServers` in `~/.claude/.claude.json`    |

Everything `agentenv` owns is recorded in a write-ahead manifest
(`~/.agentenv/state.json`) — each item records its own path, store source,
markers and hash. That manifest is what makes `drop` exact and `doctor`
possible.

**Ownership** — `agentenv` only ever removes what its manifest says it added.
Content you wrote yourself sits alongside and is left alone.

## Command reference

Every command below is real; run `agentenv --help` for the same list.

### Store

| Command                                   | What it does |
|-------------------------------------------|--------------|
| `agentenv init [--remote <url>]`          | Create the store, manifest and shims; print the shell hook. Idempotent. `--remote` on a fresh machine **clones** an existing store. |
| `agentenv create <name> [--from <env>]`   | Create an environment, optionally copying another. |
| `agentenv list`                           | List environment names. |
| `agentenv show <name>`                    | Show an environment's manifest and content counts. |
| `agentenv edit <name> [--print-path]`     | Open `env.yaml` in `$EDITOR`, or just print its path. |
| `agentenv rm <name> [--drop-first] [--yes\|--force]` | Delete an environment. |

### Content

| Command | What it does |
|---------|--------------|
| `agentenv add skill <env> <name\|localPath> [--force] [--print-path]` | Scaffold a skill, or copy in an existing local skill directory. |
| `agentenv add skills <env> <owner/repo[/path][@ref]> [--all] [--force]` | Scan a git source for skills and pick which to add. |
| `agentenv add mcp <env> <name> [--transport stdio\|http] [--force] [--print-path]` | Scaffold a server entry in `mcp/servers.yaml`. Edit the file to fill it in. |
| `agentenv add instructions <env> [--harness <h>] [--force] [--print-path]` | Create `instructions/base.md`, or `instructions/<h>.md` for one harness. Takes no `<name>`. |
| `agentenv add agent <env> <name> [--force] [--print-path]` | Scaffold `agents/<name>.md`. |
| `agentenv add command <env> <name> [--force] [--print-path]` | Scaffold `commands/<name>.md`. |

`--print-path` prints the target path and writes **nothing** — it is the
scriptable "open this in my editor" hook.

### Activation

| Command | What it does |
|---------|--------------|
| `agentenv use <env>… [--harness <h,h>] [--global]` | Activate a stack. Session by default; `--global` writes real config paths. |
| `agentenv drop [<env>… \| --all] [--harness <h,h>] [--global]` | Deactivate. |
| `agentenv default <env>… \| --remove` | Write a committable `.agentenv` naming this folder's default env(s). |
| `agentenv run <env>… -- <harness> [args…]` | One-shot: compose a private view and exec the harness. No shell hook needed. |
| `agentenv shell-init` | Print the shell hook to `eval`. |
| `agentenv status` | Session binding, global stack, and per-harness surface support. |

`--harness` takes a **comma-separated** list of harness ids or binary names, not
a repeated flag: `--harness claude-code,codex` (or `--harness claude,codex`).

### Adoption

Content you create mid-session inside a managed directory can be pulled into the
store rather than lost.

| Command | What it does |
|---------|--------------|
| `agentenv capture [--dry-run]` | Run the auto-adopt sweep now. `--dry-run` previews and changes nothing. |
| `agentenv adopt <name> --into <env>` | Adopt one new item into a chosen environment. |
| `agentenv disown <name>` | Reverse an adoption: hand the item back, drop ownership. |

### Sync, secrets and repair

| Command | What it does |
|---------|--------------|
| `agentenv remote <url> [--non-interactive] [--offline]` | Connect or safely replace the single sync remote. |
| `agentenv sync [--resolve \| --abort]` | Pull-rebase + push. `--resolve` walks you through a conflict. |
| `agentenv secret set <KEY> <VALUE>` / `list` / `rm <KEY>` | Manage machine-local `${VAR}` values. Never synced. |
| `agentenv doctor [--repair] [--restore <backup>]` | Detect, repair, or restore. |

## Session mode vs `--global`

These are two genuinely different mechanisms, and the difference matters.

**Session mode** (`agentenv use writing`) is the default and the safe one.

- Binds *this shell* + *this project directory* to a stack in a registry under
  `~/.agentenv/`.
- **No real config file is touched.** When you launch `claude`, the PATH shim
  installed by `init` intercepts it, composes a private view under
  `~/.agentenv/live/<session>/<harness>/`, points the harness's config-root env
  var at that view, and execs the real binary.
- Credentials, session history, caches and trust records inside the real config
  root are passed through by per-entry symlink, so you stay logged in.
- Requires the shell hook (`eval "$(agentenv shell-init)"`), which supplies the
  `AGENTENV_SESSION` id. Without it, `use` fails with a message telling you so.
- Different terminals can run different environments at the same time.

**Global mode** (`agentenv use writing --global`) is the explicit fallback.

- Materialises onto the harness's **real** config paths (`~/.claude`,
  `~/.codex`, `~/.config/opencode`, `~/.pi/agent`, `~/.cursor`) through a
  journalled, lock-guarded, crash-safe engine.
- Machine-wide: every harness process sees it, including GUI apps that inherit
  no shell environment.
- Required for Cursor, which has no working session isolation.
- Reversible with `agentenv drop --all --global`, which removes exactly what the
  manifest recorded and nothing else.

**One-shot** (`agentenv run writing -- claude`) composes a session view and
execs the harness immediately, without the shell hook or shims. This is the CI
and scripting entrypoint. Parallel `run`s of the same stack get isolated view
directories.

## Syncing across machines

The store (`~/.agentenv/store/`) is an ordinary git repository. `agentenv init`
makes it one and commits a baseline. Every mutating command pulls before it acts
and pushes after, with one commit per mutation
(`agentenv: add skill tone-of-voice → writing`).

**Machine A** — connect a remote you created empty:

```sh
agentenv remote git@github.com:you/agentenv-store.git
agentenv sync
```

**Machine B** — bootstrap by cloning:

```sh
agentenv init --remote git@github.com:you/agentenv-store.git
agentenv list
agentenv use writing --global
```

`init --remote` on a machine with no store yet **clones**; on a machine that
already has one it connects (or safely replaces) the remote instead. Replacing a
remote classifies the candidate's history first — `same`, `empty`, `related`,
`unrelated`, `unreachable` — and only flips the configured URL as the last step,
after the chosen action succeeded. An unrelated non-empty history is refused
non-interactively and defaults to cancel interactively.

`agentenv` **never** force-pushes, never auto-merges, and never auto-resolves a
conflict. A rebase conflict blocks *sync only* — everything local keeps working
— and `agentenv sync --resolve` walks you through the conflicted store files
(plain YAML and Markdown) before continuing. `agentenv sync --abort` cancels and
keeps your local version.

Being offline is not an error: commits queue locally and the next successful
sync pushes them.

## Secrets

**No secret value ever reaches the synced store.** The store holds `${VAR}`
placeholders; values live in `~/.agentenv/secrets.env`, which sits *beside* the
store, never inside it, and is therefore never committed or pushed.

```sh
agentenv secret set GITHUB_TOKEN ghp_xxx
agentenv secret list      # values are always masked
agentenv secret rm GITHUB_TOKEN
```

In `mcp/servers.yaml`, reference the placeholder:

```yaml
github:
  type: stdio
  command: npx
  args: ['-y', '@modelcontextprotocol/server-github']
  env:
    GITHUB_TOKEN: ${GITHUB_TOKEN}
```

Resolution order at materialisation time is `secrets.env` first, then the shell
environment. A name that resolves to nothing **fails closed for that server
only**: `agentenv` warns and skips it rather than writing an empty literal. The
rest of the environment still materialises. When a value is written back from a
harness config, the placeholder is restored — a resolved secret is never written
into the store.

This is why a fresh machine restore is safe: clone the store, run
`agentenv use … --global`, and any server whose secret you have not yet set on
that machine is reported and skipped until you `agentenv secret set` it.

## `doctor`

`agentenv doctor` compares the write-ahead manifest against the real surfaces it
owns and reports every inconsistency. It is read-only and exits non-zero when it
finds anything.

Six detectors:

| Kind                  | What it catches |
|-----------------------|-----------------|
| `journal-pending`     | A mutation interrupted mid-flight (kill, crash, power loss). |
| `dangling-symlink`    | A managed link whose store target is gone. |
| `store-drift`         | A manifest item whose store source has been deleted. |
| `mangled-markers`     | A `file-block` region a harness duplicated, relabelled, split or rewrote. |
| `reserialised-config` | An owned config key a harness rewrote to a different value. |
| `orphaned-backup`     | A backup no manifest item references. |

```sh
agentenv doctor                      # report only, exit 1 if anything is wrong
agentenv doctor --repair             # roll the journal, re-drive broken surfaces, re-scan
agentenv doctor --restore <backup>   # restore one content-addressed backup to its recorded path
```

`--repair` is idempotent and crash-safe: it reuses the same journalled,
lock-guarded mechanisms as normal activation, so a kill mid-repair leaves at
most one pending journal that the next run rolls back. Run it twice and the
second run reports clean.

`--repair` and `--restore` are mutually exclusive.

One thing that surprises people: after `agentenv drop … --global`, `doctor`
exits 1 reporting `orphaned-backup` for each dropped item. That is housekeeping,
not damage — dropping an item removes the manifest record that referenced its
pre-mutation backup. `agentenv doctor --repair` deletes them and the next
`doctor` is clean.

**What `--repair` cannot do** is set out under
[Known limitations](#known-limitations). Read it.

## Supported harnesses

| Harness         | id            | binary         | session | skills               | instructions         | MCP                  |
|-----------------|---------------|----------------|---------|----------------------|----------------------|----------------------|
| **Claude Code** | `claude-code` | `claude`       | yes     | `~/.claude/skills`   | `~/.claude/rules/`   | `.claude.json`       |
| **Codex**       | `codex`       | `codex`        | yes     | `~/.codex/skills`    | `~/.codex/AGENTS.md` | `config.toml`        |
| **OpenCode**    | `opencode`    | `opencode`     | yes     | agents dir           | `instructions[]`     | `opencode.json`      |
| **Pi**          | `pi`          | `pi`           | yes     | `~/.pi/agent/skills` | `AGENTS.md`          | **unsupported**      |
| **Cursor**      | `cursor`      | `cursor-agent` | **no**  | `~/.cursor/skills`   | **unsupported**      | `~/.cursor/mcp.json` |

Per-harness live-verification notes, including exactly which cells were probed
against a real binary and when, are in
[`docs/`](https://github.com/code-ministry-ltd/agentenv/tree/main/docs):
[Claude Code](https://github.com/code-ministry-ltd/agentenv/blob/main/docs/harness-claude.md),
[Codex](https://github.com/code-ministry-ltd/agentenv/blob/main/docs/harness-codex.md),
[OpenCode](https://github.com/code-ministry-ltd/agentenv/blob/main/docs/harness-opencode.md),
[Pi](https://github.com/code-ministry-ltd/agentenv/blob/main/docs/harness-pi.md),
[Cursor](https://github.com/code-ministry-ltd/agentenv/blob/main/docs/harness-cursor.md).

`agentenv status` prints this matrix for your machine, including which surfaces
are unsupported and *why*.

## What lives where

```
~/.agentenv/
├── store/              ← the git repo. This is what syncs.
│   ├── README.md         (generated; explains the layout to anyone who clones it)
│   ├── .gitignore
│   └── environments/
│       └── writing/
│           ├── env.yaml            description, notes, capture-ignore patterns
│           ├── skills/             one directory per skill
│           ├── instructions/       base.md, or <harness>.md
│           ├── mcp/servers.yaml    canonical MCP definitions (${VAR} placeholders)
│           ├── agents/             subagent definitions
│           ├── commands/           slash commands
│           └── files/              anything else the env carries
├── state.json          ← the write-ahead ownership manifest. Machine-local.
├── secrets.env         ← ${VAR} values. Machine-local. NEVER synced.
├── backups/            ← content-addressed pre-mutation backups. Machine-local.
├── live/               ← composed private session views. Machine-local, disposable.
├── shims/              ← PATH shims, one per harness. Machine-local.
└── lock                ← serialises agentenv's own mutations.
```

Only `store/` is under version control. Everything else is machine-local by
design — that is what keeps secrets, credentials and per-machine state out of
the synced repo.

Set `AGENTENV_HOME` to relocate the whole tree (used by the test suite to stay
hermetic).

## Known limitations

These are real, current, and will bite you if you do not know about them.

### MCP drift is reported, never applied

If you edit an MCP server through a harness — `claude mcp add`, or by hand in
`~/.claude.json` — `agentenv` **detects** the difference on its next invocation
and **tells you about it**, field by field:

```
agentenv: mcp drift — 'github' differs between the claude-code config and env 'writing':
    harness config:  /home/you/.claude/.claude.json
    canonical store: /home/you/.agentenv/store/environments/writing/mcp/servers.yaml
  changed args
  agentenv has NOT changed …/mcp/servers.yaml — edit it yourself to make the harness-side change permanent.
```

That is all it does. **`agentenv` never writes canonical MCP state from a
harness config.** If you want the change to survive, you must edit
`mcp/servers.yaml` yourself. The next `use` re-materialises from the canonical
store and your harness-side edit is gone.

This is deliberate — the canonical model is the source of truth and a harness's
serialisation of it is not — but it means MCP edits are one-directional in a way
skills and instructions are not.

### Cursor is global-only

Cursor has **no session support**. `CURSOR_CONFIG_DIR` does not isolate the CLI
(live-verified), and the IDE inherits no shell environment, so a shim cannot
work. Use `agentenv use … --global` for Cursor. Cursor also has no
global-instructions surface — User Rules are app-and-cloud state in a settings
database, not a file — so use skills instead. Project `.cursor/rules` and
`AGENTS.md` are read-only inputs and are never composed.

### Pi has no MCP

Pi has no native MCP surface. `agentenv status` reports it as `UNSUPPORTED`
rather than pretending. Use MCP on another harness, or a Pi extension.

### `doctor` gaps

Three known holes, all pinned by tests so they stay visible:

1. **A `conflict` marker rollback discards post-activation edits, unrecoverably.**
   When a harness mangles a managed instruction region — duplicating a marker,
   splitting the region, rewriting line endings — `agentenv` fails closed: it
   refuses to guess the region's span and instead rolls the whole file back to
   its activation-time bytes. Anything you wrote into that file *outside* the
   managed region since activation is destroyed, and it is captured nowhere, so
   `doctor --restore` cannot offer it back. Pinned by
   `test/doctor.hardening.mangled-markers.test.ts`
   ("a conflict rollback discards post-activation edits with no backup to
   recover them"). The fail-closed rollback is the accepted trade; the
   unrecoverability is not, and is unfixed.

   *Workaround:* keep long-lived prose out of a file `agentenv` composes into,
   or back it up yourself before letting a harness rewrite it.

2. **A harness DELETING an owned config key is not detected.** If something
   removes the `mcpServers` key that `agentenv` injected into `~/.claude.json`,
   `doctor` reports `no problems found` and exits 0. The manifest still claims
   ownership; nothing tells you the surface is empty. Re-running
   `agentenv use … --global` restores it.

3. **Partial store loss is not reported.** If an environment contributes two
   instruction sources to one region and you delete one of them from the store,
   `doctor` stays silent and exits 0. This is deliberate — dropping the whole
   region would throw away the sub-block that is still good — but you get no
   warning that the environment is now incomplete. Pinned by
   `test/doctor.hardening.store-deleted.test.ts`
   ("a PARTIAL store loss is deliberately left alone rather than dropped
   wholesale").

### Other things worth knowing

- **`agentenv` is not published to npm.** Install from GitHub. The npm name is a
  parked placeholder at `0.0.1` and does not track this repo.
- **Windows is untested.** The code prefers copies over symlinks where symlink
  behaviour is unverified, but CI runs Linux and macOS only.
- **A `.agentenv` default file is inert until approved on each machine.** A
  cloned repo containing one does nothing until you run `agentenv default` there
  yourself — deliberately, on the `.mcp.json` trust model.
- **The auto-adopt sweep never adopts project-directory items.** Use
  `agentenv adopt <name> --into <env>` deliberately for those.

## Development

```sh
npm ci
npm run lint        # eslint
npm run typecheck   # tsc, no emit
npm test            # vitest
npm run ci          # all three
```

The test suite is hermetic: every test points `AGENTENV_HOME` at a temp
directory, and `guardRealHome()` redirects `HOME` so a bug that fell back to
`~/.agentenv` would be caught rather than silently write to your real config.
No test ever reads or writes a real harness config.

The pack-and-install smoke test — which packs a tarball, installs it into a
clean prefix, builds an environment on a bare git remote, restores it on a
second simulated machine, and asserts it materialised on two harnesses — is:

```sh
npm run smoke:install
```

Release and rollback procedure:
[`docs/RELEASE.md`](https://github.com/code-ministry-ltd/agentenv/blob/main/docs/RELEASE.md).

`package.json` carries `"private": true` and a `prepublishOnly` guard that fails
loudly. That is deliberate: `agentenv` is GitHub-distributed and the npm name is
a parked placeholder. `npm pack` is unaffected.

## License

Apache-2.0. See [LICENSE](LICENSE).
