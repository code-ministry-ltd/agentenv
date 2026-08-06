# Development contract

This document records project-wide facts that change specifications reference
instead of repeating.

## Runtime and structure

- Node.js 22.12 or newer, ESM, strict TypeScript. `package.json` and
  `package-lock.json` are authoritative for exact dependency versions.
- Runtime source lives in `src/`; compiled release output lives in `dist/`.
- Vitest tests live in `test/`. Executable test fixtures live in
  `test/fixtures/`.
- Change specifications, plans, and task breakdowns live in `tasks/`. Completed
  specifications may be retained in `tasks/archive/`.
- User and release documentation lives in `README.md` and `docs/`.

## Commands

Run all commands from the repository root.

```sh
npm ci
npm run build
npm run lint
npm run typecheck
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null npm test
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null npm run ci
npm run test:offline
npm run test:migration
npm run smoke:install
npm run test:restore:container
AGENTENV_LIVE=1 npm run test:live
```

Change-specific test commands are added to `package.json` by the change that
introduces them. The full release matrix remains defined in
[`RELEASE.md`](RELEASE.md).

## Style and architecture

- Keep TypeScript strict and ESM-native. Prefer small typed domain functions and
  explicit result shapes over implicit process state.
- CLI commands are adapters over reusable domain/application behavior. New
  interfaces must not reproduce filesystem, Git, transaction, or validation
  rules in another layer.
- Validate at every external boundary. Treat paths, Git sources, editor content,
  remote content, and browser requests as hostile input.
- Canonical or harness mutations use the existing staged command/WAL, typed
  backup, identity, quarantine, and path-scoped Git primitives.
- Preserve unrelated user bytes, existing CLI output contracts, offline behavior,
  and recoverability unless an approved specification says otherwise.

## Testing

- Write the failing behavior test before its implementation.
- Use temporary `AGENTENV_HOME` and `HOME` roots; tests must never touch the real
  user installation or harness configuration.
- Prefer state and user-visible behavior over implementation-interaction mocks.
- Cover domain behavior with unit/integration tests, process boundaries with
  subprocess tests, packaged behavior with the install smoke, and supported live
  harness contracts with opt-in live tests.
- Every commit must leave lint, typecheck, relevant focused tests, and the build
  green. The full suite and applicable release gates must pass before handoff.
