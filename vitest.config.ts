import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Generous headroom for the timing-sensitive concurrency/lock tests: under a
    // loaded CI runner with parallel workers, real-timer waits (poll loops,
    // held critical sections) can be starved well past vitest's 5s default
    // without any real deadlock. 15s is far above any healthy run.
    testTimeout: 15_000,
  },
});
