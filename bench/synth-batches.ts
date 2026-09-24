// Turns the seeded synthetic library into ParsedBatch objects for the real ingest pipeline.
// Shared by the storage tests, the Node ingest benchmark and the extension-level (OPFS) benchmark.
import type { Membership, ParsedBatch, SavedItem } from '../src/core/model';
import { generateLibrary, type SynthItem, type SynthLibrary } from './synth';

export const PLATFORM = 'tiktok';

export function toSavedItem(it: SynthItem): SavedItem {
  return {
    platform: PLATFORM,
    externalId: it.externalId,
    authorHandle: it.authorHandle,
    authorName: it.authorName,
    caption: it.caption,
    hashtags: it.hashtags,
    soundTitle: it.soundTitle,
    soundAuthor: it.soundAuthor,
    durationSec: it.durationSec,
    mediaType: 'video',
    postedAt: it.postedAt,
    stats: { views: it.views, likes: it.likes, comments: it.comments, shares: it.shares, saves: it.saves },
    thumbnailUrl: it.thumbnailUrl,
    language: it.language,
    savedAt: it.firstSeenAt,
    savedAtSource: 'interpolated',
  };
}

/**
 * Split a library into ingest batches. Collections ride in the first batch; each batch carries the
 * memberships of its own items, with positions counted per collection in library order.
 */
export function synthBatches(lib: SynthLibrary, batchSize = 1000, syncedAt = Date.UTC(2026, 8, 24)): ParsedBatch[] {
  const collections = lib.collections.map((c) => ({ platform: PLATFORM, externalId: c.externalId, name: c.name }));
  const collExternal = new Map(lib.collections.map((c) => [c.id, c.externalId]));
  const nextPos = new Map<number, number>();
  const batches: ParsedBatch[] = [];
  for (let i = 0; i < lib.items.length; i += batchSize) {
    const slice = lib.items.slice(i, i + batchSize);
    const memberships: Membership[] = [];
    for (const it of slice) {
      for (const cid of it.collectionIds) {
        const pos = nextPos.get(cid) ?? 0;
        nextPos.set(cid, pos + 1);
        memberships.push({ platform: PLATFORM, itemExternalId: it.externalId, collectionExternalId: collExternal.get(cid)!, position: pos });
      }
    }
    batches.push({ items: slice.map(toSavedItem), collections: i === 0 ? collections : undefined, memberships, syncedAt });
  }
  return batches;
}

export const synthLibrary = (count: number, seed = 1337): SynthLibrary => generateLibrary(count, seed);
