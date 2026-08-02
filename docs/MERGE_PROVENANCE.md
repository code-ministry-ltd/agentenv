# Merge provenance

This branch implements the reviewed agentenv merge plan from the Code Ministry
repository while using the JimJafar repository as a behavioral and test donor.
The pinned revisions are part of the implementation contract:

| Role | Repository | Revision | License |
|---|---|---|---|
| Physical base | `code-ministry-ltd/agentenv` | `a084ad352a972fd8f4949cc2c82e71a82281f5a8` | Apache-2.0 |
| Behavioral donor | `JimJafar/agentenv` | `f1259e300a61da6fa4dda7e7670ee64a08268b26` | MIT |

The base revision remains available in Git history. The donor's license notice is
preserved in `THIRD_PARTY_NOTICES.md`. Any later substantial copied section must
also carry a nearby source note in this ledger; behavior reimplemented from tests
or specifications is recorded as behavioral provenance rather than copied code.

## Port ledger

| Area | Selected behavior or primitive | Source | Incorporation | Status |
|---|---|---|---|---|
| Filesystem, backups, lock, Git runner, parsers | Retain the CM safety primitives behind new command-level contracts | CM | Existing Apache-2.0 code | Retained |
| Claude session | Additional directory, explicit MCP file, and additional-directory instruction environment; never default to `CLAUDE_CONFIG_DIR` | JJ `src/adapters/claude.ts` | Behavioral reimplementation with CM probe/compiler | Implemented |
| Claude global | Top-level `~/.claude.json`, native skills/rules, canonical persistence | JJ `src/adapters/claude.ts` | Behavioral reimplementation with CM transactional writers | Implemented |
| Codex | Shared skills, commands-as-skills, child environment, persistence | JJ adapter and tests | Behavioral reimplementation with CM TOML/probe/compiler | Vertical session/global behavior and TOML-agent raw mapping implemented; reverse persistence pending |
| OpenCode | `XDG_CONFIG_HOME` plus `OPENCODE_CONFIG_DIR` isolation | CM adapter and live fixture | Existing Apache-2.0 code | Retained |
| Pi | Five settings arrays and real probe | CM adapter and fixtures | Existing Apache-2.0 code | Retained pending persistence work |
| Cursor | Fixed real root, shared skills, explicit unsupported semantics | JJ adapter and tests | Behavioral reimplementation with CM validator | Pending |
| Session generations and inventory | Immutable retained generations and launch-time inventories | JJ view composer/adoption tests | Behavioral reimplementation under new lease model | Pending |
| CLI and release | Settled commands, root globals, env-less global drop, Node floor, container restore | JJ CLI/release tests | Behavioral reimplementation | Pending |
| Raw mappings | Generic `files/<harness>/<relpath>` and Codex TOML agents | Merge specification | New implementation | Implemented with recursive traversal checks, per-file ownership, collision handling, session write-through, global drop, inventory, and status |

## Baseline defect ledger

Vitest `test.fails` cases are intentional executable characterizations: the suite
passes while the documented defect remains and fails if a test unexpectedly starts
passing. The marker is removed in the same slice that implements the behavior,
leaving the case as a normal regression test.

| Defect or retained safeguard | Executable evidence at the pinned CM base |
|---|---|
| Claude sessions avoid root relocation and preserve the real auth layer | `test/merge-baseline-known-failures.test.ts` |
| OpenCode requires both isolation variables | `test/adapter.opencode.test.ts` (`passes the XDG_CONFIG_HOME + OPENCODE_CONFIG_DIR overrides`) |
| Env-less global drop is a no-op | `test/merge-baseline-known-failures.test.ts` |
| Session composition records no adoption inventory | `test/merge-baseline-known-failures.test.ts` |
| Lost global-stack write after committed items | `test/engine-global-orphan.test.ts` (retained mitigation characterization) |
| Inventory owner can remain stale after deactivation | `test/merge-baseline-known-failures.test.ts` |
| Generic raw passthrough and Codex TOML agents are absent | `test/merge-baseline-known-failures.test.ts` |
| Rejected pull state is not durable or status-visible | `test/merge-baseline-known-failures.test.ts` |

## Baseline verification

Run with host Git configuration disabled:

```bash
GIT_CONFIG_GLOBAL=/dev/null npm run ci
npm run smoke:install
```

At the pinned base, lint and typecheck passed. The first test run reported 836
passing and 3 skipped tests, plus pre-existing timeouts in the live Codex adapter
test and restore test. These timeouts are execution instability, not accepted
product behavior, and are not weakened or converted to expected failures.
