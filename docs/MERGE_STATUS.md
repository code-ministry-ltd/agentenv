# Merge implementation status

Status: **frozen implementation candidate — not release-ready**

The merged implementation is frozen at code commit `3813baa` on branch
`merge/agentenv-v2`. The status/specification commit above it changes documentation
only. The branch has not been tagged or released.

## Provenance

- Physical base: `code-ministry-ltd/agentenv@a084ad352a972fd8f4949cc2c82e71a82281f5a8`
- Behavioural/test donor: `JimJafar/agentenv@f1259e300a61da6fa4dda7e7670ee64a08268b26`
- Frozen merged code: `3813baa`
- Licensing/attribution ledger: [`MERGE_PROVENANCE.md`](MERGE_PROVENANCE.md)

## What the candidate contains

The frozen code includes the merged CLI and five-adapter contract, centralized
surface planning, schema-2 state, whole-command WAL infrastructure, immutable
session generations and leases, retained global COW projections, lossless reverse
projection and secret provenance, isolated remote candidates, safe remote
replacement, gated JJ/CM migration, raw passthrough, and staged local/Git-source
content publication.

Activation/drop, staged content publication, final-generation publication,
candidate promotion, migration, and remote replacement use durable command-level
transactions. Their recovery paths retain or quarantine uncertain bytes rather
than overwriting them.

## Verification recorded for the frozen candidate

| Gate | Result |
|---|---|
| `npm run lint` | Passed after the final Cursor compatibility change |
| `npm run typecheck` | Passed after the final Cursor compatibility change |
| `npm test` | Passed: 140 files; 1,045 passed and 3 skipped |
| Hermetic `GIT_CONFIG_GLOBAL=/dev/null npm run ci` | Passed on the frozen candidate: 140 files; 1,045 passed and 3 skipped |
| `npm run test:offline` | Passed: 140 files; 3 live-only files skipped |
| `npm run test:migration` | Passed: 5 files; 41 tests |
| `npm run smoke:install` | Passed from the packed artifact, including a two-machine local-remote restore and doctor-clean teardown |
| `AGENTENV_LIVE=1 npm run test:live` | Codex and Pi passed; Claude lacked host credentials; OpenCode and Cursor were not installed |
| `npm run test:restore:container` | Not run: Docker was unavailable on the implementation host |

The missing live binaries/credentials and Docker result are release-gate
limitations, not passing results. Re-run every gate in [`RELEASE.md`](RELEASE.md)
before release.

## Known incomplete requirement

The candidate does **not** yet fully satisfy merge requirement MR-003 (one
complete ordered plan before effects) across every maintenance/content workflow.
The remaining actual-path code still composes focused v1 journals or direct store
mutations in these areas:

- drift write-back across dir-merge, file-block, config-key, and session sources;
- automatic capture, manual adoption, and disown (including inventory updates);
- `doctor --repair` and `doctor --restore`;
- environment `create`, interactive `edit`, and `rm` publication.

Those paths are locally defensive and covered by existing tests, but a crash can
still occur between their independently committed sub-operations. That is weaker
than the merged specification's all-effects command boundary and must not be
described as complete.

The required follow-up is specified in [`../tasks/spec.md`](../tasks/spec.md).
Until it is implemented and all release evidence is green:

- do not tag or release this branch;
- do not weaken or delete the focused v1 journal recovery code—it remains needed
  for compatibility and recovery while the conversion is incomplete;
- do not infer release readiness from the passing unit-test count alone.

## Handoff

Continue from `merge/agentenv-v2`. Treat `3813baa` as the known-green code
save-point. Implement the residual specification in small test-first commits,
then repeat the complete release matrix from a clean checkout.
