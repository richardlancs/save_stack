// The results area's state: one search at a time, with paging and the follow-up per-chip info. Pure, so the ordering rules
// (a newer search wins; an older answer is ignored) are unit-tested.

import type { ChipInfo, ResultItem, SearchResponse, SuggestedChip } from '../../core/search/types';

export type ResultsStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface ResultsState {
  status: ResultsStatus;
  /** The search these results belong to. Answers for any other id are ignored. */
  requestId?: string;
  /** The search whose answer the rows on screen came from (rows are rebuilt when it changes, so no row keeps state of an older search). */
  itemsFor?: string;
  items: ResultItem[];
  total: number;
  totalIsCapped: boolean;
  tooBroad: boolean;
  nextCursor?: string;
  orderedBy?: SearchResponse['orderedBy'];
  suggested: SuggestedChip[];
  /** Per-chip counts, related terms and did-you-mean; arrives after the results. */
  chipInfo: ChipInfo[];
  loadingMore: boolean;
  error?: string;
}

export const initialResults = (): ResultsState => ({ status: 'idle', items: [], total: 0, totalIsCapped: false, tooBroad: false, suggested: [], chipInfo: [], loadingMore: false });

/**
 * A new search starts. What was on screen stays until the answer arrives, so the list does not flash empty, but its paging cursor is
 * dropped: that cursor belongs to the OLD search, and "Show more" must not combine it with the new one.
 */
export function begin(s: ResultsState, requestId: string): ResultsState {
  const { nextCursor: _old, ...rest } = s;
  return { ...rest, status: 'loading', requestId, loadingMore: false, chipInfo: [] };
}

/** The list key of a row: rows are rebuilt (their thumbnail and "why" state reset) whenever the answer they belong to changes. */
export const rowKey = (s: Pick<ResultsState, 'itemsFor'>, item: Pick<ResultItem['item'], 'platform' | 'externalId'>): string => `${s.itemsFor ?? ''}:${item.platform}:${item.externalId}`;

export function loaded(s: ResultsState, res: SearchResponse): ResultsState {
  if (res.requestId !== s.requestId) return s;
  const { error: _e, nextCursor: _n, ...rest } = s;
  return {
    ...rest,
    status: 'ready',
    itemsFor: res.requestId,
    items: res.results,
    total: res.total,
    totalIsCapped: res.totalIsCapped,
    tooBroad: res.tooBroad,
    orderedBy: res.orderedBy,
    suggested: res.suggestedChips,
    loadingMore: false,
    ...(res.nextCursor !== undefined ? { nextCursor: res.nextCursor } : {}),
  };
}

export const loadingMore = (s: ResultsState): ResultsState => (s.nextCursor === undefined || s.loadingMore ? s : { ...s, loadingMore: true });

export function appended(s: ResultsState, res: SearchResponse): ResultsState {
  if (res.requestId !== s.requestId) return s;
  const have = new Set(s.items.map((r) => r.item.externalId));
  const { nextCursor: _n, ...rest } = s;
  return { ...rest, items: [...s.items, ...res.results.filter((r) => !have.has(r.item.externalId))], loadingMore: false, ...(res.nextCursor !== undefined ? { nextCursor: res.nextCursor } : {}) };
}

export function chipInfoLoaded(s: ResultsState, requestId: string, chips: ChipInfo[]): ResultsState {
  return requestId === s.requestId ? { ...s, chipInfo: chips } : s;
}

export function failed(s: ResultsState, requestId: string, message: string): ResultsState {
  return requestId === s.requestId ? { ...s, status: 'error', error: message, loadingMore: false } : s;
}

/** The chip that over-narrows an AND search: the one with the fewest matches when the whole search found nothing. */
export function narrowestChip(s: ResultsState): ChipInfo | undefined {
  if (s.status !== 'ready' || s.total > 0 || s.chipInfo.length < 2) return undefined;
  return [...s.chipInfo].sort((a, b) => a.count - b.count)[0];
}
