---
type: implementation-checklist
project: agentenv
change: local-environment-ui-v1
created: 2026-08-06
status: approved
approved: 2026-08-06
specification: tasks/spec.md
plan: tasks/plan.md
---

# Local environment browser and skill editor — build checklist

## Working rules

- Complete tasks in dependency order using RED → GREEN → REFACTOR → VERIFY.
- Commit each numbered task independently after its verification and the
  project-wide gates are green.
- Keep incomplete UI behavior unreachable; `agentenv ui` becomes user-visible
  only when its authentication and production assets work together.
- Do not broaden the approved dependency, schema, CLI-output, recovery, or product
  boundaries without updating the specification and asking first.
- At every checkpoint run `npm run lint`, `npm run typecheck`, `npm run build`, and
  `npm test`; from Task 4 onward also run the available UI and packed gates.

## Phase 1 — Contract, build, and secure launch

### Task 1 — Client and server share a safe UI contract

Define browser-neutral branded IDs, discriminated content/operation/result types,
bounded pagination primitives, opaque revisions, and the single error envelope.
Start with contract tests for JSON shape and exhaustive union handling.

- [x] Contract types import no Node-only module and distinguish every identifier
  and content kind at compile time.
- [x] Error, pagination, progress, conflict, and validation results have stable,
  serializable shapes matching UI-060.
- [x] Contract tests fail before the definitions exist and pass afterward.

Verification: `npx vitest run test/ui-contract.test.ts`

Verified 2026-08-06: focused test (4/4), typecheck, lint, build, and full
regression suite (147 files, 1,099 tests) passed.

Dependencies: none

Likely files: `src/ui/contract.ts`, `test/ui-contract.test.ts`

Size: S

### Task 2 — The build produces isolated production UI assets

Install the approved, exact UI/test dependencies and configure TypeScript/Vite so
browser assets are hashed into `dist/ui-assets/` without clearing Node output.
Assert package/build behavior before adding product UI behavior.

- [x] `npm run build` compiles Node and React production outputs in the required
  order without source maps or a runtime Vite dependency.
- [x] The tarball allowlist includes the generated assets and excludes UI source,
  fixtures, and development-only files.
- [x] Existing CLI build and typecheck behavior remains green.

Verification: `npm run build && npm pack --dry-run`

Verified 2026-08-06: focused test (2/2), exact Vite 8.2.1 build, tarball
contents, zero-vulnerability npm audit, lint, typecheck, and full regression suite
(148 files, 1,101 tests) passed.

Dependencies: Task 1

Likely files: `package.json`, `package-lock.json`, `vite.config.ts`,
`ui/tsconfig.json`, `ui/index.html`

Size: M

### Task 3 — The CLI starts a guarded loopback server

Add the hidden-until-complete `ui` command, Node HTTP lifecycle, one-time launch
credential, process session, Host/Origin/CSRF checks, body limits, security
headers, safe errors, and graceful shutdown. Test the real listener with `fetch`.

- [x] The server binds only `127.0.0.1`, chooses or validates its port, emits the
  credential only in the user-facing fragment URL, and closes cleanly on normal
  and signal-driven shutdown.
- [x] Foreign Host/Origin, missing session/CSRF, malformed or oversized bodies,
  unsupported content types, and unsupported methods return the specified errors.
- [x] Read-only asset/API requests never alter a temporary agentenv home.

Verification: `npx vitest run test/ui-server.test.ts test/ui-command.test.ts`

Verified 2026-08-06: focused HTTP/command tests (10/10), compiled process launch/
fetch/SIGTERM smoke, lint, typecheck, build, and full regression suite (150 files,
1,111 tests) passed.

Dependencies: Tasks 1–2

Likely files: `src/ui/server.ts`, `src/ui/security.ts`, `src/commands/ui.ts`,
`src/commands/index.ts`, `test/ui-server.test.ts`

Size: M

### Task 4 — A browser authenticates and renders the packaged app shell

Implement fragment credential exchange, immediate fragment removal, in-memory
CSRF handling, session refresh, the initial accessible React shell, safe fetch
adapter, and the Playwright production-server harness.

- [x] The page exchanges the fragment once, removes it, and makes subsequent API
  calls with the session cookie and mutation CSRF header.
- [x] Refresh works through the authenticated session and invalid/expired launch
  credentials reveal no application data.
- [x] Playwright launches the production build and proves authentication, shell
  rendering, security headers, and clean shutdown.

Verification: `npm run test:ui:e2e -- --grep "authenticates the local UI"`

Verified 2026-08-06: Playwright 1.61.1 production CLI flow passed in Chromium,
including fragment removal, HttpOnly/in-memory credential containment, session
refresh, CSRF mutation, replay refusal, keyboard focus, zero console problems,
and 320/768/1024/1440 layouts. Focused UI tests (16/16), lint, all three
typechecks, build, zero-vulnerability npm audit, packed isolated launch, and full
regression suite (150 files, 1,111 tests) passed.

Dependencies: Task 3

Likely files: `ui/src/main.tsx`, `ui/src/App.tsx`, `ui/src/api.ts`,
`playwright.config.ts`, `test/ui-auth.e2e.test.ts`

Size: M

### Checkpoint A — Secure packaged foundation

- [x] `npm run lint && npm run typecheck && npm run build && npm test`
- [x] `npm run test:ui:e2e -- --grep "authenticates the local UI"`
- [x] A packed isolated install starts and stops without reading the real home.

Checkpoint A passed 2026-08-06.

## Phase 2 — Browse environments and content

### Task 5 — A user can browse environment summaries

Build the read-only catalogue summary operation, authenticated paginated route,
and environment list UI with active state, description, stable ordering, counts,
and safe opaque revisions.

- [x] The list reports every environment once in stable order with accurate
  active state, description, and five-kind counts.
- [x] Pagination and query bounds reject malformed input and never expose paths.
- [x] The browser renders loading, populated, empty, and request-error outcomes.

Verified 2026-08-07: catalogue/API tests (3/3) and production CLI Playwright
flows (3/3) passed with real two-page, empty, and malformed temporary homes;
read-only identity checks passed. Lint, all three typechecks, build, UI tests
(19/19), all production-browser tests (4/4), and the full regression suite
(151 files, 1,114 tests) passed. The full suite used a process-local Git signing
override because this machine requests GPG signing but has no `gpg` executable.

Verification: `npx vitest run test/ui-catalog.test.ts && npm run test:ui:e2e -- --grep "browses environment summaries"`

Dependencies: Checkpoint A

Likely files: `src/application/catalog.ts`, `src/ui/routes.ts`,
`ui/src/EnvironmentList.tsx`, `test/ui-catalog.test.ts`,
`test/ui-browse.e2e.test.ts`

Size: M

### Task 6 — A user can inspect every content kind

Extend the catalogue, route, and selected-environment view to list skills,
instructions, MCP mapping entries, agents, and commands with relevant metadata
and redacted Git provenance.

- [x] All five groups report correct names and counts, including individual MCP
  mapping entries and skill source metadata.
- [x] Selecting or refreshing an environment never mutates store or state bytes.
- [x] The UI presents populated, empty, stale, unavailable, and error states with
  keyboard-operable group/item navigation.

Verified 2026-08-07: inventory/API tests (9/9) and focused production CLI
Playwright flows (2/2) passed, covering every content kind, safe Git metadata,
coherent/stale reads, byte-sensitive MCP revisions, no-follow regular-file
enforcement, read-only identity preservation, all UI states, and keyboard use.
Lint, all three typechecks, build, UI tests (28/28), all production-browser tests
(6/6), and the full regression suite (152 files, 1,123 tests) passed. The full
suite used the same process-local Git signing override recorded under Task 5.

Verification: `npx vitest run test/ui-inventory.test.ts && npm run test:ui:e2e -- --grep "inspects environment content"`

Dependencies: Task 5

Likely files: `src/application/catalog.ts`, `src/ui/routes.ts`,
`ui/src/EnvironmentView.tsx`, `test/ui-inventory.test.ts`,
`test/ui-browse.e2e.test.ts`

Size: M

### Task 7 — Browsing stays usable at the supported fixture size

Add within-environment filtering, explicit refresh, stale-response suppression,
and a deterministic 100-environment/1,000-element performance fixture.

- [x] Filtering is immediate, covers all displayed kinds, and preserves the
  current environment and keyboard focus where possible.
- [x] A late response from a previous environment cannot replace the current view.
- [x] The production browser list becomes enabled within one second on the
  deterministic performance fixture and logs useful timing on failure.

Verified 2026-08-07: the production Playwright journey passed with exactly 100
environments and 1,000 elements, all-kind/metadata filtering, explicit refresh,
focus retention, and late-response suppression. The first environment was
visible and trial-click actionable in 479.1ms on the exact Node 22.12.0 floor
(379.2ms during the normal Node 22.21.1 full UI gate). Lint, all three
typechecks, build, UI tests (28/28), all production-browser tests (7/7), and the
full regression suite (152 files, 1,123 tests) passed; one pre-existing Git hang
test flaked once, then passed alone and in the complete rerun.

Verification: `npm run test:ui:e2e -- --grep "large environment catalogue"`

Dependencies: Task 6

Likely files: `ui/src/EnvironmentList.tsx`, `ui/src/EnvironmentView.tsx`,
`ui/src/styles.css`, `test/fixtures/ui-large-home.ts`,
`test/ui-performance.e2e.test.ts`

Size: M

### Checkpoint B — Read-only browser

- [x] `npm run lint && npm run typecheck && npm run build && npm test`
- [x] `npm run test:ui && npm run test:ui:e2e`
- [x] Manual keyboard walkthrough confirms accurate inventory and no read effects.

Checkpoint B passed 2026-08-07. Root visual/keyboard inspection covered focused
desktop and 320px layouts with visible focus; production-browser identity tests
confirmed the walkthrough made no canonical writes.

## Phase 3 — Create, clone, and delete environments

### Task 8 — CLI and UI share create and clone rules

Extract presentation-neutral create/clone operations over the current staged
publication path, characterize existing CLI output, and make the CLI delegate
without changing its behavior.

- [x] Create publishes the valid scaffold and clone preserves the complete source
  plus provenance through one recoverable command.
- [x] Invalid, existing, stale, pending-recovery, Git-failure, and injected-failure
  cases publish nothing partial.
- [x] Existing CLI text, JSON, prompts, exit codes, and Git granularity are
  unchanged by characterization tests.

Verified 2026-08-07: presentation-neutral lifecycle/runtime tests and CLI
characterization passed with exact scaffold/clone bytes, provenance, modes,
self-contained links, path-scoped Git commits, typed stale/pending outcomes, and
no partial publication. Durable source/container preconditions passed real
SIGKILL/fresh-process recovery boundaries; no-follow source, destination, and
ancestor-link regressions passed. Focused recovery/lifecycle tests (136/136),
lint, all three typechecks, build, UI tests (28/28), production-browser tests
(7/7), and the full regression suite (153 files, 1,169 tests) passed. The full
suite used the process-local Git signing override recorded under Task 5.

Verification: `npx vitest run test/environment-lifecycle.test.ts test/create.test.ts`

Dependencies: Checkpoint B

Likely files: `src/application/environment-lifecycle.ts`,
`src/commands/create.ts`, `test/environment-lifecycle.test.ts`,
`test/create.test.ts`

Size: M

### Task 9 — A user can create or clone an environment

Expose create/clone through typed routes and accessible dialogs, including
validation, progress, conflict explanation, successful selection, and refresh.

- [x] Create and clone complete end to end with exact validated names and optional
  description/source inputs.
- [x] Validation, collision, stale, and pending-recovery outcomes preserve the
  dialog inputs and show a safe next action.
- [x] Successful publication selects and displays the new complete environment
  without a full browser reload.

Verified 2026-08-07: guarded lifecycle routes (4/4) and the production-browser
create/clone journey passed with exact scaffolds, complete provenance-preserving
clones, validation/refusal input retention, modal keyboard/focus behavior, and
no document reload. Held-mutation, post-publication projection failure, failed
refresh, stale-response, and retained-inventory retry regressions prove the UI
never invents cancellation or failure after authoritative publication and keeps
last-known-good state. Lint, all three typechecks, build, UI tests (28/28), all
production-browser tests (8/8), and the full regression suite (154 files, 1,173
tests) passed with the process-local signing override recorded under Task 5.

Verification: `npx vitest run test/ui-environment-routes.test.ts && npm run test:ui:e2e -- --grep "creates or clones an environment"`

Dependencies: Task 8

Likely files: `src/ui/routes.ts`, `ui/src/EnvironmentDialog.tsx`,
`ui/src/App.tsx`, `test/ui-environment-routes.test.ts`,
`test/ui-environment.e2e.test.ts`

Size: M

### Task 10 — CLI and UI share deletion safeguards

Extract the delete operation and active-environment/state checks from the command
without weakening retained-data, recovery, quarantine, or Git behavior.

- [x] Inactive deletion stages and publishes the same result as the existing CLI.
- [x] Active, stale, invalid, pending, and injected-failure refusals leave the
  environment and state byte-identical.
- [x] Existing CLI observable behavior remains unchanged.

Verified 2026-08-07: application deletion and exact CLI characterization tests
(22/22) passed, plus 121 focused active-state, secret-drift, path-safety,
session-binding, staged-command/WAL, concurrency, and Git-granularity tests.
Deletion validates inactivity atomically with removal, refuses waiting session
activation after removal, preserves concurrent replacements, never follows a
target outside the store, and distinguishes secret-bearing drift from ordinary
Git failure without unnecessary recovery state. Lint, all three typechecks, and
the full regression suite (155 files, 1,189 tests) passed; the known
`skill-source.git-hang` stdout timing fixture flaked once, passed immediately in
isolation, and the complete rerun passed.

Verification: `npx vitest run test/environment-delete.test.ts test/rm.test.ts`

Dependencies: Task 8

Likely files: `src/application/environment-lifecycle.ts`, `src/commands/rm.ts`,
`src/store.ts`, `test/environment-delete.test.ts`, `test/rm.test.ts`

Size: M

### Task 11 — A user can safely delete an inactive environment

Add the typed delete route and confirmation dialog requiring the exact name,
including active-environment refusal and retained input on recoverable failure.

- [x] A matching confirmation deletes one inactive environment and refreshes the
  selection; a mismatch or cancellation sends no mutation.
- [x] Active and stale refusals explain the reason and retain all bytes.
- [x] The dialog is keyboard complete, names the target prominently, restores
  focus, and does not rely on color for destructive meaning.

Verified 2026-08-07: typed deletion routes (7/7) and the production-browser
delete journey passed against temporary homes. Exact-name mismatch and
cancellation send no mutation; active, stale, missing, pending-recovery, drift,
and internal failures produce safe retained/refusal states; complete and
Git-pending publication remain truthful. Held-request, externally removed target,
failed-refresh, revision, CSRF/method/body, redaction, keyboard, focus-trap, and
focus-fallback regressions passed. Lint, all three typechecks, build, UI tests
(28/28), all production-browser tests (9/9), and the full regression suite (155
files, 1,192 tests) passed with the process-local signing override recorded under
Task 5.

Verification: `npx vitest run test/ui-environment-routes.test.ts && npm run test:ui:e2e -- --grep "deletes an inactive environment"`

Dependencies: Tasks 9–10

Likely files: `src/ui/routes.ts`, `ui/src/DeleteEnvironmentDialog.tsx`,
`ui/src/App.tsx`, `test/ui-environment-routes.test.ts`,
`test/ui-environment.e2e.test.ts`

Size: M

### Checkpoint C — Environment lifecycle

- [x] `npm run lint && npm run typecheck && npm run build && npm test`
- [x] `npm run test:ui && npm run test:ui:e2e`
- [x] Create, clone, refusal, and confirmed delete pass against a temporary home.

## Phase 4 — Copy and move all content kinds

### Task 12 — The application can copy any one element safely

Implement discriminated content locators and collision-aware copy staging for a
skill directory, instruction file, MCP entry, agent file, or command file.

- [x] Exact independent copies work for all five kinds and skill copies preserve
  source provenance in both environments.
- [x] Default collision refusal and explicit overwrite have byte-precise tested
  outcomes while unrelated content remains unchanged.
- [x] Invalid names, stale identities, pending recovery, and injected failure
  publish no partial destination.

Verified 2026-08-07: the application copy suite (47/47) passed for skill,
instruction, MCP, agent, and command content. Copy publication uses one staged
destination-environment boundary, so skill bytes and provenance recover together;
default collision refusal, explicit single-item overwrite, unrelated-content
preservation, AST-exact provenance/MCP metadata, stable no-follow source snapshots,
contained relative links, recursive physical-entry replacement, hostile runtime
outcomes, stale parent/source replacement, concurrent recovery, commit-point
truth, and close failure all have regressions. Lint, all three typechecks, the
production build, and the full suite (156 files, 1,239 tests)
passed with the process-local signing override recorded under Task 5.

Verification: `npx vitest run test/content-transfer-copy.test.ts`

Dependencies: Checkpoint C

Likely files: `src/application/content-transfer.ts`, `src/ui/contract.ts`,
`src/env-config.ts`, `test/content-transfer-copy.test.ts`

Size: M

### Task 13 — A user can copy an element between environments

Expose copy through a typed route and item action/dialog with destination,
collision details, explicit overwrite, cancellation, and affected-view refresh.

- [x] Copy works end to end for every kind and shows its source, destination,
  kind, and name before publication.
- [x] Collision cancellation sends no overwrite and explicit overwrite replaces
  only the declared destination element.
- [x] Conflict or failure retains the selection and presents a safe retry/refresh.

Verified 2026-08-07: typed transfer route/application/contract coverage (76/76)
passed, including real command, skill, instruction, MCP, and agent copies from
catalogue revisions through publication. Browser coverage proves source/kind/name/
destination review, focus trap/restore/fallback, no-request cancellation, redacted
failure and stale draft retention, refresh to a new source revision, collision
review, zero-overwrite cancellation, revision-bound held overwrite, disabled
authoritative controls, exact final bytes, and no document reload. Full UI tests
(29/29), all production-browser journeys (10/10), lint, all typechecks, build,
and the full suite (157 files, 1,264 tests) passed. Fresh review closed public
identity normalization, preflight-to-copy overwrite races, durable full-source
revision checks, and removed-item focus recovery; final re-review found no
required issue.

Verification: `npx vitest run test/ui-transfer-routes.test.ts && npm run test:ui:e2e -- --grep "copies content between environments"`

Dependencies: Task 12

Likely files: `src/ui/routes.ts`, `ui/src/TransferDialog.tsx`,
`ui/src/EnvironmentView.tsx`, `test/ui-transfer-routes.test.ts`,
`test/ui-transfer.e2e.test.ts`

Size: M

### Task 14 — The application moves an element atomically

Extend transfer publication so destination creation/overwrite, source removal,
and affected provenance files share one staged command and recovery boundary.

- [x] Move transfers each of the five kinds with no duplicate and no lost sole
  copy after successful completion.
- [x] Failure/crash injection at each publication boundary resolves to an exact
  pre-state or complete post-state through existing recovery behavior.
- [x] Concurrent source or destination replacement is retained and reported as a
  conflict rather than overwritten.

Verified 2026-08-07: move application tests (25/25), move/copy recovery tests
(60/60), and the combined transactional suite (206/206) passed. All five kinds
cover no-collision, refusal, and explicit overwrite; skill provenance and MCP
YAML presentation remain exact. Real child-process SIGKILL recovery covers every
forward publication boundary, reverse rollback, committed/Git-pending outcomes,
and concurrent-replacement quarantine. Directory backup restoration preserves
nested modes. Lint, all typechecks, build, and the full regression suite
(159 files, 1,303 tests) passed. Direct non-agentenv writes inside the final
publication window are outside the serialized v1 mutation contract and recorded
as deferred hardening rather than a UI release blocker.

Verification: `npx vitest run test/content-transfer-move.test.ts test/content-transfer-recovery.test.ts`

Dependencies: Task 12

Likely files: `src/application/content-transfer.ts`, `src/staged-command.ts`,
`src/path-identity.ts`, `test/content-transfer-move.test.ts`,
`test/content-transfer-recovery.test.ts`

Size: M

### Task 15 — A user can move an element between environments

Extend the transfer contract/dialog for move, warn that the source will be
removed, and surface collision, stale, pending, and recovery outcomes accurately.

- [x] Move works end to end for every kind and refreshes both affected inventories.
- [x] Cancel/overwrite decisions are explicit, keyboard operable, and never reused
  for a different stale destination.
- [x] UI success is shown only after the complete transaction is committed.

Verified 2026-08-07: transfer route/application tests (41/41) passed for real
five-kind moves, operation/result truth, collision consent, Git-pending outcomes,
and best-effort projections of both environments. Production-browser copy and
move journeys (2/2) passed with source-removal warning, keyboard cancellation,
failure/stale retention, refreshed revisions, collision cancellation, consent
invalidation, held overwrite, no duplicate requests, exact destination bytes,
source removal, focus fallback, and no reload. A review-driven revision-keyed
tombstone prevents an authoritatively moved item from remaining actionable when
source reconciliation fails, while a genuinely recreated revision returns after
refresh. Lint, all typechecks, build, UI tests (29/29), all production-browser
tests (11/11), and the full regression suite (159 files, 1,320 tests) passed.

Verification: `npx vitest run test/ui-transfer-routes.test.ts && npm run test:ui:e2e -- --grep "moves content between environments"`

Dependencies: Tasks 13–14

Likely files: `src/ui/routes.ts`, `ui/src/TransferDialog.tsx`,
`ui/src/EnvironmentView.tsx`, `test/ui-transfer-routes.test.ts`,
`test/ui-transfer.e2e.test.ts`

Size: M

### Checkpoint D — Content transfer

- [x] `npm run lint && npm run typecheck && npm run build && npm test`
- [x] `npm run test:ui && npm run test:ui:e2e`
- [x] The 5 × copy/move × collision matrix and recovery injection suite are green.

Checkpoint D passed 2026-08-07.

## Phase 5 — Edit and preview `SKILL.md`

### Task 16 — A user can open a skill document with its revision

Implement safe skill-document loading, a typed route, and a CodeMirror workspace
that loads only the selected skill's `SKILL.md` and tracks its opaque revision.

- [x] Load validates environment/skill names, returns no absolute path, and reads
  no file outside the selected validated skill directory.
- [x] CodeMirror opens the exact text with accessible source/preview/split controls
  and conventional editing behavior.
- [x] Missing, invalid, stale, and request-failure states do not discard an
  existing client draft.

Verified 2026-08-07: skill document application/route tests (9/9) passed for
exact stable no-follow reads, typed invalid/missing/unsafe/stale/failure outcomes,
opaque revisions, authenticated exact-GET behavior, and zero path/content leakage.
The production-browser editor journeys (2/2) passed for direct CodeMirror 6
lifecycle, exact hostile source text, keyboard-accessible Source/Preview/Split,
inert literal preview, retained drafts through late/failing responses, pending
newer-revision promotion, undo/cursor preservation across views, fresh history on
new revisions, locator-keyed selection, focus fallback, disabled save, and no
reload. Exact modular CodeMirror versions are lockfile-pinned; audit is clean.
Lint, all typechecks, build, UI tests (38/38), copy/move journeys (2/2), the
large-catalogue gate (518.1ms), and the full regression suite (160 files,
1,329 tests) passed. A non-cooperating alternating ancestor-symlink mutation
during the read window is recorded as deferred direct-store hardening under the
v1 concurrency boundary.

Verification: `npx vitest run test/skill-document.test.ts && npm run test:ui:e2e -- --grep "opens a skill document"`

Dependencies: Checkpoint D

Likely files: `src/application/skill-document.ts`, `src/ui/routes.ts`,
`ui/src/SkillEditor.tsx`, `test/skill-document.test.ts`,
`test/ui-editor.e2e.test.ts`

Size: M

### Task 17 — A user can validate and save a skill edit

Add staged authoritative validation, expected-revision save, scoped Git history,
typed validation/conflict responses, local feedback, and save shortcuts.

- [x] A valid edit publishes only `SKILL.md`, preserves the rest of the skill, and
  creates the established path-scoped local Git history.
- [x] Invalid content and injected failures retain the browser draft and leave
  canonical bytes unchanged.
- [x] An external edit after load refuses publication and offers reload or draft
  copy without clobbering either version.

Verified 2026-08-07: skill save application/route/listener tests (10/10) and
combined editor tests (17/17) passed for single-file staged publication, sibling
byte/mode preservation, path-scoped local Git history, frontmatter/name
validation, external and byte-identical replacement staleness, pre-commit
rollback, Git-pending recovery truth, strict authenticated CSRF mutation shape,
and configured runtime/offline/Git seam propagation. The production-browser save
journey passed for local validation with zero requests, one held Mod-S request,
exact saved revision/bytes, stale refusal, copy-draft and confirmed reload,
late-response isolation, truthful Git-pending state, draft retention, and no
reload. Lint, all typechecks, build, UI tests (48/48), related tests (113/113),
browser editor/copy/move journeys (4/4), and the full regression suite
(161 files, 1,340 tests) passed. One earlier run hit the known unrelated
`skill-source.git-hang` stdout timing flake; it passed immediately alone and the
complete corrected rerun was green.

Verification: `npx vitest run test/skill-document-save.test.ts && npm run test:ui:e2e -- --grep "validates and saves a skill"`

Dependencies: Task 16

Likely files: `src/application/skill-document.ts`, `src/ui/routes.ts`,
`ui/src/SkillEditor.tsx`, `test/skill-document-save.test.ts`,
`test/ui-editor.e2e.test.ts`

Size: M

### Task 18 — Skill preview and unsaved drafts are safe

Add a raw-HTML-disabled Markdown preview, permitted-link policy, dirty navigation/
refresh/close guards, retained retryable drafts, and complete keyboard/focus states.

- [x] Script/HTML payloads render inertly, remote plugins/assets do not load, and
  external links cannot retain opener access.
- [x] Dirty navigation, environment changes, refresh, and close warn before loss;
  cancellation preserves cursor, draft, and selected skill.
- [x] Source, preview, and split views plus validation/status announcements are
  keyboard operable and programmatically named.

Verified 2026-08-07: the production-browser preview/draft journey passed with
raw HTML rendered inertly, no script or image elements, zero remote image
requests, non-navigable unsafe/relative URLs, opener-safe permitted links,
keyboard Source/Preview/Split controls, browser unload protection, and an
accessible cancel/discard dialog. Cancelling close or environment navigation
retained the exact draft, cursor position, selected skill, and CodeMirror
instance; explicit discard completed navigation and removed the unload guard.
Stale reload uses the same in-app guard and retains the dirty state if reload
fails. Lint, all typechecks, build, UI tests (49/49), browser journeys (14/14),
and the full regression suite (161 files, 1,340 tests) passed.

Verification: `npm run test:ui:e2e -- --grep "previews safely and retains drafts"`

Dependencies: Task 17

Likely files: `ui/src/SkillEditor.tsx`, `ui/src/SafeMarkdown.tsx`,
`ui/src/navigation-guard.ts`, `ui/src/styles.css`,
`test/ui-editor.e2e.test.ts`

Size: M

### Checkpoint E — Skill editor

- [x] `npm run lint && npm run typecheck && npm run build && npm test`
- [x] `npm run test:ui && npm run test:ui:e2e`
- [x] Manual editor walkthrough confirms safe preview, save, stale refusal, and draft retention.

## Phase 6 — Browse and import skills from Git

### Task 19 — CLI and UI share exact Git skill discovery

Extract reusable fetch/scan/candidate metadata and vendoring boundaries from
`add skills`, retaining every supported source syntax, offline rule, Git auth
behavior, validation, provenance, and existing CLI output.

- [x] Local and network-form sources resolve to exact commit/path candidates with
  no browser or presentation dependency.
- [x] Invalid, unreachable, hostile, and offline-disallowed sources mutate no
  environment and reveal no credentials/private temp paths.
- [x] Existing `add skill` and `add skills` behavior remains unchanged.

Verified 2026-08-07: the shared application discovery lease resolves file URLs,
raw local-repository paths, network forms, refs, exact commits, repository paths,
descriptions, and validation state while keeping checkout paths private. Offline
network input is rejected before Git runs; injected Git environment/auth seams
are honored; failed and explicitly released checkouts are removed without temp
path leakage. The CLI's single/collection Git paths now use the same discovery
boundary while existing raw-directory copy semantics and rendered output remain
unchanged. Discovery and all add-source tests (52/52), lint, all typechecks,
build, and the full regression suite (162 files, 1,344 tests) passed.

Verification: `npx vitest run test/git-skill-discovery.test.ts test/add.source.*.test.ts test/add.skill.test.ts`

Dependencies: Checkpoint E

Likely files: `src/application/git-skill-discovery.ts`, `src/skill-source.ts`,
`src/commands/add.ts`, `test/git-skill-discovery.test.ts`,
`test/add-skills.test.ts`

Size: M

### Task 20 — A user can browse discovered Git skills

Implement async server-owned candidate sets, progress polling, bounded pagination,
opaque candidate IDs, private temp storage, and a repository/candidate browser.

- [x] Discovery returns immediately as `PENDING`, becomes `READY` or safely
  `FAILED`, and never blocks unrelated catalogue/editor requests.
- [x] Ready candidates show safe name, description, repo path/ref/commit metadata
  and support client filtering without accepting browser paths.
- [x] Explicit discard and 15-minute idle expiry invalidate candidates and clean
  temporary data no later than operation release or server shutdown.

Verified 2026-08-07: server-owned candidate sets return an opaque PENDING ID
immediately, report resolving/fetching/scanning progress, settle to redacted
READY/FAILED state, paginate at bounded sizes, and omit invalid candidates and
all private checkout paths. Candidate IDs require server-held object identity;
explicit discard, idle expiry, and server shutdown await private checkout
release. The production UI browses a real local Git repository, shows exact
repository/path/ref/commit metadata, filters client-side, restores focus, and
mutates no environment. Candidate application/HTTP tests (4/4), UI tests
(53/53), browser journeys (15/15), lint, all typechecks, build, and the full
regression suite (163 files, 1,348 tests) passed.

Verification: `npx vitest run test/ui-git-candidates.test.ts && npm run test:ui:e2e -- --grep "browses skills from Git"`

Dependencies: Task 19

Likely files: `src/application/git-candidates.ts`, `src/ui/routes.ts`,
`ui/src/GitImportDialog.tsx`, `test/ui-git-candidates.test.ts`,
`test/ui-git.e2e.test.ts`

Size: M

### Task 21 — A user can import selected Git skills

Resolve selected opaque candidates to their exact scanned content, revalidate
identity, publish through existing per-skill vendoring/history, preserve
provenance, and present explicit collision choices and per-skill outcomes.

- [x] Multiple selected candidates install exact validated content and current
  provenance into the chosen environment.
- [x] Existing destinations default to skipped; only a candidate-specific explicit
  overwrite may replace one, without changing unselected content.
- [x] Installed, skipped, and failed results remain truthful after mixed outcomes,
  expiry, substitution attempts, Git failure, or publication failure.

Verification: `npx vitest run test/git-skill-import.test.ts test/ui-git-candidates.test.ts && npm run test:ui:e2e -- --grep "imports selected Git skills"`

Evidence: exact selected multi-import, provenance, default skip, explicit overwrite,
unselected preservation, candidate substitution, expiry, cleanup, and Git-pending
outcomes are covered by the application, candidate-store, and real-browser tests.

Dependencies: Task 20

Likely files: `src/application/git-candidates.ts`, `src/ui/routes.ts`,
`ui/src/GitImportDialog.tsx`, `test/git-skill-import.test.ts`,
`test/ui-git.e2e.test.ts`

Size: M

### Checkpoint F — Git discovery and import

- [x] `npm run lint && npm run typecheck && npm run build && npm test`
- [x] `npm run test:ui && npm run test:ui:e2e`
- [x] Local multi-skill, mixed-result, offline, hostile, expiry, and cleanup cases are green.

Evidence: lint, typecheck, production build, 53 focused UI tests, 16 browser
journeys, and the full regression suite passed on 2026-08-07. Git discovery and
import tests cover local multi-skill and mixed outcomes plus offline, hostile,
expiry, substitution, failed-publication, and private-checkout cleanup paths.

## Phase 7 — Package and release hardening

### Task 22 — The local UI boundary survives adversarial requests

Perform the planned focused security review and add regression cases for launch/
session reuse, DNS rebinding headers, CSRF, path traversal, Git argument handling,
Markdown payloads, secret redaction, candidate substitution, and shutdown cleanup.

- [x] Every identified high/medium finding has a regression test and minimal fix,
  or is recorded as a blocking unresolved decision.
- [x] No request can nominate an absolute path, bypass identity/recovery checks, or
  expose launch/Git/private-path data.
- [x] Security and full compatibility suites remain green from a clean checkout.

Verification: `npx vitest run test/ui-security.test.ts && npm run test:ui:e2e -- --grep "rejects hostile UI input"`

Evidence: the focused review added four boundary tests for exact Host/Origin/CSRF,
single-use launch credentials, path and opaque-candidate substitution, Git argument
handling, and shutdown cleanup. One option-shaped Git-ref finding was fixed by
rejecting the ref before Git invocation. Existing hostile Markdown, redaction,
identity, and recovery cases remain green. The focused security suite (4/4), UI
suite (57/57), all 16 browser journeys, lint, typecheck, build, and the full
compatibility suite passed on 2026-08-07; no high/medium finding remains open.

Dependencies: Checkpoint F

Likely files: `src/ui/security.ts`, `src/ui/routes.ts`,
`ui/src/SafeMarkdown.tsx`, `test/ui-security.test.ts`,
`test/ui-security.e2e.test.ts`

Size: M

### Task 23 — The packed artifact completes the core workflow

Extend the isolated install smoke to launch/authenticate the production UI,
browse, create, copy, edit, import from a local Git fixture, delete, and shut down
on the supported Node floor without touching the real home.

- [x] The tarball contains everything needed and no source/dev-only UI material.
- [x] The core workflow succeeds from the installed prefix on a temporary home,
  and a failed startup leaves no listener or credential/temp residue.
- [x] Existing CLI packed and restore-container smokes remain unchanged and green.

Verification: `npm run smoke:install && npm run test:restore:container`

Evidence: the tarball allowlist now asserts the installed command, compiled UI
server, index, and hashed browser assets while excluding raw UI/source/test/dev
trees. The installed binary authenticated and served production assets, browsed
the restored store, created an environment, copied and edited a skill, imported
a selected skill from a local Git fixture, deleted the environment, and released
its listener and private checkout on SIGTERM. An occupied-port startup exposed no
credential and wrote no state or temp content. The local packed smoke and the
clean Node 22 Linux container restore smoke passed on 2026-08-07.

Dependencies: Task 22

Likely files: `scripts/smoke-install.sh`, `scripts/smoke-ui-install.sh`,
`package.json`, `test/fixtures/ui-smoke-repo.ts`

Size: M

### Task 24 — Users and maintainers can operate the finished UI

Document launch flags, security/local-only behavior, workflows, conflict/recovery
messages, development commands, test tiers, build layout, and current limitations.

- [x] README user instructions match the packed CLI and every v1 boundary.
- [x] Development documentation contains exact clean-checkout UI build/test/smoke
  commands and explains the shared application/HTTP/client dependency direction.
- [x] No documentation promises remote access, rich non-skill editing, bulk
  transfer, hosted discovery, or administration excluded from v1.

Verification: `npm run build && npm run lint && npm run typecheck`

Evidence: README now documents the exact `ui`, `--no-open`, `--port`, and offline
launch forms plus the bounded v1 feature set. `docs/UI.md` covers workflows,
security, collision/recovery messages, Git behavior, and current limits.
Development and release docs record the application → HTTP → client → React
dependency direction and exact clean-checkout build, focused UI, browser, packed,
and container gates. Build, lint, and all typechecks passed on 2026-08-07.

Dependencies: Task 23

Likely files: `README.md`, `docs/DEVELOPMENT.md`, `docs/UI.md`,
`tasks/todo.md`

Size: S

### Final checkpoint — Release evidence

- [x] `npm run lint && npm run typecheck && npm run build`
- [x] `npm test && npm run test:offline && npm run test:migration`
- [x] `npm run test:ui && npm run test:ui:e2e`
- [x] `npm run smoke:install && npm run test:restore:container`
- [x] Working tree is clean and every numbered task has one independently
  revertible commit with its checkbox and verification evidence recorded.

Release evidence: build/lint/typecheck, the full and offline suites (1,355/1,355
each), migration (41/41), focused UI (57/57), all 16 production-browser journeys,
the local packed-artifact workflow, and the Node 22 Linux container restore proof
passed on 2026-08-07. Tasks 1–24 are recorded as separate ordered commits; the
working tree was checked again after the final documentation commit.

## Approval gate

This checklist was approved on 2026-08-06. Work follows the numbered dependency
order and stops at the explicit checkpoints for attended review unless the user
directs an autonomous run through all checkpoints.
