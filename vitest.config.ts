import { defineConfig } from 'vitest/config';

// Unit + storage-contract tests run in plain Node against the real SQLite engine (sqlite-wasm's Node build).
// Browser/extension behaviour is covered by the Playwright scripts under bench/.
export default defineConfig({
  // The panel's components are TSX (Preact): tests import them for static rendering.
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    testTimeout: 60_000,
  },
});
