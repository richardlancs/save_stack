// The sync state machine: a pure reducer. See types.ts for the vocabulary.
//
//   start -> [home: who is signed in?] -> [saved list, to its end] -> [each collection, to its end] -> done
//
// Design rules:
//  - Pure and total: no I/O, no clock (time arrives in the event), never throws, never mutates its input.
//  - Everything needed to resume lives in the state, which is JSON, so a killed service worker resumes exactly here.
//  - "Complete" is only claimed for a list whose pages CHAINED (each request cursor was the previous response cursor) up to a page
//    that said hasMore === false. Only a complete pass may mark videos unavailable, so a missed page can never make the library
//    silently forget a video.

import { matchAccount } from '../ingest/account';
import {
  DEFAULT_SYNC_CONFIG,
  type AttentionReason,
  type SyncCollection,
  type SyncConfig,
  type SyncEffect,
  type SyncEvent,
  type SyncPage,
  type SyncState,
  type SyncStatus,
  type SyncStep,
  type SyncTarget,
} from './types';

export const SYNC_STATE_VERSION = 1 as const;

const ATTENTION_MESSAGES: Record<AttentionReason, string> = {
  login_required: 'Sign in to the platform in the sync window, then press Resume.',
  captcha: 'The platform is asking for a verification. Complete it in the sync window, then press Resume.',
  wrong_account: 'The signed-in account is not the one this library belongs to. Sign in to the original account, or wipe the library to switch.',
  not_own_profile: 'The sync window is showing someone else\'s page. Nothing was read from it.',
  tab_hidden: 'The sync window is hidden, and scrolling stalls in hidden windows. Bring it to the front (it continues by itself).',
  tab_closed: 'The sync window was closed. Press Resume to reopen it.',
  stalled: 'The list did not load. Open it yourself in the sync window (for the saved list, click the Favorites tab; for a collection, click the collection) and the sync continues by itself, or press Resume to try again.',
  blocked: 'The platform keeps returning errors (a rate limit or a challenge). Wait a while, then press Resume.',
  open_collections: 'The list of collections did not load. Open the collections view in the sync window and it will continue.',
};

const ACTIVE: readonly SyncStatus[] = ['running', 'paused', 'needs_attention'];
export const isActive = (s: Pick<SyncState, 'status'>): boolean => ACTIVE.includes(s.status);
export const isFinished = (s: Pick<SyncState, 'status'>): boolean => s.status === 'completed' || s.status === 'failed' || s.status === 'cancelled';

export function initialSyncState(platform = ''): SyncState {
  return {
    v: SYNC_STATE_VERSION,
    seq: 0,
    runId: '',
    platform,
    status: 'idle',
    requestedMode: 'incremental',
    mode: 'incremental',
    phase: 'start',
    target: { kind: 'home' },
    saved: { pages: 0, items: 0, inserted: 0, knownStreak: 0, done: false },
    collections: [],
    collectionsListed: false,
    totals: { pages: 0, items: 0, inserted: 0, reindexed: 0 },
    startedAt: 0,
    updatedAt: 0,
    lastProgressAt: 0,
    chain: { gap: false },
    warnings: [],
    stallRetries: 0,
    chainRetries: 0,
    badStreak: 0,
    storageFailures: 0,
    config: { ...DEFAULT_SYNC_CONFIG },
  };
}

const lc = (v: string | undefined): string | undefined => (v === undefined ? undefined : v.toLowerCase());
const activeCollection = (s: SyncState): SyncCollection | undefined => (s.target.kind === 'collection' ? s.collections.find((c) => c.id === (s.target as { id: string }).id) : undefined);

/** The whole reducer. Never throws: an unexpected event in an unexpected state is ignored. */
export function reduce(prev: SyncState, event: SyncEvent): SyncStep {
  const s = structuredClone(prev);
  const effects: SyncEffect[] = [];
  let changed = false;
  try {
    changed = apply(s, event, effects);
  } catch (e) {
    // A bug here must not wedge the sync: fail the run visibly instead of throwing into the service worker.
    if (isActive(s)) {
      s.status = 'failed';
      s.error = `internal error: ${e instanceof Error ? e.message : String(e)}`;
      s.finishedAt = event.now;
      effects.length = 0;
      effects.push({ type: 'driver_stop' }, { type: 'clear_seen' }, { type: 'close_window' });
      changed = true;
    }
  }
  if (!changed) return { state: prev, effects: [] };
  s.seq = prev.seq + 1;
  s.updatedAt = event.now;
  return { state: s, effects };
}

function apply(s: SyncState, e: SyncEvent, fx: SyncEffect[]): boolean {
  switch (e.type) {
    case 'start': return onStart(s, e, fx);
    case 'cancel': return onCancel(s, e.now, fx);
    case 'pause': return onPause(s, fx);
    case 'resume': return onResume(s, e.now, fx);
    case 'driver_ready': return s.status === 'running' ? onReady(s, e, fx) : false;
    case 'driver_hidden': return s.status === 'running' ? attention(s, 'tab_hidden', e.now, fx) : false;
    case 'driver_visible': return onVisible(s, e.now, fx);
    case 'driver_stalled': return s.status === 'running' ? onStall(s, e.now, fx) : false;
    case 'driver_blocked': return s.status === 'running' ? attention(s, e.pageState === 'login' ? 'login_required' : 'captcha', e.now, fx) : false;
    // (A hidden window that is then closed can never become visible again: it needs the user, like any closed window.)
    case 'tab_closed': return s.status === 'running' || (s.status === 'needs_attention' && s.attention?.reason === 'tab_hidden') ? attention(s, 'tab_closed', e.now, fx) : false;
    case 'page': return onPage(s, e.page, e.now, fx);
    case 'rejected': return s.status === 'running' ? onRejected(s, e.reason, e.now, fx) : false;
    case 'tick': return s.status === 'running' && e.now - s.lastProgressAt > s.config.stallMs ? onStall(s, e.now, fx) : false;
    case 'fatal': return onFatal(s, e.message, e.now, fx);
    // A run can finish in the same step that reconciles its last list, so warnings and failures still apply to a run that just completed.
    case 'warn': return (isActive(s) || s.status === 'completed') && s.warnings.length < 20 ? (s.warnings.push(e.message.slice(0, 300)), true) : false;
    default: return false;
  }
}

function onFatal(s: SyncState, message: string, now: number, fx: SyncEffect[]): boolean {
  if (!isActive(s) && s.status !== 'completed') return false;
  s.status = 'failed';
  s.error = message.slice(0, 300);
  delete s.attention;
  s.finishedAt = now;
  fx.push({ type: 'driver_stop' }, { type: 'clear_seen' }, { type: 'close_window' });
  return true;
}

// ---------------------------------------------------------------------------------------------------------------- commands

function onStart(s: SyncState, e: Extract<SyncEvent, { type: 'start' }>, fx: SyncEffect[]): boolean {
  if (isActive(s)) return false; // one run at a time; the caller reports the refusal
  const config: SyncConfig = { ...DEFAULT_SYNC_CONFIG, ...(e.config ?? {}) };
  const fresh = initialSyncState(e.platform);
  const seq = s.seq;
  for (const k of Object.keys(s)) delete (s as unknown as Record<string, unknown>)[k]; // nothing of the previous run may leak into this one
  Object.assign(s, fresh, {
    seq,
    runId: e.runId,
    status: 'running' as const,
    requestedMode: e.mode,
    // An incremental pass may stop early, which is only safe if a complete pass has already read the whole list once.
    mode: e.mode === 'incremental' && e.hasCompletedBefore ? ('incremental' as const) : ('full' as const),
    startedAt: e.now,
    lastProgressAt: e.now,
    config,
  });
  if (e.mode === 'incremental' && !e.hasCompletedBefore) s.warnings.push('No complete pass has run yet, so this sync reads everything.');
  if (e.boundHandle !== undefined) s.boundHandle = e.boundHandle;
  if (e.boundId !== undefined) s.boundId = e.boundId;
  fx.push({ type: 'open', target: s.target });
  return true;
}

function onCancel(s: SyncState, now: number, fx: SyncEffect[]): boolean {
  if (!isActive(s)) return false;
  s.status = 'cancelled';
  s.finishedAt = now;
  delete s.attention;
  fx.push({ type: 'driver_stop' }, { type: 'clear_seen' }, { type: 'close_window' });
  return true;
}

function onPause(s: SyncState, fx: SyncEffect[]): boolean {
  if (s.status !== 'running') return false;
  s.status = 'paused';
  fx.push({ type: 'driver_stop' });
  return true;
}

function onResume(s: SyncState, now: number, fx: SyncEffect[]): boolean {
  if (s.status !== 'paused' && s.status !== 'needs_attention') return false;
  s.status = 'running';
  delete s.attention;
  s.lastProgressAt = now;
  s.stallRetries = 0;
  s.badStreak = 0;
  fx.push({ type: 'resume_target', target: s.target });
  return true;
}

function onVisible(s: SyncState, now: number, fx: SyncEffect[]): boolean {
  if (s.status !== 'needs_attention' || s.attention?.reason !== 'tab_hidden') return false;
  s.status = 'running';
  delete s.attention;
  s.lastProgressAt = now;
  fx.push({ type: 'resume_target', target: s.target });
  return true;
}

// ---------------------------------------------------------------------------------------------------------------- attention

function attention(s: SyncState, reason: AttentionReason, now: number, fx: SyncEffect[], message?: string): boolean {
  s.status = 'needs_attention';
  s.attention = { reason, message: message ?? ATTENTION_MESSAGES[reason], at: now };
  fx.push({ type: 'driver_stop' });
  return true;
}

// ---------------------------------------------------------------------------------------------------------------- the page driver

function onReady(s: SyncState, e: Extract<SyncEvent, { type: 'driver_ready' }>, fx: SyncEffect[]): boolean {
  if (e.pageState === 'login') return attention(s, 'login_required', e.now, fx);
  if (e.pageState === 'captcha') return attention(s, 'captcha', e.now, fx);
  if (e.pageState !== 'ok') return false; // interstitial / not yet the real page: the driver reports again once it is

  if (e.handle === undefined) return attention(s, 'login_required', e.now, fx);
  const viewer = lc(e.handle)!;
  const ref = (handle: string, id: string | undefined) => ({ platform: s.platform, handle, ...(id !== undefined ? { id } : {}) });
  const seenNow = ref(e.handle, e.id);
  // By stable id when both sides have one (a username change is the same person), otherwise by handle.
  if (s.boundHandle !== undefined && matchAccount(ref(s.boundHandle, s.boundId), seenNow) === 'different') return attention(s, 'wrong_account', e.now, fx);
  if (s.handle !== undefined && matchAccount(ref(s.handle, s.accountId), seenNow) === 'different') return attention(s, 'wrong_account', e.now, fx);
  s.handle = e.handle;
  if (e.id !== undefined) s.accountId = e.id;
  if (e.view.pageHandle !== undefined && lc(e.view.pageHandle) !== viewer) return attention(s, 'not_own_profile', e.now, fx);

  if (s.phase === 'start') {
    s.phase = 'saved';
    s.target = { kind: 'saved' };
    s.lastProgressAt = e.now;
    fx.push({ type: 'open', target: s.target });
    return true;
  }

  const onRightPage =
    s.target.kind === 'saved' ? e.view.kind === 'profile'
    : s.target.kind === 'collection' ? e.view.kind === 'collection' && e.view.collectionId === s.target.id
    : true;
  if (onRightPage) {
    fx.push({ type: 'driver_start', target: s.target });
    return true;
  }
  // Redirected somewhere else: reload the target, but not forever.
  return retryTarget(s, e.now, fx);
}

/** Reload the current list; after too many attempts ask the user. */
function retryTarget(s: SyncState, now: number, fx: SyncEffect[]): boolean {
  if (s.stallRetries >= s.config.maxStallRetries) return attention(s, 'stalled', now, fx);
  s.stallRetries += 1;
  return reload(s, now, fx);
}

function reload(s: SyncState, now: number, fx: SyncEffect[]): boolean {
  s.lastProgressAt = now;
  s.chain = { gap: false };
  fx.push({ type: 'open', target: s.target });
  return true;
}

function onStall(s: SyncState, now: number, fx: SyncEffect[]): boolean {
  return retryTarget(s, now, fx);
}

// ---------------------------------------------------------------------------------------------------------------- capture events

function onRejected(s: SyncState, reason: string, now: number, fx: SyncEffect[]): boolean {
  switch (reason) {
    case 'identity_unknown': return attention(s, 'login_required', now, fx);
    case 'account_mismatch': return attention(s, 'wrong_account', now, fx);
    case 'not_own_profile':
    case 'owner_mismatch': return attention(s, 'not_own_profile', now, fx);
    case 'bad_envelope':
      s.badStreak += 1;
      if (s.badStreak >= s.config.maxBadPages) return attention(s, 'blocked', now, fx);
      return true;
    case 'ingest_failed':
      s.storageFailures += 1;
      if (s.storageFailures >= s.config.maxStorageFailures) {
        s.status = 'failed';
        s.error = 'The local database kept failing to save what was read. Nothing more was read.';
        s.finishedAt = now;
        fx.push({ type: 'driver_stop' }, { type: 'clear_seen' }, { type: 'close_window' });
      }
      return true;
    default: return false; // sender / malformed / too_large / stale ...: not evidence about the sync itself
  }
}

function onPage(s: SyncState, p: SyncPage, now: number, fx: SyncEffect[]): boolean {
  // The collection list can arrive while we are waiting for it after the saved list finished.
  if (s.status === 'needs_attention' && s.attention?.reason === 'open_collections' && p.role === 'collections') {
    s.status = 'running';
    delete s.attention;
    absorbCollections(s, p);
    s.lastProgressAt = now;
    advance(s, now, fx);
    return true;
  }
  // What collections exist (and their declared sizes) is plain information: take it whenever a run is active, even while waiting for the
  // user (in guided mode the list arrives BEFORE the saved list the user just opened, and must not be lost).
  if (isActive(s) && s.status !== 'running') {
    if (p.role === 'collections') { absorbCollections(s, p); return true; }
    if (p.role === 'collection_info') {
      const c = s.collections.find((x) => x.id === p.collectionId);
      if (c && p.declaredTotal !== undefined) c.declaredTotal = p.declaredTotal;
      if (c) return true;
    }
  }
  // Guided mode: the list never loaded by itself, the user opened it in the sync window, and pages started arriving.
  if (s.status === 'needs_attention' && s.attention?.reason === 'stalled' && p.items > 0 && isCurrentList(s, p)) {
    s.status = 'running';
    delete s.attention;
    s.stallRetries = 0;
    s.chain = { gap: false };
    fx.push({ type: 'resume_target', target: s.target });
  }
  if (s.status !== 'running') return false;

  s.badStreak = 0;
  s.storageFailures = 0;

  if (p.role === 'collections') { absorbCollections(s, p); s.lastProgressAt = now; return true; }
  if (p.role === 'collection_info') {
    const c = s.collections.find((x) => x.id === p.collectionId);
    if (c && p.declaredTotal !== undefined) c.declaredTotal = p.declaredTotal;
    return c !== undefined;
  }

  if (p.role === 'saved') {
    if (s.target.kind !== 'saved') return false;
    return onSavedPage(s, p, now, fx);
  }

  // role === 'collection'
  if (s.target.kind !== 'collection' || p.collectionId !== s.target.id) return false;
  return onCollectionPage(s, p, now, fx);
}

function isCurrentList(s: SyncState, p: SyncPage): boolean {
  if (p.role === 'saved') return s.target.kind === 'saved';
  if (p.role === 'collection') return s.target.kind === 'collection' && p.collectionId === s.target.id;
  return false;
}

const MORE_COLLECTIONS = 'The platform says there are more collections than it sent at once, so some may not have been read. Open the collections view, scroll it, then run a full sync.';

function absorbCollections(s: SyncState, p: SyncPage): void {
  s.collectionsListed = true;
  if (p.hasMore === true && !s.warnings.includes(MORE_COLLECTIONS) && s.warnings.length < 20) s.warnings.push(MORE_COLLECTIONS);
  for (const c of p.collections ?? []) {
    const existing = s.collections.find((x) => x.id === c.id);
    if (existing) {
      existing.name = c.name;
      if (c.declaredTotal !== undefined) existing.declaredTotal = c.declaredTotal;
    } else {
      s.collections.push({ id: c.id, name: c.name, status: 'pending', pages: 0, items: 0, ...(c.declaredTotal !== undefined ? { declaredTotal: c.declaredTotal } : {}) });
    }
  }
}

/** Track whether the pages of the current list chain. A duplicate page is still a page of the chain (it replays an earlier one). */
function trackChain(s: SyncState, p: SyncPage): void {
  const req = p.requestCursor;
  if (req === undefined || req === '0') s.chain.gap = false; // the start of a list, e.g. after a reload
  else if (s.chain.cursor === undefined || req !== s.chain.cursor) s.chain.gap = true; // joined mid-list, or a page went missing
  s.chain.cursor = p.responseCursor;
}

function count(s: SyncState, p: SyncPage, now: number): void {
  s.totals.pages += 1;
  s.totals.items += p.items;
  s.totals.inserted += p.inserted;
  s.totals.reindexed += p.reindexed;
  s.lastProgressAt = now;
  if (p.items > 0) s.stallRetries = 0;
}

function overCap(s: SyncState, now: number, fx: SyncEffect[]): boolean {
  if (s.totals.pages < s.config.maxPages) return false;
  s.status = 'failed';
  s.error = `Stopped after ${s.totals.pages} pages (the per-run limit). What was read is saved; start another sync to continue.`;
  s.finishedAt = now;
  fx.push({ type: 'driver_stop' }, { type: 'clear_seen' }, { type: 'close_window' });
  return true;
}

function onSavedPage(s: SyncState, p: SyncPage, now: number, fx: SyncEffect[]): boolean {
  count(s, p, now);
  s.saved.pages += 1;
  s.saved.items += p.items;
  s.saved.inserted += p.inserted;
  s.saved.knownStreak = p.items > 0 && p.inserted === 0 ? s.saved.knownStreak + 1 : 0;
  trackChain(s, p);
  if (overCap(s, now, fx)) return true;

  if (p.hasMore === false) {
    if (s.chain.gap) return listIncomplete(s, now, fx, 'the saved list');
    s.saved.done = 'complete';
    fx.push({ type: 'driver_stop' }, { type: 'mark_complete_pass' });
    if (s.mode === 'full') fx.push({ type: 'reconcile', scope: 'saved' });
    return afterSaved(s, now, fx);
  }
  if (s.mode === 'incremental' && s.saved.knownStreak >= s.config.knownPagesToStop) {
    s.saved.done = 'early';
    fx.push({ type: 'driver_stop' });
    return afterSaved(s, now, fx);
  }
  return true;
}

/** A list ended, but its pages did not chain: re-read it from the top, and if that keeps failing, finish it without claiming completeness. */
function listIncomplete(s: SyncState, now: number, fx: SyncEffect[], what: string): boolean {
  // Counted separately from stalls: reading pages successfully must not reset it, or a page that is always missing would loop forever.
  if (s.chainRetries < s.config.maxStallRetries) { s.chainRetries += 1; return reload(s, now, fx); }
  s.warnings.push(`Some pages of ${what} were missed, so it may be incomplete and nothing was marked unavailable. Run a full sync again.`);
  if (s.target.kind === 'saved') {
    s.saved.done = 'partial';
    fx.push({ type: 'driver_stop' });
    return afterSaved(s, now, fx);
  }
  const c = activeCollection(s);
  if (c) { c.status = 'done'; c.note = 'incomplete'; }
  s.chainRetries = 0;
  fx.push({ type: 'driver_stop' });
  advance(s, now, fx);
  return true;
}

function afterSaved(s: SyncState, now: number, fx: SyncEffect[]): boolean {
  s.stallRetries = 0;
  s.chainRetries = 0;
  s.chain = { gap: false };
  if (!s.collectionsListed) return attention(s, 'open_collections', now, fx);
  advance(s, now, fx);
  return true;
}

function onCollectionPage(s: SyncState, p: SyncPage, now: number, fx: SyncEffect[]): boolean {
  const c = activeCollection(s);
  if (!c) return false;
  count(s, p, now);
  c.pages += 1;
  c.items += p.items;
  trackChain(s, p);
  if (overCap(s, now, fx)) return true;
  if (p.hasMore !== false) return true;

  if (s.chain.gap) return listIncomplete(s, now, fx, `the collection "${c.name}"`);
  c.status = 'done';
  fx.push({ type: 'driver_stop' });
  if (s.mode === 'full') fx.push({ type: 'reconcile', scope: 'collection', collectionId: c.id });
  s.stallRetries = 0;
  s.chainRetries = 0;
  s.chain = { gap: false };
  advance(s, now, fx);
  return true;
}

/** Move to the next collection, or finish the run. */
function advance(s: SyncState, now: number, fx: SyncEffect[]): void {
  const next = s.collections.find((c) => c.status === 'pending');
  if (next) {
    next.status = 'active';
    s.phase = 'collections';
    s.target = { kind: 'collection', id: next.id, name: next.name } satisfies SyncTarget;
    s.chain = { gap: false };
    fx.push({ type: 'open', target: s.target });
    return;
  }
  s.status = 'completed';
  s.phase = 'done';
  s.finishedAt = now;
  if (!fx.some((f) => f.type === 'driver_stop')) fx.push({ type: 'driver_stop' });
  fx.push({ type: 'clear_seen' }, { type: 'close_window' });
}

