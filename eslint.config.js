// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // fake-harness.mjs is an executable test fixture (a stand-in harness binary),
    // exercised by being spawned in tests rather than imported — it runs as plain
    // Node with runtime globals, so it is verified by execution, not by lint.
    ignores: ['dist/**', 'coverage/**', 'test/fixtures/**/*.mjs'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
