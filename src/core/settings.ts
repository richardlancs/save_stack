// The few user preferences. Pure: validation and merging only; where they are stored is the service worker's business.

import type { SearchSort } from './search/types';

export interface Settings {
  /** New categories also match related words ("food" finds recipe, pasta ...). */
  relatedWords: boolean;
  /** The sort the panel starts with. */
  sort: SearchSort;
  /** Videos per page of results. */
  pageSize: number;
}

export const SORTS: readonly SearchSort[] = ['relevance', 'recently_saved', 'newest', 'most_viewed'];
export const PAGE_SIZES: readonly number[] = [10, 30, 50, 100];

export const DEFAULT_SETTINGS: Readonly<Settings> = { relatedWords: true, sort: 'relevance', pageSize: 30 };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Take whatever was stored (older build, damaged, empty) and return a complete, valid Settings. Never throws. */
export function normalizeSettings(raw: unknown): Settings {
  return mergeSettings({ ...DEFAULT_SETTINGS }, raw);
}

/**
 * Apply a patch to a settings object. Only known keys with valid values are taken; everything else is ignored, so a bad value can
 * never damage what is stored and a newer build's extra keys are dropped rather than carried.
 */
export function mergeSettings(current: Settings, patch: unknown): Settings {
  if (!isObj(patch)) return { ...current };
  const next: Settings = { ...current };
  if (typeof patch.relatedWords === 'boolean') next.relatedWords = patch.relatedWords;
  if (typeof patch.sort === 'string' && (SORTS as readonly string[]).includes(patch.sort)) next.sort = patch.sort as SearchSort;
  if (typeof patch.pageSize === 'number' && PAGE_SIZES.includes(patch.pageSize)) next.pageSize = patch.pageSize;
  return next;
}
