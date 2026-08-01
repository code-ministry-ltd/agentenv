# Releasing agentenv

`agentenv` is distributed **from GitHub only**: an annotated tag, a GitHub
release, and a packed npm tarball attached to it.

**It is never published to npm.** The npm name `@code-ministry/agentenv` is a
parked placeholder at `0.0.1` and is deliberately left that way. Do not run
`npm publish`. `npm pack` — which only builds a tarball locally — is the whole
of the packaging step.

Two guards in `package.json` enforce this:

- `"private": true`;
- a `prepublishOnly` script that prints the reason and exits 1.

`npm publish` therefore fails; `npm pack`, `npm install -g <tgz>` and
`npm install -g github:…` are all unaffected. Do not remove either guard to
"just try it".

---

## Versioning

Semantic versioning of the **CLI**, which is separate from the two on-disk
schema versions:

| Version           | Where                                      | Meaning |
|-------------------|--------------------------------------------|---------|
| CLI version       | `package.json` `version`, `agentenv --version` | What you release. |
| Env schema        | `SCHEMA_VERSION` in `src/env-config.ts`    | The shape of `environments/<name>/env.yaml`. |
| Manifest schema   | `STATE_SCHEMA_VERSION` in `src/state.ts`   | The shape of `~/.agentenv/state.json`. |

Both schemas are currently `1.0`. Both tolerate skew the same way: unknown
fields and a newer **minor** load fine; a newer **major** is refused with
`store newer than CLI — upgrade agentenv` / `state newer than CLI — upgrade
agentenv`. **This is the constraint that governs rollback** — see
[Rolling back](#rolling-back).

Bump the CLI version when you release. Bump a schema major only when you must,
and never in a patch release.

## Cutting a release

Everything below runs on `main`, after the PR is merged.

### 1. Green gate

```sh
git checkout main && git pull
npm ci
npm run lint
npm run typecheck
npx vitest run
```

All three must pass on their own exit codes. Do not pipe them through
`tail`/`head`/`grep`.

### 2. Pack-and-install smoke

```sh
npm run smoke:install
```

This packs a tarball, installs it into a throwaway prefix, and drives the whole
acceptance criterion against the installed binary: build an environment on a
simulated machine A, push it to a bare git remote, restore it on a simulated
machine B with `agentenv init --remote`, activate it, and assert the content
landed on two harnesses. It uses a temp `AGENTENV_HOME` and a temp `HOME`
throughout and never touches real harness config.

### 3. Bump the version

Edit `package.json` `version`, then:

```sh
npm run build
node dist/bin.js --version   # must print the new version
```

Nothing else hardcodes the version: `agentenv --version` reads `package.json`
at runtime, and the smoke test compares the installed binary against
`package.json` rather than a literal. So the bump is a one-line change.

Commit it on a branch and merge it through a PR like any other change.

### 4. Tag

An **annotated** tag on the merged commit:

```sh
git checkout main && git pull
git tag -a v1.0.0 -m "agentenv v1.0.0"
git push origin v1.0.0
```

Tags are `v<semver>`. Never move or delete a published tag — cut a new patch
release instead.

### 5. Build the artifact

```sh
npm ci
npm run build
npm pack
# → code-ministry-agentenv-1.0.0.tgz
```

Check the contents before attaching it:

```sh
tar -tzf code-ministry-agentenv-1.0.0.tgz | sed 's|^package/||' | cut -d/ -f1 | sort -u
# dist
# LICENSE
# package.json
# README.md
```

The `files` field in `package.json` is the allowlist. `test/`, `docs/`,
`spike/`, `.github/` and any local notes must **not** appear.

### 6. Create the GitHub release

```sh
gh release create v1.0.0 \
  --title "agentenv v1.0.0" \
  --notes-file RELEASE-NOTES.md \
  code-ministry-agentenv-1.0.0.tgz
```

Release notes should state, at minimum: what changed, which harnesses are
supported, and a link to the README's
[Known limitations](../README.md#known-limitations) section. Do not paper over
the limitations in the notes — a user who is surprised by MCP drift being
report-only after reading the release notes is a user the notes failed.

### 7. Verify the artifact a stranger would download

From a clean directory, on a machine that is not the build machine if possible:

```sh
gh release download v1.0.0 --repo code-ministry-ltd/agentenv --pattern '*.tgz'
npm install -g ./code-ministry-agentenv-1.0.0.tgz
agentenv --version
```

## Rolling back

### Rolling back the CLI

The CLI is a stateless binary; downgrading is just reinstalling an older
artifact.

```sh
PREV=v1.0.0   # the tag you want back; `gh release list` shows them
npm uninstall -g @code-ministry/agentenv
gh release download "$PREV" --repo code-ministry-ltd/agentenv --pattern '*.tgz'
npm install -g ./code-ministry-agentenv-*.tgz
agentenv --version
```

**The one thing that can block a rollback is a schema major bump.** If the newer
CLI wrote a `state.json` or an `env.yaml` at a higher major version, the older
CLI refuses to read it:

```
…/state.json: state newer than CLI — upgrade agentenv (state.json is v2.0, this agentenv supports up to v1.x)
```

That is a deliberate fail-closed refusal, not a bug. Recovery options, in order
of preference:

1. **Reinstall the newer CLI.** The refusal is telling you the on-disk state is
   ahead of the tool.
2. **Roll the store back in git.** The store is an ordinary git repo:
   `git -C ~/.agentenv/store log` and `git -C ~/.agentenv/store revert <sha>`.
   Every mutation is its own commit, so you can revert precisely one change.
3. **Rebuild the manifest.** `state.json` is machine-local, not synced. Running
   `agentenv drop --all --global` under the *newer* CLI, then reinstalling the
   older one and re-activating, gets you a manifest the older CLI understands —
   at the cost of re-activating your environments.

Within a single schema major, downgrade and upgrade are both safe: a newer minor
and unknown fields are tolerated by design.

### Rolling back a bad store change

The store is git. Nothing special is needed:

```sh
git -C ~/.agentenv/store log --oneline
git -C ~/.agentenv/store revert <sha>
agentenv sync
```

`agentenv` never force-pushes and never rewrites store history, so a revert is
always the right move — do not reset a pushed branch.

### Rolling back an activation

```sh
agentenv drop --all --global
```

This removes exactly what `state.json` records `agentenv` as having added, and
nothing else. Content you wrote yourself is untouched.

## What `doctor` can and cannot recover

`agentenv doctor` is the repair tool, not a backup system. Be precise about what
it covers.

### `doctor --repair` CAN recover

| Situation | What repair does |
|-----------|------------------|
| A mutation interrupted mid-flight (kill, crash, power loss) | Rolls the write-ahead journal forward or back to a consistent state. |
| A managed symlink whose store target is gone | Removes the dangling link and its ownership record. |
| A manifest item whose store source was deleted | Drops the orphaned materialisation and the record. |
| A managed instruction region a harness mangled (duplicated / relabelled / split / CRLF-rewritten) | Rolls the file back to its activation-time bytes and re-materialises from the manifest + store. **Lossy — see below.** |
| A managed instruction region a harness deleted outright | Re-inserts the region into the file as it currently stands, preserving your later edits. |
| An owned config key a harness rewrote to a different value | Reconciles the manifest hash to the current value and restores `${VAR}` placeholders. |
| Backups no manifest item references | Deletes them. |

`--repair` is idempotent and crash-safe: it reuses the same journalled,
lock-guarded mechanisms as normal activation. A kill mid-repair leaves at most
one pending journal that the next run rolls back. A second run reports clean.

### `doctor --repair` CANNOT recover

- **Edits you made to a composed instruction file outside the managed region,
  when that region is repaired from a `conflict`.** The rollback restores the
  file's activation-time bytes and those later edits are gone. They are captured
  nowhere, so `--restore` cannot offer them back either. This is a known,
  unfixed gap, pinned by
  `test/doctor.hardening.mangled-markers.test.ts`.
- **A harness DELETING an owned config key.** `doctor` reports
  `no problems found` and exits 0. Re-run `agentenv use … --global` to put it
  back.
- **Partial store loss.** If an environment contributes two instruction sources
  to one region and one is deleted from the store, `doctor` stays silent and
  exits 0 — deliberately, so the still-good sub-block is not thrown away with
  it. You get no warning that the environment is incomplete.
- **Anything outside the manifest.** `doctor` only knows what `state.json`
  records. Content `agentenv` never owned is neither checked nor repaired.
- **A lost store.** If `~/.agentenv/store` is deleted and there is no sync
  remote, `doctor` can report the sourceless surfaces and hand them back to you,
  but the content itself is gone. Connect a remote (`agentenv remote <url>`)
  before you need it.

### `doctor --restore <backup>` CAN recover

One content-addressed pre-mutation backup, written back to the path the manifest
records for it:

```sh
agentenv doctor --restore <backup-id>
```

Constraints, all enforced:

- The backup must be **referenced by a manifest item**. An unreferenced backup
  is an orphan, and `--repair` garbage-collects orphans — so a rescue copy that
  no item points at will not survive to be restored.
- The backup must still be present under `~/.agentenv/backups/`.
- The destination is the manifest-recorded path. You cannot redirect it.
- `--restore` and `--repair` are mutually exclusive in one invocation.

Backup ids appear in `doctor` output (the `orphaned-backup` detector names
them) and in `state.json`.

### `doctor --restore` CANNOT recover

- Anything without a `backupRef` on a live manifest item.
- Anything discarded by the `conflict` rollback described above — that path
  overwrites without capturing first.
- Store content. Backups are of **real surface files before agentenv mutated
  them**, not of your environments. Your environments' backup is the git remote.

## Release checklist

```
[ ] main is green: lint, typecheck, vitest — bare, exit codes checked
[ ] npm run smoke:install passes
[ ] package.json version bumped
[ ] README limitations still accurate for this build
[ ] annotated tag v<semver> pushed
[ ] npm pack contents = dist/, README.md, LICENSE, package.json only
[ ] gh release created with the tarball attached
[ ] downloaded artifact installs and reports the right version
[ ] NOT published to npm
```
