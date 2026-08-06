# Merge implementation status

Status: **implementation complete — release candidate**

The merged implementation and the remaining command-transaction work are complete
on `merge/agentenv-v2`. The final code revision is `e70feff`; the branch has not
been tagged or released.

## Provenance

- Physical base: `code-ministry-ltd/agentenv@a084ad352a972fd8f4949cc2c82e71a82281f5a8`
- Behavioural/test donor: `JimJafar/agentenv@f1259e300a61da6fa4dda7e7670ee64a08268b26`
- Frozen merged baseline: `3813baa`
- Completed transaction implementation: `e70feff`
- Licensing/attribution ledger: [`MERGE_PROVENANCE.md`](MERGE_PROVENANCE.md)

## Completed scope

The shared schema-2 staged-command boundary now covers drift write-back, automatic
capture, manual adoption, disown, doctor repair and restore, and environment
create/edit/remove. Each workflow plans in private staging before touching actual
paths, persists typed pre/post identities and undo data, publishes local effects as
one recoverable command, and retains required path-scoped Git progress until it is
complete.

Central startup, `status`, `doctor`, and `resolve` understand the new command kinds.
Recovery is fresh-process safe, rescues third identities instead of overwriting
them, preserves unrelated dirty Git paths, and does not allow fetch/promotion past
required pending bookkeeping. The focused legacy journal readers remain for
backward recovery and migration compatibility.

The implementation is split into these independently tested slices:

- `46203c6` — reusable staged command transaction boundary
- `e03a787` — transactional environment content publication
- `36647aa` — atomic adoption workflows
- `4448e53` — recoverable whole-sweep drift publication
- `9f0566c` — doctor planning and repair through a shadow installation
- `a58ee78` — forward/rollback SIGKILL recovery matrix
- `db3d745` — isolated fix for a pre-existing timeout-fixture scheduling race
- `e70feff` — full-suite sync, secret-gate, and held-rebase compatibility fixes

## Verification recorded on 2026-08-06

Host: macOS Darwin 25.5.0 arm64, Node v22.21.1. Container evidence used Node
v22.23.2 on Linux.

| Gate | Result |
|---|---|
| Focused crash matrix | Passed: 26 real SIGKILL subprocess cases across every staged boundary and command kind |
| Full suite | Passed: 146 files; 1,095 tests |
| `GIT_CONFIG_GLOBAL=/dev/null npm run ci` | Passed: lint, typecheck, 146 files, 1,095 tests |
| `npm run test:offline` | Passed: 146 files; 1,095 tests |
| `npm run test:migration` | Passed: 5 files; 41 tests |
| `npm run smoke:install` | Passed from the packed artifact, including two-machine restore, private Codex launch, two global harnesses, drop, projection reconciliation, and doctor-clean teardown |
| `npm run test:restore:container` | Passed in a clean Node 22 Linux Docker container |
| `AGENTENV_LIVE=1 npm run test:live` | Codex and Pi passed; Claude lacked the live test's credential prerequisite; OpenCode and Cursor were not on this shell's `PATH` |

## Release status

The build and implementation requirements in [`../tasks/spec.md`](../tasks/spec.md)
are complete, and every locally runnable non-live release gate is green. The live
checkpoint remains partial: two harnesses passed and three were skipped because of
host prerequisites. Under the strict checklist in [`RELEASE.md`](RELEASE.md), run
the Claude, OpenCode, and Cursor live probes on a suitably configured release host
before tagging, or record an explicit release waiver. Do not describe skipped live
probes as passing results.

No npm publication, release tag, or force-push is part of this merge completion.
