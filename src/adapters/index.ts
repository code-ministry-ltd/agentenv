import type { Adapter } from '../adapter.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { opencodeAdapter } from './opencode.js';
import { piAdapter } from './pi.js';

/**
 * The real adapter registry — the single source of truth for which harnesses
 * agentenv supports at runtime.
 *
 * Claude Code (1.8), Codex (4.1), OpenCode (4.2) and Pi (4.3) are the real
 * adapters; Cursor (4.4) is the remaining one — each ships by appending its
 * adapter here (the same pattern the command registry uses). The session
 * machinery (composer, launch, shims, `run`) takes the adapter list as a
 * parameter defaulting to this array, so tests can still drive the whole flow
 * against the {@link import('../../test/fixtures/fixture-adapter.js') fixture
 * adapter} with no real harness installed.
 */
export const adapters: readonly Adapter[] = [
  claudeAdapter,
  codexAdapter,
  opencodeAdapter,
  piAdapter,
];
