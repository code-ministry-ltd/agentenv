import type { Adapter } from '../adapter.js';

/**
 * The real adapter registry — the single source of truth for which harnesses
 * agentenv supports at runtime.
 *
 * DELIBERATELY EMPTY in Phase 1. The five real adapters are out of scope here:
 * Claude Code is Task 1.8; Codex / OpenCode / Pi / Cursor are Tasks 4.x. Each
 * ships by appending its adapter to this array (the same pattern the command
 * registry uses). The session machinery (composer, launch, shims, `run`) takes
 * the adapter list as a parameter defaulting to this array, so tests drive the
 * whole flow against the {@link import('../../test/fixtures/fixture-adapter.js')
 * fixture adapter} with no real harness installed.
 */
export const adapters: readonly Adapter[] = [];
