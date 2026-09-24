// Sync = actively reading the whole saved list and every collection, by scrolling the platform's own pages in a dedicated
// window. This file is the vocabulary of the sync STATE MACHINE (machine.ts): pure data, no chrome.*, no platform names.
//
// The machine is a reducer: (state, event) -> (state, effects). It never does I/O. The service worker persists the state after
// every event and performs the effects, so a killed service worker resumes exactly where the state says it was.

export type SyncMode = 'incremental' | 'full';

export type SyncStatus =
  | 'idle' //             nothing has run yet (or the state was cleared)
  | 'running'
  | 'paused' //           the user paused; the window stays open
  | 'needs_attention' //  stopped until the user (or the page) fixes `attention`; some reasons clear themselves
  | 'completed'
  | 'failed'
  | 'cancelled';

export type SyncPhase = 'start' | 'saved' | 'collections' | 'done';

export type AttentionReason =
  | 'login_required' //    not signed in on the platform
  | 'captcha' //           the platform shows a verification challenge
  | 'wrong_account' //     the signed-in account differs from the one the library belongs to
  | 'not_own_profile' //   the sync window is on someone else's page
  | 'tab_hidden' //        the sync window is not visible; scrolling stalls in hidden tabs (clears itself)
  | 'tab_closed' //        the sync window was closed
  | 'stalled' //           nothing loaded for a long time, even after reloading
  | 'blocked' //           the platform keeps answering with errors (rate limit or challenge)
  | 'open_collections'; // the list of collections never arrived: open it in the sync window

/** What the sync window should be showing right now. */
export type SyncTarget =
  | { kind: 'home' } //                                 identify the signed-in user
  | { kind: 'saved' } //                                the flat list of everything saved
  | { kind: 'collection'; id: string; name: string };

export type SyncCollectionStatus = 'pending' | 'active' | 'done' | 'skipped';

export interface SyncCollection {
  id: string;
  name: string;
  status: SyncCollectionStatus;
  pages: number;
  items: number;
  /** What the platform claims (unreliable). */
  declaredTotal?: number;
  note?: string;
}

export interface SyncConfig {
  /** An incremental pass over the saved list stops after this many consecutive pages that added nothing new. */
  knownPagesToStop: number;
  /** How many times the current list may be reloaded after it stalls before asking the user. */
  maxStallRetries: number;
  /** No progress for this long while running counts as a stall. */
  stallMs: number;
  /** Hard cap on pages read in one run. */
  maxPages: number;
  /** Consecutive unreadable responses before asking the user (challenge or rate limit). */
  maxBadPages: number;
  /** Consecutive database failures before giving up. */
  maxStorageFailures: number;
}

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  knownPagesToStop: 2,
  maxStallRetries: 3,
  stallMs: 120_000,
  maxPages: 3_000,
  maxBadPages: 2,
  maxStorageFailures: 3,
};

export interface SyncSavedProgress {
  pages: number;
  items: number;
  inserted: number;
  /** Consecutive pages with nothing new (drives the incremental early stop). */
  knownStreak: number;
  /** The list was read to its end ('complete') or an incremental pass stopped early ('early'). */
  done: false | 'complete' | 'early' | 'partial';
}

export interface SyncState {
  v: 1;
  /** Increments on every state change, so a UI can ignore out-of-order broadcasts. */
  seq: number;
  runId: string;
  platform: string;
  status: SyncStatus;
  /** What was asked for. */
  requestedMode: SyncMode;
  /** What actually runs: an incremental request becomes a full pass when no complete pass has ever finished. */
  mode: SyncMode;
  phase: SyncPhase;
  target: SyncTarget;
  /** The signed-in account being synced (from the platform page). `accountId` is the platform's stable id for it, when known. */
  handle?: string;
  accountId?: string;
  /** The account the library already belongs to, if any: a different signed-in account is refused. */
  boundHandle?: string;
  boundId?: string;
  saved: SyncSavedProgress;
  /** Known once the platform's collection list has been read. */
  collections: SyncCollection[];
  collectionsListed: boolean;
  totals: { pages: number; items: number; inserted: number; reindexed: number };
  startedAt: number;
  updatedAt: number;
  lastProgressAt: number;
  finishedAt?: number;
  attention?: { reason: AttentionReason; message: string; at: number };
  /** Cursor chain of the list being read: a gap means a page was missed, so the pass cannot be called complete. */
  chain: { cursor?: string; gap: boolean };
  /** Things the user should know about a finished run (e.g. a list that could not be read completely). */
  warnings: string[];
  stallRetries: number;
  /** Reloads of the current list because its pages did not chain (not reset by progress). */
  chainRetries: number;
  badStreak: number;
  storageFailures: number;
  config: SyncConfig;
  error?: string;
}

/** The kinds of list the platform serves, in the platform-independent vocabulary the machine understands. */
export type CaptureRole = 'saved' | 'collections' | 'collection' | 'collection_info';

/** What the sync needs to know about one accepted capture. */
export interface SyncPage {
  role: CaptureRole;
  collectionId?: string;
  hasMore: boolean | null;
  items: number;
  inserted: number;
  reindexed: number;
  /** The same page was already stored (the platform re-requests the first pages when a tab opens). */
  duplicate: boolean;
  /** The cursor the page was requested with and the one it returned: consecutive pages of a list must chain (response n = request n+1), otherwise a page was missed. */
  requestCursor?: string;
  responseCursor?: string;
  /** role === 'collections': the collections listed. */
  collections?: Array<{ id: string; name: string; declaredTotal?: number }>;
  /** role === 'collection_info': the declared size. */
  declaredTotal?: number;
}

export type PageState = 'ok' | 'login' | 'captcha' | 'interstitial' | 'unknown';

/** Plain facts about the page the driver is on. The platform adapter turns them into a PageState / PageView (pure, so it is unit-tested). */
export interface PageSnapshot {
  pathname: string;
  search: string;
  title: string;
  /** The signed-in user, if the page's own data names one (handle, and the stable id when the page has it). */
  viewer?: string;
  viewerId?: string;
  /** Whether the page's own bootstrap data is present (absent on interstitials and error pages). */
  hasBootstrap: boolean;
  /** Which of the adapter's probe selectors match something on the page. */
  present: Record<string, boolean>;
}

/** What kind of page the sync window is on, as classified by the platform adapter. */
export interface PageView {
  kind: 'home' | 'profile' | 'collection' | 'other';
  /** The profile the page belongs to (from the URL). */
  pageHandle?: string;
  collectionId?: string;
}

export type SyncEvent =
  | { type: 'start'; now: number; runId: string; platform: string; mode: SyncMode; hasCompletedBefore: boolean; boundHandle?: string; boundId?: string; config?: Partial<SyncConfig> }
  | { type: 'pause'; now: number }
  | { type: 'resume'; now: number }
  | { type: 'cancel'; now: number }
  | { type: 'driver_ready'; now: number; handle?: string; id?: string; pageState: PageState; view: PageView }
  | { type: 'driver_hidden'; now: number }
  | { type: 'driver_visible'; now: number }
  | { type: 'driver_stalled'; now: number }
  | { type: 'driver_blocked'; now: number; pageState: 'login' | 'captcha' }
  | { type: 'tab_closed'; now: number }
  | { type: 'page'; now: number; page: SyncPage }
  | { type: 'rejected'; now: number; reason: string }
  | { type: 'tick'; now: number }
  /** The service worker could not carry out an effect (e.g. the sync window could not be opened). */
  | { type: 'fatal'; now: number; message: string }
  /** A note for the user about this run (e.g. a reconcile that was skipped as unsafe). */
  | { type: 'warn'; now: number; message: string };

export type SyncEffect =
  /** Navigate the sync window to the target (creating the window if needed). */
  | { type: 'open'; target: SyncTarget }
  /** Keep going on the current page if it is the right one, otherwise open the target. */
  | { type: 'resume_target'; target: SyncTarget }
  /** Tell the page driver to start scrolling for this target. */
  | { type: 'driver_start'; target: SyncTarget }
  | { type: 'driver_stop' }
  /** Apply a COMPLETE pass: mark vanished videos unavailable (scope 'saved') or drop stale memberships (scope 'collection'). */
  | { type: 'reconcile'; scope: 'saved' } | { type: 'reconcile'; scope: 'collection'; collectionId: string }
  /** The pass over the saved list reached its end, so a later incremental pass may stop early. */
  | { type: 'mark_complete_pass' }
  | { type: 'close_window' }
  /** The run is over: discard the ids remembered for reconciliation. */
  | { type: 'clear_seen' };

export interface SyncStep {
  state: SyncState;
  effects: SyncEffect[];
}

/** What the coordinator (service worker) needs from a platform to run a sync. */
export interface SyncPlatformSpec {
  platform: string;
  homeUrl: string;
  savedUrl(handle: string): string;
  collectionUrl(handle: string, collection: { id: string; name: string }): string;
  /** How each of the platform's capture kinds is used by the sync. */
  roles: Record<string, CaptureRole>;
}

/** What the in-page driver needs from a platform. Pure functions over plain facts, so they are unit-tested. */
export interface SyncPageSpec {
  detectPageState(snapshot: PageSnapshot): PageState;
  classifyPage(snapshot: PageSnapshot): PageView;
  /** CSS selectors the driver tests to build a PageSnapshot (keys become PageSnapshot.present). */
  probes: Record<string, string>;
  /** Controls a person would click to open the saved list, tried once by the driver (best effort). */
  revealSavedSelectors: string[];
}
