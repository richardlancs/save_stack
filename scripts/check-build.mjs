// Verifies the PRODUCTION bundle (.output/chrome-mv3). Run after `npm run build`.  npm run check:build
//
// The expected permission list below is the single source of truth for "what the extension may ask for", and every
// change to it must be justified in docs/DECISIONS.md. A gate fails if the built manifest differs from it.
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve('.output/chrome-mv3');
const EXPECTED = {
  permissions: ['offscreen', 'unlimitedStorage', 'storage', 'alarms', 'sidePanel'],
  host_permissions: undefined,
  csp: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  // The only pages the extension runs in. Declared with `matches`, which needs no host permission.
  // capture hook (MAIN), capture relay, and the sync page driver (both isolated)
  content_scripts: ['ISOLATED@https://www.tiktok.com/*', 'ISOLATED@https://www.tiktok.com/*', 'MAIN@https://www.tiktok.com/*'],
};
const SIZE_BUDGET_BYTES_EXCL_WASM = 3 * 1024 * 1024;

const problems = [];
const note = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); if (!ok) problems.push(msg); };

if (!fs.existsSync(path.join(DIR, 'manifest.json'))) { console.error(`no production build at ${DIR}; run: npm run build`); process.exit(1); }
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
const sameSet = (a, b) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());

note(manifest.manifest_version === 3, 'manifest v3');
note(sameSet(manifest.permissions, EXPECTED.permissions), `permissions are exactly [${EXPECTED.permissions.join(', ')}] (built: [${(manifest.permissions ?? []).join(', ')}])`);
note(sameSet(manifest.host_permissions, EXPECTED.host_permissions), `host_permissions are exactly [${(EXPECTED.host_permissions ?? []).join(', ') || 'none'}] (built: [${(manifest.host_permissions ?? []).join(', ') || 'none'}])`);
note(!JSON.stringify(manifest).includes('<all_urls>') && !JSON.stringify(manifest).includes('"*://*/*"'), 'no <all_urls> or wildcard host access anywhere in the manifest');
note(manifest.content_security_policy?.extension_pages === EXPECTED.csp, `CSP is exactly: ${EXPECTED.csp}`);
note([16, 32, 48, 128].every((s) => manifest.icons?.[s] && fs.existsSync(path.join(DIR, manifest.icons[s]))), 'icons 16, 32, 48 and 128 are declared and present');
note(Boolean(manifest.side_panel?.default_path) && fs.existsSync(path.join(DIR, manifest.side_panel.default_path)), 'the side panel page is declared and present');
note(!manifest.externally_connectable, 'not externally_connectable (no web page can message the extension)');
note(!manifest.web_accessible_resources, 'no web_accessible_resources');
const cs = (manifest.content_scripts ?? []).map((c) => `${c.world ?? 'ISOLATED'}@${(c.matches ?? []).join('|')}`);
note(JSON.stringify(cs.sort()) === JSON.stringify((EXPECTED.content_scripts ?? []).slice().sort()), `content scripts are exactly [${(EXPECTED.content_scripts ?? []).join(', ') || 'none'}] (built: [${cs.join(', ') || 'none'}])`);

for (const c of manifest.content_scripts ?? []) {
  const driver = c.js.some((f) => f.includes('driver')); // the sync page driver waits for the page; the capture scripts must be there first
  const timing = driver ? (c.run_at === undefined || c.run_at === 'document_idle') : c.run_at === 'document_start';
  note(timing && c.all_frames !== true && !c.match_about_blank && !c.match_origin_as_fallback, `content script ${c.js.join(',')}: runs at ${driver ? 'document_idle' : 'document_start'}, top frame only`);
}

// walk the bundle
const files = [];
(function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? walk(p) : files.push(p); } })(DIR);
const js = files.filter((f) => f.endsWith('.js'));
const hook = js.filter((f) => fs.readFileSync(f, 'utf8').includes('__scroganize'));
note(hook.length === 0, `no end-to-end test hook in the production bundle${hook.length ? ` (found in ${hook.map((f) => path.basename(f)).join(', ')})` : ''}`);
const forcedHidden = js.filter((f) => fs.readFileSync(f, 'utf8').includes('data-scroganize-e2e-hidden'));
note(forcedHidden.length === 0, `no end-to-end "force hidden" switch in the production bundle${forcedHidden.length ? ` (found in ${forcedHidden.map((f) => path.basename(f)).join(', ')})` : ''}`);
const remote = files.filter((f) => f.endsWith('.html')).filter((f) => /<script[^>]+src=["']https?:/i.test(fs.readFileSync(f, 'utf8')));
note(remote.length === 0, 'no remote <script src> in any page');
const importScriptsRemote = js.filter((f) => /importScripts\(\s*["']https?:/.test(fs.readFileSync(f, 'utf8')));
note(importScriptsRemote.length === 0, 'no remote importScripts');

// WXT wraps isolated content scripts in a context that announces itself to the page (window.postMessage with the extension id) unless
// told not to. The page must not be able to learn that this extension is installed.
for (const c of (manifest.content_scripts ?? []).filter((c) => c.world !== 'MAIN')) {
  for (const rel of c.js) {
    const src = fs.readFileSync(path.join(DIR, rel), 'utf8');
    note(/noScriptStartedPostMessage\s*:\s*(!0|true)/.test(src), `isolated content script ${rel} does not announce itself to the page`);
  }
}

// The MAIN-world script runs inside the platform's own page: it must stay tiny, use no extension API and pull in nothing else.
for (const c of (manifest.content_scripts ?? []).filter((c) => c.world === 'MAIN')) {
  for (const rel of c.js) {
    const src = fs.readFileSync(path.join(DIR, rel), 'utf8');
    note(src.length < 16 * 1024, `MAIN-world script ${rel} is ${(src.length / 1024).toFixed(1)} KB (limit 16 KB)`);
    note(!/\b(chrome|browser)\.(runtime|storage|tabs|scripting)/.test(src), `MAIN-world script ${rel} uses no extension API`);
    note(!/sqlite|\beval\(|new Function/i.test(src), `MAIN-world script ${rel} contains no database code, eval or Function()`);
  }
}
for (const c of manifest.content_scripts ?? []) for (const rel of c.js) {
  const src = fs.readFileSync(path.join(DIR, rel), 'utf8');
  note(!/sqlite|\beval\(|new Function|importScripts|https?:\/\/[^`'"]*\.(js|wasm)/i.test(src), `content script ${rel}: no database code, eval, Function(), importScripts or remote code`);
}

const total = files.reduce((n, f) => n + fs.statSync(f).size, 0);
const wasm = files.filter((f) => f.endsWith('.wasm')).reduce((n, f) => n + fs.statSync(f).size, 0);
const mb = (n) => (n / 1048576).toFixed(2);
note(total - wasm < SIZE_BUDGET_BYTES_EXCL_WASM, `bundle ${mb(total)} MB total, ${mb(total - wasm)} MB excluding the ${mb(wasm)} MB wasm (budget ${mb(SIZE_BUDGET_BYTES_EXCL_WASM)} MB excl. wasm)`);
console.log(`files: ${files.length} (${js.length} js)`);

if (problems.length) { console.error(`\n${problems.length} problem(s)`); process.exit(1); }
console.log('\nbuild check passed');
