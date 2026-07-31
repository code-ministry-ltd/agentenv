import type { Adapter } from '../adapter.js';
import { claudeAdapter } from './claude.js';

/**
 * The real adapter registry — the single source of truth for which harnesses
 * agentenv supports at runtime.
 *
 * Claude Code (Task 1.8) is the first real adapter. Codex / OpenCode / Pi / Cursor
 * are Tasks 4.x — each ships by appending its adapter here (the same pattern the
 * command registry uses). The session machinery (composer, launch, shims, `run`)
 * takes the adapter list as a parameter defaulting to this array, so tests can
 * still drive the whole flow against the {@link
 * import('../../test/fixtures/fixture-adapter.js') fixture adapter} with no real
 * harness installed.
 */
export const adapters: readonly Adapter[] = [claudeAdapter];
