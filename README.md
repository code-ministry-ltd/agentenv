# agentenv

Switchable, Git-backed environments for AI coding agents.

An environment is a named bundle of skills, instructions, MCP servers,
subagents, commands, and raw harness files. `agentenv` can expose the same stack
to Claude Code, Codex, OpenCode, Pi, and Cursor while preserving config it does
not own.

This merged implementation uses isolated session generations, retained global
copy-on-write projections, field-level reverse projection, an operation WAL,
isolated Git candidates, and gated migration from both pinned v1 formats. It is
intentionally conservative: uncertain bytes are retained for explicit
resolution rather than overwritten or deleted.

## Requirements and status

- Node.js 22.12 or newer.
- macOS or Linux. Windows is best-effort and does not carry the same process and
  filesystem guarantees.
- Git for store history and multi-machine sync. Local session/global operation
  remains available when Git or the network is unavailable.
- Apache-2.0; incorporated donor work is recorded in
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and
  [docs/MERGE_PROVENANCE.md](docs/MERGE_PROVENANCE.md).

The package is distributed as a GitHub release artifact, not through the npm
registry.

## Install

Download a release tarball and install it globally:

```sh
gh release download --repo code-ministry-ltd/agentenv --pattern '*.tgz'
npm install -g ./code-ministry-agentenv-*.tgz
agentenv --version
```

Or build a checkout:

```sh
git clone https://github.com/code-ministry-ltd/agentenv.git
cd agentenv
npm ci
npm run build
npm install -g .
```

Installing directly from a GitHub URL is unsupported because npm does not make
the development build toolchain available reliably during that install path.

## Quickstart

```sh
agentenv init
eval "$(agentenv shell-init)"

agentenv create writing
agentenv add skill writing tone-of-voice
agentenv add instructions writing
agentenv use writing
agentenv status
```

`use` without `--global` binds the current shell and project. The installed shim
builds an isolated generation when a harness launches; it does not alter the
harness's real configuration.

For GUI or machine-wide use:

```sh
agentenv use writing --global
agentenv status
agentenv drop --global
```

An env-less `drop --global` clears the complete global stack. There is no
`--all` alias and activation cannot be limited to selected harnesses.

### Local environment UI

Launch the browser interface with:

```sh
agentenv ui
```

The command starts a loopback-only server, prints its one-time launch URL, and
opens the default browser. Keep that terminal running while you use the UI and
press Ctrl-C to stop it. On a headless machine, or when you want to open the URL
yourself, use:

```sh
agentenv ui --no-open
agentenv ui --no-open --port 41739
```

The UI can browse every environment and content kind; create, clone, and delete
inactive environments; copy or move one content item at a time; edit and preview
`SKILL.md`; and discover and import selected skills from a supported Git source.
Existing content is skipped or refused by default and is replaced only after an
explicit overwrite choice.

It does not expose the server to the LAN, edit non-skill content, perform bulk
transfers, or provide activation, sync, recovery, migration, secret, or harness
administration. See [docs/UI.md](docs/UI.md) for workflows, safety behavior, and
recovery messages.

## Commands

Root flags must precede the command:

```sh
agentenv --offline use writing
agentenv --json status
agentenv --json --verbose status
```

`--offline` disables fetch, pull, push, remote probes, remote bootstrap, and
network Git skill sources. Local mutations, local commits, drift sweeps, and
`file://` or existing-directory skill sources still work. `--json` emits a
versioned result envelope; `--verbose` adds safe diagnostics without secret
values.

Run `agentenv --help` for the canonical one-line list. The public surface is:

| Area | Commands |
|---|---|
| Store | `init [--remote <url>]`, `migrate [--rollback]`, `create <name> [--from <env>]`, `list`, `show <name>`, `edit <name> [--print-path]`, `rm <name>` |
| Content | `add skill`, `add skills`, `add mcp`, `add instructions`, `add agent`, `add command` |
| Activation | `use <env>… [--global]`, `drop [<env>…] [--global]`, `default <env>… \| --remove`, `run <env>… -- <harness> [args…]`, `shell-init` |
| Adoption | `capture [--dry-run]`, `adopt <name> --into <env>`, `disown <name>` |
| Sync and recovery | `remote <url>`, `sync [--resolve \| --abort]`, `status`, `doctor [--repair] [--restore <backup>]`, `resolve …` |
| Local UI | `ui [--no-open] [--port <port>]` |

`rm` always refuses an active environment and always asks before deleting an
inactive one. Deactivate it explicitly first; there are no `--yes`, `--force`,
or `--drop-first` shortcuts.

### Adding content

```sh
agentenv add skill writing tone-of-voice
agentenv add skill writing ./my-skill
agentenv add skill writing owner/repo/path@ref
agentenv add skills writing owner/repo/path@ref --all
agentenv add mcp writing github --transport stdio
agentenv add instructions writing
agentenv add instructions writing --harness codex
agentenv add agent writing reviewer
agentenv add command writing review
```

Local and Git-sourced skills are validated before staged publication. Git
provenance and content publish together; symlinks participate in hashing and
diffing. `--force` remains available only on content-add workflows to resolve a
named content collision deliberately.

### Project defaults

`agentenv default writing` writes a committable `.agentenv` at the project root
and records a machine-local approval. A fresh clone does not activate that file
until approved locally. An explicit shell binding wins over a project default;
malformed or missing defaults fail open to an unbound harness launch.

### One-shot runs

```sh
agentenv run writing -- codex exec 'review this repository'
agentenv run base writing -- claude
```

The `--` separator is mandatory. Each invocation gets its own retained session
generation.

## Session and global lifecycles

Session views are immutable generations. A launch reserves a generation before
spawn, records process identity after spawn, supervises the process group, and
sweeps drift/adoption after the final process exits. A failed or ambiguous final
sweep retains the generation and appears in `status`.

Global mode uses retained copy-on-write projections because a GUI or other
unsupervised process can keep an old file descriptor open after `drop`. Dropping
restores the real surface immediately but retains the detached projection. After
closing every writer, reconcile it explicitly:

```sh
agentenv status
agentenv resolve projection <id> --quiescent
```

Activation and drop are rendered against private copies first. The complete
surface and ownership diff is then published through one identity-checked command
WAL; a pre-commit interruption restores the prior surfaces, while a third identity
is retained for explicit resolution. Already-open global writer descriptors are
handed to retained storage without changing their inode.

Other retained lifecycle records use the same explicit pattern:

```text
agentenv resolve command <id> --retry
agentenv resolve generation <id> --retry
agentenv resolve candidate <id> --retry
agentenv resolve candidate <id> --abandon
agentenv resolve rescue <id> --acknowledge
```

Resolved data remains retained until conservative garbage collection proves it
is unreferenced, unleased, and safe to collect.

## Git sync and remote replacement

The canonical store at `~/.agentenv/store` is a normal Git repository. Local
mutations commit before a best-effort push. Network failure does not roll back
local work; the push remains queued for a later invocation.

```sh
# Machine A
agentenv remote git@github.com:you/agentenv-store.git
agentenv sync

# Machine B
agentenv init --remote git@github.com:you/agentenv-store.git
agentenv list
```

Fetched history is validated in an isolated candidate before promotion. Invalid,
secret-bearing, conflicting, or writer-blocked candidates remain isolated and
visible in `status`. `agentenv` never force-pushes, auto-integrates unrelated
history, or auto-resolves a rebase conflict.

Remote replacement classifies same, empty, related, unrelated, and unreachable
histories. The configured URL changes only after the chosen operation succeeds;
an unrelated history defaults to cancel and can only be adopted after an
explicit archive confirmation.

## Secrets

Secret values are never accepted as command arguments. Put machine-local values
in `~/.agentenv/secrets.env` using `KEY=value` lines and restrict the file to the
current user:

```sh
install -m 600 /dev/null ~/.agentenv/secrets.env
$EDITOR ~/.agentenv/secrets.env
```

Canonical content contains `${VAR}` placeholders. `secrets.env` takes
precedence over the process environment. Values are exposed only to a child or
materialiser that needs them; state, status, rescue metadata, and Git retain
placeholders or machine-keyed non-reversible fingerprints, never resolved values. An
unresolved required variable skips the affected server and reports its variable
name.

## Adoption and reverse projection

Launch-time inventories let `capture` distinguish new session/global items from
pre-existing user content. Foreign-manager symlinks and project paths are left
untouched, `capture.ignore` applies, and secret-like content requires
confirmation.

For managed instruction and config fields, a sweep compares the rendered
baseline, observed harness bytes, and current canonical bytes. Demonstrably
lossless edits are patched back while preserving unknown fields and placeholders.
Concurrent, invalid, or ambiguous edits are quarantined with their bytes and an
actionable value-free diagnostic.

## Migration from v1

When a pinned Code Ministry or JimJafar v1 state file is detected, mutating
commands exit with code 2 and direct you to:

```sh
agentenv migrate
```

Migration installs a version-neutral closed shim gate, checks conservative
quiescence, backs up the old root and owned external paths, imports through
pinned read-only parsers, runs probes, and only then opens schema 2. Before that
opening point, `agentenv migrate --rollback` restores the v1 installation. After
opening, rollback is intentionally refused because it could overwrite
post-cutover work.

## Harness support

| Harness | Session | Global | Important limitations |
|---|---:|---:|---|
| Claude Code | Yes | Yes | Sessions use `--add-dir` plus explicit `--mcp-config`; global MCP is top-level `~/.claude.json`. |
| Codex | Yes | Yes | Global skills/command-skills use `~/.agents/skills`; raw `agents/*.toml` is supported; project trust is never granted automatically. |
| OpenCode | Yes | Yes | Session isolation requires `XDG_CONFIG_HOME` as well as its additive config override. |
| Pi | Yes | Yes | No native MCP support; it is reported and skipped. |
| Cursor | No | Yes | No isolated session root; global instructions are unsupported because User Rules are app/cloud state. |

See the verified adapter notes in [docs](docs/) for exact paths, transforms, and
probe caveats.

## Doctor and recovery

`agentenv doctor` is read-only and exits non-zero when it finds ownership,
journal, lifecycle, candidate, quarantine, migration, marker, config, backup, or
store inconsistencies.

```sh
agentenv doctor
agentenv doctor --repair
agentenv doctor --restore <backup-id>
```

Repair is deliberately narrower than “make the warning disappear.” It never
forgets uncertain ownership, overwrites a third identity, or discards retained
generation/projection/candidate bytes. Those cases require the corresponding
`resolve` command. A Git remote remains the backup for canonical environments;
surface backups are not a replacement for it.

## Known limitations

- Real-harness live checks require locally installed binaries and any required
  login; they are excluded from the default hermetic suite.
- Cursor is global-only and has no managed global-instructions surface.
- Pi has no native MCP surface.
- Resolved retained data has no time-based auto-deletion; safe collection is
  intentionally conservative.
- A global drop can leave projection records requiring an explicit
  `resolve projection … --quiescent` after writers close.
- Windows remains degraded and is not a first-class release target.
- The command-WAL and migration suites kill real child processes at every
  modeled durable boundary and recover in fresh processes. Operators should
  still keep the retained v1 backup until the new installation has been
  exercised normally.

## Development and release gates

```sh
npm ci
GIT_CONFIG_GLOBAL=/dev/null npm run ci
npm run test:offline
npm run test:migration
npm run test:ui
npm run test:ui:e2e
npm run smoke:install
npm run test:restore:container   # Docker required
AGENTENV_LIVE=1 npm run test:live
```

The default tests use temporary homes, local bare Git repositories, and injected
harness seams. The packed-artifact smoke installs into a clean prefix, syncs
between two simulated machines, activates Claude and Codex surfaces, drops them,
reconciles retained projections, and completes the local UI's core workflow. The
container gate repeats that proof in a clean Node 22 Linux image.

Release procedure and rollback guidance live in
[docs/RELEASE.md](docs/RELEASE.md).
