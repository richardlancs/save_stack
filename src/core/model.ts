// Platform-agnostic data model. No chrome.* and no DOM imports: this file must run in plain Node.
//
// Everything a platform adapter can fail to provide is optional. Real TikTok data has optional-field
// rates from 0.2% to 87% (docs/TIKTOK_FINDINGS.md §2), so "required" is reserved for identity.

export type MediaType = 'video' | 'photo';

/**
 * How trustworthy `savedAt` is. TikTok exposes no per-video saved time, so it is estimated:
 *  - `interpolated`: from favorites-list page cursors (page granularity; the initial import)
 *  - `first_seen`:   the sync that first observed the video (accurate to the sync interval)
 *  - `exact`:        a platform-provided timestamp (reserved; none exists today)
 *  - `unknown`:      provided without provenance
 * Precedence (higher wins, never downgraded): exact > first_seen > interpolated > unknown.
 */
export type SavedAtSource = 'unknown' | 'interpolated' | 'first_seen' | 'exact';

export interface ItemStats {
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
}

/** A saved post as an adapter reports it. Times are epoch milliseconds. */
export interface SavedItem {
  platform: string;
  externalId: string;
  authorHandle: string;
  authorName?: string;
  caption?: string;
  /** Lower-case, without '#'. The storage layer normalizes defensively. */
  hashtags?: string[];
  soundTitle?: string;
  soundAuthor?: string;
  /** Seconds. Leave undefined for photo posts (TikTok reports 0). */
  durationSec?: number;
  mediaType?: MediaType;
  postedAt?: number;
  stats?: ItemStats;
  /** Ephemeral: TikTok cover URLs are signed and expire in ~47 h. Refreshed by every capture. */
  thumbnailUrl?: string;
  language?: string;
  isAd?: boolean;
  savedAt?: number;
  savedAtSource?: SavedAtSource;
  /** Opt-in: only platforms that need reprocessing data set this. NULL by default. */
  rawJson?: string;
}

export interface Collection {
  platform: string;
  externalId: string;
  name: string;
  /** What the platform *claims*. Unreliable (48 declared vs 45 delivered), so it is stored separately from what we saw. */
  declaredTotal?: number;
}

export interface Membership {
  platform: string;
  itemExternalId: string;
  collectionExternalId: string;
  /** Order within the collection as the platform returned it (0 = first). */
  position: number;
}

/** A signed-in account on a platform. `id` is the platform's stable identifier when it has one (survives a rename). */
export interface AccountRef {
  platform: string;
  id?: string;
  handle: string;
}

/** One unit of ingestion. Idempotent: applying the same batch twice changes nothing but `last_seen_at`. */
export interface ParsedBatch {
  /**
   * The account this batch was read as. Storage binds the library to it on first use and refuses a different account
   * (AccountMismatchError) atomically with the write, so two accounts can never be mixed.
   */
  account?: AccountRef;
  /**
   * These items come from the NEWEST end of the platform's saved list (the first page). Videos in such a batch that the library has not
   * seen before are new saves: when the library already holds data, storage dates them by when they were first seen (newest first, one
   * second apart) instead of trusting a page-boundary estimate, which shifts every time the list grows and would file a new save among
   * older ones. Only meaningful for platforms whose saved list is ordered newest first.
   */
  headOfList?: boolean;
  items: SavedItem[];
  collections?: Collection[];
  memberships?: Membership[];
  /** Epoch ms of this sync. Injectable so tests are deterministic. Defaults to Date.now(). */
  syncedAt?: number;
}

export interface UpsertResult {
  inserted: number;
  /** Existing items whose searchable text changed (FTS reindexed). */
  reindexed: number;
  /** Existing items with unchanged text (only stats / last_seen refreshed). */
  touched: number;
  membershipsWritten: number;
  /** Memberships referencing an unknown item or collection; reported, never thrown. */
  skippedMemberships: number;
}

export interface StoredCollectionRef {
  externalId: string;
  name: string;
  position: number;
}

export interface StoredItem extends SavedItem {
  id: number;
  mediaType: MediaType;
  isAd: boolean;
  hashtags: string[];
  savedAt: number;
  savedAtSource: SavedAtSource;
  firstSeenAt: number;
  lastSeenAt: number;
  /** 0 when a complete sync no longer sees the video (removed / went private). Never deleted. */
  available: boolean;
  collections: StoredCollectionRef[];
}

export interface StoredCollection {
  platform: string;
  externalId: string;
  name: string;
  declaredTotal: number | null;
  /** Videos of this collection we currently hold. Compare with `declaredTotal` to report "N unavailable". */
  itemsSeen: number;
  lastSyncedAt: number | null;
}

export interface StorageStats {
  schemaVersion: number;
  items: number;
  availableItems: number;
  collections: number;
  memberships: number;
  hashtags: number;
  dbBytes: number;
}

export interface ReconcileInput {
  platform: string;
  /** Every external id observed by a COMPLETE pass (caller guarantees hasMore was exhausted). */
  seenExternalIds: string[];
  /**
   * If set, the pass covered that collection: memberships of items not seen are dropped.
   * If unset, the pass covered the whole favorites list: items not seen become `available = 0`.
   */
  collectionExternalId?: string;
  /**
   * An empty `seenExternalIds` is refused unless this is true: after a failed or interrupted sync it would
   * silently mark the entire library unavailable.
   */
  allowEmpty?: boolean;
}

export interface ReconcileResult {
  markedUnavailable: number;
  revived: number;
  membershipsRemoved: number;
}

export interface ExportBundle {
  format: 'scroganize-export';
  version: 1;
  schemaVersion: number;
  exportedAt: number;
  items: Array<Omit<StoredItem, 'id' | 'collections'>>;
  collections: Array<Omit<StoredCollection, 'itemsSeen'>>;
  memberships: Membership[];
  /** The account binding, when there is one (absent in older exports). */
  accounts?: AccountRef[];
}
