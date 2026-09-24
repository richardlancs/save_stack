// What the search service needs from a storage engine. Kept separate from the service so the query logic
// (planner + service) never sees SQL, and the SQL (storage/sqlite/search.ts) never sees chips or UI concerns.

import type { StoredItem } from '../model';
import type { ChipPlan, SearchPlan } from './planner';
import type { MatchField, SearchSort } from './types';

export interface StoreResult {
  /** The page, in display order. */
  ids: number[];
  /** Parallel to `ids`: higher = more relevant; 0 when the ordering is not by relevance. */
  scores: number[];
  /** Up to ~300 leading matches, for facets (first page only). */
  candidateIds: number[];
  /** Capped at 10,001. */
  total: number;
  totalIsCapped: boolean;
  /** The ordering actually used. */
  orderedBy: SearchSort;
  /** More than 10,000 matches: relevance was skipped. */
  tooBroad: boolean;
  nextCursor?: string;
}

export interface FacetCounts {
  hashtags: Array<{ text: string; count: number }>;
  collections: Array<{ text: string; count: number }>;
  authors: Array<{ text: string; count: number }>;
}

export interface ChipCount {
  count: number;
  capped: boolean;
}

export interface ChipExplanation {
  chipId: string;
  via: 'direct' | 'related' | 'none';
  fields: MatchField[];
  /** For 'related': which related term matched. */
  term?: string;
}

export interface Vocabulary {
  hashtags: string[];
  authors: string[];
  collections: string[];
}

export interface SearchStore {
  searchQuery(plan: SearchPlan): Promise<StoreResult>;
  /** Full items (with collections and hashtags) in the order of `ids`. Unknown ids are skipped. */
  hydrateItems(ids: readonly number[]): Promise<StoredItem[]>;
  facetCandidates(ids: readonly number[]): Promise<FacetCounts>;
  /** How many videos match THIS chip alone (capped at 10,001). */
  countChip(chip: ChipPlan): Promise<ChipCount>;
  /** Null if the item does not exist. */
  explainItem(platform: string, externalId: string, chips: readonly ChipPlan[]): Promise<ChipExplanation[] | null>;
  vocabulary(): Promise<Vocabulary>;
}
