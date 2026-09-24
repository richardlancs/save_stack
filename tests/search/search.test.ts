// Search integration: the real SearchService over the real SQLite adapter (in-memory), and through the RPC layer.
import { describe, expect, it } from 'vitest';
import { SearchInputError } from '../../src/core/search/chips';
import { SearchService } from '../../src/core/search/service';
import type { Chip, SearchRequest, SearchResponse } from '../../src/core/search/types';
import type { SavedItem } from '../../src/core/model';
import { TOO_BROAD } from '../../src/core/storage/sqlite/search';
import { RpcCallError, createClient, isSuperseded } from '../../src/extension/rpc/client';
import { createRpcServer } from '../../src/extension/rpc/server';
import { DAY, T0, batch, coll, item, member, memoryAdapter } from '../storage/helpers';
import { CHIP_LABELS, LABELED_ITEMS, type Label } from './labeled';

let seq = 0;
const chip = (text: string, extra: Partial<Chip> = {}): Chip => ({ id: `c${seq++}`, text, ...extra });
const req = (chips: Chip[], extra: Partial<SearchRequest> = {}): SearchRequest => ({ requestId: `r${seq++}`, chips, ...extra });

async function setup(items: SavedItem[], extra: Parameters<typeof batch>[0] extends infer B ? Partial<B> : never = {}) {
  const mem = await memoryAdapter();
  for (let i = 0; i < items.length; i += 1000) await mem.adapter.upsertBatch(batch({ items: items.slice(i, i + 1000), ...(i === 0 ? extra : {}) }));
  return { ...mem, service: new SearchService(mem.adapter) };
}

/** Follow nextCursor to the end, returning every result in order. */
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

const stripLabels = (): SavedItem[] => LABELED_ITEMS.map(({ labels: _l, ...rest }) => rest);

describe('quality: does a chip find what a person would file under it?', () => {
  it('finds videos by category even when they never use the category word (hand-labeled set)', async () => {
    const { service } = await setup(stripLabels());
    let tp = 0, fp = 0, fn = 0;
    const lines: string[] = [];
    for (const label of CHIP_LABELS) {
      const relevant = new Set(LABELED_ITEMS.filter((i) => i.labels.includes(label)).map((i) => i.externalId));
      const { ids } = await collect(service, [chip(label)]);
      const got = new Set(ids);
      const hit = [...got].filter((id) => relevant.has(id)).length;
      const recall = hit / relevant.size;
      const precision = got.size ? hit / got.size : 1;
      tp += hit; fp += got.size - hit; fn += relevant.size - hit;
      lines.push(`${label.padEnd(8)} recall ${(recall * 100).toFixed(0).padStart(3)}%  precision ${(precision * 100).toFixed(0).padStart(3)}%  (${hit}/${relevant.size} found, ${got.size - hit} extra)`);
      expect(recall, `${label}: found ${hit} of ${relevant.size}`).toBeGreaterThanOrEqual(0.7);
    }
    const recall = tp / (tp + fn), precision = tp / (tp + fp);
    console.log(`\n${lines.join('\n')}\nOVERALL recall ${(recall * 100).toFixed(1)}%  precision ${(precision * 100).toFixed(1)}%\n`);
    expect(recall).toBeGreaterThanOrEqual(0.9);
    expect(precision).toBeGreaterThanOrEqual(0.85);
  });

  it('related terms are what make the difference: "food" alone finds few, with expansion it finds nearly all', async () => {
    const { service } = await setup(stripLabels());
    const relevant = new Set(LABELED_ITEMS.filter((i) => i.labels.includes('food')).map((i) => i.externalId));
    const rate = async (expand: boolean) => (await collect(service, [chip('food', { expand })])).ids.filter((id) => relevant.has(id)).length / relevant.size;
    const direct = await rate(false);
    const expanded = await rate(true);
    console.log(`"food": exact-only recall ${(direct * 100).toFixed(0)}%, with related terms ${(expanded * 100).toFixed(0)}%`);
    expect(direct).toBeLessThan(0.4);
    expect(expanded).toBeGreaterThanOrEqual(0.85);
    expect(expanded - direct).toBeGreaterThanOrEqual(0.4);
  });

  it('a pasta video that never says "food" is found by the "food" chip', async () => {
    const { service } = await setup(stripLabels());
    const { ids } = await collect(service, [chip('food')]);
    const pasta = LABELED_ITEMS.find((i) => (i.caption ?? '').startsWith('easy pasta carbonara'))!;
    expect(pasta.caption ?? '').not.toMatch(/food/i);
    expect(ids).toContain(pasta.externalId);
    expect((await collect(service, [chip('food', { expand: false })])).ids).not.toContain(pasta.externalId);
  });
});

describe('ranking and combining chips', () => {
  const A = item(1, { caption: 'food truck festival downtown', hashtags: [] });
  const B = item(2, { caption: 'quick recipe for tonight', hashtags: [] });
  const C = item(3, { caption: 'totally unrelated cat video', hashtags: [] });

  it("a video matching the chip's own words ranks above one matching only via a related term", async () => {
    const { service } = await setup([B, C, A]); // insertion order must not decide it
    const r = await service.search(req([chip('food')]));
    expect(r.results.map((x) => x.item.externalId)).toEqual(['id1', 'id2']);
    expect(r.results[0]!.score).toBeGreaterThan(r.results[1]!.score);
    expect(r.orderedBy).toBe('relevance');
    expect(r.total).toBe(2);
    expect((await service.search(req([chip('food', { expand: false })]))).results.map((x) => x.item.externalId)).toEqual(['id1']);
  });

  it('weights fields: the same word in a hashtag outranks it in a caption', async () => {
    const inTag = item(1, { caption: 'morning stretch', hashtags: ['yoga'] });
    const inCaption = item(2, { caption: 'morning yoga', hashtags: [] });
    const { service } = await setup([inCaption, inTag]);
    const r = await service.search(req([chip('yoga', { expand: false })]));
    expect(r.results.map((x) => x.item.externalId)).toEqual(['id1', 'id2']);
  });

  it('AND (default) narrows, OR widens', async () => {
    const both = item(1, { caption: 'food haul and makeup haul', hashtags: [] });
    const foodOnly = item(2, { caption: 'food diary', hashtags: [] });
    const makeupOnly = item(3, { caption: 'makeup diary', hashtags: [] });
    const { service } = await setup([both, foodOnly, makeupOnly]);
    const chips = [chip('food', { expand: false }), chip('makeup', { expand: false })];
    expect((await service.search(req(chips))).results.map((r) => r.item.externalId)).toEqual(['id1']);
    expect((await service.search(req(chips, { mode: 'all' }))).total).toBe(1);
    const any = await service.search(req(chips, { mode: 'any' }));
    expect(any.total).toBe(3);
    expect(any.results[0]!.item.externalId).toBe('id1'); // matching both scores highest
  });

  it('a multiword chip matches the concatenated hashtag, and its words in any order', async () => {
    const tagged = item(1, { caption: 'sunday reset', hashtags: ['mealprep'] });
    const spoken = item(2, { caption: 'my meal prep for the week', hashtags: [] });
    const shuffled = item(3, { caption: 'prep school lunch and dinner meal', hashtags: [] });
    const other = item(4, { caption: 'gym day', hashtags: [] });
    const { service } = await setup([tagged, spoken, shuffled, other]);
    const { ids } = await collect(service, [chip('meal prep', { expand: false })]);
    expect(new Set(ids)).toEqual(new Set(['id1', 'id2', 'id3']));
  });

  it('prefix matching works for words of 3+ letters ("fit" finds "fitness") but not for 1-2 letters', async () => {
    const { service } = await setup([item(1, { caption: 'fitness journey', hashtags: [] }), item(2, { caption: 'a big day', hashtags: [] })]);
    expect((await service.search(req([chip('fit', { expand: false })]))).total).toBe(1);
    expect((await service.search(req([chip('a', { expand: false })]))).total).toBe(1); // exact word "a" only, not "aaaa..." prefixes
  });

  it('matches a collection name, so a video in "Recipes" is found even if its own text is unrelated', async () => {
    const { service } = await setup([item(1, { caption: 'cozy apartment tour', hashtags: [] }), item(2, { caption: 'gym day', hashtags: [] })], {
      collections: [coll(1, 'Weeknight Dinners')],
      memberships: [member(1, 1)],
    });
    expect((await service.search(req([chip('dinners', { expand: false })]))).results.map((r) => r.item.externalId)).toEqual(['id1']);
  });
});

describe('ordering and pagination', () => {
  const library = () => Array.from({ length: 30 }, (_, i) => item(i + 1, { caption: `note ${i + 1}`, hashtags: [], savedAt: T0 + i * 1000, savedAtSource: 'interpolated' }));

  it('no chips = browse everything, newest saved first; pages cover every video exactly once', async () => {
    const { service } = await setup(library());
    const { ids, pages } = await collect(service, [], { limit: 7 });
    expect(ids).toHaveLength(30);
    expect(new Set(ids).size).toBe(30);
    expect(ids[0]).toBe('id30');
    expect(ids[29]).toBe('id1');
    expect(pages[0]!).toMatchObject({ total: 30, orderedBy: 'recently_saved', tooBroad: false });
    expect(pages.at(-1)!.nextCursor).toBeUndefined();
  });

  it('keyset pages stay stable when a newer video arrives between page 1 and page 2', async () => {
    const { service, adapter } = await setup(library());
    const p1 = await service.search(req([], { limit: 10 }));
    await adapter.upsertBatch(batch({ items: [item(99, { caption: 'brand new', hashtags: [], savedAt: T0 + 999_999, savedAtSource: 'first_seen' })] }, T0 + DAY));
    const p2 = await service.search(req([], { limit: 10, cursor: p1.nextCursor }));
    const seen = [...p1.results, ...p2.results].map((r) => r.item.externalId);
    expect(new Set(seen).size).toBe(20); // no duplicates
    expect(seen).not.toContain('id99'); // the newcomer belongs to page 1, which we already have
    expect(p2.results[0]!.item.externalId).toBe('id20');
  });

  it('other sorts: newest posted, most viewed', async () => {
    const items = [item(1, { caption: 'x', hashtags: [], postedAt: 300, stats: { views: 5 } }), item(2, { caption: 'x', hashtags: [], postedAt: 100, stats: { views: 50 } }), item(3, { caption: 'x', hashtags: [], postedAt: 200, stats: { views: 20 } })];
    const { service } = await setup(items);
    expect((await service.search(req([chip('x', { expand: false })], { sort: 'newest' }))).results.map((r) => r.item.externalId)).toEqual(['id1', 'id3', 'id2']);
    expect((await service.search(req([chip('x', { expand: false })], { sort: 'most_viewed' }))).results.map((r) => r.item.externalId)).toEqual(['id2', 'id3', 'id1']);
    expect((await service.search(req([], { sort: 'most_viewed' }))).results[0]!.item.externalId).toBe('id2');
  });

  it('"recently saved" follows saved_at, NOT insertion order (they disagree here on purpose)', async () => {
    // id1 was inserted first but saved LAST; id5 was inserted last but saved FIRST
    const items = Array.from({ length: 5 }, (_, i) => item(i + 1, { caption: `note ${i + 1}`, hashtags: [], savedAt: T0 + (5 - i) * 1000, savedAtSource: 'interpolated' }));
    const { service } = await setup(items);
    expect((await service.search(req([]))).results.map((r) => r.item.externalId)).toEqual(['id1', 'id2', 'id3', 'id4', 'id5']);
    expect((await service.search(req([chip('note', { expand: false })], { sort: 'recently_saved' }))).results.map((r) => r.item.externalId)).toEqual(['id1', 'id2', 'id3', 'id4', 'id5']);
    const { ids } = await collect(service, [], { limit: 2 }); // keyset paging follows the same order, with no gaps or repeats
    expect(ids).toEqual(['id1', 'id2', 'id3', 'id4', 'id5']);
    // ties on saved_at fall back to id (newest id first), so paging is deterministic
    const tied = await setup([item(1, { caption: 'x', hashtags: [] }), item(2, { caption: 'x', hashtags: [] }), item(3, { caption: 'x', hashtags: [] })]);
    expect((await tied.service.search(req([]))).results.map((r) => r.item.externalId)).toEqual(['id3', 'id2', 'id1']);
  });

  it('relevance pages (offset cursors) cover every match once, and stop at the end', async () => {
    const yoga = Array.from({ length: 60 }, (_, i) => item(i + 1, { caption: `yoga ${'flow '.repeat(i % 7)}session ${i}`, hashtags: [] }));
    const others = Array.from({ length: 20 }, (_, i) => item(100 + i, { caption: `cooking ${i}`, hashtags: [] }));
    const { service } = await setup([...yoga, ...others]);
    const { ids, pages } = await collect(service, [chip('yoga', { expand: false })], { limit: 20 });
    expect(pages).toHaveLength(3);
    expect(ids).toHaveLength(60);
    expect(new Set(ids).size).toBe(60);
    expect(pages.every((p) => p.total === 60)).toBe(true);
    expect(pages[0]!.nextCursor).toBe('r:20:60');
    expect(pages[2]!.nextCursor).toBeUndefined();
  });

  it('cursors describe themselves: a relevance cursor cannot page a column-ordered search (and vice versa)', async () => {
    const { service } = await setup(library());
    await expect(service.search(req([], { cursor: 'r:5:30' }))).rejects.toThrow(SearchInputError); // browse is column-ordered
    await expect(service.search(req([chip('note', { expand: false })], { sort: 'most_viewed', cursor: 'r:5:30' }))).rejects.toThrow(SearchInputError);
    // a keyset cursor on a relevance search is how a "too broad" search continues, so it is accepted and stays recency-ordered
    const cont = await service.search(req([chip('note', { expand: false })], { cursor: 'k:s:5:5:30' }));
    expect(cont.orderedBy).toBe('recently_saved');
    await expect(service.search(req([], { cursor: 'x:1' }))).rejects.toThrow(SearchInputError);
  });
});

describe('too broad', () => {
  it(`above ${TOO_BROAD} matches: total is capped, relevance is skipped, newest saved first, paging still works`, async () => {
    const big = Array.from({ length: TOO_BROAD + 50 }, (_, i) => item(i + 1, { caption: `hello world ${i}`, hashtags: [], savedAt: T0 + i, savedAtSource: 'interpolated' }));
    const { service } = await setup(big);
    const p1 = await service.search(req([chip('hello', { expand: false })], { limit: 25 }));
    expect(p1).toMatchObject({ total: TOO_BROAD + 1, totalIsCapped: true, tooBroad: true, orderedBy: 'recently_saved' });
    expect(p1.results.map((r) => r.item.externalId).slice(0, 3)).toEqual([`id${TOO_BROAD + 50}`, `id${TOO_BROAD + 49}`, `id${TOO_BROAD + 48}`]);
    expect(p1.nextCursor).toMatch(/^k:/);
    const p2 = await service.search(req([chip('hello', { expand: false })], { limit: 25, cursor: p1.nextCursor }));
    expect(p2.results[0]!.item.externalId).toBe(`id${TOO_BROAD + 50 - 25}`);
    expect(p1.tookMs).toBeLessThan(2000);
    // an explicit sort is honoured and still reports too broad
    expect((await service.search(req([chip('hello', { expand: false })], { sort: 'most_viewed', limit: 5 }))).orderedBy).toBe('most_viewed');
    // a narrower query on the same library is not too broad
    expect((await service.search(req([chip('hello', { expand: false }), chip('world 7', { expand: false })]))).tooBroad).toBe(false);
  }, 60_000);
});

describe('chip info', () => {
  const lib = [
    item(1, { caption: 'soft glam', hashtags: ['makeup'] }),
    item(2, { caption: 'drugstore finds', hashtags: ['makeup'] }),
    item(3, { caption: 'easy pasta', hashtags: ['dinner'] }),
  ];

  it('reports per-chip counts, the related terms used, and a did-you-mean only for chips that match nothing', async () => {
    const { service } = await setup(lib);
    const chips = [chip('makeup', { expand: false }), chip('makup'), chip('zzzzzz'), chip('food')];
    const r = await service.chipInfo({ requestId: 'q', chips });
    const byChip = new Map(r.chips.map((c) => [c.chipId, c]));
    expect(byChip.get(chips[0]!.id)).toMatchObject({ count: 2, countIsCapped: false, expandedTerms: [] });
    expect(byChip.get(chips[1]!.id)).toMatchObject({ count: 0, didYouMean: 'makeup' });
    expect(byChip.get(chips[2]!.id)!.count).toBe(0);
    expect(byChip.get(chips[2]!.id)!.didYouMean).toBeUndefined();
    const food = byChip.get(chips[3]!.id)!;
    expect(food.count).toBe(1); // "easy pasta" via the related term
    expect(food.expandedTerms).toContain('recipe');
    expect(food.didYouMean).toBeUndefined();
  });

  it('says which chip over-narrows an AND search', async () => {
    const { service } = await setup(lib);
    const chips = [chip('makeup', { expand: false }), chip('pasta', { expand: false })];
    expect((await service.search(req(chips))).total).toBe(0);
    const info = await service.chipInfo({ requestId: 'q', chips });
    expect(info.chips.map((c) => c.count)).toEqual([2, 1]);
  });

  it('counts substring chips too', async () => {
    const { service } = await setup([item(1, { caption: '簡単レシピ', hashtags: [] }), item(2, { caption: 'plain', hashtags: [] })]);
    expect((await service.chipInfo({ requestId: 'q', chips: [chip('レシピ')] })).chips[0]!.count).toBe(1);
  });
});

describe('explain: why did this result match?', () => {
  it('tells direct from related, and names the fields and the related term', async () => {
    const it1 = item(1, { caption: 'pasta recipe for tonight', hashtags: ['dinner'], authorHandle: 'chefjo', authorName: 'Chef Jo' });
    const { service } = await setup([it1], { collections: [coll(1, 'Weeknight Ideas')], memberships: [member(1, 1)] });
    const chips = [chip('food'), chip('chefjo'), chip('yoga'), chip('pasta'), chip('weeknight')];
    const { matches } = await service.explain({ platform: 'tiktok', externalId: 'id1', chips });
    const m = new Map(matches.map((x) => [x.chipId, x]));
    expect(m.get(chips[0]!.id)).toMatchObject({ via: 'related', term: 'recipe' });
    expect(m.get(chips[0]!.id)!.fields).toEqual(expect.arrayContaining(['caption', 'hashtags']));
    expect(m.get(chips[1]!.id)).toMatchObject({ via: 'direct', fields: ['author'] });
    expect(m.get(chips[2]!.id)).toMatchObject({ via: 'none', fields: [] });
    expect(m.get(chips[3]!.id)).toMatchObject({ via: 'direct', fields: ['caption'] });
    expect(m.get(chips[4]!.id)).toMatchObject({ via: 'direct', fields: ['collection'] });
  });

  it('agrees with search: a result is explained as matching every chip that found it', async () => {
    const { service } = await setup(stripLabels());
    for (const label of ['food', 'fitness', 'travel'] as Label[]) {
      const c = chip(label);
      const { ids } = await collect(service, [c]);
      for (const id of ids.slice(0, 8)) {
        const { matches } = await service.explain({ platform: 'tiktok', externalId: id, chips: [c] });
        expect(matches[0]!.via, `${label}: ${id}`).not.toBe('none');
      }
    }
  });

  it('explains substring chips and rejects unknown items', async () => {
    const { service } = await setup([item(1, { caption: '簡単レシピ', hashtags: [] })]);
    const c = chip('レシピ');
    expect((await service.explain({ platform: 'tiktok', externalId: 'id1', chips: [c] })).matches[0]).toMatchObject({ via: 'direct', fields: ['caption'] });
    await expect(service.explain({ platform: 'tiktok', externalId: 'nope', chips: [c] })).rejects.toThrow(/no such item/);
  });
});

describe('languages without spaces, and emoji', () => {
  const lib = [
    item(1, { caption: '簡単レシピ', hashtags: [] }),
    item(2, { caption: '🍝 pasta dinner', hashtags: [] }),
    item(3, { caption: 'plain english recipe', hashtags: [] }),
    item(4, { caption: 'メイク動画', hashtags: [] }),
  ];
  it('finds text inside a run of CJK, including 2-character words and emoji (which full-text search cannot)', async () => {
    const { service } = await setup(lib);
    const ids = async (t: string) => (await service.search(req([chip(t)]))).results.map((r) => r.item.externalId);
    expect(await ids('レシピ')).toEqual(['id1']);
    expect(await ids('簡単')).toEqual(['id1']);
    expect(await ids('メイク')).toEqual(['id4']);
    expect(await ids('🍝')).toEqual(['id2']);
  });
  it('mixes ordinary and substring chips with AND / OR', async () => {
    const { service } = await setup(lib);
    expect((await service.search(req([chip('recipe', { expand: false }), chip('レシピ')]))).total).toBe(0);
    const any = await service.search(req([chip('recipe', { expand: false }), chip('レシピ')], { mode: 'any' }));
    expect(new Set(any.results.map((r) => r.item.externalId))).toEqual(new Set(['id1', 'id3']));
    expect(any.orderedBy).toBe('recently_saved'); // relevance is not available when a substring chip is involved
    const all = await service.search(req([chip('pasta', { expand: false }), chip('🍝')]));
    expect(all.results.map((r) => r.item.externalId)).toEqual(['id2']);
  });
  it('highlights the matched substring', async () => {
    const { service } = await setup(lib);
    const r = await service.search(req([chip('レシピ')]));
    expect(r.results[0]!.snippet.filter((s) => s.hit).map((s) => s.text)).toEqual(['レシピ']);
  });
  it('a LIKE wildcard typed by the user is literal', async () => {
    const { service } = await setup([item(1, { caption: '100%レシピ', hashtags: [] }), item(2, { caption: '簡単レシピ', hashtags: [] })]);
    expect((await service.search(req([chip('%レシピ')]))).results.map((r) => r.item.externalId)).toEqual(['id1']);
  });
});

describe('hostile input', () => {
  it('chip text never changes the query: it either searches for its words or is cleanly rejected; the data is untouched', async () => {
    const { service, adapter } = await setup([item(1, { caption: 'normal caption about food', hashtags: [] })]);
    const before = await adapter.stats();
    const outcomes: Record<string, string> = {};
    for (const h of ['" OR 1=1 --', 'a AND b', 'NEAR(a b)', 'x* y', 'col:val', '-neg', '(open', 'a"b', "'; DROP TABLE items; --", '^start', 'x OR NOT y', '%', '_', String.fromCharCode(92), 'food OR NOT', '" "', '***']) {
      try {
        const r = await service.search(req([chip(h, { expand: false })]));
        expect(Array.isArray(r.results), h).toBe(true);
        await service.chipInfo({ requestId: 'q', chips: [chip(h)] });
        outcomes[h] = 'searched';
      } catch (e) {
        expect(e, `${h} must be rejected with SearchInputError, not fail some other way`).toBeInstanceOf(SearchInputError);
        outcomes[h] = 'rejected';
      }
    }
    // punctuation-only chips are rejected; anything with words is searched as those words
    expect(outcomes['%']).toBe('rejected');
    expect(outcomes['***']).toBe('rejected');
    expect(outcomes["'; DROP TABLE items; --"]).toBe('searched');
    expect(await adapter.stats()).toEqual(before);
  });
  it('rejects bad requests with SearchInputError', async () => {
    const { service } = await setup([]);
    for (const bad of [req([chip('   ')]), req([chip('!!!')]), req([chip('x'.repeat(65))]), req(Array.from({ length: 21 }, (_, i) => chip(`w${i}`))), req([], { sort: 'chaos' as never }), req([], { limit: 0 }), req([], { mode: 'some' as never }), { requestId: '', chips: [] } as SearchRequest]) {
      await expect(service.search(bad), JSON.stringify(bad).slice(0, 60)).rejects.toThrow(SearchInputError);
    }
  });
  it('captions are returned as structured segments, never as markup', async () => {
    const evil = '<script>alert(1)</script> food <img src=x onerror=alert(2)>';
    const { service } = await setup([item(1, { caption: evil, hashtags: [] })]);
    const r = await service.search(req([chip('food', { expand: false })]));
    const segs = r.results[0]!.snippet;
    expect(segs.map((s) => s.text).join('')).toBe(evil);
    expect(segs.filter((s) => s.hit).map((s) => s.text)).toEqual(['food']);
  });
});

describe('suggested chips', () => {
  it('offers hashtags, collections and authors from the results, minus platform noise and chips already used', async () => {
    const items = Array.from({ length: 40 }, (_, i) => item(i + 1, { caption: `pasta night ${i}`, hashtags: i < 30 ? ['pasta', 'fyp', 'sauce'] : ['pasta', 'fyp'], authorHandle: i < 25 ? 'chefjo' : `other${i}` }));
    const { service } = await setup(items, { collections: [coll(1, 'Dinner Ideas')], memberships: Array.from({ length: 20 }, (_, i) => member(i + 1, 1)) });
    const r = await service.search(req([chip('pasta', { expand: false })], { limit: 10 }));
    const texts = r.suggestedChips.map((s) => `${s.source}:${s.text}`);
    expect(texts).toContain('hashtag:sauce');
    expect(texts).toContain('collection:Dinner Ideas');
    expect(texts).toContain('author:chefjo');
    expect(texts.join()).not.toContain('fyp'); // platform noise
    expect(texts).not.toContain('hashtag:pasta'); // already a chip
    expect(r.suggestedChips.find((s) => s.text === 'sauce')!.count).toBe(30);
    const p2 = await service.search(req([chip('pasta', { expand: false })], { limit: 10, cursor: r.nextCursor }));
    expect(p2.suggestedChips).toEqual([]); // only the first page carries suggestions
  });
});

describe('unavailable videos', () => {
  it('are still found (the UI marks them)', async () => {
    const { service, adapter } = await setup([item(1, { caption: 'food a', hashtags: [] }), item(2, { caption: 'food b', hashtags: [] })]);
    await adapter.reconcile({ platform: 'tiktok', seenExternalIds: ['id1'] });
    const r = await service.search(req([chip('food', { expand: false })]));
    expect(r.results.map((x) => [x.item.externalId, x.item.available]).sort()).toEqual([['id1', true], ['id2', false]]);
  });
});

describe('wide queries', () => {
  it('5 chips x up to 30 related terms each, in "any" mode, runs and returns', async () => {
    const { service } = await setup(stripLabels());
    const r = await service.search(req(['food', 'fitness', 'travel', 'makeup', 'gaming'].map((t) => chip(t)), { mode: 'any', limit: 50 }));
    expect(r.total).toBeGreaterThan(30);
    expect(r.results.length).toBe(Math.min(50, r.total));
    expect(Number.isFinite(r.tookMs)).toBe(true);
  });
});

describe('through the RPC layer', () => {
  async function rpcSetup(isSuperseded?: (id: string) => boolean) {
    const mem = await memoryAdapter();
    await mem.adapter.upsertBatch(batch({ items: [item(1, { caption: 'easy pasta dinner', hashtags: ['dinner'] }), item(2, { caption: 'gym day', hashtags: [] })], collections: [coll(1, 'Weeknight')], memberships: [member(1, 1)] }));
    const server = createRpcServer({ adapter: () => mem.adapter, storage: 'memory', isSuperseded });
    const client = createClient(async (r) => JSON.parse(JSON.stringify(await server(JSON.parse(JSON.stringify(r))))));
    return { ...mem, client };
  }

  it('search, getChipInfo and explainMatch work over JSON', async () => {
    const { client } = await rpcSetup();
    const c = chip('food');
    const res = await client.search({ requestId: 'x1', chips: [c] });
    expect(res.results.map((r) => r.item.externalId)).toEqual(['id1']);
    expect(res.results[0]!.item.collections).toMatchObject([{ name: 'Weeknight' }]);
    expect((await client.getChipInfo({ requestId: 'x1', chips: [c] })).chips[0]).toMatchObject({ count: 1 });
    expect((await client.explainMatch({ platform: 'tiktok', externalId: 'id1', chips: [c] })).matches[0]).toMatchObject({ via: 'related' });
  });

  it('bad input is BAD_REQUEST, not INTERNAL', async () => {
    const { client } = await rpcSetup();
    await expect(client.search({ requestId: 'x', chips: [chip('  ')] })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(client.explainMatch({ platform: 'tiktok', externalId: 'nope', chips: [] })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('a search replaced by a newer one is answered SUPERSEDED and never touches the database', async () => {
    let latest = 'new';
    const { client } = await rpcSetup((id) => id !== latest);
    const stale = client.search({ requestId: 'old', chips: [chip('food')] });
    await expect(stale).rejects.toBeInstanceOf(RpcCallError);
    await stale.catch((e) => expect(isSuperseded(e)).toBe(true));
    await expect(client.getChipInfo({ requestId: 'old', chips: [chip('food')] })).rejects.toMatchObject({ code: 'SUPERSEDED' });
    expect((await client.search({ requestId: 'new', chips: [chip('food')] })).total).toBe(1);
    latest = 'newer';
    await expect(client.search({ requestId: 'new', chips: [] })).rejects.toMatchObject({ code: 'SUPERSEDED' });
    // methods without a requestId are never superseded
    expect((await client.getStats()).items).toBe(2);
  });
});
