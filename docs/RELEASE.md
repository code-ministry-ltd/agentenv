# Releasing agentenv

agentenv is released from GitHub as an npm-format tarball. It is not published
to the npm registry: `private: true` and the failing `prepublishOnly` script are
deliberate safeguards.

## Supported release matrix

- Node.js 22.12 and the current Node 24 line.
- Ubuntu and macOS CI.
- No native runtime dependencies.
- Five adapters: Claude Code, Codex, OpenCode, Pi, and Cursor. Cursor remains
  global-only; Pi has no native MCP surface.

The CLI version is in `package.json`. Canonical `env.yaml` uses schema 1.x;
machine-local `state.json` and its lifecycle records use schema 2.x. A newer
major is rejected before mutation; unknown fields and newer minor fields are
preserved.

## Required gates

Run from a clean checkout with Node 22.12 or newer:

```sh
npm ci
GIT_CONFIG_GLOBAL=/dev/null npm run ci
npm run test:offline
npm run test:migration
npm run smoke:install
npm run test:restore:container
AGENTENV_LIVE=1 npm run test:live
```

What each extra gate proves:

| Gate | Evidence |
|---|---|
| `test:offline` | The non-live suite completes without depending on hosted services or a user home. |
| `test:migration` | Both pinned v1 readers, closed-gate cutover, probes, and fresh-process recovery after real SIGKILL at every modeled boundary. |
| `smoke:install` | A packed artifact installs in a clean prefix, syncs through a local bare remote, restores to a second machine, materialises Claude/Codex, drops, reconciles projections, and finishes doctor-clean. |
| `test:restore:container` | The same packed restore proof in a clean Node 22 Linux container. Docker is required. |
| `test:live` | Current installed Claude, Codex, OpenCode, and Pi binaries accept isolated views. These checks are intentionally opt-in because they depend on local binaries/login state. Cursor has no session probe. |

Do not replace a missing live or container result with the default unit suite.
Record the OS, Node version, and harness versions used in the release evidence.

## Cut a release

1. Confirm every required gate above is green and the worktree is clean.
2. Review `README.md`, every `docs/harness-*.md`, migration instructions, and
   known limitations against observed behavior.
3. Bump `package.json` and `package-lock.json` to the intended semver.
4. Build and verify the version:

   ```sh
   npm run build
   node dist/bin.js --version
   ```

5. Commit through the normal PR workflow, merge, and create an annotated tag:

   ```sh
   git tag -a v1.0.0 -m "agentenv v1.0.0"
   git push origin v1.0.0
   ```

6. Pack and inspect the allowlisted artifact:

   ```sh
   npm ci
   npm pack
   tar -tzf code-ministry-agentenv-1.0.0.tgz
   ```

   The top level must contain only `dist/`, `README.md`, `LICENSE`,
   `THIRD_PARTY_NOTICES.md`, and `package.json`. Tests, sources, docs, CI
   configuration, and local notes must not ship.

7. Create the GitHub release and attach the tarball:

   ```sh
   gh release create v1.0.0 \
     --title "agentenv v1.0.0" \
     --notes-file RELEASE-NOTES.md \
     code-ministry-agentenv-1.0.0.tgz
   ```

Release notes must include migration requirements, harness limitations, any
retained-data/recovery behavior that changed, and links to the README and exact
adapter notes.

## Rollback and recovery

### Before a v1 migration opens

The migration gate is closed and mutation is blocked. Use:

```sh
agentenv migrate --rollback
```

This restores the pinned v1 root and managed entry points from the migration
backup. Keep the backup until the merged installation has been exercised.

### After a migration opens

Do not run a destructive “downgrade.” Post-cutover work may exist and the old
format cannot represent schema-2 lifecycle state. Reinstall the newer CLI or
perform a new forward migration from an explicitly reviewed snapshot.

### Roll back a canonical store change

Use a normal Git revert; never rewrite shared history:

```sh
git -C ~/.agentenv/store log --oneline
git -C ~/.agentenv/store revert <sha>
agentenv sync
```

### Hand back global surfaces

```sh
agentenv drop --global
agentenv status
```

Close all unsupervised harness writers, then reconcile each retained projection:

```sh
agentenv resolve projection <id> --quiescent
agentenv doctor
```

`doctor --repair` handles deterministic repairable inconsistencies. It does not
erase ambiguous ownership or retained lifecycle bytes. Use the explicit
`resolve` command named by `status`/`doctor` for commands, generations,
projections, candidates, and rescues.

## Release checklist

```text
[ ] package and lockfile versions agree
[ ] Node >=22.12 engine floor and Linux/macOS CI are green
[ ] hermetic CI, offline, migration, packed smoke, and container restore pass
[ ] live harness evidence is recorded with versions
[ ] README and adapter limitations match the build
[ ] no resolved secret appears in output, Git refs, fixtures, or artifacts
[ ] annotated v<semver> tag points at the reviewed commit
[ ] tarball contents match the package allowlist
[ ] GitHub release contains the tarball and migration/recovery notes
[ ] nothing was published to npm
```
