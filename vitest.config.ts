import { defineConfig } from 'vitest/config';

// Unit + storage-contract tests run in plain Node against the real SQLite engine (sqlite-wasm's Node build).
// Browser/extension behaviour is covered by the Playwright scripts under bench/.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
