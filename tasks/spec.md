---
type: specification
project: agentenv
change: local-environment-ui-v1
created: 2026-08-06
status: approved
approved: 2026-08-06
project_facts: docs/DEVELOPMENT.md
depends_on: tasks/archive/complete-command-transaction-boundaries.md
---

# Local environment browser and skill editor — version one

## Approved assumptions

1. The product is a single-user local web application launched by `agentenv ui`,
   not Electron, a hosted service, or a remotely accessible server.
2. It binds only to loopback, uses per-launch request authentication plus
   origin/CSRF defenses, and opens the user's default browser unless told not to.
3. The web and CLI surfaces share one application layer. The UI never writes the
   store directly or reimplements transaction, validation, Git, or recovery rules.
4. All five content kinds are browsable and transferable: skills, instructions,
   MCP servers, agents, and commands. Only `SKILL.md` has a rich editor in v1.
5. Copy and move operate on one named element at a time and transfer the complete
   element atomically. Collisions require explicit cancel or overwrite; there is
   no merge mode.
6. Skill Git provenance is preserved by copy and move. Resulting copies update
   independently from the same recorded source.
7. Users can create, clone, and delete environments. Existing active-environment
   deletion refusals remain authoritative.
8. Git import accepts the source formats and configured Git authentication already
   supported by agentenv. It browses skills inside a supplied repository; it is
   not GitHub-wide search, OAuth, or a public catalogue.
9. External changes are detected at publication time and shown as conflicts.
   Filesystem watching and collaborative multi-tab editing are out of scope.
10. The approved UI stack is React 19, TypeScript, Vite 8, and CodeMirror 6,
    bundled into the npm-format artifact and served by the Node process. Playwright
    1.61 is the browser-test target. Exact packages are lockfile-pinned.

Project-wide runtime, structure, command, style, and testing conventions are in
[`docs/DEVELOPMENT.md`](../docs/DEVELOPMENT.md).

## Objective

Give a local agentenv user a safe, approachable way to browse and organise their
environments without requiring routine shell or filesystem work. Version one
must make the common content-management loop complete: launch the UI; understand
what each environment contains; create, clone, or delete environments; copy or
move content between them; edit and validate skill Markdown; and discover and
import selected skills from a Git source.

The UI is an additional interface to agentenv, not a second implementation. Every
mutation must retain the command-level atomicity, no-clobber guarantees, Git
provenance, secret protections, and recovery behavior already provided by the CLI.

## Required behavior

### UI-001 — Local launch and security boundary

- Add `agentenv ui [--no-open] [--port <port>]`. The default port is allocated by
  the operating system; `--port` accepts an available non-privileged port for
  development and automation.
- Bind to `127.0.0.1` only. Print the URL and open it in the default browser unless
  `--no-open` is present. Startup failure returns a non-zero result without
  leaving a listener or temporary credential behind.
- Generate an unguessable credential for each server lifetime. State-changing API
  requests require that credential and a valid same-origin request. Reject invalid
  `Host` and `Origin` headers, unauthenticated requests, unsupported methods, and
  oversized or malformed bodies with one safe, consistent error shape.
- Serve only bundled assets and same-origin API responses. Apply a restrictive
  Content Security Policy and related browser headers; do not use a CDN, execute
  skill HTML/scripts, expose absolute private paths unnecessarily, or place the
  launch credential in logs, referrers, or persisted browser storage.
- SIGINT/SIGTERM and normal shutdown close the listener and clean ephemeral Git/UI
  state. Read-only HTTP requests never service persistence or mutate agentenv.

### UI-010 — Browse environments and content

- Show all environments with description, active/inactive state, and content
  counts. Selecting one shows named skills, instructions, MCP servers, agents, and
  commands in separate groups.
- Each element shows its kind and user-relevant metadata. Git-sourced skills also
  show repository, repository path, ref, and short commit without exposing
  credentials embedded in remote configuration.
- Provide filtering within the selected environment, explicit refresh, and
  complete loading, empty, stale, unavailable, and error states. Successful
  mutations refresh the affected views without a full browser reload.
- On a deterministic fixture containing 100 environments and 1,000 elements, the
  environment list becomes usable within one second on the supported Node floor.

### UI-020 — Create, clone, and delete environments

- Create validates a new environment name and optional description and publishes
  the same valid scaffold as the CLI.
- Clone requires a source and new name, copies the complete environment including
  skill provenance, validates the staged result, and publishes it as one
  recoverable command.
- Delete names the target prominently, requires the user to type its exact name,
  and delegates to the existing inactive-environment and retained-data safeguards.
  Refusal leaves the environment byte-identical and explains how to proceed.
- A stale identity, validation failure, pending recovery operation, or Git failure
  is reported without a partial environment or false success indication.

### UI-030 — Copy and move content between environments

- A user can select one skill, instruction, MCP server, agent, or command and copy
  or move it to another existing environment.
- Copy preserves the source and publishes a complete destination. Move publishes
  destination creation and source removal as one command boundary; a crash cannot
  leave duplicates or lose the only copy.
- Skill transfers include the whole skill directory and adjust `env.yaml` source
  provenance consistently. Copy retains provenance in both environments; move
  transfers it from source to destination.
- If the destination name exists, present cancel and overwrite choices with the
  affected kind, environment, and name. Overwrite is explicit and transactional;
  no automatic content merge is performed.
- Revalidate source and destination identities immediately before publication.
  Concurrent bytes are retained or rejected through existing recovery semantics,
  never silently overwritten.

### UI-040 — Edit and preview skill Markdown

- Open a skill's `SKILL.md` in a keyboard-accessible CodeMirror editor with a
  rendered Markdown preview. Provide source, preview, and split-view modes plus
  conventional save shortcuts.
- Validate required frontmatter, skill name/folder agreement, and the existing
  skill rules while editing. The server repeats authoritative validation before
  publication. Invalid content remains in the browser as a draft and never
  changes the canonical skill.
- Save through a staged, identity-checked command and create the same scoped local
  Git history as an equivalent CLI content edit. If the file changed since load,
  refuse the save and offer reload or draft copy; do not overwrite either version.
- Warn before navigation, environment change, browser refresh, or close when the
  buffer differs from the loaded identity. A failed request retains the draft and
  presents a retryable, non-secret error.
- Markdown preview treats raw HTML as text, cannot execute scripts, uses no remote
  plugins, and opens permitted links without granting opener access.

### UI-050 — Browse and import skills from Git

- Accept the existing `owner/repo[/path][@ref]`, Git URL, `file://`, and local
  repository forms. Under `--offline`, refuse network sources while continuing to
  support allowed local sources.
- Fetch into private temporary storage, show immediate progress, discover valid
  `SKILL.md` directories, and return filterable candidates with name, description,
  repository path, ref, and commit. Fetch/parse failure changes no environment.
- Let the user select one or more candidates and import them into one environment.
  Validate each exact fetched candidate, record current provenance, and use the
  existing staged publication and per-skill Git history contracts.
- Existing destinations are unselected by default and require an explicit
  overwrite decision. Report each installed, skipped, or failed skill accurately;
  never claim the whole selection succeeded after a partial outcome.
- Candidate identifiers are opaque and server-issued. Browser requests cannot
  nominate arbitrary clone paths or substitute content after discovery. Temporary
  clones expire on completion, server shutdown, or a bounded idle timeout.

### UI-060 — Shared application and HTTP contracts

- Extract or extend reusable application operations for environment inventory,
  environment lifecycle, element transfer, skill load/save, Git discovery, and
  Git import. CLI behavior continues to call the same lower-level rules or is
  migrated to the shared operation where doing so removes duplication without
  changing output.
- Define typed request, success, progress, conflict, validation, pending-recovery,
  and failure shapes. Validate every browser field at the HTTP boundary and every
  filesystem/Git identity again at the domain boundary.
- Long Git work must not block browsing or editing. The client displays its phase
  and ignores stale responses after navigation. Only one mutation affecting the
  same environment paths may publish at a time; existing locks/WAL remain the
  source of truth.
- The UI surfaces safe next actions for pending commands and conflicts but does not
  implement general `doctor`, `status`, or `resolve` administration in v1.

### UI-070 — Packaging, accessibility, and compatibility

- Vite emits hashed static assets into an isolated directory included by the
  existing build and package allowlist. Production uses those assets, never the
  Vite development server. Source maps and development-only files are not shipped
  unless the release policy explicitly permits them.
- The installed artifact can run `agentenv ui --no-open`, authenticate a browser,
  complete the core workflow against a temporary home, and shut down cleanly on
  macOS and Linux with Node 22.12 or newer.
- Environment and content navigation, dialogs, Git selection, collision choices,
  editor controls, validation, and notifications are operable by keyboard, expose
  programmatic names, preserve visible focus, and do not rely on color alone.
- Existing CLI commands, JSON output, offline behavior, migration, transactional
  recovery, adapter behavior, and packed restore smoke remain compatible.

## Success criteria

1. From a packed clean install, `agentenv ui --no-open` prints a loopback URL,
   rejects unauthenticated/foreign-origin requests, serves the production UI after
   authentication, and exits cleanly without touching the real home.
2. A browser test loads 100 environments/1,000 elements within the stated target,
   filters them, and renders every content kind plus Git provenance correctly.
3. Browser tests create, clone, and delete an inactive environment; active deletion,
   invalid names, stale input, and cancelled confirmation change no canonical data.
4. For each of the five content kinds, copy produces an exact independent
   destination and move atomically transfers it. Collision cancellation,
   overwrite, injected failure, and concurrent replacement preserve all bytes.
5. A skill edit previews safely, validates locally and authoritatively, saves by
   expected identity, creates scoped Git history, retains invalid/failed drafts,
   and refuses a stale save without clobbering either version.
6. Against a local multi-skill Git fixture, the UI discovers candidates, filters
   and selects several, imports exact validated content with provenance, handles
   collisions, and reports mixed outcomes truthfully. An unreachable or hostile
   source changes nothing and leaks no credential or private path.
7. HTTP contract tests cover auth, Host/Origin/CSRF, body limits, malformed input,
   method restrictions, path containment, safe error serialization, security
   headers, and ephemeral candidate expiry.
8. `npm run lint`, `npm run typecheck`, `npm run test:ui`,
   `npm run test:ui:e2e`, the full hermetic suite, `npm run smoke:install`, and
   `npm run test:restore:container` are green from a clean checkout.

## Boundaries

### Always

- Write a failing domain or browser test before implementing each behavior.
- Keep the HTTP server and React client thin over typed shared operations.
- Stage, validate, identity-check, and transactionally publish every mutation.
- Preserve provenance, placeholders, modes, unrelated Git changes, recovery data,
  and existing CLI behavior.
- Use temporary homes and local repositories in automated tests; make browser
  tests deterministic and independent of installed harnesses or hosted services.
- Keep all production UI assets local, enforce the loopback/authentication boundary,
  sanitize user-visible errors, and render Markdown without executable HTML.

### Ask first

- Add remote/LAN access, user accounts, cloud storage, telemetry, or analytics.
- Add GitHub OAuth/API integration, repository-wide search, registries, or a public
  skill catalogue.
- Change a state/env schema major, CLI output contract, Git commit granularity,
  deletion safeguard, overwrite policy, or recovery behavior.
- Add editors for non-skill content, bulk transfer, filesystem watching, merge
  tools, upstream bulk update, or activation/sync/doctor controls.
- Add production or browser-test dependencies beyond the approved React 19,
  Vite 8, CodeMirror 6, safe Markdown renderer, and Playwright stack.

### Never

- Trust a browser-supplied absolute path, clone path, object identity, provenance,
  or authorization decision.
- Write canonical content directly from an HTTP handler or React component.
- Bypass a pending WAL, active-environment refusal, secret scan, validation,
  identity check, backup, quarantine, or path-scoped Git requirement.
- Execute Markdown HTML/scripts, interpolate Git input into a shell, expose the UI
  beyond loopback, or persist/log credentials, resolved secrets, launch tokens, or
  sensitive filesystem paths.
- Weaken, skip, or delete existing tests to make the UI build pass.

## Out of scope

- Remote hosting, multi-user collaboration, mobile-native or Electron packaging.
- Environment activation/drop/run, sync and remote administration, doctor,
  recovery resolution, migration, secret management, and harness configuration.
- Rich editing of instructions, MCP servers, agents, commands, or skill assets.
- Bulk copy/move, content merging, live filesystem watching, and multi-tab editing.
- GitHub-wide discovery, OAuth, hosted catalogues, ratings, publishing, pull
  requests, and automatic upstream-update sweeps.

## Open questions

There are no blocking product questions. The implementation plan must choose the
internal application-operation boundary, HTTP route layout, launch-token exchange,
styling approach, and candidate-expiry mechanism within the requirements above.
Any choice that changes an approved assumption or boundary requires this
specification to be updated and re-approved before implementation.
