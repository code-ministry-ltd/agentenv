import type { GlobalSkip } from '../engine.js';

/** Human-readable one-liners for global-engine skips (shadowing / collisions / unsupported). */
export function renderGlobalSkips(skips: readonly GlobalSkip[]): string[] {
  return skips.map((s) => `agentenv: [${s.adapterId}/${s.surfaceId}] ${s.reason}: ${s.detail}`);
}
