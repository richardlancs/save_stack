// Substring chips (CJK, emoji): the single-scan fast path, the general set path, and the shared related-terms budget.
import { describe, expect, it } from 'vitest';
import { normalizeChips } from '../../src/core/search/chips';
import { MAX_RELATED_TERMS } from '../../src/core/search/expander';
import { MIN_RELATED_PER_CHIP, TOTAL_RELATED_BUDGET, planSearch, relatedCap } from '../../src/core/search/planner';
import { defaultExpander } from '../../src/core/search/expander';
import { SearchService } from '../../src/core/search/service';
import type { Chip, SearchRequest, SearchResponse } from '../../src/core/search/types';
import type { SavedItem } from '../../src/core/model';
import { TOO_BROAD } from '../../src/core/storage/sqlite/search';
import { T0, batch, coll, item, member, memoryAdapter } from '../storage/helpers';
import { LABELED_ITEMS } from './labeled';

let seq = 0;
const chip = (text: string, extra: Partial<Chip> = {}): Chip => ({ id: `s${seq++}`, text, ...extra });
const req = (chips: Chip[], extra: Partial<SearchRequest> = {}): SearchRequest => ({ requestId: `s${seq++}`, chips, ...extra });

async function setup(items: SavedItem[], extra: Partial<Parameters<typeof batch>[0]> = {}) {
  const mem = await memoryAdapter();
  for (let i = 0; i < items.length; i += 1000) await mem.adapter.upsertBatch(batch({ items: items.slice(i, i + 1000), ...(i === 0 ? extra : {}) }));
  return { ...mem, service: new SearchService(mem.adapter) };
}

async function collect(service: SearchService, chips: Chip[], extra: Partial<SearchRequest> = {}): Promise<{ ids: string[]; pages: SearchResponse[] }> {
  const pages: SearchResponse[] = [];
  let cursor: string | undefined;
  do {
    const page = await service.search(req(chips, { limit: 100, ...extra, cursor }));
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor && pages.length < 200);
  return { ids: pages.flatMap((p) => p.results.map((r) => r.item.externalId)), pages };
}

describe('substring chips: the single-scan fast path', () => {
  it('matches caption, author, sound, hashtag and collection name (all five fields), by substring', async () => {
    const lib = [
      item(1, { caption: '簡単レシピ', hashtags: [] }),
      item(2, { caption: 'plain', hashtags: ['レシピ動画'], authorHandle: 'a2', authorName: 'A2' }),
      item(3, { caption: 'plain', hashtags: [], authorHandle: 'a3', authorName: 'レシピ太郎' }),
      item(4, { caption: 'plain', hashtags: [], soundTitle: 'レシピのうた' }),
      item(5, { caption: 'plain', hashtags: [] }),
      item(6, { caption: 'nothing', hashtags: [] }),
    ];
    const { service } = await setup(lib, { collections: [coll(1, '今日のレシピ')], memberships: [member(5, 1)] });
    const r = await service.search(req([chip('レシピ')]));
    expect(new Set(r.results.map((x) => x.item.externalId))).toEqual(new Set(['id1', 'id2', 'id3', 'id4', 'id5']));
    expect(r.total).toBe(5);
    expect(r.orderedBy).toBe('recently_saved');
    const ex = await service.explain({ platform: 'tiktok', externalId: 'id5', chips: [chip('レシピ')] });
    expect(ex.matches[0]).toMatchObject({ via: 'direct', fields: ['collection'] });
  });

  it('AND / OR across several substring chips, and several words in one chip', async () => {
    const lib = [item(1, { caption: 'メイク 簡単', hashtags: [] }), item(2, { caption: 'メイク', hashtags: [] }), item(3, { caption: '簡単', hashtags: [] }), item(4, { caption: 'other', hashtags: [] })];
    const { service } = await setup(lib);
    const ids = async (chips: Chip[], mode?: 'all' | 'any') => (await service.search(req(chips, { mode }))).results.map((r) => r.item.externalId).sort();
    expect(await ids([chip('メイク'), chip('簡単')])).toEqual(['id1']);
    expect(await ids([chip('メイク'), chip('簡単')], 'any')).toEqual(['id1', 'id2', 'id3']);
    expect(await ids([chip('メイク 簡単')])).toEqual(['id1']); // both words of one chip
    expect(await ids([chip('メイク'), chip('🍝')], 'any')).toEqual(['id1', 'id2']);
  });

  it('a wildcard character typed by the user is literal, in every field', async () => {
    const lib = [item(1, { caption: '100%レシピ', hashtags: [] }), item(2, { caption: '簡単レシピ', hashtags: [] })];
    const { service } = await setup(lib);
    expect((await service.search(req([chip('%レシピ')]))).results.map((r) => r.item.externalId)).toEqual(['id1']);
  });

  it('pages a large substring result with a stable keyset cursor and a total that does not drift', async () => {
    const lib = Array.from({ length: 95 }, (_, i) => item(i + 1, { caption: i % 5 === 0 ? `他 ${i}` : `簡単 ${i}`, hashtags: [], savedAt: T0 + i, savedAtSource: 'interpolated' }));
    const { service } = await setup(lib);
    const { ids, pages } = await collect(service, [chip('簡単')], { limit: 20 });
    expect(ids).toHaveLength(76);
    expect(new Set(ids).size).toBe(76);
    expect(pages.every((p) => p.total === 76)).toBe(true);
    expect(ids[0]).toBe('id95'); // index 94 is the newest video that contains the word (index 0-based, id = index + 1)
    expect(pages.at(-1)!.nextCursor).toBeUndefined();
  });

  it('a substring search over more than 10,000 videos is capped and flagged too broad', async () => {
    const big = Array.from({ length: TOO_BROAD + 40 }, (_, i) => item(i + 1, { caption: `簡単 ${i}`, hashtags: [], savedAt: T0 + i, savedAtSource: 'interpolated' }));
    const { service } = await setup(big);
    const r = await service.search(req([chip('簡単')], { limit: 10 }));
    expect(r).toMatchObject({ total: TOO_BROAD + 1, totalIsCapped: true, tooBroad: true });
    expect(r.results[0]!.item.externalId).toBe(`id${TOO_BROAD + 40}`);
  }, 60_000);

  it('mixed with an ordinary chip it still works (the general set path)', async () => {
    const lib = [item(1, { caption: 'pasta 簡単レシピ', hashtags: [] }), item(2, { caption: 'pasta', hashtags: [] }), item(3, { caption: '簡単レシピ', hashtags: [] })];
    const { service } = await setup(lib);
    expect((await service.search(req([chip('pasta', { expand: false }), chip('レシピ')]))).results.map((r) => r.item.externalId)).toEqual(['id1']);
    expect((await service.search(req([chip('pasta', { expand: false }), chip('レシピ')], { mode: 'any' }))).total).toBe(3);
  });
});

describe('related terms are shared across the chips of one query', () => {
  const ex = defaultExpander;
  const n = (texts: string[], extra: Record<string, unknown> = {}) => normalizeChips(texts.map((t, i) => ({ id: `c${i}`, text: t, ...extra })));

  it('1-2 chips keep 30 each, more chips get a smaller share, and the total stays bounded', () => {
    expect(relatedCap(n(['food']))).toBe(MAX_RELATED_TERMS);
    expect(relatedCap(n(['food', 'hair']))).toBe(30);
    expect(relatedCap(n(['food', 'hair', 'travel']))).toBe(20);
    expect(relatedCap(n(['food', 'hair', 'travel', 'gaming', 'yoga']))).toBe(12);
    expect(relatedCap(n(Array.from({ length: 20 }, (_, i) => `w${i}`)))).toBe(MIN_RELATED_PER_CHIP); // never starved completely
    expect(relatedCap(n(['food', 'hair', 'travel', 'gaming', 'yoga'], { expand: false }))).toBe(30); // chips that do not expand do not consume the budget
    const p = planSearch({ chips: ['food', 'fitness', 'travel', 'makeup', 'gaming'].map((t) => chip(t)), mode: 'any' }, ex);
    expect(p.chips.every((c) => c.related.length <= 12)).toBe(true);
    expect(p.chips.reduce((a, c) => a + c.related.length, 0)).toBeLessThanOrEqual(TOTAL_RELATED_BUDGET);
    expect(planSearch({ chips: [chip('food')] }, ex).chips[0]!.related.length).toBeGreaterThan(20);
  });

  it("a chip's badge count is computed with the same share the search used", async () => {
    const stripped: SavedItem[] = LABELED_ITEMS.map(({ labels: _l, ...rest }) => rest);
    const { service } = await setup(stripped);
    const chips = ['food', 'fitness', 'travel', 'makeup', 'gaming'].map((t) => chip(t));
    const info = await service.chipInfo({ requestId: 'q', chips });
    for (const c of info.chips) expect(c.expandedTerms.length).toBeLessThanOrEqual(12);
    const any = await service.search(req(chips, { mode: 'any', limit: 100 }));
    expect(any.total).toBeLessThanOrEqual(info.chips.reduce((a, c) => a + c.count, 0)); // an OR cannot match more than the badges add up to
    expect(any.results.length).toBe(Math.min(100, any.total));
  });
});

describe('too broad: ordering uses the chips\' own words when they alone already exceed the limit', () => {
  it('a related-only video is left out of the recency listing (and flagged too broad), and every page stays consistent', async () => {
    const big: SavedItem[] = Array.from({ length: TOO_BROAD + 30 }, (_, i) => item(i + 1, { caption: `food ${i}`, hashtags: [], savedAt: T0 + i, savedAtSource: 'interpolated' }));
    // a related-only video (says "recipe", never "food") that is the very NEWEST saved
    big.push(item(99_999, { caption: 'quick recipe', hashtags: [], savedAt: T0 + 10_000_000, savedAtSource: 'interpolated' }));
    const { service } = await setup(big);
    const p1 = await service.search(req([chip('food')], { limit: 20 }));
    expect(p1).toMatchObject({ tooBroad: true, totalIsCapped: true, orderedBy: 'recently_saved', total: TOO_BROAD + 1 });
    expect(p1.results.some((r) => r.item.externalId === 'id99999')).toBe(false); // not part of the own-word listing
    expect(p1.results.every((r) => /food/.test(r.item.caption ?? ''))).toBe(true);
    const p2 = await service.search(req([chip('food')], { limit: 20, cursor: p1.nextCursor }));
    expect(p2.results.every((r) => /food/.test(r.item.caption ?? ''))).toBe(true);
    expect(p2.results[0]!.item.externalId).not.toBe(p1.results[0]!.item.externalId);
    // a chip that names the related-only video's own word brings it into the listing (that search is still too broad)
    const narrowed = await service.search(req([chip('food'), chip('recipe', { expand: false })], { mode: 'any' }));
    expect(narrowed.results.map((r) => r.item.externalId)).toContain('id99999');
  }, 90_000);
});
