// Chips -> a SearchPlan (FTS5 expressions + ordering). Pure: no storage, no chrome.*.
//
// Design (docs/STORAGE_SPIKE.md §4-§5):
//   * a chip matches when ALL of its words appear (any order, any field): "own" words
//   * OR when any of its related terms appear (only if chip.expand)
//   * tier 1 = own words only (small expression, ranked first); tier 2 = `(full) NOT (direct)`, queried only to fill the page
//   * a multiword chip also tries the concatenated hashtag: "meal prep" -> #mealprep
//   * only tokens made of letters/digits are ever placed in an expression, and always inside double quotes,
//     so user text can never inject FTS5 syntax

import { MAX_CHIPS, SearchInputError, normalizeChips, tokenize, type NormalizedChip } from './chips';
import { MAX_RELATED_TERMS, type TermExpander } from './expander';
import type { SearchMode, SearchRequest, SearchSort } from './types';

/**
 * Related terms are shared across the whole query: the cost of a search grows with the size of its full-text expression
 * (about 120 OR'd terms took 60+ ms; docs/STORAGE_SPIKE.md §4), so a query may use at most this many related terms in
 * total. One or two chips keep the full 30 each; five chips get 12 each. Latency stays bounded by construction.
 */
export const TOTAL_RELATED_BUDGET = 60;
export const MIN_RELATED_PER_CHIP = 8;

/** How many related terms each expanding chip in this list may use. Shared by search and chipInfo so their counts agree. */
export function relatedCap(chips: readonly NormalizedChip[]): number {
  const expanding = chips.filter((c) => c.expand && c.tokens.length > 0).length;
  if (expanding <= 1) return MAX_RELATED_TERMS;
  return Math.max(MIN_RELATED_PER_CHIP, Math.min(MAX_RELATED_TERMS, Math.floor(TOTAL_RELATED_BUDGET / expanding)));
}

export const DEFAULT_LIMIT = 30;
export const MAX_LIMIT = 100;
/** Prefix matching (typing "fit" finds "fitness") only applies to words of at least this length: "a*" would match half the library. */
export const MIN_PREFIX_LENGTH = 3;

const SORTS: readonly SearchSort[] = ['relevance', 'recently_saved', 'newest', 'most_viewed'];
const MODES: readonly SearchMode[] = ['all', 'any'];
// r:<offset>:<total> (relevance pages) or k|d:<sort>:<value>:<id>:<total> (column-ordered pages); see storage/sqlite/search.ts
const CURSOR = /^(r:\d{1,6}:\d{1,6}|[kd]:[snv]:-?\d{1,16}:\d{1,16}:\d{1,6})$/;

export interface ChipPlan {
  chipId: string;
  /** Display text. */
  text: string;
  /** Matching identity. */
  key: string;
  expand: boolean;
  category?: string;
  /** Own words as an FTS5 expression; null for chips matched by substring. */
  own: string | null;
  /** One FTS5 sub-expression per related term. */
  related: string[];
  /** The same related terms as plain text (for transparency and highlighting). */
  relatedTerms: string[];
  /** Whole words matched by LIKE (CJK, emoji, symbols). Empty for ordinary chips. */
  substrings: string[];
  /** `(own OR related...)`; null for substring chips. */
  expr: string | null;
}

export interface SearchPlan {
  chips: ChipPlan[];
  mode: SearchMode;
  /** Resolved: 'relevance' only when there are chips. */
  sort: SearchSort;
  limit: number;
  cursor?: string;
  /** All FTS-matchable chips combined by `mode`; null if there are none. */
  fullExpr: string | null;
  /** Same, using own words only. */
  directExpr: string | null;
  hasRelated: boolean;
  hasSubstring: boolean;
}

/** `"food"*` for one word, `(("meal" AND "prep"*) OR "mealprep"*)` for several. */
export function ownExpr(tokens: readonly string[]): string {
  const last = tokens.length - 1;
  const parts = tokens.map((t, i) => (i === last && t.length >= MIN_PREFIX_LENGTH ? `"${t}"*` : `"${t}"`));
  if (parts.length === 1) return parts[0]!;
  // hashtags are one token (#mealprep); without this "meal prep" would never match them
  return `((${parts.join(' AND ')}) OR "${tokens.join('')}"*)`;
}

/** A related term: an exact (stemmed) word, or a phrase that also tries its concatenated form. */
export function termExpr(term: string): string | null {
  const t = tokenize(term);
  if (t.length === 0) return null;
  if (t.length === 1) return `"${t[0]}"`;
  return `("${t.join(' ')}" OR "${t.join('')}")`;
}

export function planChip(chip: NormalizedChip, expander: TermExpander, cap: number = MAX_RELATED_TERMS): ChipPlan {
  if (chip.tokens.length === 0) {
    // substring chip (CJK / emoji): no FTS expression, no related terms (the lexicon is English)
    return { chipId: chip.id, text: chip.text, key: chip.key, expand: chip.expand, own: null, related: [], relatedTerms: [], substrings: chip.substrings, expr: null };
  }
  const own = ownExpr(chip.tokens);
  const expansion = chip.expand ? expander.expand(chip.key) : { terms: [] as string[], category: undefined };
  const terms = expansion.terms.slice(0, cap);
  const category = expansion.category;
  const related: string[] = [];
  const relatedTerms: string[] = [];
  for (const t of terms) {
    const e = termExpr(t);
    if (e) { related.push(e); relatedTerms.push(t); }
  }
  return {
    chipId: chip.id,
    text: chip.text,
    key: chip.key,
    expand: chip.expand,
    category,
    own,
    related,
    relatedTerms,
    substrings: [],
    expr: `(${[own, ...related].join(' OR ')})`,
  };
}

const combine = (parts: string[], mode: SearchMode): string | null =>
  parts.length === 0 ? null : parts.join(mode === 'all' ? ' AND ' : ' OR ');

export function planSearch(req: Pick<SearchRequest, 'chips' | 'mode' | 'sort' | 'limit' | 'cursor'>, expander: TermExpander): SearchPlan {
  const normalized = normalizeChips(req.chips ?? []);
  const mode = req.mode ?? 'all';
  if (!MODES.includes(mode)) throw new SearchInputError(`unknown mode "${String(mode)}"`);
  const sort = req.sort ?? (normalized.length > 0 ? 'relevance' : 'recently_saved');
  if (!SORTS.includes(sort)) throw new SearchInputError(`unknown sort "${String(sort)}"`);
  const limit = req.limit === undefined ? DEFAULT_LIMIT : req.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new SearchInputError(`limit must be a whole number from 1 to ${MAX_LIMIT}`);
  if (req.cursor !== undefined && !(typeof req.cursor === 'string' && CURSOR.test(req.cursor))) throw new SearchInputError('malformed cursor');
  if (normalized.length > MAX_CHIPS) throw new SearchInputError(`too many chips (max ${MAX_CHIPS})`);

  const cap = relatedCap(normalized);
  const chips = normalized.map((c) => planChip(c, expander, cap));
  const fts = chips.filter((c) => c.expr !== null);
  return {
    chips,
    mode,
    // there is nothing to rank when there are no chips
    sort: chips.length === 0 && sort === 'relevance' ? 'recently_saved' : sort,
    limit,
    cursor: req.cursor,
    fullExpr: combine(fts.map((c) => c.expr!), mode),
    directExpr: combine(fts.map((c) => c.own!), mode),
    hasRelated: fts.some((c) => c.related.length > 0),
    hasSubstring: chips.some((c) => c.substrings.length > 0),
  };
}
