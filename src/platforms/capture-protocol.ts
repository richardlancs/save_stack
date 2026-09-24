// The message a page-side hook sends when it sees an allowed response, and the status the extension keeps about captures.
// Platform-agnostic and chrome-free: shared by the hook (runs inside the platform's page), the relay content script and the
// service worker's capture pipeline.
//
// SECURITY MODEL, stated honestly: the hook runs in the PAGE'S OWN JavaScript world, because that is the only place TikTok's
// responses can be seen. Any other script on the same page can therefore also post a message shaped like this, and nothing in
// a message can prove otherwise (a nonce would sit in the same page-readable DOM). What protects the user is not secrecy but
// limits: strict shape/size validation at BOTH the relay and the service worker, an allowlist of response kinds, digits-only
// request values, the identity guard (only the signed-in user's OWN profile is stored), and that capture can only ever ADD
// or refresh saved-video records, never delete or read anything. See docs/ARCHITECTURE.md.

export const CAPTURE_CHANNEL = 'scroganize:capture';
export const CAPTURE_VERSION = 1;
/** A response larger than this is dropped (real pages were 0.4 to 0.75 MB). */
export const MAX_BODY_CHARS = 12_000_000;
/** A capture claiming to be older or newer than this (ms) is rejected. */
export const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000;

export interface CaptureMessage {
  channel: typeof CAPTURE_CHANNEL;
  v: typeof CAPTURE_VERSION;
  platform: string;
  kind: string;
  requestCursor?: string;
  collectionId?: string;
  capturedAt: number;
  /** The response body as JSON TEXT (parsed later, inside the service worker, where a failure cannot hurt the page). */
  body: string;
  /** Whose profile the page is showing (from the URL), and who is signed in (from the page's own data). */
  pageHandle?: string;
  viewerHandle?: string;
  /** The signed-in user's stable numeric id, when the page's data has one (a username can change; this cannot). */
  viewerId?: string;
}

export type CaptureRejection =
  | 'malformed' //         not a well-formed capture message
  | 'wrong_platform' //    a platform this build has no adapter for
  | 'unknown_kind' //      not one of the platform's allowed response kinds
  | 'too_large' //         body over the size cap
  | 'stale' //             timestamp outside the allowed clock skew
  | 'sender' //            did not come from a content script of this extension on the platform's origin
  | 'bad_json' //          body is not JSON
  | 'identity_unknown' //  the signed-in user could not be determined
  | 'not_own_profile' //   the page shows someone else's profile
  | 'owner_mismatch' //    the payload names a different account than the signed-in user
  | 'account_mismatch' //  the library already belongs to a different signed-in account (wipe it to switch)
  | 'bad_envelope' //      JSON, but not the shape this kind of response has
  | 'ingest_failed'; //    valid capture, but the database could not store it (nothing was recorded as seen)

export interface CaptureOutcome {
  accepted: boolean;
  reason?: CaptureRejection;
  kind?: string;
  items?: number;
  inserted?: number;
  duplicate?: boolean;
}

export interface CaptureStatus {
  version: 1;
  /** The platforms this build can read (display names for the UI, which never hard-codes one). Filled in by the service worker when it answers `getCaptureStatus`. */
  platforms?: Array<{ id: string; displayName: string }>;
  /** The signed-in user the last accepted capture belonged to (a display cache: the database holds the binding). */
  viewerHandle?: string;
  viewerId?: string;
  lastCaptureAt?: number;
  pages: number;
  items: number;
  inserted: number;
  touched: number;
  reindexed: number;
  /** Pages that added nothing new (a platform re-sends the first pages when a tab opens). They are still applied, which refreshes thumbnails and stats. */
  duplicates: number;
  /** Collection memberships that arrived before their collection existed (kept and applied once it does). */
  skippedMemberships: number;
  rejected: Partial<Record<CaptureRejection, number>>;
  lastRejection?: { reason: CaptureRejection; at: number };
  byKind: Record<string, { pages: number; items: number; lastAt: number }>;
  /** The most recent accepted page: lets a UI show "collection X: 45 delivered of 48 declared". */
  lastPage?: { kind: string; hasMore: boolean | null; itemsDelivered: number; declaredTotal?: number; collectionId?: string; at: number };
  /** Signals that the platform changed its response shape (M6 turns this into a visible warning). */
  drift: {
    parserVersion: number;
    itemsSeen: number;
    badRecords: number;
    unknownItemKeys: string[];
    missing: Record<string, number>;
    lastReportAt?: number;
  };
}

export const emptyCaptureStatus = (parserVersion = 0): CaptureStatus => ({
  version: 1,
  pages: 0,
  items: 0,
  inserted: 0,
  touched: 0,
  reindexed: 0,
  duplicates: 0,
  skippedMemberships: 0,
  rejected: {},
  byKind: {},
  drift: { parserVersion, itemsSeen: 0, badRecords: 0, unknownItemKeys: [], missing: {} },
});

/** One page the pipeline accepted (or recognised as a duplicate), described without its body. Feeds the sync. */
export interface AcceptedPage {
  kind: string;
  collectionId?: string;
  requestCursor?: string;
  responseCursor?: string;
  hasMore: boolean | null;
  itemsDelivered: number;
  inserted: number;
  reindexed: number;
  /** The page held videos but none were new (a re-sent page). It was still applied. */
  duplicate: boolean;
  externalIds: string[];
  collections?: Array<{ id: string; name: string; declaredTotal?: number }>;
  declaredTotal?: number;
}

/** The tab a capture message came from, as the browser reported it (not something the page can set). */
export interface CaptureSource { tabId?: number }

/** Observes pipeline outcomes. Called after the outcome is recorded; never awaited and never allowed to break a capture. */
export interface CaptureListener {
  accepted?(page: AcceptedPage, from?: CaptureSource): void | Promise<void>;
  rejected?(reason: CaptureRejection, kind?: string, from?: CaptureSource): void | Promise<void>;
}
