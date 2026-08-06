---
type: specification
project: agentenv
change: complete-command-transaction-boundaries
created: 2026-08-03
status: implemented
depends_on: docs/MERGE_STATUS.md
frozen_code_revision: 3813baa
implementation_revision: e70feff
verified: 2026-08-06
governing_requirements: MR-003 through MR-006 from the reviewed merge specification
---

# Complete the remaining command transaction boundaries

## Assumptions

1. Work continues from frozen code revision `3813baa` on
   `merge/agentenv-v2`; this specification does not reopen the base or donor
   decision.
2. The original merge specification remains authoritative. This document narrows
   the remaining work needed for MR-003 through MR-006 and their crash-matrix
   success criteria; it does not relax them.
3. Existing CLI syntax, prompts, output, adoption commit-message granularity,
   offline behaviour, and no-clobber semantics remain user contracts.
4. The schema-2 command WAL, typed backups, path identities, quarantine records,
   and local-commit-before-Git ordering are the foundation to extend, not replace.
5. A legacy focused journal may be used to render a private staged result or to
   recover an old interrupted operation. It may not be the durability boundary
   for a new in-scope command on actual store, state, or harness paths.
6. Planning may create private staging data, typed backups, and durable intent.
   It may not change a canonical store path, owned harness surface, machine state
   domain record, Git index/ref, or project file before the complete plan exists.
7. No new runtime dependency, daemon, or background service is required.

## Objective

Make every remaining maintenance and environment-content workflow atomic at the
user-command boundary. Before its first real effect, a command must durably name
all affected paths and state changes, their expected pre/post identities, undo or
rescue material, and required Git bookkeeping. A crash must then either restore
the exact pre-command state or finish an already committed command without losing
or overwriting a third identity.

This closes the known release blocker recorded in
[`docs/MERGE_STATUS.md`](../docs/MERGE_STATUS.md). It is for users who expect
agentenv to preserve concurrent harness writes and unowned configuration even
when the CLI, host, or Git process dies at the worst possible boundary.

## Required behaviour

### CT-001 — One reusable actual-path transaction boundary

- Extend the schema-2 command plan so every in-scope mutation is reconstructible
  from durable data in a fresh process; recovery must not depend on closures or
  re-running discovery against changed inputs.
- A plan records a stable transaction ID and kind plus an ordered operation for
  every store, surface, state-domain, inventory, retained-data, and Git effect.
- Every filesystem operation records path, typed pre/post identity, undo reference,
  and the existing `pending → applying → applied → undoing → undone` states.
- State-domain application must preserve the command record that is driving it;
  replacing `state.json` wholesale and thereby deleting the WAL is forbidden.
- The command-level commit point occurs only after every local filesystem/state
  effect is applied. Required Git bookkeeping follows it durably; fail-soft push
  remains last and outside the local atomicity boundary.
- Central CLI recovery recognizes every new command kind before unrelated mutation.
  `status`, `doctor`, and `resolve` report or resolve pending commands without
  disguising them as legacy journals.

### CT-002 — Inert discovery and staging

- Each workflow separates discovery/classification from application. Discovery
  produces a complete deterministic post-state in private staging.
- All prompts, secret classification, format validation, collision checks, and
  destination selection finish before durable apply begins.
- Immediately before each destructive effect, revalidate the current identity
  against the planned pre-identity. A mismatch is a third identity: retain it and
  stop/roll back according to the command phase; never overwrite it.
- Staging is retained while a command is recoverable and collected only after the
  command and required Git bookkeeping complete.

### CT-010 — Drift write-back

- One drift sweep plans all attributable changes across dir-merge copies,
  file-block sources/refreshes, config-key reconciliation, retained global COW
  projections, and immutable session generations before changing any actual path.
- The plan includes canonical writes, safe rendered-surface refreshes, manifest
  hash/provenance changes, and quarantine outcomes. Ambiguous or concurrently
  changed projections remain recoverable and uncommitted.
- Secret placeholders and provenance survive reverse projection; no resolved value
  may enter staging metadata, WAL data, diagnostics, a diff, or Git history.
- All canonical drift from the sweep is included in the required local Git
  bookkeeping. A blocked or failed commit leaves the command `git-pending` and
  retryable; it does not clear the WAL or silently continue to fetch/promotion.
- The no-change path creates no command plan, backup, Git commit, or state churn.

### CT-020 — Capture, adopt, and disown

- Automatic capture classifies the complete inventory and obtains every required
  confirmation before applying the first adoption. Skipped candidates remain
  untouched with their existing reason.
- One capture plan contains every approved source-to-store publication, replacement
  symlink, ownership record, and inventory update. Manual `adopt` uses the same
  planner for its selected item.
- Source and destination identities are checked both during planning and at apply.
  Foreign-manager symlinks, project paths, `capture.ignore`, invalid shapes,
  secret-declined content, and unowned destination collisions retain current
  behaviour.
- Preserve the existing per-adoption Git history contract. Ordered path-scoped
  Git steps and their progress must be durable and idempotent so a crash between
  commits cannot duplicate a commit or absorb unrelated dirty store paths.
- `disown` plans removal of the managed link/store owner, restoration or explicit
  placement of content, baseline update, and required Git bookkeeping together.
  A destination that changes after the prompt is rescued, never overwritten.

### CT-030 — Doctor repair and restore

- `doctor` without a mutation flag remains read-only.
- `doctor --repair` diagnoses a stable snapshot and builds one plan for every
  deterministic repair it can safely perform. A problem that cannot be bounded
  exactly remains reported/quarantined and does not cause a guessed repair.
- The plan covers dangling-link repair, sourceless ownership removal, bounded
  marker repair, missing marker reinsertion, config-key reconciliation, rescue
  records, state changes, and orphaned-backup retirement.
- Current bytes are retained before every repair that displaces them. Repair must
  patch only the manifest-owned item/region/key and must never restore an old
  whole file over unrelated edits.
- Orphaned backups are moved into recoverable retirement before commit and are
  collected only after the command is complete; a crash cannot make a still-needed
  undo reference disappear.
- `doctor --restore <backup>` is its own one-plan operation. It revalidates the
  recorded target, retains any current identity, restores the typed backup, and
  records the rescue/repair outcome atomically.
- Recovery of an existing legacy journal is a prerequisite operation before new
  planning. The new doctor command must not open additional focused journals on
  actual paths.

### CT-040 — Environment content publication

- `create` renders or copies the new environment into private staging, validates
  the complete environment, and publishes it plus required Git bookkeeping through
  one command plan.
- Interactive `edit` gives the editor a private staged copy. On successful editor
  exit, validate the result and publish it through one command plan; on failure or
  invalid content, leave the canonical file unchanged and retain/report the staged
  draft when useful for recovery.
- `rm` publishes a planned absence for the inactive environment. Its pre-command
  bytes remain available to rollback until the local commit and required Git
  bookkeeping complete; no direct recursive deletion is allowed.
- Existing active-environment refusal, confirmations, validation, output, offline
  behaviour, and commit messages remain unchanged.
- Existing staged `add` workflows stay on their current whole-command boundary,
  but their recovery is included in the common startup/status/resolve audit so
  all content command kinds behave consistently.

### CT-050 — Git and sync ordering

- A required commit stages only the paths declared by the durable plan. Unrelated
  dirty store content is neither committed nor discarded.
- The durable plan records enough Git intent and progress to retry after process
  death without duplicate commits. An already-created intended commit is detected
  by durable identity, not guessed from a subject line alone.
- Fetch/candidate integration occurs only after pre-existing drift/adoption has
  reached its required local Git state. A `git-pending` command blocks unrelated
  store mutation and gives actionable recovery instructions.
- Push is attempted once after local completion and remains fail-soft/queued. No
  harness launch waits for a network pull.

## Success criteria

All criteria are release blockers for this follow-up.

1. **Plan-before-effect:** instrumentation proves every in-scope command persists
   its complete ordered plan before the first actual-path, state-domain, or Git
   mutation. Planning failures leave those domains byte-identical.
2. **Forward crash matrix:** subprocess tests kill before and after every forward
   operation transition for drift, multi-item capture, manual adopt, disown,
   doctor repair/restore, create, edit publication, and rm. Fresh-process recovery
   restores exact pre-command state before commit or completes after commit.
3. **Rollback crash matrix:** the same tests kill before and after every undo
   transition. Recovery is idempotent across repeated deaths and eventually
   reaches exact pre-state without deleting retained data.
4. **Third identity:** each workflow is faulted after an external replacement of
   every destructive target. The replacement bytes/type are present in quarantine
   or rescue, the command does not clobber them, and diagnostics reveal no secret.
5. **Whole-sweep drift:** simultaneous drift in all supported mechanisms yields
   either one locally committed sweep or a complete rollback; no subset reaches
   canonical state or Git alone.
6. **Multi-item capture:** two or more approved items adopt as one local command;
   failures at each item boundary restore all surface/store/state/inventory data.
   Successful Git history retains the existing per-item commit contract without
   including unrelated dirty files.
7. **Doctor:** a fixture containing multiple independently repairable problems is
   repaired all-or-nothing. Concurrent/unbounded damage is retained and remains
   actionable. Orphaned backup cleanup cannot break rollback.
8. **Content:** create, editor success/failure/invalid output, and rm pass staged
   publication and Git-failure tests. The canonical environment is never partially
   written or deleted.
9. **Recovery UX:** `status`, `doctor`, and `resolve` identify every pending new
   command kind, phase, affected non-secret paths, Git state, and safe next action.
10. **Compatibility:** all existing CLI golden tests, adapter tests, migration
    fixtures, candidate tests, global COW late-writer tests, and packed smoke tests
    remain green without weakening assertions or reclassifying required tests.
11. **Release matrix:** from a clean checkout on Node >=22.12,
    `GIT_CONFIG_GLOBAL=/dev/null npm run ci`, `npm run test:offline`,
    `npm run test:migration`, `npm run smoke:install`,
    `npm run test:restore:container`, and the documented five-harness
    `AGENTENV_LIVE=1 npm run test:live` checkpoint are green.

## Boundaries

### Always

- Write the failing crash/no-clobber test before converting each workflow.
- Keep each implementation slice independently buildable, testable, and
  recoverable from both its predecessor and successor states.
- Reuse typed backup, identity, quarantine, projection, and command-WAL primitives;
  centralize extensions needed by more than one workflow.
- Preserve unowned bytes, symlink targets, directory structure, modes, secret
  placeholders, and unrelated Git changes.
- Update this specification before implementing a changed decision.

### Ask first

- Change any command, option, prompt, output/exit-code contract, commit-message or
  per-adoption commit granularity.
- Add a runtime dependency, daemon, network service, schema-major bump, or new
  release platform claim.
- Make a currently required persistence path report-only or relax a crash/release
  criterion.
- Delete rescue/quarantine/staged recovery data without a proven successor.

### Never

- Mutate an actual destination, canonical source, state domain, Git index, or ref
  while still discovering the command plan.
- Launch the user's editor against the canonical store file.
- Clear a plan before required Git bookkeeping succeeds, or continue fetch/promotion
  past an unresolved `git-pending` command.
- Use an unscoped `git add -A` to implement path-specific durable bookkeeping.
- Re-run discovery during rollback, infer ownership from marker-shaped text, restore
  over a third identity, or force-push.
- Persist or log a resolved secret in WAL, staging metadata, rescue metadata, Git,
  status, doctor output, or tests.

## Out of scope

- Replacing the already-compliant activation/drop, migration, remote replacement,
  candidate promotion, global COW, generation publication, or staged `add`
  architecture except for small shared recovery integrations.
- Changing adapter behaviour or adding harnesses.
- New CLI features, secret-management commands, first-class Windows parity, npm
  publication, or a release tag.
- Removing legacy state readers or legacy-journal recovery needed by migrations or
  installations interrupted before this conversion.

## Open questions

There are no blocking product questions. Exact internal module boundaries and the
schema-2 minor extension used for durable Git-step progress are implementation
decisions, provided all compatibility and recovery criteria above remain true.
