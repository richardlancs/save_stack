// Pure, engine-agnostic helpers shared by every StorageAdapter implementation.

import type { MediaType, SavedAtSource, SavedItem } from '../model';

/** Lower-case, strip a leading '#', trim, drop empties, de-duplicate, keep first-seen order. */
export function normalizeHashtags(tags: readonly string[] | undefined): string[] {
  if (!tags) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const t = String(raw ?? '').normalize('NFKC').trim().replace(/^#+/, '').toLowerCase();
    if (t && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

/** 53-bit string hash (cyrb53). 32 bits would collide often enough over a lifetime of re-syncs to skip a reindex. */
export function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

const SEP = '\u0001';

/**
 * Hash of exactly the fields that feed full-text search (caption, hashtags, author, sound).
 * Stats, thumbnail and membership are deliberately excluded: they change without needing an FTS reindex.
 */
export function contentHash(item: SavedItem, hashtags: readonly string[] = normalizeHashtags(item.hashtags)): string {
  return cyrb53([
    item.caption ?? '',
    [...hashtags].sort().join(','),
    item.authorHandle ?? '',
    item.authorName ?? '',
    item.soundTitle ?? '',
    item.soundAuthor ?? '',
  ].join(SEP));
}

export interface FtsColumns {
  caption: string;
  hashtags: string;
  author: string;
  sound: string;
  collections: string;
}

/** The five `items_fts` columns, in schema order. Collection names are sorted so the text is deterministic. */
export function ftsColumns(item: SavedItem, hashtags: readonly string[], collectionNames: readonly string[]): FtsColumns {
  return {
    caption: item.caption ?? '',
    hashtags: hashtags.join(' '),
    author: [item.authorHandle, item.authorName].filter(Boolean).join(' '),
    sound: [item.soundTitle, item.soundAuthor].filter(Boolean).join(' '),
    collections: [...collectionNames].sort().join(' '),
  };
}

export const SAVED_AT_RANK: Readonly<Record<SavedAtSource, number>> = {
  unknown: 0,
  interpolated: 1,
  first_seen: 2,
  exact: 3,
};

/** True when `incoming` is a strictly better provenance than what is stored, so the stored value may be replaced. */
export function isBetterSavedAt(existing: SavedAtSource, incoming: SavedAtSource | undefined): boolean {
  return incoming !== undefined && SAVED_AT_RANK[incoming] > SAVED_AT_RANK[existing];
}

export function mediaTypeOf(item: SavedItem): MediaType {
  return item.mediaType ?? 'video';
}

/** Integer-or-null for SQL binding: platforms send numbers as numbers, numeric strings, or nothing. */
export function toIntOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export function textOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
