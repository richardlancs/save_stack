// The layering rules the design depends on, checked mechanically on the source tree. If one of these fails, a dependency crept in that
// makes the core platform-specific, or makes the UI non-replaceable.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve('src');
const rel = (f: string): string => path.relative(SRC, f).split(path.sep).join('/');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx|css|html)$/.test(name)) out.push(p);
  }
  return out;
}
const files = walk(SRC);
const under = (prefix: string): string[] => files.filter((f) => rel(f).startsWith(prefix));

/** Source with // and block comments removed (a // preceded by a word character or a colon, as in a URL, is not a comment). */
function code(f: string): string {
  return fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[\s;{}()])\/\/.*$/gm, '$1');
}

interface Imp { spec: string; typeOnly: boolean }
function imports(f: string): Imp[] {
  const src = code(f);
  const out: Imp[] = [];
  for (const m of src.matchAll(/(?:^|\n)\s*(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/g)) {
    const clause = m[3] ?? '';
    const allInline = /\{[^}]*\}/.test(clause) && clause.replace(/[{}\s]/g, '').split(',').filter(Boolean).every((s) => s.startsWith('type'));
    out.push({ spec: m[4]!, typeOnly: Boolean(m[2]) || allInline });
  }
  for (const m of src.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) out.push({ spec: m[1]!, typeOnly: false });
  for (const m of src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push({ spec: m[1]!, typeOnly: false });
  return out;
}
const resolveSpec = (from: string, spec: string): string | undefined => (spec.startsWith('.') ? rel(path.resolve(path.dirname(from), spec)) : undefined);

describe('the UI depends only on the documented contract', () => {
  const uiFiles = [...under('ui/'), ...under('extension/entrypoints/sidepanel/')];
  const RUNTIME_OK = new Set(['preact', 'preact/hooks']);

  it('the UI exists', () => { expect(uiFiles.length).toBeGreaterThan(5); });

  it('imports NO runtime code from core/ or platforms/ (types only), and from the extension only the RPC client and its chrome transport', () => {
    for (const f of uiFiles) {
      for (const imp of imports(f)) {
        if (imp.typeOnly) continue;
        if (RUNTIME_OK.has(imp.spec) || imp.spec.endsWith('.css')) continue;
        const target = resolveSpec(f, imp.spec);
        if (target === undefined) throw new Error(`${rel(f)} imports the package "${imp.spec}" at runtime, which is not on the allowed list`);
        const inUi = target.startsWith('ui/') || target.startsWith('extension/entrypoints/sidepanel/');
        const rpc = target === 'extension/rpc/client' || target === 'extension/rpc/chrome-transport';
        expect(inUi || rpc, `${rel(f)} imports ${target} at runtime`).toBe(true);
      }
    }
  });

  it('only the API wrapper touches chrome.*', () => {
    for (const f of uiFiles) if (!rel(f).endsWith('ui/api.ts') && /\.tsx?$/.test(f)) expect(/\bchrome\./.test(code(f)), rel(f)).toBe(false);
  });

  it('never names a platform', () => {
    for (const f of uiFiles) expect(/tiktok/i.test(code(f)), rel(f)).toBe(false);
  });

  it('renders captured text as text: no innerHTML or dangerouslySetInnerHTML anywhere', () => {
    for (const f of uiFiles) expect(/innerHTML|dangerouslySetInnerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/.test(code(f)), rel(f)).toBe(false);
  });
});

describe('the core is platform-agnostic and free of browser APIs', () => {
  const core = [...under('core/'), ...under('platforms/')].filter((f) => /\.tsx?$/.test(f));

  it('core/ and platforms/ never touch chrome, window, document or navigator', () => {
    for (const f of core) expect(/\b(chrome|window|document|navigator)\b\s*[.[]/.test(code(f)), rel(f)).toBe(false);
  });

  it('core/ never names a platform in code (the one exception is a hashtag that is noise on every platform)', () => {
    for (const f of under('core/').filter((x) => /\.ts$/.test(x))) {
      const lines = code(f).split('\n').filter((l) => /tiktok/i.test(l) && !/NOISE_TAGS/.test(l) && !/^\s*--/.test(l));
      expect(lines, rel(f)).toEqual([]);
    }
  });

  it('layers point one way: core imports nothing from platforms/extension/ui; platforms import nothing from extension/ui', () => {
    for (const f of under('core/')) for (const imp of imports(f)) { const t = resolveSpec(f, imp.spec); if (t) expect(/^(platforms|extension|ui)\//.test(t), `${rel(f)} -> ${t}`).toBe(false); }
    for (const f of under('platforms/')) for (const imp of imports(f)) { const t = resolveSpec(f, imp.spec); if (t) expect(/^(extension|ui)\//.test(t), `${rel(f)} -> ${t}`).toBe(false); }
  });

  it('only the registry (and the adapter itself) knows the TikTok folder', () => {
    for (const f of under('platforms/').filter((x) => !rel(x).startsWith('platforms/tiktok/'))) {
      for (const imp of imports(f)) { const t = resolveSpec(f, imp.spec); if (t?.startsWith('platforms/tiktok/')) expect(rel(f), `${rel(f)} imports ${t}`).toBe('platforms/registry.ts'); }
    }
  });

  it('the shared extension code (pipeline, router, coordinator, hook, relay, driver) does not import from the TikTok folder', () => {
    const shared = under('extension/').filter((f) => !/entrypoints\/tiktok-/.test(rel(f)) && !/\.(css|html)$/.test(f));
    for (const f of shared) for (const imp of imports(f)) { const t = resolveSpec(f, imp.spec); if (t) expect(t.startsWith('platforms/tiktok/'), `${rel(f)} -> ${t}`).toBe(false); }
  });
});

describe('the code that runs inside the platform page stays small and self-contained', () => {
  it('the MAIN-world entrypoint imports only the hook and platform files (no extension API, no storage)', () => {
    const f = path.join(SRC, 'extension/entrypoints/tiktok-main.content.ts');
    for (const imp of imports(f)) {
      const t = resolveSpec(f, imp.spec);
      expect(t === undefined || /^(extension\/capture\/hook|platforms\/tiktok\/(capture-rules|page-identity)|platforms\/capture-protocol)$/.test(t), `${imp.spec}`).toBe(true);
    }
    expect(/\b(chrome|browser)\./.test(code(f))).toBe(false);
  });
});
