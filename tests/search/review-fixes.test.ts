// Regression tests for the problems the M2 independent code review found (each was verified real before being fixed).
import { describe, expect, it } from 'vitest';
import { SearchInputError } from '../../src/core/search/chips';
import { SearchService } from '../../src/core/search/service';
import type { Chip, SearchRequest } from '../../src/core/search/types';
import type { SavedItem } from '../../src/core/model';
import { TOO_BROAD } from '../../src/core/storage/sqlite/search';
import { T0, batch, coll, item, member, memoryAdapter } from '../storage/helpers';

let seq = 0;
const chip = (text: string, extra: Partial<Chip> = {}): Chip => ({ id: `r${seq++}`, text, ...extra });
const req = (chips: Chip[], extra: Partial<SearchRequest> = {}): SearchRequest => ({ requestId: `q${seq++}`, chips, ...extra });

async function setup(items: SavedItem[], extra: Partial<Parameters<typeof batch>[0]> = {}) {
  const mem = await memoryAdapter();
  for (let i = 0; i < items.length; i += 1000) await mem.adapter.upsertBatch(batch({ items: items.slice(i, i + 1000), ...(i === 0 ? extra : {}) }));
  return { ...mem, service: new SearchService(mem.adapter) };
}

describe('duplicate chips still get an answer (review finding: chipInfo/explain silently omitted them)', () => {
  it('chipInfo and explainMatch return one entry for EVERY chip sent, each under its own id', async () => {
    const { service } = await setup([item(1, { caption: 'easy pasta dinner', hashtags: [] })]);
    const a = chip('Food');
    const b = chip('food'); // same chip, different case
    const c = chip('gym');
    const info = await service.chipInfo({ requestId: 'q', chips: [a, b, c] });
    expect(info.chips.map((x) => x.chipId)).toEqual([a.id, b.id, c.id]);
    expect(info.chips[1]).toMatchObject({ count: info.chips[0]!.count, expandedTerms: info.chips[0]!.expandedTerms });
    const ex = await service.explain({ platform: 'tiktok', externalId: 'id1', chips: [a, b, c] });
    expect(ex.matches.map((m) => m.chipId)).toEqual([a.id, b.id, c.id]);
    expect(ex.matches[1]).toMatchObject({ via: ex.matches[0]!.via });
    expect(ex.matches[2]).toMatchObject({ via: 'none' });
  });

  it('a bad chip is still rejected even when it is a duplicate-looking neighbour', async () => {
    const { service } = await setup([]);
    await expect(service.chipInfo({ requestId: 'q', chips: [chip('food'), chip('  ')] })).rejects.toThrow(SearchInputError);
    await expect(service.chipInfo({ requestId: 'q', chips: Array.from({ length: 41 }, (_, i) => chip(`w${i}`)) })).rejects.toThrow(/too many chips/);
  });
});

describe('cursors (review finding: not tied to the sort; the total was trusted)', () => {
  const lib = () => Array.from({ length: 30 }, (_, i) => item(i + 1, { caption: `note ${i + 1}`, hashtags: [], savedAt: T0 + i, stats: { views: 1000 - i } }));

  it('a cursor issued for one sort is refused under another sort', async () => {
    const { service } = await setup(lib());
    const p1 = await service.search(req([], { limit: 10, sort: 'recently_saved' }));
    expect(p1.nextCursor).toMatch(/^k:s:/);
    await expect(service.search(req([], { limit: 10, sort: 'most_viewed', cursor: p1.nextCursor }))).rejects.toThrow(/different sort/);
    await expect(service.search(req([], { limit: 10, sort: 'newest', cursor: p1.nextCursor }))).rejects.toThrow(/different sort/);
    // the same sort still pages
    expect((await service.search(req([], { limit: 10, sort: 'recently_saved', cursor: p1.nextCursor }))).results).toHaveLength(10);
    const v1 = await service.search(req([], { limit: 10, sort: 'most_viewed' }));
    expect(v1.nextCursor).toMatch(/^k:v:/);
  });

  it('a hand-edited total cannot report an absurd count', async () => {
    const { service } = await setup(lib());
    const p1 = await service.search(req([], { limit: 10 }));
    const forged = p1.nextCursor!.replace(/:\d+$/, ':999999');
    const p2 = await service.search(req([], { limit: 10, cursor: forged }));
    expect(p2.total).toBeLessThanOrEqual(TOO_BROAD + 1);
    const r = await service.search(req([chip('note', { expand: false })], { limit: 5, cursor: 'r:5:999999' }));
    expect(r.total).toBeLessThanOrEqual(TOO_BROAD + 1);
  });

  it('the old cursor shape and malformed ones are rejected', async () => {
    const { service } = await setup(lib());
    for (const bad of ['k:5:5:30', 'k:x:5:5:30', 'k:s:5:5', 'q:s:1:1:1', 'r:5', 'k:s:1:1:1;DROP']) {
      await expect(service.search(req([], { cursor: bad })), bad).rejects.toThrow(SearchInputError);
    }
  });
});

describe('a too-broad own-words listing keeps the same set on every page (review finding: decision was recomputed per page)', () => {
  it('page 1 issues a d: cursor and page 2 continues over the same own-word set without a count', async () => {
    const big: SavedItem[] = Array.from({ length: TOO_BROAD + 30 }, (_, i) => item(i + 1, { caption: `food ${i}`, hashtags: [], savedAt: T0 + i, savedAtSource: 'interpolated' }));
    big.push(item(99_999, { caption: 'quick recipe', hashtags: [], savedAt: T0 + 10_000_000, savedAtSource: 'interpolated' }));
    const { service } = await setup(big);
    const p1 = await service.search(req([chip('food')], { limit: 20 }));
    expect(p1.tooBroad).toBe(true);
    expect(p1.nextCursor).toMatch(/^d:s:/);
    const p2 = await service.search(req([chip('food')], { limit: 20, cursor: p1.nextCursor }));
    expect(p2.tooBroad).toBe(true);
    expect(p2.total).toBe(p1.total);
    expect(p2.results.some((r) => r.item.externalId === 'id99999')).toBe(false); // still the own-word set
    expect(p2.nextCursor).toMatch(/^d:s:/);
    // a relevance-sized search of the same chips never emits a d: cursor
    const small = await setup([item(1, { caption: 'food a', hashtags: [] })]);
    expect((await small.service.search(req([chip('food')]))).nextCursor).toBeUndefined();
    // a d: cursor is meaningless for a browse or an explicit column sort
    await expect(service.search(req([], { cursor: p1.nextCursor }))).rejects.toThrow(SearchInputError);
    await expect(service.search(req([chip('food')], { sort: 'most_viewed', cursor: p1.nextCursor }))).rejects.toThrow(SearchInputError);
  }, 90_000);
});

describe('substring chips beyond 500 matching hashtags or collections (review finding: silently truncated)', () => {
  it('finds items whose ONLY match is one of more than 500 matching hashtags', async () => {
    const items = Array.from({ length: 600 }, (_, i) => item(i + 1, { caption: 'plain words', hashtags: [`レシピ${i}`] }));
    const { service } = await setup(items);
    const r = await service.search(req([chip('レシピ')], { limit: 100 }));
    expect(r.total).toBe(600);
    const ids = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await service.search(req([chip('レシピ')], { limit: 100, cursor }));
      page.results.forEach((x) => ids.add(x.item.externalId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(ids.size).toBe(600);
    expect((await service.chipInfo({ requestId: 'q', chips: [chip('レシピ')] })).chips[0]!.count).toBe(600);
  });

  it('finds items whose ONLY match is one of more than 500 matching collection names', async () => {
    const items = Array.from({ length: 520 }, (_, i) => item(i + 1, { caption: 'plain words', hashtags: [] }));
    const collections = Array.from({ length: 520 }, (_, i) => coll(i + 1, `レシピ集${i}`));
    const memberships = Array.from({ length: 520 }, (_, i) => member(i + 1, i + 1));
    const { service } = await setup(items, { collections, memberships });
    expect((await service.search(req([chip('レシピ')], { limit: 100 }))).total).toBe(520);
  });
});

describe('search results do not carry raw_json (review finding: it crossed the RPC boundary for nothing)', () => {
  it('a result omits rawJson, while getItem still returns it', async () => {
    const withRaw = item(1, { caption: 'food', hashtags: [], rawJson: JSON.stringify({ big: 'x'.repeat(5000) }) });
    const { service, adapter } = await setup([withRaw]);
    const r = await service.search(req([chip('food', { expand: false })]));
    expect(r.results[0]!.item.rawJson).toBeUndefined();
    expect(JSON.stringify(r).length).toBeLessThan(3000);
    expect((await adapter.getItem('tiktok', 'id1'))!.rawJson).toContain('xxxx');
  });
});

describe('did-you-mean vocabulary cache (review finding: rebuilt with full scans for every typo)', () => {
  it('is reused between calls, and refreshed as soon as the data changes', async () => {
    const { service, adapter } = await setup([item(1, { caption: 'x', hashtags: ['gym'] })]);
    const typo = () => service.chipInfo({ requestId: 'q', chips: [chip('zumbafitt')] });
    expect((await typo()).chips[0]!.didYouMean).toBeUndefined(); // nothing close yet
    let scans = 0;
    const realSelect = adapter['db'].selectValues.bind(adapter['db']);
    (adapter['db'] as { selectValues: unknown }).selectValues = (sql: string, ...rest: unknown[]) => { if (/FROM hashtags$/.test(sql)) scans++; return (realSelect as (...a: unknown[]) => unknown)(sql, ...rest); };
    await typo();
    await typo();
    expect(scans).toBe(0); // served from the cache
    await adapter.upsertBatch(batch({ items: [item(2, { caption: 'y', hashtags: ['zumbafit'] })] }, T0 + 1));
    expect((await typo()).chips[0]!.didYouMean).toBe('zumbafit'); // the new hashtag is visible: the cache was invalidated
    expect(scans).toBe(1);
    await typo();
    expect(scans).toBe(1);
  });
});
