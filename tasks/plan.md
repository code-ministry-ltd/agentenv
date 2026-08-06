---
type: implementation-plan
project: agentenv
change: local-environment-ui-v1
created: 2026-08-06
status: approved
approved: 2026-08-06
specification: tasks/spec.md
project_facts: docs/DEVELOPMENT.md
---

# Local environment browser and skill editor — implementation plan

## Outcome

Add a production-packaged, loopback-only web interface launched by `agentenv ui`.
The browser will let a user inspect all five environment content kinds, manage
environments, copy or move one element at a time, edit `SKILL.md`, and discover
and import skills from an existing supported Git source.

The implementation will extend the current transactional core rather than place
filesystem rules in HTTP handlers or React components. Existing CLI behavior and
recovery semantics remain compatibility constraints throughout the work.

## Architecture

### 1. One process and three explicit layers

The `agentenv ui` command starts one Node process containing the production HTTP
server and the same application services used by commands. It serves pre-built
browser assets; Vite is not present at runtime.

| Layer | Responsibility | Must not do |
| --- | --- | --- |
| React client | Display state, retain drafts, gather explicit decisions, call typed endpoints | Access local paths, infer authorization, or mutate the store |
| HTTP adapter | Authenticate, validate request shape, translate application results to one response contract | Contain filesystem, Git, or recovery policy |
| Application/domain services | Inventory, validation, staging, identity checks, Git work, transactional publication | Depend on browser or HTTP concepts |

The CLI will delegate to shared application services when that removes duplicated
policy. Its messages, JSON output, exit behavior, and adapter contracts remain in
the command layer.

### 2. Source and build layout

- Put browser-neutral contract types in `src/ui/contract.ts`. They must import no
  Node-only modules so the client can consume them safely.
- Put Node application and server code below `src/application/` and `src/ui/`.
- Put the React application in `ui/src/` with its own DOM-focused TypeScript and
  Vite configuration.
- Compile the existing Node program to `dist/`, then build hashed UI assets into
  `dist/ui-assets/` without clearing the Node output.
- Keep the npm package allowlist centred on `dist/`; verify the tarball contains
  production assets and excludes UI source, development servers, fixtures, and
  source maps unless existing release policy requires them.
- Use Node's built-in HTTP server. Adding an HTTP framework would add surface area
  without providing domain value for this bounded API.

### 3. Launch authentication and browser security

Each server lifetime creates two independent random values: a one-time launch
credential and a session secret. The printed/opened URL places the launch
credential in the URL fragment, which browsers do not send in HTTP requests,
logs, or referrers. Client startup exchanges it through `POST /api/session`, then
removes the fragment immediately.

The exchange establishes an `HttpOnly`, `SameSite=Strict`, process-lifetime
session cookie and returns a CSRF value held only in page memory. Subsequent API
calls require the cookie. Mutations also require the CSRF header and the exact
same-origin `Origin`; all API requests validate `Host` against the bound
`127.0.0.1:<port>`. There is no CORS support. A refresh may recover a CSRF value
through an authenticated same-origin `GET /api/session` without reusing or
revealing the launch credential.

The server will apply a restrictive Content Security Policy and related headers,
enforce an explicit JSON body limit, reject unsupported content types/methods,
and redact credentials and private paths from errors. The default port is chosen
by the operating system. Browser launching uses argument-based process spawning
for the platform opener, never a shell-interpolated command, and failure to open
the browser leaves the printed URL usable.

### 4. Typed HTTP contract

The API will remain an internal, single live contract under `/api`; v1 does not
create a second version namespace. Request and response types are separate,
browser-controlled identifiers are validated at the boundary, and domain
services independently revalidate names, paths, identities, and provenance.

Every failure uses:

```json
{
  "error": {
    "code": "STABLE_MACHINE_CODE",
    "message": "Safe user-facing summary",
    "details": {}
  }
}
```

Expected mappings are `400` malformed request, `401` missing/invalid session,
`403` origin or CSRF refusal, `404` absent resource, `409` collision/stale state/
pending recovery, `422` valid request with invalid domain content, and `500` an
unexpected redacted failure. Successful mutation results identify affected
resources and their new opaque revisions. Collection endpoints use bounded
`page`/`pageSize` inputs and stable ordering even where the first UI initially
loads every page.

The initial endpoint families are:

- session exchange and session refresh;
- paginated environment summaries and one environment inventory;
- create/clone and confirmed delete;
- one copy/move transfer request with explicit collision policy;
- load and identity-checked save of one skill document;
- start, poll, and discard a Git candidate set;
- import selected candidate IDs into one environment.

Environment names, content names, candidate-set IDs, candidate IDs, and opaque
revision strings are distinct branded contract types. Content and operation
kinds use discriminated unions so an MCP mapping entry cannot accidentally be
handled as a skill directory or Markdown file.

### 5. Shared application services

Create small use-case modules rather than one UI service:

- `catalog`: stable, read-only environment summaries and inventories. It parses
  MCP server entries as individual elements and resolves active state through the
  existing state model without exposing absolute paths.
- `environment-lifecycle`: create, clone, and delete using the same validation,
  active-environment refusal, staging, publication, and recovery contracts as the
  CLI. Existing commands become adapters over these operations where practical.
- `content-transfer`: a discriminated locator for all five kinds plus handlers for
  directories, Markdown files, and an MCP YAML mapping entry. Copy and move stage
  every affected content path and `env.yaml` provenance record in one command;
  overwrite is a declared precondition, never a fallback.
- `skill-document`: load `SKILL.md` plus an opaque identity, validate an edited
  staged skill directory, and publish only if the loaded identity is still
  current. The rest of the skill directory remains byte-preserved.
- `git-candidates`: fetch and scan a supported source in private temporary
  storage, issue opaque server-owned candidate identifiers, and import selected
  exact candidates through the same vendoring/provenance operation as `add`.

Shared operations accept injectable command context dependencies so tests remain
hermetic and the CLI keeps its established harness and Git seams. Application
results are structured and presentation-neutral; CLI and HTTP adapters translate
them independently.

### 6. Identity, concurrency, and recovery

Read operations return opaque revisions derived from the existing path identity
model, never from client-provided paths. Each mutation records its expected source
and destination identities, stages the complete post-state, validates it, and
rechecks identities immediately before the existing transactional publication.

Move uses one staged command covering destination creation and source removal.
Skill copy/move includes both affected `env.yaml` files where provenance changes.
MCP transfer rewrites only the named mapping entry while retaining unrelated YAML
content and validating the entire result. A collision decision does not waive the
expected-revision check.

The existing write-ahead log, locks, quarantine, backup, and pending-command
behavior remain authoritative. The HTTP process may serialize overlapping
mutations as an early usability guard, but that in-memory coordination is not a
replacement for durable concurrency and crash recovery.

### 7. Asynchronous Git discovery

Starting discovery returns a candidate-set resource immediately. The server owns
its temporary directory and moves the resource through a discriminated state:
`PENDING`, `READY`, or `FAILED`. The browser polls while allowing normal browsing
and editing requests to continue.

Ready results are paginated and include only safe metadata plus opaque candidate
IDs. Import resolves those IDs back to the exact scanned directories and verifies
their identities before staging. Candidate sets expire after a bounded 15-minute
idle period, after explicit discard, and at server shutdown. Discard during an
in-flight child process marks the result unusable and cleans it as soon as the
operation releases it; v1 does not promise remote-process cancellation.

Mixed imports use per-skill structured outcomes. Each selected skill remains an
independent publication boundary, matching current `add skills` behavior, so a
successful earlier import is reported truthfully if a later candidate fails.

### 8. React client

The client is a compact application shell using React built-ins and a typed fetch
adapter rather than a second state-management framework. Its primary structure is
an environment list, selected-environment inventory, item details/actions, and
focused dialogs or workspaces for lifecycle, transfer, editing, and Git import.

CodeMirror 6 is mounted through an explicit component lifecycle and dispatches
editor transactions into a retained draft model. A safe Markdown renderer is
configured without raw HTML support; links use an allowlist and external links
receive `noopener noreferrer`. The editor keeps invalid or failed drafts in
memory, compares them to the loaded revision, and installs unload/navigation
guards while dirty.

Accessibility is implemented with each vertical slice: semantic controls,
keyboard-complete dialogs and lists, visible focus, focus restoration, named
status regions, and text/icon distinctions in addition to color. No third-party
visual component system is planned for v1.

### 9. Verification strategy

- Vitest domain tests exercise each application operation against temporary
  homes and local Git repositories, including injected publication failures and
  byte-for-byte invariants.
- HTTP integration tests start the real loopback server and use `fetch` to prove
  the full contract, authentication, Host/Origin/CSRF checks, size limits, method
  handling, redaction, security headers, shutdown, and candidate expiry.
- Playwright drives the production-built React client against a temporary home.
  It covers the complete user workflows and accessibility/keyboard behavior; no
  separate browser component-test dependency is required.
- The 100-environment/1,000-element fixture is deterministic. Its Playwright test
  measures from navigation to the enabled environment list, runs serially, and
  records timing on failure so the one-second criterion is diagnosable.
- Package smoke installs the tarball into an isolated prefix, launches the UI,
  authenticates through the same browser path, completes a minimal mutation, and
  shuts down without reading the user's real agentenv home.
- Existing full, restore-container, migration, adapter, and packed-install suites
  remain mandatory regression gates.

## Dependency graph

```text
approved specification
        |
        v
contract + build/package skeleton
        |
        +----------------------+
        v                      v
secure loopback server     application services
        |                  /   |   |   |   \
        |             catalog life transfer edit git
        |                  \   |   |   |   /
        +----------------------+
                    |
                    v
             typed HTTP routes
                    |
        +-----------+------------+
        v           v            v
   browse shell  mutations   editor/import UI
        \           |            /
         +----------+-----------+
                    |
                    v
        package, security, accessibility,
        performance, and regression gates
```

## Phased implementation

### Phase 1 — Contract, build, and secure launch skeleton

1. Define contract primitives, discriminated unions, revisions, pagination, and
   the single error envelope with contract tests.
2. Add the React/Vite production build, a minimal packaged page, and package-file
   assertions without changing existing Node output.
3. Add `agentenv ui`, loopback lifecycle, launch/session exchange, request guards,
   security headers, graceful shutdown, and HTTP security integration tests.

Checkpoint: a packed clean install opens or prints an authenticated production UI
and rejects hostile requests, but exposes no environment operations yet.

### Phase 2 — Read-only vertical slice

1. Build the catalog service for summaries, active state, five-kind inventories,
   Git provenance, stable sorting, pagination, and safe metadata.
2. Expose catalog routes through the typed authenticated adapter.
3. Build the accessible environment shell, inventory groups, filtering, refresh,
   and complete loading/empty/stale/error states.

Checkpoint: browser and domain tests prove the read-only UI, every content kind,
safe provenance display, the large fixture, and zero store changes from reads.

### Phase 3 — Environment lifecycle

1. Extract create/clone/delete application operations without changing CLI output
   or transaction/recovery behavior; migrate the corresponding commands to them.
2. Add lifecycle routes with validation, revisions, typed conflicts, and exact-name
   deletion confirmation.
3. Add create, clone, and delete UI flows including active deletion and pending
   recovery explanations.

Checkpoint: CLI regressions and Playwright prove successful and refused lifecycle
operations, injected failures, stale state, and byte-identical refusal cases.

### Phase 4 — Five-kind copy and move

1. Implement content locators and exact content readers/stagers for skills,
   instructions, MCP entries, agents, and commands.
2. Implement collision-aware copy and atomic move, including provenance updates,
   identity rechecks, overwrite, rollback, and recovery tests for every kind.
3. Add the transfer route and UI destination/collision workflow with clear result
   and refresh behavior.

Checkpoint: a test matrix covers 5 kinds × copy/move × no collision/cancel/
overwrite, plus injected crash boundaries and concurrent replacement.

### Phase 5 — Skill editor

1. Implement identity-bearing skill document load, staged validation/save, scoped
   Git history, and stale-save refusal.
2. Add load/save routes with authoritative validation errors and safe failure data.
3. Add CodeMirror source/split/preview modes, safe Markdown rendering, local
   validation feedback, save shortcuts, dirty guards, and retained drafts.

Checkpoint: browser tests prove valid save, invalid and failed draft retention,
safe preview, navigation warning, stale conflict, keyboard use, and Git history.

### Phase 6 — Git discovery and import

1. Extract reusable source scanning/vendoring operations from `add skills` while
   preserving supported source syntax, offline behavior, authentication, and
   provenance.
2. Implement candidate-set ownership, async progress, pagination, expiry, exact
   identity validation, cleanup, and per-skill import results.
3. Add discovery/import routes and the repository form, progress state, candidate
   browser/filter/selection, collision decisions, and mixed-result UI.

Checkpoint: local multi-skill fixtures prove discovery and import end to end;
hostile, expired, unreachable, substituted, and offline sources change nothing
and disclose no sensitive data.

### Phase 7 — Final hardening and release evidence

1. Run a focused security review of token/session handling, boundary validation,
   path containment, Git process invocation, Markdown rendering, redaction, CSP,
   and shutdown cleanup; fix findings with regression tests.
2. Complete keyboard/accessibility review and deterministic performance evidence.
3. Extend development/user documentation, package and install smoke, and run every
   success-criteria gate from a clean checkout.

Checkpoint: the npm tarball—not the source checkout—passes the core UI workflow,
all new gates, and the complete pre-existing regression suite on the supported
Node floor.

## Parallelism and sequencing

After Phase 1 fixes the contract and build boundaries, catalog work and the visual
application shell can proceed independently against fixtures. Within later phases,
domain tests/services and UI presentation can be developed in parallel only after
the relevant request/response shapes are fixed. Environment lifecycle and content
transfer both touch staged publication and should be integrated sequentially to
avoid competing refactors of the same command core. Git extraction begins only
after the shared publication interface is stable.

Each phase is delivered as test-first vertical slices and checkpointed before the
next begins. The eventual task breakdown will keep each slice independently
verifiable and will not batch security, accessibility, or failure behavior into a
final cleanup task.

## Risks and mitigations

| Risk | Consequence | Mitigation |
| --- | --- | --- |
| UI duplicates CLI policy | Divergent validation and unsafe mutations | Extract presentation-neutral services first; keep adapters thin; run CLI compatibility tests |
| Multi-path transfer is only superficially atomic | Lost or duplicated content after crash | One staged command and WAL for all affected paths; inject failures at each boundary |
| Browser on loopback is treated as trusted | Another page or local process mutates data | Fragment launch exchange, HttpOnly session, CSRF, exact Host/Origin, no CORS, CSP, body limits |
| MCP entries do not share the filesystem shape of other items | Transfer overwrites unrelated servers | Model MCP as its own union member and patch/validate the whole mapping transactionally |
| Skill provenance drifts during transfer/import | Update points to missing or wrong source | Stage content and both provenance records together; verify against exact fetched commit |
| Git work blocks requests or leaks temp data | Frozen UX or private repository residue | Async candidate resources, private directories, bounded expiry, shutdown cleanup, redacted errors |
| Vite output damages or escapes the npm build | Broken CLI package or missing UI assets | Isolated output directory, deterministic build order, tarball content assertions, packed smoke |
| Stale browser state overwrites external edits | User data loss | Opaque revisions at load, publication-time identity checks, draft retention and explicit reload |
| Large test matrix becomes slow or flaky | Untrusted release signal | Domain matrix below the browser, focused E2E journeys, local Git fixtures, serial timing test |
| Refactoring mature commands changes observable behavior | CLI regression | Characterization tests before extraction and mandatory full existing suite at phase checkpoints |

## Decisions deferred within the approved boundary

These are implementation details, not blocking product questions:

- Exact module filenames may move to fit existing dependency direction, provided
  browser-neutral contracts remain separate from Node code.
- The safe Markdown renderer will be selected and lockfile-pinned during Phase 1;
  it must meet the spec without raw HTML or remote plugins.
- UI visual tokens, layout breakpoints, and wording will evolve during vertical
  slices while retaining the stated workflows and accessibility requirements.
- The exact bounded page-size defaults and body-size limit will be chosen from
  fixture measurements and contract tests and documented as server constants.

## Approval gate

This plan was approved by the explicit implementation request on 2026-08-06. Its
task breakdown is maintained in `tasks/todo.md`.
