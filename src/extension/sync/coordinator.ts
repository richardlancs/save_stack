// The sync coordinator: the service worker's side of sync. It owns no logic about WHAT to do (that is the pure state machine in
// core/sync/machine.ts); it feeds events in, persists the state BEFORE acting, performs the effects (open a window, tell the page
// driver to scroll, reconcile the library), and broadcasts the state so a UI can show progress.
//
// Everything that touches Chrome or the database arrives through small interfaces (SyncEnv), so the whole thing is unit-tested
// with fakes, including "the service worker was killed and a new one continues from the persisted state".
//
// Events are processed strictly one at a time, in arrival order.

import { initialSyncState, isActive, reduce } from '../../core/sync/machine';
import type { ReconcileInput, ReconcileResult } from '../../core/model';
import type { SyncConfig, SyncEffect, SyncEvent, SyncMode, SyncPage, SyncPlatformSpec, SyncState, SyncTarget } from '../../core/sync/types';
import type { AcceptedPage } from '../../platforms/capture-protocol';
import type { DriverCommand, DriverConfig, DriverEvent } from './driver';

export interface SyncWindowRecord { tabId: number; windowId: number }
export interface LastPass { completedAt: number }

export interface SyncStore {
  loadState(): Promise<SyncState | undefined>;
  saveState(state: SyncState): Promise<void>;
  loadWindow(): Promise<SyncWindowRecord | undefined>;
  saveWindow(w: SyncWindowRecord | undefined): Promise<void>;
  /** When a COMPLETE pass over the saved list last finished, per platform. */
  loadLast(platform: string): Promise<LastPass | undefined>;
  saveLast(platform: string, last: LastPass): Promise<void>;
  /** Forget that a complete pass ever ran (the library was wiped or replaced: what it held is gone). */
  clearLast(platform: string): Promise<void>;
  /** External ids read during a run, per list ("bucket"), kept between service worker restarts. */
  seenAppend(runId: string, bucket: string, ids: string[]): Promise<void>;
  seenRead(runId: string, bucket: string): Promise<string[]>;
  seenClear(runId: string): Promise<void>;
}

export interface SyncWindows {
  /** Open a new, focused, dedicated window on the url. */
  open(url: string): Promise<SyncWindowRecord>;
  exists(tabId: number): Promise<boolean>;
  /** Navigate an existing sync window and bring it to the front. */
  navigate(rec: SyncWindowRecord, url: string): Promise<void>;
  close(rec: SyncWindowRecord): Promise<void>;
}

export interface SyncData {
  reconcile(input: ReconcileInput): Promise<ReconcileResult>;
  /** Videos currently available, for the "is this reconcile plausible?" check. */
  availableItems(): Promise<number>;
  /** Videos currently stored as members of one collection, for the same check. */
  collectionSize(platform: string, collectionExternalId: string): Promise<number>;
  /** The account the library is bound to (from the database), if any. */
  boundAccount(): Promise<{ handle: string; id?: string } | undefined>;
}

export interface SyncEnv {
  now(): number;
  newRunId(): string;
  spec: SyncPlatformSpec;
  store: SyncStore;
  windows: SyncWindows;
  /** Deliver a command to the page driver in the sync window. Resolves false if it could not be delivered. */
  sendToDriver(tabId: number, command: DriverCommand): Promise<boolean>;
  data: SyncData;
  broadcast(state: SyncState): void;
  /** Keep a heartbeat while a run is active (recovers from a hung window and from a killed service worker). */
  alarm: { arm(): void; disarm(): void };
  syncConfig?: Partial<SyncConfig>;
  driverConfig?: Partial<DriverConfig>;
}

export type CapturedPage = AcceptedPage;

/** Where a capture came from. Only the sync window's own tab may move a run along. */
export interface CaptureOrigin { tabId?: number }

export class SyncBusyError extends Error {
  constructor() { super('A sync is already in progress'); this.name = 'SyncBusyError'; }
}

/** Reading fewer than this share of the videos already stored means the pass was not really complete: do not mark the rest unavailable. */
const MIN_PLAUSIBLE_SHARE = 0.5;
const MIN_LIBRARY_FOR_CHECK = 20;

export interface SyncCoordinator {
  init(): Promise<SyncState>;
  start(mode: SyncMode): Promise<SyncState>;
  pause(): Promise<SyncState>;
  resume(): Promise<SyncState>;
  cancel(): Promise<SyncState>;
  status(): Promise<SyncState>;
  onCaptured(page: CapturedPage, from?: CaptureOrigin): Promise<void>;
  onCaptureRejected(reason: string, from?: CaptureOrigin): Promise<void>;
  onDriverEvent(event: DriverEvent, sender: { tabId?: number }): Promise<void>;
  onTabRemoved(tabId: number): Promise<void>;
  onAlarm(): Promise<void>;
  /** The library was wiped or replaced: a run in progress no longer makes sense. */
  onLibraryReplaced(): Promise<void>;
}

export function createSyncCoordinator(env: SyncEnv): SyncCoordinator {
  let state: SyncState | undefined;
  let chain: Promise<unknown> = Promise.resolve();

  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };

  const load = async (): Promise<SyncState> => {
    if (state) return state;
    let stored: SyncState | undefined;
    try { stored = await env.store.loadState(); } catch { stored = undefined; }
    state = stored && stored.v === 1 ? stored : initialSyncState(env.spec.platform);
    return state;
  };

  function urlFor(target: SyncTarget, s: SyncState): string {
    if (target.kind === 'home' || s.handle === undefined) return env.spec.homeUrl;
    return target.kind === 'saved' ? env.spec.savedUrl(s.handle) : env.spec.collectionUrl(s.handle, { id: target.id, name: target.name });
  }

  async function openTarget(target: SyncTarget, s: SyncState): Promise<void> {
    const url = urlFor(target, s);
    const rec = await env.store.loadWindow();
    if (rec && (await env.windows.exists(rec.tabId))) {
      await env.windows.navigate(rec, url);
      return;
    }
    await env.store.saveWindow(await env.windows.open(url));
  }

  async function perform(effect: SyncEffect, s: SyncState, followUps: SyncEvent[]): Promise<void> {
    switch (effect.type) {
      case 'open': return openTarget(effect.target, s);
      case 'resume_target': {
        const rec = await env.store.loadWindow();
        if (rec && (await env.windows.exists(rec.tabId)) && (await env.sendToDriver(rec.tabId, { cmd: 'probe' }))) return; // the driver answers with `ready`
        return openTarget(effect.target, s);
      }
      case 'driver_start': {
        const rec = await env.store.loadWindow();
        if (rec) await env.sendToDriver(rec.tabId, { cmd: 'start', reveal: effect.target.kind === 'saved', ...(env.driverConfig ? { config: env.driverConfig } : {}) });
        return;
      }
      case 'driver_stop': {
        const rec = await env.store.loadWindow();
        if (rec) await env.sendToDriver(rec.tabId, { cmd: 'stop' });
        return;
      }
      case 'mark_complete_pass': await env.store.saveLast(s.platform, { completedAt: env.now() }); return;
      case 'close_window': {
        const rec = await env.store.loadWindow();
        if (rec) { await env.store.saveWindow(undefined); await env.windows.close(rec).catch(() => undefined); }
        return;
      }
      case 'clear_seen': await env.store.seenClear(s.runId); return;
      case 'reconcile': return reconcile(effect, s, followUps);
    }
  }

  async function reconcile(effect: Extract<SyncEffect, { type: 'reconcile' }>, s: SyncState, followUps: SyncEvent[]): Promise<void> {
    const warn = (message: string): void => { followUps.push({ type: 'warn', now: env.now(), message }); };
    if (effect.scope === 'saved') {
      const ids = [...new Set(await env.store.seenRead(s.runId, 'saved'))]; // a replayed page repeats ids: count each video once
      const stored = await env.data.availableItems();
      if (ids.length === 0) return warn('Nothing was read from the saved list, so no video was marked unavailable.');
      if (stored >= MIN_LIBRARY_FOR_CHECK && ids.length < stored * MIN_PLAUSIBLE_SHARE) {
        return warn(`Only ${ids.length} of ${stored} stored videos were seen, which is implausibly few, so no video was marked unavailable.`);
      }
      await env.data.reconcile({ platform: s.platform, seenExternalIds: ids });
      return;
    }
    const ids = [...new Set(await env.store.seenRead(s.runId, effect.collectionId))];
    const c = s.collections.find((x) => x.id === effect.collectionId);
    const declared = c?.declaredTotal ?? 0;
    if (ids.length === 0 && declared > 0) return warn(`"${c?.name ?? 'A collection'}" came back empty although the platform says it has videos, so its contents were left as they were.`);
    // Same guard as the saved list: a pass that saw far fewer videos than the collection is known to hold was not really complete.
    const expected = Math.max(await env.data.collectionSize(s.platform, effect.collectionId), declared);
    if (expected >= MIN_LIBRARY_FOR_CHECK && ids.length < expected * MIN_PLAUSIBLE_SHARE) {
      return warn(`Only ${ids.length} of about ${expected} videos in "${c?.name ?? 'a collection'}" were seen, which is implausibly few, so its contents were left as they were.`);
    }
    await env.data.reconcile({ platform: s.platform, collectionExternalId: effect.collectionId, seenExternalIds: ids, allowEmpty: true });
  }

  /** Reduce one event, persist, act, then feed back anything the acting produced (warnings, failures). */
  async function dispatch(event: SyncEvent): Promise<SyncState> {
    const queue: SyncEvent[] = [event];
    let last = await load();
    while (queue.length > 0) {
      const ev = queue.shift()!;
      const before = last;
      const step = reduce(before, ev);
      if (step.state === before) continue;
      last = step.state;
      state = last;
      await env.store.saveState(last); // persist BEFORE acting: a killed worker resumes from here
      const followUps: SyncEvent[] = [];
      for (const effect of step.effects) {
        try { await perform(effect, last, followUps); }
        catch (e) {
          followUps.push({ type: 'fatal', now: env.now(), message: `Could not ${effect.type.replace('_', ' ')}: ${e instanceof Error ? e.message : String(e)}` });
          break;
        }
      }
      queue.push(...followUps);
      env.broadcast(last);
    }
    if (last.status === 'running') env.alarm.arm(); else env.alarm.disarm();
    return last;
  }

  /** While a run is active, captures from any tab but the sync window's own are ignored by the sync (the library still stores them). */
  async function fromOtherTab(s: SyncState, from: CaptureOrigin | undefined): Promise<boolean> {
    if (!isActive(s) || from?.tabId === undefined) return false;
    const rec = await env.store.loadWindow();
    return rec === undefined || rec.tabId !== from.tabId;
  }

  const pageEvent = (p: CapturedPage): SyncPage | undefined => {
    const role = env.spec.roles[p.kind];
    if (!role) return undefined;
    return {
      role,
      ...(p.collectionId !== undefined ? { collectionId: p.collectionId } : {}),
      hasMore: p.hasMore,
      items: p.itemsDelivered,
      inserted: p.inserted,
      reindexed: p.reindexed,
      duplicate: p.duplicate,
      ...(p.requestCursor !== undefined ? { requestCursor: p.requestCursor } : {}),
      ...(p.responseCursor !== undefined ? { responseCursor: p.responseCursor } : {}),
      ...(p.collections ? { collections: p.collections } : {}),
      ...(p.declaredTotal !== undefined ? { declaredTotal: p.declaredTotal } : {}),
    };
  };

  return {
    init: () => serial(async () => {
      const s = await load();
      // A run that says "running" but has no window of this browser session (the browser was restarted, or the window record never got
      // written) is not running: say so and let the user press Resume. Never open a window or touch a tab on our own.
      if (s.status === 'running' && !(await env.store.loadWindow())) return dispatch({ type: 'tab_closed', now: env.now() });
      if (s.status === 'running') env.alarm.arm(); else env.alarm.disarm();
      return s;
    }),

    start: (mode) => serial(async () => {
      const s = await load();
      if (isActive(s)) throw new SyncBusyError();
      const last = await env.store.loadLast(env.spec.platform);
      const bound = await env.data.boundAccount();
      await env.store.seenClear(s.runId).catch(() => undefined); // leftovers of a previous run
      return dispatch({
        type: 'start', now: env.now(), runId: env.newRunId(), platform: env.spec.platform, mode,
        hasCompletedBefore: last !== undefined, ...(bound !== undefined ? { boundHandle: bound.handle, ...(bound.id !== undefined ? { boundId: bound.id } : {}) } : {}), ...(env.syncConfig ? { config: env.syncConfig } : {}),
      });
    }),
    pause: () => serial(() => dispatch({ type: 'pause', now: env.now() })),
    resume: () => serial(() => dispatch({ type: 'resume', now: env.now() })),
    cancel: () => serial(() => dispatch({ type: 'cancel', now: env.now() })),
    status: () => serial(async () => structuredClone(await load())),

    onCaptured: (p, from) => serial(async () => {
      const s = await load();
      const page = pageEvent(p);
      if (!page || (await fromOtherTab(s, from))) return;
      // Remember what was read, for reconciliation. Duplicates count: they carry the same ids as the page they replay.
      // (The machine also counts a page that arrives while it waits for the user to open a list, so this must too.)
      const listening = s.status === 'running' || (s.status === 'needs_attention' && (s.attention?.reason === 'open_collections' || s.attention?.reason === 'stalled'));
      if (listening && s.mode === 'full' && p.externalIds.length > 0) {
        if (page.role === 'saved' && s.target.kind === 'saved') await env.store.seenAppend(s.runId, 'saved', p.externalIds);
        else if (page.role === 'collection' && s.target.kind === 'collection' && p.collectionId === s.target.id) await env.store.seenAppend(s.runId, p.collectionId, p.externalIds);
      }
      await dispatch({ type: 'page', now: env.now(), page });
    }),

    onCaptureRejected: (reason, from) => serial(async () => {
      if (await fromOtherTab(await load(), from)) return; // someone else's page in an ordinary tab says nothing about the sync window
      await dispatch({ type: 'rejected', now: env.now(), reason });
    }),

    onDriverEvent: (ev, sender) => serial(async () => {
      const rec = await env.store.loadWindow();
      if (!rec || sender.tabId !== rec.tabId) return; // only the sync window's own driver counts
      const now = env.now();
      switch (ev.type) {
        case 'ready': await dispatch({ type: 'driver_ready', now, ...(ev.handle !== undefined ? { handle: ev.handle } : {}), ...(ev.id !== undefined ? { id: ev.id } : {}), pageState: ev.pageState, view: ev.view }); return;
        case 'hidden': await dispatch({ type: 'driver_hidden', now }); return;
        case 'visible': await dispatch({ type: 'driver_visible', now }); return;
        case 'stalled': await dispatch({ type: 'driver_stalled', now }); return;
        case 'blocked': await dispatch({ type: 'driver_blocked', now, pageState: ev.pageState }); return;
      }
    }),

    onTabRemoved: (tabId) => serial(async () => {
      const rec = await env.store.loadWindow();
      if (!rec || rec.tabId !== tabId) return;
      await env.store.saveWindow(undefined);
      await dispatch({ type: 'tab_closed', now: env.now() });
    }),

    onAlarm: () => serial(async () => { await dispatch({ type: 'tick', now: env.now() }); }),

    onLibraryReplaced: () => serial(async () => {
      await dispatch({ type: 'cancel', now: env.now() });
      await env.store.clearLast(env.spec.platform); // the next sync must read everything again, not stop after two known pages
    }),
  };
}
