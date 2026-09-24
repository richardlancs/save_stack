// Fuzzing the parser with mutated REAL-SHAPED payloads. Deterministic (seeded), so a failure is reproducible:
// the failing seed and mutation are printed. The property: whatever TikTok sends, the parser returns and its output is
// safe to store (bounded, typed, serializable). It is the unknown-unknowns test behind "every field except id is optional".
import { describe, expect, it } from 'vitest';
import collectionDetail from '../../src/platforms/tiktok/fixtures/collection_detail.json';
import collectionItems1 from '../../src/platforms/tiktok/fixtures/collection_item_list.page1.json';
import collectionListFixture from '../../src/platforms/tiktok/fixtures/collection_list.json';
import favEdge from '../../src/platforms/tiktok/fixtures/favorites_item_list.edge_cases.json';
import fav1 from '../../src/platforms/tiktok/fixtures/favorites_item_list.page1.json';
import { parseTikTokCapture } from '../../src/platforms/tiktok/parse';
import type { ParsedCapture } from '../../src/platforms/types';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const WEIRD: Json[] = [null, true, false, 0, -1, 1e308, -1e308, 'x', '', ' ', '0', '123', '1e5', 'NaN', 'Infinity', '\u0000', '\ud83d', 'a'.repeat(100_000), [], [null], [[]], {}, { a: 1 }, [{ id: 1 }], -0, 2 ** 53, 0.1];

/** Apply one random structural mutation somewhere inside `root`. Returns a description for failure messages. */
function mutate(root: Json, rnd: () => number): string {
  // collect every container with a path
  const nodes: Array<{ parent: Json; key: string | number; path: string }> = [];
  (function walk(v: Json, path: string): void {
    if (Array.isArray(v)) v.forEach((c, i) => { nodes.push({ parent: v, key: i, path: `${path}[${i}]` }); walk(c, `${path}[${i}]`); });
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) { nodes.push({ parent: v, key: k, path: `${path}.${k}` }); walk(v[k]!, `${path}.${k}`); }
  })(root, '$');
  if (nodes.length === 0) return 'noop';
  const n = nodes[Math.floor(rnd() * nodes.length)]!;
  const p = n.parent as Record<string | number, Json>;
  const roll = rnd();
  if (roll < 0.4) { const w = WEIRD[Math.floor(rnd() * WEIRD.length)]!; p[n.key] = w; return `retype ${n.path} -> ${JSON.stringify(w)?.slice(0, 40)}`; }
  if (roll < 0.65) { if (Array.isArray(p)) p.splice(n.key as number, 1); else delete p[n.key]; return `delete ${n.path}`; }
  if (roll < 0.8) { const v = p[n.key]!; p[n.key] = Array.isArray(v) ? [...v, ...v, ...v] : { wrapped: v }; return `nest/duplicate ${n.path}`; }
  if (roll < 0.9) { if (!Array.isArray(p)) p[`extra_${Math.floor(rnd() * 1000)}`] = WEIRD[Math.floor(rnd() * WEIRD.length)]!; return `add field near ${n.path}`; }
  p[n.key] = JSON.parse(JSON.stringify(p[n.key] ?? null)) as Json; // no-op clone: keeps some iterations pristine
  return `clone ${n.path}`;
}

const SOURCES: Array<[string, Json]> = [
  ['favorites', fav1 as unknown as Json], ['favorites', favEdge as unknown as Json], ['collection_items', collectionItems1 as unknown as Json],
  ['collection_list', collectionListFixture as unknown as Json], ['collection_detail', collectionDetail as unknown as Json],
];

/** What must hold for ANY output, however hostile the input. */
function assertSafe(r: ParsedCapture, context: string): void {
  const fail = (m: string) => { throw new Error(`${m} [${context}]`); };
  if (!r || typeof r !== 'object') fail('result is not an object');
  const seen = new Set<string>();
  for (const it of r.batch.items) {
    if (typeof it.externalId !== 'string' || !/^\d{5,30}$/.test(it.externalId)) fail(`bad id ${String(it.externalId)}`);
    if (seen.has(it.externalId)) fail('duplicate id in one page');
    seen.add(it.externalId);
    if (it.platform !== 'tiktok') fail('platform');
    if (typeof it.authorHandle !== 'string' || it.authorHandle.length > 64) fail('authorHandle');
    if (it.caption !== undefined && (typeof it.caption !== 'string' || it.caption.length > 10_000)) fail('caption');
    if (it.hashtags !== undefined && (!Array.isArray(it.hashtags) || it.hashtags.length > 64 || it.hashtags.some((t) => typeof t !== 'string' || t.length === 0 || t.length > 100))) fail('hashtags');
    for (const f of ['durationSec', 'postedAt', 'savedAt'] as const) if (it[f] !== undefined && !Number.isFinite(it[f])) fail(`${f} not finite`);
    if (it.stats) for (const v of Object.values(it.stats)) if (v !== undefined && !Number.isFinite(v)) fail('stat not finite');
    if (it.thumbnailUrl !== undefined && !it.thumbnailUrl.startsWith('https://')) fail('thumbnail scheme');
    if (it.mediaType !== 'video' && it.mediaType !== 'photo') fail('mediaType');
    if (it.mediaType === 'photo' && it.durationSec !== undefined) fail('photo with duration');
  }
  for (const c of r.batch.collections ?? []) if (typeof c.externalId !== 'string' || typeof c.name !== 'string' || c.name.length === 0 || c.name.length > 200) fail('collection');
  for (const m of r.batch.memberships ?? []) if (!Number.isInteger(m.position) || m.position < 0) fail('membership position');
  if (r.page.itemsDelivered !== (r.batch.collections && r.page.kind.startsWith('collection_') && r.page.kind !== 'collection_items' ? r.batch.collections.length : r.batch.items.length)) fail('itemsDelivered does not match what was returned');
  if (r.problems.length > 51) fail('problems not bounded');
  if (r.shape.unknownItemKeys.length > 30 || r.shape.unknownItemKeys.some((k) => k.length > 64)) fail('unknown keys not bounded');
  if (r.batch.items.length > 300 || (r.batch.collections?.length ?? 0) > 500) fail('page not capped');
  JSON.parse(JSON.stringify(r)); // must survive structured-clone / JSON (it crosses the RPC boundary)
}

describe('parser fuzzing', () => {
  it('never throws and always returns storable output, over 6,000 mutated payloads', () => {
    let iterations = 0;
    let withProblems = 0;
    for (let seed = 1; seed <= 1200; seed++) {
      for (const [kind, source] of SOURCES) {
        const rnd = mulberry32(seed * 7919 + kind.length);
        const body = JSON.parse(JSON.stringify(source)) as Json;
        const steps = 1 + Math.floor(rnd() * 6);
        const applied: string[] = [];
        for (let s = 0; s < steps; s++) applied.push(mutate(body, rnd));
        const context = `seed ${seed}, ${kind}: ${applied.join('; ')}`;
        let r: ParsedCapture;
        try { r = parseTikTokCapture({ platform: 'tiktok', kind, body, capturedAt: 1_787_000_000_000, collectionId: '7000000000000000501', requestCursor: '30' }); }
        catch (e) { throw new Error(`parser THREW: ${(e as Error).message} [${context}]`); }
        assertSafe(r, context);
        iterations++;
        if (r.problems.length > 0) withProblems++;
      }
    }
    expect(iterations).toBe(6000);
    expect(withProblems).toBeGreaterThan(100); // the fuzzer really does break payloads (otherwise this test proves nothing)
  }, 60_000);

  it('the untouched fixtures pass the same safety check (the check itself is not vacuous)', () => {
    for (const [kind, source] of SOURCES) assertSafe(parseTikTokCapture({ platform: 'tiktok', kind, body: source, capturedAt: 1_787_000_000_000, collectionId: '7000000000000000501', requestCursor: '30' }), kind);
  });

  it('assertSafe really detects a bad result', () => {
    const good = parseTikTokCapture({ platform: 'tiktok', kind: 'favorites', body: fav1, capturedAt: 1_787_000_000_000 });
    const bad = JSON.parse(JSON.stringify(good)) as ParsedCapture;
    bad.batch.items[0]!.externalId = 'not-an-id';
    expect(() => assertSafe(bad, 'x')).toThrow(/bad id/);
    const bad2 = JSON.parse(JSON.stringify(good)) as ParsedCapture;
    bad2.batch.items[0]!.thumbnailUrl = 'javascript:alert(1)';
    expect(() => assertSafe(bad2, 'x')).toThrow(/thumbnail scheme/);
  });
});
