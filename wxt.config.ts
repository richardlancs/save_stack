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
    // The toolbar icon opens the side panel (see background.ts).
    action: { default_title: 'Open Scroganize' },
    // offscreen: hosts the dedicated Worker that owns the SQLite database.
    // unlimitedStorage: the DB lives in OPFS and can outgrow the default quota.
    // storage: capture counters and the resumable sync state live in chrome.storage.local; the data itself stays in SQLite.
    // alarms: a 30-second heartbeat while a sync runs, so a hung sync window or a killed service worker is noticed (no install warning).
    // No host_permissions on purpose: the content scripts are declared with `matches`, which needs none, and the extension never
    // fetches anything itself; the sync window is opened and driven with APIs that need no permission.
    permissions: ['offscreen', 'unlimitedStorage', 'storage', 'alarms'],
    // MV3's default CSP is `script-src 'self'`, which blocks WebAssembly (M0 finding). 'wasm-unsafe-eval'
    // allows compiling .wasm only; it does NOT allow JS eval / inline scripts / remote code.
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  },
  vite: () => ({
    build: { target: 'es2022' },
    // The side panel is written in Preact (JSX).
    oxc: { jsx: { runtime: 'automatic' as const, importSource: 'preact' } },
    worker: { format: 'es' as const },
    // sqlite-wasm resolves its .wasm via import.meta.url; pre-bundling breaks that.
    optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  }),
});
