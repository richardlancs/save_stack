import { defineConfig } from 'wxt';

// Chrome-only MV3 build for v1. Keep the config small: everything platform- or
// engine-specific belongs in src/, not here.
export default defineConfig({
  // The end-to-end build (test hooks enabled) goes to its own directory so it can never be mistaken for, or shipped as, the real build.
  outDir: process.env.WXT_E2E_HOOKS ? '.output-e2e' : '.output',
  srcDir: 'src',
  entrypointsDir: 'extension/entrypoints',
  manifest: {
    name: 'Scroganize',
    description: 'Search your saved social-media collections.',
    minimum_chrome_version: '116',
    // offscreen: hosts the dedicated Worker that owns the SQLite database.
    // unlimitedStorage: the DB lives in OPFS and can outgrow the default quota.
    permissions: ['offscreen', 'unlimitedStorage'],
    // MV3's default CSP is `script-src 'self'`, which blocks WebAssembly (M0 finding). 'wasm-unsafe-eval'
    // allows compiling .wasm only; it does NOT allow JS eval / inline scripts / remote code.
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  },
  vite: () => ({
    build: { target: 'es2022' },
    worker: { format: 'es' as const },
    // sqlite-wasm resolves its .wasm via import.meta.url; pre-bundling breaks that.
    optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  }),
});
