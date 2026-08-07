# Local environment UI

`agentenv ui` is a local browser interface over the same validated,
transactional operations as the CLI. It is intended for day-to-day environment
and skill management without routine shell or filesystem work.

## Launch and stop

```sh
agentenv ui
```

The command listens only on `127.0.0.1`, prints a one-time launch URL, and opens
the default browser. Keep the command running while the UI is open. Press Ctrl-C
in that terminal to stop the listener and remove private Git candidate checkouts.

Use `--no-open` to print the URL without opening a browser, or choose an
unprivileged port explicitly:

```sh
agentenv ui --no-open
agentenv ui --no-open --port 41739
```

Global flags still precede the command. Offline mode refuses network Git sources
but permits `file://` and existing local repositories:

```sh
agentenv --offline ui
```

Each server process creates a fresh launch URL. Its credential is carried in the
URL fragment, exchanged once for an HttpOnly session, removed from the address
bar, and never written to agentenv state. Reopening an already-consumed launch
URL fails; launch a new `agentenv ui` process or use the authenticated tab.

## What version one can do

- Browse environments in stable order, filter all displayed content, and inspect
  skills, instructions, individual MCP servers, agents, and commands.
- Create an empty environment or clone an existing one.
- Delete an inactive environment after typing its exact name. Active
  environments must be deactivated first.
- Copy or move one content item between environments. Existing destination
  content is never replaced automatically.
- Open one skill's `SKILL.md`, edit it with Markdown support, use source, preview,
  or split view, validate it, and save against the revision that was loaded.
- Enter any Git skill source accepted by the CLI—such as
  `owner/repo/path@ref`, a supported Git URL, `file://`, or an existing local
  repository—then browse, filter, select, and import skills into one environment.

Git import uses a private checkout and records the resolved repository path, ref,
commit, and content hash with the vendored skill. A collision defaults to
**Skip**. Select **Overwrite** for each exact existing skill you intend to
replace; unselected skills and unrelated environment content are left alone.

## Conflicts, recovery, and Git

Every mutation stages and validates its result before publication, checks that
the environment still has the revision shown in the browser, and creates
path-scoped local Git history. Network push failure does not undo a completed
local change.

Common messages mean:

| Message | What it means | What to do |
|---|---|---|
| Content or environment changed | Something else edited the same canonical content after this screen loaded. | Refresh, review the newer content, and retry. Skill drafts are retained where possible. |
| Existing content / collision | The destination already contains that name. | Cancel, keep the existing item, or explicitly approve overwrite for that exact item. |
| Environment is active | A running or global harness still uses the environment. | Stop or drop that use, then retry deletion. |
| Pending recovery | An earlier mutation published incompletely or still needs Git bookkeeping. | Run `agentenv status`, then the exact `agentenv resolve command <id> …` action it reports; refresh the UI afterward. |
| Git pending | The canonical filesystem change completed but its required local Git bookkeeping did not. | Do not repeat the UI mutation blindly. Use `agentenv status` and retry the pending command. |
| Validation failed | The proposed name, skill frontmatter, or Markdown document is not valid. | Correct the named field or line; the editor draft remains available. |

Canonical environments live in the Git-backed agentenv store, so normal Git
history remains the recovery boundary for completed changes. A crash during a
mutation can leave an incomplete agentenv command state rather than silently
claiming success; `status` and `resolve` make that state explicit.

## Security and current limits

The UI is single-user and local-only. The server checks the exact loopback Host,
same Origin, session cookie, and CSRF token; it accepts opaque identities rather
than browser filesystem paths. Skill Markdown preview does not execute raw HTML
or scripts, fetch images, or navigate unsafe or relative URLs.

Version one deliberately does not provide:

- remote or LAN access, accounts, collaboration, telemetry, or hosted discovery;
- rich editing for instructions, MCP servers, agents, commands, or skill assets;
- bulk transfer, content merging, filesystem watching, or multi-tab editing;
- activation, drop, run, sync, remote, doctor, recovery, migration, secret, or
  harness administration.

Use the CLI for those supported administrative workflows. Developer build and
test instructions are in [DEVELOPMENT.md](DEVELOPMENT.md).
