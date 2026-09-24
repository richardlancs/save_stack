// The Chrome-backed parts of the sync coordinator's environment: persistence in chrome.storage.local, the dedicated sync window, and
// the messaging channel to the page driver. Thin on purpose (no decisions here); exercised by the end-to-end run, since the logic that
// uses them is unit-tested against fakes of exactly these interfaces.

import type { SyncState } from '../../core/sync/types';
import type { LastPass, SyncStore, SyncWindowRecord, SyncWindows } from './coordinator';
import type { DriverCommand } from './driver';

export const SYNC_ALARM = 'scroganize-sync-heartbeat';
export const SYNC_PROGRESS_TARGET = 'sync-progress';

const KEY = {
  state: 'scroganize.sync.state',
  window: 'scroganize.sync.window',
  last: (platform: string) => `scroganize.sync.last.${platform}`,
  boot: 'scroganize.boot',
  seenIndex: 'scroganize.sync.seenIndex',
  seen: (runId: string, bucket: string, chunk: number) => `scroganize.sync.seen.${runId}.${bucket}.${chunk}`,
} as const;

type SeenIndex = Record<string, Record<string, number>>; // runId -> bucket -> number of chunks

const local = () => chrome.storage.local;

/**
 * An id for THIS browser session. chrome.storage.session survives the service worker being stopped but not the browser being closed,
 * and tab ids start over in every session, so a stored window record from an earlier session must never be trusted: its tab id could
 * belong to one of the user's own tabs now.
 */
let boot: Promise<string> | undefined;
export const bootId = (): Promise<string> => (boot ??= (async () => {
  try {
    const got = (await chrome.storage.session.get(KEY.boot))[KEY.boot] as string | undefined;
    if (got) return got;
    const fresh = crypto.randomUUID();
    await chrome.storage.session.set({ [KEY.boot]: fresh });
    return fresh;
  } catch { return 'no-session-storage'; }
})());
/** Test seam: forget the cached id (a new "browser session" in a unit test). */
export const resetBootIdForTests = (): void => { boot = undefined; };

interface StoredWindow extends SyncWindowRecord { boot?: string }

export const chromeSyncStore: SyncStore = {
  loadState: async () => (await local().get(KEY.state))[KEY.state] as SyncState | undefined,
  saveState: (s) => local().set({ [KEY.state]: s }),
  loadWindow: async () => {
    const rec = (await local().get(KEY.window))[KEY.window] as StoredWindow | undefined;
    if (!rec || rec.boot !== (await bootId())) return undefined; // recorded in an earlier browser session: it is not our window
    return { tabId: rec.tabId, windowId: rec.windowId };
  },
  saveWindow: async (w) => { if (w) await local().set({ [KEY.window]: { ...w, boot: await bootId() } satisfies StoredWindow }); else await local().remove(KEY.window); },
  loadLast: async (platform) => (await local().get(KEY.last(platform)))[KEY.last(platform)] as LastPass | undefined,
  saveLast: (platform, last) => local().set({ [KEY.last(platform)]: last }),
  clearLast: (platform) => local().remove(KEY.last(platform)),

  // Ids read during a run are appended as small chunks (one write per page), never rewritten, so a long run stays cheap.
  seenAppend: async (runId, bucket, ids) => {
    const index = ((await local().get(KEY.seenIndex))[KEY.seenIndex] ?? {}) as SeenIndex;
    const run = (index[runId] ??= {});
    const chunk = run[bucket] ?? 0;
    run[bucket] = chunk + 1;
    await local().set({ [KEY.seen(runId, bucket, chunk)]: ids, [KEY.seenIndex]: index });
  },
  seenRead: async (runId, bucket) => {
    const index = ((await local().get(KEY.seenIndex))[KEY.seenIndex] ?? {}) as SeenIndex;
    const n = index[runId]?.[bucket] ?? 0;
    if (n === 0) return [];
    const keys = Array.from({ length: n }, (_, i) => KEY.seen(runId, bucket, i));
    const got = await local().get(keys);
    return keys.flatMap((k) => (got[k] as string[] | undefined) ?? []);
  },
  seenClear: async (runId) => {
    const index = ((await local().get(KEY.seenIndex))[KEY.seenIndex] ?? {}) as SeenIndex;
    const run = index[runId];
    if (!run) return;
    const keys = Object.entries(run).flatMap(([bucket, n]) => Array.from({ length: n }, (_, i) => KEY.seen(runId, bucket, i)));
    delete index[runId];
    await local().remove(keys);
    await local().set({ [KEY.seenIndex]: index });
  },
};

export const chromeSyncWindows: SyncWindows = {
  open: async (url) => {
    const win = await chrome.windows.create({ url, type: 'normal', focused: true, width: 1100, height: 850 });
    const tab = win?.tabs?.[0];
    if (!win || win.id === undefined || tab?.id === undefined) throw new Error('the browser did not open a window');
    return { tabId: tab.id, windowId: win.id };
  },
  exists: async (tabId) => {
    try { await chrome.tabs.get(tabId); return true; } catch { return false; }
  },
  navigate: async (rec, url) => {
    await chrome.tabs.update(rec.tabId, { url, active: true });
    await chrome.windows.update(rec.windowId, { focused: true, state: 'normal' }).catch(() => undefined);
  },
  // Close OUR tab, not the window: the user may have opened or dragged tabs of their own into it (an emptied window closes itself).
  close: async (rec) => { await chrome.tabs.remove(rec.tabId); },
};

/** Deliver a command to the page driver in the sync window. Resolves false when nobody is listening (page not ready, tab gone). */
export async function sendToDriver(tabId: number, command: DriverCommand): Promise<boolean> {
  try { await chrome.tabs.sendMessage(tabId, { driver: command }); return true; } catch { return false; }
}

export const chromeAlarm = {
  // Only when absent: re-creating it on every event would restart its period each time and starve the heartbeat.
  arm: (): void => { void chrome.alarms.get(SYNC_ALARM).then((a) => (a ? undefined : chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 0.5 }))).catch(() => undefined); },
  disarm: (): void => { void chrome.alarms.clear(SYNC_ALARM); },
};
