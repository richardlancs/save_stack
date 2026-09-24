// The SEARCH CONTRACT: types only, no logic (M2 implements it). This is the surface the UI developer builds against,
// so it is defined in M1 alongside the RPC skeleton. Design evidence: docs/STORAGE_SPIKE.md §4.
//
// Search is split so the first paint is fast (accepted decision, M0):
//   search()       -> results, capped total, suggested chips          (fast path)
//   getChipInfo()  -> per-chip counts, related terms, did-you-mean    (follow-up; fills in chip badges)
//   explainMatch() -> why one result matched                          (lazy; called for the row being expanded)

import type { StoredItem } from '../model';

/** One user-typed category ("food", "meal prep"). The UI owns the chip list; the core is stateless. */
export interface Chip {
  /** Stable id for UI keying and for correlating per-chip info. */
  id: string;
  text: string;
  /** Match related terms too ("food" also tries recipe, cooking, ...). Default true. */
  expand?: boolean;
  /** Reserved for typed chips later (author, hashtag, collection, date...). v1 is text only. */
  kind?: 'text';
}

/** 'all' = every chip must match (default). 'any' = any chip matches. */
export type SearchMode = 'all' | 'any';
export type SearchSort = 'relevance' | 'recently_saved' | 'newest' | 'most_viewed';

export interface SearchRequest {
  /** For cancellation: a newer request id supersedes older ones and stale results are never delivered. */
  requestId: string;
  /** Committed chips. Empty = browse everything, newest saved first. */
  chips: Chip[];
  mode?: SearchMode;
  sort?: SearchSort;
  limit?: number;
  cursor?: string;
}

/** Highlighted text as structured segments. Never HTML: captions are untrusted. */
export interface HighlightSegment {
  text: string;
  hit: boolean;
}

export interface ResultItem {
  /** Includes `collections` (names and positions). */
  item: StoredItem;
  snippet: HighlightSegment[];
  score: number;
  /** A link back to the original post, built by the platform's adapter (absent when the platform has no adapter). */
  url?: string;
}

export interface SuggestedChip {
  text: string;
  count: number;
  source: 'hashtag' | 'collection' | 'author';
}

export interface SearchResponse {
  requestId: string;
  results: ResultItem[];
  /** Capped at 10,001. When `totalIsCapped`, show "10,000+". */
  total: number;
  totalIsCapped: boolean;
  nextCursor?: string;
  tookMs: number;
  /** The ordering actually used. */
  orderedBy: SearchSort;
  /** More than 10,000 matches: relevance ranking is skipped (meaningless at that size) and results are newest-saved first. The UI should prompt the user to add chips. */
  tooBroad: boolean;
  suggestedChips: SuggestedChip[];
}

export interface ChipInfoRequest {
  requestId: string;
  chips: Chip[];
  mode?: SearchMode;
}

export interface ChipInfo {
  chipId: string;
  /** How many videos match THIS chip alone, so a zero-result AND can say which chip over-narrows. */
  count: number;
  countIsCapped: boolean;
  /** What the chip also matched, for transparency ("food" -> recipe, cooking, ...). */
  expandedTerms: string[];
  /** Only for a chip with zero matches. A suggestion, never a silent substitution. */
  didYouMean?: string;
}

export interface ChipInfoResponse {
  requestId: string;
  chips: ChipInfo[];
}

export interface ExplainRequest {
  platform: string;
  externalId: string;
  chips: Chip[];
}

export type MatchField = 'caption' | 'hashtags' | 'author' | 'sound' | 'collection';

export interface ChipMatch {
  chipId: string;
  /** 'direct' = the chip's own words; 'related' = only via an expanded term; 'none' = did not match. */
  via: 'direct' | 'related' | 'none';
  fields: MatchField[];
  term?: string;
}

export interface ExplainResponse {
  matches: ChipMatch[];
}
