import type { SavedAtSource, StoredItem } from '../../model';

/** Map an `items` row (plus its hashtags) to the public item shape. `id` and `collections` are added by the caller. */
export function rowToItem(row: Record<string, unknown>, hashtags: string[]): Omit<StoredItem, 'id' | 'collections'> {
  const num = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));
  const str = (v: unknown) => (v === null || v === undefined ? undefined : String(v));
  const stats = { views: num(row.views), likes: num(row.likes), comments: num(row.comments), shares: num(row.shares), saves: num(row.saves) };
  return {
    platform: String(row.platform),
    externalId: String(row.external_id),
    authorHandle: String(row.author_handle),
    authorName: str(row.author_name),
    caption: String(row.caption),
    hashtags,
    soundTitle: str(row.sound_title),
    soundAuthor: str(row.sound_author),
    durationSec: num(row.duration_sec),
    mediaType: row.media_type === 'photo' ? 'photo' : 'video',
    postedAt: num(row.posted_at),
    stats: Object.values(stats).some((v) => v !== undefined) ? stats : undefined,
    thumbnailUrl: str(row.thumbnail_url),
    language: str(row.language),
    isAd: Number(row.is_ad) === 1,
    savedAt: Number(row.saved_at),
    savedAtSource: String(row.saved_at_source) as SavedAtSource,
    rawJson: str(row.raw_json),
    firstSeenAt: Number(row.first_seen_at),
    lastSeenAt: Number(row.last_seen_at),
    available: Number(row.available) === 1,
  };
}
