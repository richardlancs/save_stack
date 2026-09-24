// Chip normalization and validation. Pure: no chrome.*, no DOM, no storage.
//
// A chip is one free-form category the user typed ("food", "meal prep", "メイク", "🍝"). This module decides what
// text is searchable, what counts as the same chip, and which chips FTS5 can't serve (see needsSubstring).

import type { Chip } from './types';

export const MAX_CHIP_LENGTH = 64;
export const MAX_CHIPS = 20;

/** Thrown for input the caller must fix. The RPC layer maps it to BAD_REQUEST. */
export class SearchInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SearchInputError';
  }
}

const WORD = /[\p{L}\p{N}]+/gu;
// Scripts written without spaces between words, plus emoji/symbols. FTS5's unicode61 tokenizer treats a run of CJK
// characters as ONE token (so "レシピ" never matches inside "簡単レシピ") and indexes emoji to nothing (M0 finding),
// so chips containing these are matched by substring instead.
const NEEDS_SUBSTRING = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Extended_Pictographic}]/u;

/** Lower-case NFKC words (letters and digits only). These are the only strings that ever reach an FTS5 expression. */
export function tokenize(text: string): string[] {
  return text.normalize('NFKC').toLowerCase().match(WORD) ?? [];
}

/** Display form: NFKC, collapsed whitespace, no leading '#' or '@' (v1 treats them as plain text). */
export function cleanChipText(raw: string): string {
  return String(raw ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().replace(/^[#@]+/, '').trim();
}

/** Identity for de-duplication and lookups: "Meal  Prep" and "meal prep" are the same chip. */
export function chipKey(text: string): string {
  const tokens = tokenize(text);
  return tokens.length > 0 ? tokens.join(' ') : cleanChipText(text).toLowerCase();
}

export function needsSubstring(text: string): boolean {
  return NEEDS_SUBSTRING.test(text.normalize('NFKC'));
}

export type ChipRejection = 'empty' | 'too_long' | 'no_searchable_text';

export function validateChipText(raw: string): { ok: true; text: string } | { ok: false; reason: ChipRejection } {
  const text = cleanChipText(raw);
  if (text.length === 0) return { ok: false, reason: 'empty' };
  if (text.length > MAX_CHIP_LENGTH) return { ok: false, reason: 'too_long' };
  if (tokenize(text).length === 0 && !needsSubstring(text)) return { ok: false, reason: 'no_searchable_text' };
  return { ok: true, text };
}

/** Pasted text like "food, makeup\nhair" becomes several chips. Empty pieces are dropped. */
export function splitPasted(raw: string): string[] {
  return String(raw ?? '')
    .split(/[,\n\r;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export interface NormalizedChip {
  id: string;
  /** Display text. */
  text: string;
  /** Matching identity. */
  key: string;
  expand: boolean;
  /** Words for FTS5 (empty when the chip is matched by substring). */
  tokens: string[];
  /** Whole words to match by LIKE (CJK / emoji / symbols); empty for ordinary chips. */
  substrings: string[];
}

const REASONS: Record<ChipRejection, string> = {
  empty: 'a chip is empty',
  too_long: `a chip is longer than ${MAX_CHIP_LENGTH} characters`,
  no_searchable_text: 'a chip has no letters, numbers or emoji to search for',
};

export function normalizeChip(chip: Chip): NormalizedChip {
  if (chip === null || typeof chip !== 'object') throw new SearchInputError('a chip must be an object');
  if (typeof chip.id !== 'string' || typeof chip.text !== 'string') throw new SearchInputError('a chip needs a string id and text');
  if (chip.kind !== undefined && chip.kind !== 'text') throw new SearchInputError(`unsupported chip kind "${String(chip.kind)}" (v1 supports text only)`);
  const v = validateChipText(chip.text);
  if (!v.ok) throw new SearchInputError(REASONS[v.reason]);
  const substring = needsSubstring(v.text);
  return {
    id: chip.id,
    text: v.text,
    key: chipKey(v.text),
    expand: chip.expand !== false,
    tokens: substring ? [] : tokenize(v.text),
    substrings: substring ? v.text.toLowerCase().split(' ').filter(Boolean) : [],
  };
}

/** Normalize a chip list: enforce the cap, and drop duplicates (same matching identity and expand setting), keeping the first. */
export function normalizeChips(chips: readonly Chip[]): NormalizedChip[] {
  if (!Array.isArray(chips)) throw new SearchInputError('chips must be an array');
  if (chips.length > MAX_CHIPS * 2) throw new SearchInputError(`too many chips (max ${MAX_CHIPS})`);
  const seen = new Set<string>();
  const out: NormalizedChip[] = [];
  for (const chip of chips) {
    const n = normalizeChip(chip);
    const id = `${n.key}\u0000${n.expand}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(n);
  }
  if (out.length > MAX_CHIPS) throw new SearchInputError(`too many chips (max ${MAX_CHIPS})`);
  return out;
}
