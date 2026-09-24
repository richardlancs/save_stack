// The service worker: an RPC ROUTER. It owns no data and keeps no state that must survive being killed (MV3 workers
// die after ~30 s idle). It makes sure the offscreen document exists and forwards requests to it.
import type { CaptureStatus } from '../../platforms/capture-protocol';
import { registry } from '../../platforms/registry';
import { createCapturePipeline, type StatusStore } from '../capture/pipeline';
import { CAPTURE_STATUS_KEY } from '../capture/protocol';
import { createMessageRouter } from '../message-router';
import { mergeSettings, normalizeSettings } from '../../core/settings';
import type { SyncConfig, SyncMode, SyncState } from '../../core/sync/types';
import { chromeAlarm, chromeSyncStore, chromeSyncWindows, sendToDriver, SYNC_ALARM, SYNC_PROGRESS_TARGET } from '../sync/chrome-env';
import { createSyncCoordinator, SyncBusyError } from '../sync/coordinator';
import type { DriverConfig } from '../sync/driver';
import { RPC_VERSION, type Methods, type RpcRequest, type RpcResponse, type RuntimeMessage } from '../rpc/protocol';

const OFFSCREEN_PATH = 'offscreen.html';
const FORWARD_BUDGET_MS = 30_000; // offscreen creation + wasm init + waiting for a previous owner's handles
const RETRYABLE = /Receiving end does not exist|message port closed|Could not establish connection/i;

let creating: Promise<void> | null = null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const unavailable = (id: string, e: unknown): RpcResponse => ({
  v: RPC_VERSION,
  id,
  ok: false,
  error: { code: 'UNAVAILABLE', message: `database unavailable: ${e instanceof Error ? e.message : String(e)}` },
});

/** Singleton: at most one offscreen document, and concurrent callers share one creation. */
async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType] });
  if (existing.length > 0) return;
  creating ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['WORKERS' as chrome.offscreen.Reason],
      justification: 'Owns the local SQLite database in a dedicated Worker (OPFS sync access handles).',
    })
    .catch((e: unknown) => { if (!/single offscreen document/i.test(String(e))) throw e; }) // lost a race: it exists now
    .finally(() => { creating = null; });
  await creating;
}

/**
 * Forward one request to the database owner, (re)creating the offscreen document if Chrome closed it.
 * Retrying is safe because every method is idempotent (upserts, reconcile, import-replace, wipe).
 */
export async function forward(request: RpcRequest): Promise<RpcResponse> {
  const deadline = Date.now() + FORWARD_BUDGET_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      await ensureOffscreen();
      const message: RuntimeMessage = { target: 'offscreen', request };
      const response = (await chrome.runtime.sendMessage(message)) as RpcResponse | undefined;
      if (response) return response;
      throw new Error('empty response from the offscreen document');
    } catch (e) {
      if (Date.now() > deadline || !RETRYABLE.test(String(e))) return unavailable(request.id, e);
      await sleep(100 * Math.min(attempt + 1, 10));
    }
  }
}

const SETTINGS_KEY = 'scroganize.settings';
let settingsChain: Promise<void> = Promise.resolve();
const SYNC_METHODS = ['startSync', 'pauseSync', 'resumeSync', 'cancelSync', 'getSyncStatus'] as const;

const chromeStatusStore: StatusStore = {
  load: async () => (await chrome.storage.local.get(CAPTURE_STATUS_KEY))[CAPTURE_STATUS_KEY] as CaptureStatus | undefined,
  save: (status) => chrome.storage.local.set({ [CAPTURE_STATUS_KEY]: status }),
};

export default defineBackground(() => {
  // Clicking the toolbar icon opens the side panel.
  void chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => undefined);

  const extensionOrigin = new URL(chrome.runtime.getURL('')).origin;

  const pipeline = createCapturePipeline({
    registry,
    ownExtensionId: chrome.runtime.id,
    store: chromeStatusStore,
    ingest: async (batch) => {
      const res = (await forward({ v: RPC_VERSION, id: `cap-${crypto.randomUUID()}`, method: 'upsertBatch', params: batch })) as RpcResponse<'upsertBatch'>;
      if (!res.ok) throw Object.assign(new Error(res.error.message), { code: res.error.code });
      return res.result;
    },
  });

  // Sync: one platform in v1 (the first registered adapter). Pacing/limits are the defaults; only the end-to-end build may override them.
  const syncAdapter = registry.all()[0]!;
  const e2eOptions: { sync?: Partial<SyncConfig>; driver?: Partial<DriverConfig> } = {};
  const dbCall = async <M extends 'reconcile' | 'getStats' | 'getAccount' | 'getCollections'>(method: M, params: Methods[M]['params']): Promise<Methods[M]['result']> => {
    const res = (await forward({ v: RPC_VERSION, id: `sync-${crypto.randomUUID()}`, method, params } as RpcRequest)) as RpcResponse<M>;
    if (!res.ok) throw new Error(res.error.message);
    return res.result;
  };
  const coordinator = createSyncCoordinator({
    now: () => Date.now(),
    newRunId: () => crypto.randomUUID(),
    spec: syncAdapter.sync,
    store: chromeSyncStore,
    windows: chromeSyncWindows,
    sendToDriver,
    data: {
      reconcile: (input) => dbCall('reconcile', input),
      availableItems: async () => (await dbCall('getStats', undefined)).availableItems,
      collectionSize: async (platform, collectionExternalId) => (await dbCall('getCollections', undefined)).find((c) => c.platform === platform && c.externalId === collectionExternalId)?.itemsSeen ?? 0,
      boundAccount: async () => {
        const a = await dbCall('getAccount', { platform: syncAdapter.id });
        return a ? { handle: a.handle, ...(a.id !== undefined ? { id: a.id } : {}) } : undefined;
      },
    },
    broadcast: (state: SyncState) => { void chrome.runtime.sendMessage({ target: SYNC_PROGRESS_TARGET, state }).catch(() => undefined); },
    alarm: chromeAlarm,
    get syncConfig() { return e2eOptions.sync; },
    get driverConfig() { return e2eOptions.driver; },
  });
  pipeline.subscribe({
    accepted: (page, from) => coordinator.onCaptured(page, from),
    rejected: (reason, _kind, from) => coordinator.onCaptureRejected(reason, from),
  });
  chrome.tabs.onRemoved.addListener((tabId) => { void coordinator.onTabRemoved(tabId); });
  chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === SYNC_ALARM) void coordinator.onAlarm(); });
  void coordinator.init();

  const failure = (id: string, code: 'BAD_REQUEST' | 'BUSY' | 'INTERNAL', message: string): RpcResponse => ({ v: RPC_VERSION, id, ok: false, error: { code, message } });
  const handleSync = async (request: RpcRequest): Promise<RpcResponse> => {
    try {
      let result: SyncState;
      switch (request.method) {
        case 'startSync': {
          const mode = (request.params as { mode?: unknown } | undefined)?.mode;
          if (mode !== undefined && mode !== 'incremental' && mode !== 'full') return failure(request.id, 'BAD_REQUEST', 'startSync: mode must be "incremental" or "full"');
          result = await coordinator.start((mode ?? 'incremental') as SyncMode);
          break;
        }
        case 'pauseSync': result = await coordinator.pause(); break;
        case 'resumeSync': result = await coordinator.resume(); break;
        case 'cancelSync': result = await coordinator.cancel(); break;
        default: result = await coordinator.status();
      }
      return { v: RPC_VERSION, id: request.id, ok: true, result } as RpcResponse;
    } catch (e) {
      if (e instanceof SyncBusyError) return failure(request.id, 'BUSY', e.message);
      return failure(request.id, 'INTERNAL', e instanceof Error ? e.message : String(e));
    }
  };

  /** One entry point for every database request from our own pages (and from the e2e hook): SW-owned methods, then the worker. */
  const handleDb = async (request: RpcRequest): Promise<RpcResponse> => {
    if (request === null || typeof request !== 'object') return { v: RPC_VERSION, id: '', ok: false, error: { code: 'BAD_REQUEST', message: 'malformed request' } };
    if ((SYNC_METHODS as readonly string[]).includes(request.method)) return handleSync(request);
    if (request.method === 'getSettings' || request.method === 'setSettings') {
      // One at a time: two patches arriving together must both land (each is a read-modify-write of the same stored object).
      const run = settingsChain.then(async () => {
        const stored = normalizeSettings((await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY]);
        const result = request.method === 'setSettings' ? mergeSettings(stored, request.params) : stored;
        if (request.method === 'setSettings') await chrome.storage.local.set({ [SETTINGS_KEY]: result });
        return result;
      });
      settingsChain = run.then(() => undefined, () => undefined);
      try { return { v: RPC_VERSION, id: request.id, ok: true, result: await run } as RpcResponse; }
      catch (e) { return failure(request.id, 'INTERNAL', e instanceof Error ? e.message : String(e)); }
    }
    if (request.method === 'getCaptureStatus') {
      const status = await pipeline.getStatus();
      return { v: RPC_VERSION, id: request.id, ok: true, result: { ...status, platforms: registry.all().map((a) => ({ id: a.id, displayName: a.displayName })) } } satisfies RpcResponse<'getCaptureStatus'>;
    }
    const replacing = request.method === 'wipeData' || request.method === 'importData';
    // A sync in progress stops FIRST (and closes its window), so a page still in flight cannot write into the new library.
    if (replacing) await coordinator.onLibraryReplaced();
    const response = await forward(request);
    // The library was replaced or emptied: the capture counters and the account it was bound to no longer describe it.
    if (replacing && response.ok) await pipeline.reset();
    return response;
  };

  const route = createMessageRouter({ ownExtensionId: chrome.runtime.id, extensionOrigin, pipeline, handleDb, sync: coordinator, platformMatches: syncAdapter.hostMatches });
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    const answer = route(message, { id: sender.id, origin: sender.origin, frameId: sender.frameId, ...(sender.tab?.id !== undefined ? { tabId: sender.tab.id } : {}) });
    if (!answer) return false; // not ours (e.g. the offscreen document's own messages)
    void answer.then(sendResponse, (e: unknown) => sendResponse({ v: RPC_VERSION, id: '', ok: false, error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) } } satisfies RpcResponse));
    return true;
  });

  // Test-only hooks. Present ONLY in builds made with WXT_E2E_HOOKS=1 (which go to .output-e2e), never in a normal build.
  if (import.meta.env.WXT_E2E_HOOKS) {
    void chrome.storage.local.get('scroganize.e2e.options').then((r) => {
      const o = r['scroganize.e2e.options'] as { sync?: Partial<SyncConfig>; driver?: Partial<DriverConfig> } | undefined;
      if (o) { e2eOptions.sync = o.sync; e2eOptions.driver = o.driver; }
    });
    (globalThis as Record<string, unknown>).__scroganize = {
      forward,
      /** What a UI page's request goes through: also answers getCaptureStatus and resets capture state on wipe/import. */
      rpc: handleDb,
      /** Same as forward, plus how long the SW -> offscreen -> worker -> back round trip took (excludes the Playwright transfer). */
      forwardTimed: async (request: RpcRequest) => {
        const t0 = performance.now();
        const response = await forward(request);
        return { response, swMs: performance.now() - t0 };
      },
      closeOffscreen: () => chrome.offscreen.closeDocument(),
      /** Faster pacing and lower limits for the end-to-end run. Never present in a production build. */
      setSyncOptions: (o: { sync?: Partial<SyncConfig>; driver?: Partial<DriverConfig> }) => {
        e2eOptions.sync = o.sync;
        e2eOptions.driver = o.driver;
        void chrome.storage.local.set({ 'scroganize.e2e.options': o }); // survives the service worker being stopped
      },
    };
  }
});
