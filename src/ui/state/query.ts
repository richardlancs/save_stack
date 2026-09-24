// The search box's state: what the user is typing, the categories ("chips") they have built, and what the last search used.
//
// The interaction (accepted decision):
//   * typing a category and pressing Enter (or typing a comma) turns it into a chip under the search bar;
//   * chips can be added freely; the Search button (or Enter in an EMPTY box) runs the search over the chips;
//   * removing a chip with its x only edits the DRAFT: the results do not change until Search is pressed, and the UI says so;
//   * no chips = browse everything, newest saved first.
//
// Pure functions over plain data: nothing here touches the DOM, chrome.* or the network.

import type { Chip, SearchMode, SearchSort } from '../../core/search/types';

export const MAX_CHIPS = 20;
export const MAX_CHIP_LENGTH = 64;

export interface QueryChip extends Chip {
  expand: boolean;
}

export interface QueryState {
  /** The text currently in the box. */
  input: string;
  /** The chips being built (shown under the search bar). */
  draft: QueryChip[];
  /** The chips of the last search: what the results on screen reflect. */
  committed: QueryChip[];
  mode: SearchMode;
  sort: SearchSort;
  committedMode: SearchMode;
  committedSort: SearchSort;
  /** New categories start with related words on or off (a saved preference). */
  defaultExpand: boolean;
  /** True when the results on screen came from a search (the panel opens by browsing everything, which counts). */
  searched: boolean;
  /** A short message about the last input (e.g. "You can use up to 20 categories"). Cleared by the next edit. */
  notice?: string;
  nextId: number;
}

export interface SearchParams {
  chips: QueryChip[];
  mode: SearchMode;
  sort: SearchSort;
}

export function initialQuery(prefs: { relatedWords?: boolean; sort?: SearchSort } = {}): QueryState {
  const sort = prefs.sort ?? 'relevance';
  // opens on "everything, newest first"
  return { input: '', draft: [], committed: [], mode: 'all', sort, committedMode: 'all', committedSort: sort, defaultExpand: prefs.relatedWords ?? true, searched: true, nextId: 1 };
}

/** What is stored for a category: trimmed, inner whitespace collapsed, a leading # or @ dropped (the search core ignores them anyway). */
export function normalizeChipText(raw: string): string {
  return raw.normalize('NFKC').replace(/\s+/g, ' ').trim().replace(/^[#@]+/, '').trim();
}

const key = (text: string): string => text.toLowerCase();

/** The backend refuses a category with no letter, digit or emoji in it ("!!!", "-"): say so here instead of failing the whole search later. */
const searchable = (text: string): boolean => /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(text);

function addChip(s: QueryState, raw: string): QueryState {
  const text = normalizeChipText(raw);
  if (text === '') return s;
  if (text.length > MAX_CHIP_LENGTH) return { ...s, notice: `A category can be at most ${MAX_CHIP_LENGTH} characters.` };
  if (!searchable(text)) return { ...s, notice: 'A category needs at least one letter, number or emoji.' };
  if (s.draft.some((c) => key(c.text) === key(text))) return { ...s, input: '', notice: `"${text}" is already there.` };
  if (s.draft.length >= MAX_CHIPS) return { ...s, notice: `You can use up to ${MAX_CHIPS} categories.` };
  const chip: QueryChip = { id: `c${s.nextId}`, text, expand: s.defaultExpand };
  const { notice: _dropped, ...rest } = s;
  return { ...rest, input: '', draft: [...s.draft, chip], nextId: s.nextId + 1 };
}

/** The box changed. A comma finishes a category: "food, makeup," becomes two chips. */
export function typeInput(s: QueryState, value: string): QueryState {
  const base: QueryState = { ...s, input: value };
  delete base.notice;
  if (!value.includes(',')) return base;
  const parts = value.split(',');
  const rest = parts.pop() ?? '';
  let next: QueryState = { ...base, input: '' };
  for (const p of parts) next = addChip(next, p);
  return { ...next, input: rest.trimStart() }; // "food, ma": the box keeps "ma", not " ma"
}

/** Pasted text with a comma or a line break in it is a list: every part becomes a chip. Anything else is left to the box as usual. */
export const pasteIsList = (text: string): boolean => /[,\n\r]/.test(text);

/** Paste a list: one chip per part (blank parts and duplicates are skipped, the notice says why); whatever was typed in the box stays. */
export function pasteList(s: QueryState, text: string): QueryState {
  let next: QueryState = { ...s };
  delete next.notice;
  for (const part of text.split(/[,\n\r]+/)) next = addChip(next, part);
  return { ...next, input: s.input };
}

/** Enter in the box: a non-empty box becomes a chip; an empty box means "Search". */
export function pressEnter(s: QueryState): { state: QueryState; search: boolean } {
  if (normalizeChipText(s.input) === '') return { state: s, search: true };
  return { state: addChip(s, s.input), search: false };
}

/** The chip's x. Only the draft changes: the results stay as they were until the next search. */
export function removeChip(s: QueryState, id: string): QueryState {
  const { notice: _dropped, ...rest } = s;
  return { ...rest, draft: s.draft.filter((c) => c.id !== id) };
}

/** Backspace in an empty box removes the last chip (keyboard convenience). */
export function removeLastChip(s: QueryState): QueryState {
  return s.input === '' && s.draft.length > 0 ? removeChip(s, s.draft[s.draft.length - 1]!.id) : s;
}

export function toggleExpand(s: QueryState, id: string): QueryState {
  return { ...s, draft: s.draft.map((c) => (c.id === id ? { ...c, expand: !c.expand } : c)) };
}

export const setMode = (s: QueryState, mode: SearchMode): QueryState => ({ ...s, mode });
export const setSort = (s: QueryState, sort: SearchSort): QueryState => ({ ...s, sort });

/** Press Search: whatever is in the box becomes a chip first, then the draft is what the next results reflect. */
export function commit(s: QueryState): { state: QueryState; params: SearchParams } {
  const withInput = normalizeChipText(s.input) === '' ? s : addChip(s, s.input);
  const state: QueryState = { ...withInput, committed: withInput.draft, committedMode: withInput.mode, committedSort: withInput.sort, searched: true };
  return { state, params: { chips: state.committed, mode: state.committedMode, sort: state.committedSort } };
}

const sameChips = (a: readonly QueryChip[], b: readonly QueryChip[]): boolean =>
  a.length === b.length && a.every((c, i) => c.id === b[i]!.id && c.text === b[i]!.text && c.expand === b[i]!.expand);

/** The draft differs from what the results on screen reflect: show "Filters changed, press Search". */
export function isStale(s: QueryState): boolean {
  return s.searched && (!sameChips(s.draft, s.committed) || s.mode !== s.committedMode || s.sort !== s.committedSort);
}

/** Replace a chip's text (used by "did you mean ...?"): stays a draft edit until Search is pressed. */
export function replaceChipText(s: QueryState, id: string, text: string): QueryState {
  const clean = normalizeChipText(text);
  if (clean === '' || clean.length > MAX_CHIP_LENGTH) return s;
  if (s.draft.some((c) => c.id !== id && key(c.text) === key(clean))) return removeChip(s, id); // the suggestion is already a chip
  return { ...s, draft: s.draft.map((c) => (c.id === id ? { ...c, text: clean } : c)) };
}

/** Add a suggested category as a chip (from the suggestions under the results). */
export function addSuggested(s: QueryState, text: string): QueryState {
  return addChip({ ...s }, text);
}

/** A few words for the screen: what the committed search was. */
export function describeCommitted(s: QueryState): string {
  if (s.committed.length === 0) return 'Everything you saved, newest first';
  const words = s.committed.map((c) => `"${c.text}"`);
  return s.committed.length === 1 ? words[0]! : words.join(s.committedMode === 'all' ? ' and ' : ' or ');
}

/** The "Include related words" switch: applies to every chip in the draft (and to chips added later, which start on). */
export function setExpandAll(s: QueryState, on: boolean): QueryState {
  return { ...s, defaultExpand: on, draft: s.draft.map((c) => ({ ...c, expand: on })) };
}
