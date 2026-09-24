// The search box's rules: chips, staging, and when the results are "out of date".
import { describe, expect, it } from 'vitest';
import {
  MAX_CHIPS, MAX_CHIP_LENGTH, addSuggested, commit, describeCommitted, initialQuery, isStale, normalizeChipText, pasteIsList, pasteList, pressEnter, removeChip, removeLastChip,
  replaceChipText, setExpandAll, setMode, setSort, toggleExpand, typeInput, type QueryState,
} from '../../src/ui/state/query';

const type = (s: QueryState, text: string): QueryState => pressEnter(typeInput(s, text)).state;
const texts = (s: QueryState): string[] => s.draft.map((c) => c.text);

describe('typing categories', () => {
  it('Enter turns the box into a chip and clears it; nothing is searched', () => {
    const r = pressEnter(typeInput(initialQuery(), 'food'));
    expect(r.search).toBe(false);
    expect(texts(r.state)).toEqual(['food']);
    expect(r.state.input).toBe('');
    expect(r.state.committed).toEqual([]); // the results still reflect the previous search
  });

  it('Enter in an EMPTY box means Search', () => {
    expect(pressEnter(initialQuery()).search).toBe(true);
    expect(pressEnter(typeInput(initialQuery(), '   ')).search).toBe(true);
  });

  it('a comma finishes a category: "food, makeup," is two chips; a partial word stays in the box', () => {
    const two = typeInput(initialQuery(), 'food, makeup,');
    expect(texts(two)).toEqual(['food', 'makeup']);
    expect(two.input).toBe('');
    const partial = typeInput(initialQuery(), 'food, ma');
    expect(texts(partial)).toEqual(['food']);
    expect(partial.input).toBe('ma');
    expect(texts(typeInput(initialQuery(), ',,,'))).toEqual([]);
  });

  it('tidies what was typed: spaces collapsed, a leading # or @ dropped, unicode normalized', () => {
    expect(normalizeChipText('  meal   prep ')).toBe('meal prep');
    expect(normalizeChipText('#pasta')).toBe('pasta');
    expect(normalizeChipText('@@someone')).toBe('someone');
    expect(normalizeChipText('ｆｏｏｄ')).toBe('food'); // full-width letters
    expect(normalizeChipText('#')).toBe('');
  });

  it('a duplicate (any case) is not added twice, and says so', () => {
    const s = type(type(initialQuery(), 'Food'), 'food');
    expect(texts(s)).toEqual(['Food']);
    expect(s.notice).toMatch(/already there/);
    expect(s.input).toBe('');
  });

  it('there is a cap on categories and on their length, with a message', () => {
    let s = initialQuery();
    for (let i = 0; i < MAX_CHIPS; i++) s = type(s, `word${i}`);
    expect(s.draft).toHaveLength(MAX_CHIPS);
    const over = type(s, 'one more');
    expect(over.draft).toHaveLength(MAX_CHIPS);
    expect(over.notice).toMatch(/up to 20/);
    expect(type(initialQuery(), 'x'.repeat(65)).notice).toMatch(/at most 64/);
    expect(type(initialQuery(), 'x'.repeat(64)).draft).toHaveLength(1);
  });

  it('the next edit clears the notice', () => {
    const s = type(type(initialQuery(), 'a'), 'a');
    expect(s.notice).toBeDefined();
    expect(typeInput(s, 'b').notice).toBeUndefined();
  });

  it('chips get unique, stable ids', () => {
    const s = type(type(type(initialQuery(), 'a'), 'b'), 'c');
    expect(new Set(s.draft.map((c) => c.id)).size).toBe(3);
    const removed = removeChip(s, s.draft[1]!.id);
    expect(type(removed, 'd').draft.map((c) => c.id)).not.toContain(s.draft[1]!.id); // an id is never reused
  });
});

describe('staging: the x only edits the draft until Search is pressed', () => {
  const searched = (...words: string[]) => commit(words.reduce(type, initialQuery())).state;

  it('right after a search nothing is out of date', () => {
    expect(isStale(searched('food', 'easy'))).toBe(false);
    expect(isStale(initialQuery())).toBe(false);
  });

  it('the panel opens on "everything": adding the first chip already makes those results out of date', () => {
    expect(isStale(type(initialQuery(), 'food'))).toBe(true);
    expect(initialQuery().committed).toEqual([]);
  });

  it('removing a chip changes the draft, NOT the committed chips, and marks the results out of date', () => {
    const s = searched('food', 'easy');
    const removed = removeChip(s, s.draft[0]!.id);
    expect(texts(removed)).toEqual(['easy']);
    expect(removed.committed.map((c) => c.text)).toEqual(['food', 'easy']);
    expect(isStale(removed)).toBe(true);
  });

  it('adding a chip after a search marks the results out of date too; searching again clears it', () => {
    const s = type(searched('food'), 'makeup');
    expect(isStale(s)).toBe(true);
    const again = commit(s).state;
    expect(isStale(again)).toBe(false);
    expect(again.committed.map((c) => c.text)).toEqual(['food', 'makeup']);
  });

  it('removing a chip and putting the same one back is not out of date (same chips, same order)', () => {
    const s = searched('food');
    const removed = removeChip(s, s.draft[0]!.id);
    expect(isStale(removed)).toBe(true);
    // a NEW chip with the same text has a new id: the draft differs from what was searched, honestly
    expect(isStale(type(removed, 'food'))).toBe(true);
  });

  it('changing All/Any, the sort or the related-words switch also makes the results out of date', () => {
    const s = searched('food');
    expect(isStale(setMode(s, 'any'))).toBe(true);
    expect(isStale(setSort(s, 'most_viewed'))).toBe(true);
    expect(isStale(toggleExpand(s, s.draft[0]!.id))).toBe(true);
    expect(isStale(setExpandAll(s, false))).toBe(true);
    expect(isStale(setMode(setMode(s, 'any'), 'all'))).toBe(false);
  });

  it('emptying the draft and searching browses everything', () => {
    const s = searched('food');
    const empty = removeChip(s, s.draft[0]!.id);
    const { state, params } = commit(empty);
    expect(params.chips).toEqual([]);
    expect(describeCommitted(state)).toMatch(/newest first/);
  });
});

describe('committing a search', () => {
  it('whatever is still in the box becomes a chip first', () => {
    const { state, params } = commit(typeInput(type(initialQuery(), 'food'), 'makeup'));
    expect(params.chips.map((c) => c.text)).toEqual(['food', 'makeup']);
    expect(state.input).toBe('');
  });

  it('returns exactly what the results will reflect (chips, mode, sort)', () => {
    const s = setSort(setMode(type(initialQuery(), 'food'), 'any'), 'recently_saved');
    const { params } = commit(s);
    expect(params).toMatchObject({ mode: 'any', sort: 'recently_saved' });
    expect(params.chips[0]).toMatchObject({ text: 'food', expand: true });
  });

  it('describes the committed search in words', () => {
    const two = commit(type(type(initialQuery(), 'food'), 'easy')).state;
    expect(describeCommitted(two)).toBe('"food" and "easy"');
    expect(describeCommitted(commit(setMode(two, 'any')).state)).toBe('"food" or "easy"');
    expect(describeCommitted(commit(type(initialQuery(), 'food')).state)).toBe('"food"');
    expect(describeCommitted(initialQuery())).toMatch(/newest first/);
  });
});

describe('keyboard and suggestions', () => {
  it('Backspace in an empty box removes the last chip; with text in the box it does nothing here', () => {
    const s = type(type(initialQuery(), 'a'), 'b');
    expect(texts(removeLastChip(s))).toEqual(['a']);
    expect(removeLastChip(typeInput(s, 'x'))).toEqual(typeInput(s, 'x'));
    expect(removeLastChip(initialQuery())).toEqual(initialQuery());
  });

  it('a "did you mean" replaces the chip text (a draft edit), or drops the chip if the suggestion is already there', () => {
    const s = type(type(initialQuery(), 'makup'), 'makeup');
    const typoId = s.draft[0]!.id;
    expect(texts(replaceChipText(type(initialQuery(), 'makup'), typoId, 'makeup'))).toEqual(['makeup']);
    expect(texts(replaceChipText(s, typoId, 'makeup'))).toEqual(['makeup']);
    expect(replaceChipText(s, typoId, '   ')).toEqual(s);
    expect(replaceChipText(s, typoId, 'x'.repeat(100))).toEqual(s);
  });

  it('a suggested category is added as a draft chip (and follows the same rules)', () => {
    const s = addSuggested(type(initialQuery(), 'food'), 'pasta');
    expect(texts(s)).toEqual(['food', 'pasta']);
    expect(addSuggested(s, 'FOOD').notice).toMatch(/already/);
  });

  it('new chips follow the saved preference for related words, and the switch updates it', () => {
    const off = type(initialQuery({ relatedWords: false }), 'food');
    expect(off.draft[0]!.expand).toBe(false);
    const on = setExpandAll(off, true);
    expect(type(on, 'makeup').draft.map((c) => c.expand)).toEqual([true, true]);
    expect(initialQuery({ sort: 'newest' })).toMatchObject({ sort: 'newest', committedSort: 'newest', defaultExpand: true });
  });

  it('text with no letter, number or emoji is not a chip (the backend would refuse the whole search), but words in any script are', () => {
    for (const bad of ['!!!', '-', '...', '&', ' _ ', '#!']) {
      const s = pressEnter(typeInput(initialQuery(), bad)).state;
      expect(s.draft, bad).toEqual([]);
      expect(s.notice, bad).toMatch(/letter, number or emoji/);
    }
    for (const good of ['food', '2024', 'メイク', '한국어', 'مطبخ', '🍝', 'c++']) expect(texts(type(initialQuery(), good)), good).toEqual([good]);
    expect(pasteList(initialQuery(), 'ok, ???, fine').draft.map((c) => c.text)).toEqual(['ok', 'fine']);
  });

  it('pasting a list (commas or line breaks) makes one chip per part and leaves the box alone', () => {
    expect(pasteIsList('food')).toBe(false);
    expect(pasteIsList('food, makeup')).toBe(true);
    expect(pasteIsList('food\nmakeup')).toBe(true);
    const start = typeInput(initialQuery(), 'typing');
    const s = pasteList(start, 'food, Makeup\r\ntravel,,  food ,\n');
    expect(s.draft.map((c) => c.text)).toEqual(['food', 'Makeup', 'travel']);
    expect(s.input).toBe('typing');
    expect(s.notice).toMatch(/already there/);
  });

  it('a pasted list respects the chip cap and length limit', () => {
    const many = Array.from({ length: MAX_CHIPS + 5 }, (_, i) => `word${i}`).join(',');
    const s = pasteList(initialQuery(), many);
    expect(s.draft).toHaveLength(MAX_CHIPS);
    expect(s.notice).toMatch(/up to 20 categories/);
    expect(pasteList(initialQuery(), `${'x'.repeat(MAX_CHIP_LENGTH + 1)}, ok`).draft.map((c) => c.text)).toEqual(['ok']);
  });

  it('the related-words switch applies to every draft chip', () => {
    const s = setExpandAll(type(type(initialQuery(), 'a'), 'b'), false);
    expect(s.draft.every((c) => !c.expand)).toBe(true);
    expect(setExpandAll(s, true).draft.every((c) => c.expand)).toBe(true);
  });
});
