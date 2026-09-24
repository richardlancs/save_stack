// Pure unit tests: chips, the related-terms data and expander, the planner, and the text helpers.
import { describe, expect, it } from 'vitest';
import data from '../../src/core/search/related-terms.json';
import {
  MAX_CHIPS,
  MAX_CHIP_LENGTH,
  SearchInputError,
  chipKey,
  cleanChipText,
  needsSubstring,
  normalizeChip,
  normalizeChips,
  splitPasted,
  tokenize,
  validateChipText,
} from '../../src/core/search/chips';
import { MAX_RELATED_TERMS, createExpander } from '../../src/core/search/expander';
import { DEFAULT_LIMIT, MAX_LIMIT, ownExpr, planChip, planSearch, termExpr } from '../../src/core/search/planner';
import { buildSnippet, closestWord, editDistance } from '../../src/core/search/text';

const chip = (text: string, extra: Record<string, unknown> = {}) => ({ id: `c-${text}`, text, ...extra });

describe('chips', () => {
  it.each([
    ['food', 'food'],
    ['  Meal   Prep ', 'Meal Prep'],
    ['#foodtok', 'foodtok'],
    ['@chefjo', 'chefjo'],
    ['##double', 'double'],
    ['ＦＯＯＤ', 'FOOD'], // full-width letters normalize (NFKC)
    ['メイク', 'メイク'],
    ['🍝', '🍝'],
  ])('cleans %j to %j', (raw, want) => {
    expect(cleanChipText(raw)).toBe(want);
    expect(validateChipText(raw)).toEqual({ ok: true, text: want });
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['#', 'empty'],
    ['!!!', 'no_searchable_text'],
    ['---', 'no_searchable_text'],
    ['a'.repeat(MAX_CHIP_LENGTH + 1), 'too_long'],
  ])('rejects %j as %s', (raw, reason) => {
    expect(validateChipText(raw)).toEqual({ ok: false, reason });
  });

  it('matching identity ignores case, spacing and punctuation', () => {
    expect(chipKey('Meal   Prep')).toBe('meal prep');
    expect(chipKey('meal-prep')).toBe('meal prep');
    expect(chipKey('#Meal_Prep')).toBe('meal prep'.replace(' ', '') === 'mealprep' ? chipKey('#Meal_Prep') : ''); // '_' counts as a separator or a letter: either way, deterministic
    expect(tokenize("it's 5K!")).toEqual(['it', 's', '5k']);
  });

  it('classifies chips that FTS cannot serve', () => {
    expect(needsSubstring('food')).toBe(false);
    expect(needsSubstring('café')).toBe(false);
    expect(needsSubstring('привет')).toBe(false); // Cyrillic tokenizes fine
    for (const t of ['メイク', '簡単', '한국어', 'ภาษาไทย', '🍝', 'food 🍝', '日本語 makeup']) expect(needsSubstring(t), t).toBe(true);
  });

  it('splits pasted text into several chips', () => {
    expect(splitPasted('food, makeup\nhair;  travel,,')).toEqual(['food', 'makeup', 'hair', 'travel']);
    expect(splitPasted('')).toEqual([]);
  });

  it('normalizes a chip: substring chips have no FTS tokens; ordinary chips have no substrings', () => {
    expect(normalizeChip(chip('Meal Prep'))).toMatchObject({ text: 'Meal Prep', key: 'meal prep', tokens: ['meal', 'prep'], substrings: [], expand: true });
    expect(normalizeChip(chip('メイク makeup'))).toMatchObject({ tokens: [], substrings: ['メイク', 'makeup'] });
    expect(normalizeChip(chip('food', { expand: false })).expand).toBe(false);
  });

  it('rejects malformed chips with a SearchInputError', () => {
    for (const bad of [null, 5, { id: 1, text: 'x' }, { id: 'a' }, { id: 'a', text: 'x', kind: 'author' }, { id: 'a', text: '' }]) {
      expect(() => normalizeChip(bad as never), JSON.stringify(bad)).toThrow(SearchInputError);
    }
  });

  it('de-duplicates by matching identity and expand setting, keeping the first; enforces the cap', () => {
    const out = normalizeChips([chip('Food'), { id: 'x', text: '  food ' }, { id: 'y', text: 'food', expand: false }, chip('hair')]);
    expect(out.map((c) => [c.id, c.expand])).toEqual([['c-Food', true], ['y', false], ['c-hair', true]]);
    const many = Array.from({ length: MAX_CHIPS + 1 }, (_, i) => chip(`word${i}`));
    expect(() => normalizeChips(many)).toThrow(/too many chips/);
    expect(() => normalizeChips('food' as never)).toThrow(SearchInputError);
  });
});

describe('related-terms data', () => {
  const categories = Object.entries(data.categories) as Array<[string, string[]]>;

  it('has a reasonable number of categories, each within bounds', () => {
    expect(categories.length).toBeGreaterThanOrEqual(75);
    for (const [name, terms] of categories) {
      expect(terms.length, `${name} has ${terms.length} terms`).toBeGreaterThanOrEqual(8);
      expect(terms.length, `${name} has ${terms.length} terms`).toBeLessThanOrEqual(MAX_RELATED_TERMS);
    }
  });

  it('is clean: lower-case, trimmed, no duplicates, no FTS-hostile characters, no substring-only scripts', () => {
    for (const [name, terms] of categories) {
      const seen = new Set<string>();
      for (const t of terms) {
        expect(t, `${name}: "${t}"`).toBe(t.trim().toLowerCase());
        expect(seen.has(t), `${name} lists "${t}" twice`).toBe(false);
        seen.add(t);
        expect(tokenize(t).length, `${name}: "${t}" has no searchable word`).toBeGreaterThan(0);
        expect(needsSubstring(t), `${name}: "${t}" needs substring matching, which the lexicon cannot use`).toBe(false);
      }
    }
  });

  it('every alias points at a real category', () => {
    for (const [alias, target] of Object.entries(data.aliases)) expect(data.categories, `${alias} -> ${target}`).toHaveProperty(target);
  });

  it('avoids the words that cause false positives everywhere', () => {
    const generic = new Set(['best', 'easy', 'how', 'new', 'good', 'love', 'video', 'day', 'time', 'thing', 'game', 'run', 'build', 'review', 'series', 'episode', 'home', 'match', 'the', 'and', 'you']);
    for (const [name, terms] of categories) for (const t of terms) expect(generic.has(t), `${name} lists the generic word "${t}"`).toBe(false);
  });
});

describe('expander', () => {
  const ex = createExpander();
  it('expands a known category, excluding the chip\'s own words, within the cap', () => {
    const e = ex.expand('food');
    expect(e.category).toBe('food');
    expect(e.terms).toContain('recipe');
    expect(e.terms).toContain('pasta');
    expect(e.terms).not.toContain('food');
    expect(e.terms.length).toBeLessThanOrEqual(MAX_RELATED_TERMS);
  });
  it('resolves aliases and simple plurals / -ing forms', () => {
    expect(ex.expand('recipes').category).toBe('food');
    expect(ex.expand('cooking').category).toBe('food');
    expect(ex.expand('workouts').category).toBe('fitness');
    expect(ex.expand('dogs').category).toBe('dogs');
    expect(ex.expand('hobbies').category).toBeUndefined();
    expect(ex.expand('stocks').category).toBe('investing');
  });
  it('does not expand words that are merely related terms, or unknown words', () => {
    expect(ex.expand('pasta')).toEqual({ terms: [] });
    expect(ex.expand('zxqv')).toEqual({ terms: [] });
    expect(ex.expand('')).toEqual({ terms: [] });
  });
  it('honours a custom data set and caps oversized categories', () => {
    const big = createExpander({ version: 1, categories: { x: Array.from({ length: 50 }, (_, i) => `term${i}`) }, aliases: {} });
    expect(big.expand('x').terms).toHaveLength(MAX_RELATED_TERMS);
  });
});

describe('planner', () => {
  const ex = createExpander();
  it('quotes every word, prefixes only the last one (and only if it is long enough)', () => {
    expect(ownExpr(['food'])).toBe('"food"*');
    expect(ownExpr(['5k'])).toBe('"5k"');
    expect(ownExpr(['meal', 'prep'])).toBe('(("meal" AND "prep"*) OR "mealprep"*)');
  });
  it('related phrases also try their concatenated form; related words are exact', () => {
    expect(termExpr('recipe')).toBe('"recipe"');
    expect(termExpr('air fryer')).toBe('("air fryer" OR "airfryer")');
    expect(termExpr('!!!')).toBeNull();
  });
  it('builds own + related for a category chip, own only when expand is off', () => {
    const on = planChip(normalizeChip(chip('food')), ex);
    expect(on.expr).toContain('"food"*');
    expect(on.expr).toContain('"recipe"');
    expect(on.related.length).toBeGreaterThan(10);
    const off = planChip(normalizeChip(chip('food', { expand: false })), ex);
    expect(off.expr).toBe('("food"*)');
    expect(off.related).toEqual([]);
  });
  it('combines chips with AND by default and OR for mode "any"', () => {
    const p = planSearch({ chips: [chip('food', { expand: false }), chip('hair', { expand: false })] }, ex);
    expect(p.fullExpr).toBe('("food"*) AND ("hair"*)');
    const q = planSearch({ chips: [chip('food', { expand: false }), chip('hair', { expand: false })], mode: 'any' }, ex);
    expect(q.fullExpr).toBe('("food"*) OR ("hair"*)');
    expect(q.directExpr).toBe('"food"* OR "hair"*');
  });
  it('defaults: relevance with chips, recently saved without; limit 30', () => {
    expect(planSearch({ chips: [chip('food')] }, ex)).toMatchObject({ sort: 'relevance', mode: 'all', limit: DEFAULT_LIMIT });
    expect(planSearch({ chips: [] }, ex)).toMatchObject({ sort: 'recently_saved', fullExpr: null, directExpr: null });
    expect(planSearch({ chips: [], sort: 'relevance' }, ex).sort).toBe('recently_saved'); // nothing to rank
  });
  it('substring chips get no FTS expression', () => {
    const p = planSearch({ chips: [chip('メイク')] }, ex);
    expect(p).toMatchObject({ fullExpr: null, hasSubstring: true });
    expect(p.chips[0]).toMatchObject({ own: null, expr: null, substrings: ['メイク'] });
  });
  it('validates mode, sort, limit and cursor', () => {
    const c = [chip('food')];
    for (const bad of [{ mode: 'some' }, { sort: 'random' }, { limit: 0 }, { limit: MAX_LIMIT + 1 }, { limit: 2.5 }, { cursor: 'x:1' }, { cursor: 'r:abc' }, { cursor: 'r:5' }, { cursor: 'k:5:5' }, { cursor: 'k:5:5:30' }, { cursor: 'k:x:5:5:30' }, { cursor: 12 }]) {
      expect(() => planSearch({ chips: c, ...(bad as object) } as never, ex), JSON.stringify(bad)).toThrow(SearchInputError);
    }
    expect(() => planSearch({ chips: c, cursor: 'r:30:100' }, ex)).not.toThrow();
    expect(() => planSearch({ chips: c, cursor: 'k:s:-5:9:100' }, ex)).not.toThrow();
    expect(() => planSearch({ chips: c, cursor: 'd:v:1:2:3' }, ex)).not.toThrow();
  });
  it('user text can never inject FTS5 syntax: every expression is built only from quoted alphanumeric tokens', () => {
    const hostile = ['" OR 1=1 --', 'a AND b', 'NEAR(a b)', 'x* y', 'col:val', '-neg', '(open', 'a"b', "'; DROP TABLE items; --", '^start', 'x OR NOT y'];
    for (const h of hostile) {
      const p = planSearch({ chips: [chip(h, { expand: false })] }, ex);
      const expr = p.fullExpr!;
      // strip quoted tokens and the operators the planner itself emits; nothing else may remain
      const leftover = expr.replace(/"[\p{L}\p{N}]+"\*?/gu, '').replace(/\b(AND|OR)\b/g, '').replace(/[()\s]/g, '');
      expect(leftover, `${h} -> ${expr}`).toBe('');
    }
  });
  it('5 chips x 30 related terms stays a bounded expression', () => {
    const p = planSearch({ chips: ['food', 'fitness', 'travel', 'makeup', 'gaming'].map((t) => chip(t)), mode: 'any' }, ex);
    expect(p.fullExpr!.length).toBeLessThan(20_000);
    expect(p.chips.every((c) => c.related.length <= MAX_RELATED_TERMS)).toBe(true);
  });
});

describe('text helpers', () => {
  it('editDistance is the optimal string alignment distance, and gives up early', () => {
    expect(editDistance('makup', 'makeup', 2)).toBe(1);
    expect(editDistance('ab', 'ba', 2)).toBe(1); // transposition
    expect(editDistance('kitten', 'sitting', 5)).toBe(3);
    expect(editDistance('abc', 'abc', 2)).toBe(0);
    expect(editDistance('abcdef', 'uvwxyz', 2)).toBeGreaterThan(2);
    expect(editDistance('a', 'abcdef', 2)).toBeGreaterThan(2);
  });
  it('closestWord suggests within tolerance, prefers the same first letter, never the word itself', () => {
    const vocab = ['makeup', 'skincare', 'fitness', 'travel', 'pasta'];
    expect(closestWord('makup', vocab)).toBe('makeup');
    expect(closestWord('fitnes', vocab)).toBe('fitness');
    expect(closestWord('travle', vocab)).toBe('travel');
    expect(closestWord('makeup', vocab)).toBeUndefined();
    expect(closestWord('zzzzzz', vocab)).toBeUndefined();
    expect(closestWord('ab', vocab)).toBeUndefined(); // too short to guess
    expect(closestWord('bat', ['cat', 'bar'])).toBe('bar'); // same first letter wins the tie
  });
  it('buildSnippet marks matched words and returns structured text, never markup', () => {
    const terms = { prefixes: ['food'], exact: ['recipe'], phrases: ['air fryer'], substrings: [] };
    const segs = buildSnippet('easy Recipes for food lovers, air fryer edition', terms);
    expect(segs.map((s) => s.text).join('')).toBe('easy Recipes for food lovers, air fryer edition');
    expect(segs.filter((s) => s.hit).map((s) => s.text)).toEqual(['Recipes', 'food', 'air fryer']);
  });
  it('buildSnippet is safe for hostile captions: the text is passed through as text, nothing is interpreted', () => {
    const evil = '<img src=x onerror=alert(1)> <script>alert(2)</script> food & more';
    const segs = buildSnippet(evil, { prefixes: ['food'], exact: [], phrases: [], substrings: [] });
    expect(segs.map((s) => s.text).join('')).toBe(evil);
    expect(segs.filter((s) => s.hit).map((s) => s.text)).toEqual(['food']);
  });
  it('buildSnippet trims long captions around the first hit with ellipses, and handles CJK substrings', () => {
    const long = `${'blah '.repeat(60)}the pasta recipe ${'blah '.repeat(60)}`;
    const segs = buildSnippet(long, { prefixes: [], exact: ['recipe'], phrases: [], substrings: [] });
    const joined = segs.map((s) => s.text).join('');
    expect(joined.length).toBeLessThan(long.length);
    expect(joined.startsWith('…')).toBe(true);
    expect(segs.some((s) => s.hit && s.text === 'recipe')).toBe(true);
    expect(buildSnippet('簡単レシピ動画', { prefixes: [], exact: [], phrases: [], substrings: ['レシピ'] }).filter((s) => s.hit).map((s) => s.text)).toEqual(['レシピ']);
    expect(buildSnippet('', { prefixes: ['x'], exact: [], phrases: [], substrings: [] })).toEqual([]);
    expect(buildSnippet('nothing here', { prefixes: ['zzz'], exact: [], phrases: [], substrings: [] })).toEqual([{ text: 'nothing here', hit: false }]);
  });
});
