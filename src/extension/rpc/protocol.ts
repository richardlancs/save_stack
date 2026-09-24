// The typed RPC contract between any UI surface and the database owner.
//
//   side panel / popup / content script  --chrome.runtime-->  service worker  --chrome.runtime-->  offscreen doc  --postMessage-->  DB Worker
//
// This file is TYPES + constants only, so a UI in any framework can import it without pulling in the extension.
// See docs/UI_CONTRACT.md.

import type {
  AccountRef,
  ExportBundle,
  ParsedBatch,
  ReconcileInput,
  ReconcileResult,
  StorageStats,
  StoredCollection,
  StoredItem,
  UpsertResult,
} from '../../core/model';
import type { Settings } from '../../core/settings';
import type { SyncState } from '../../core/sync/types';
import type { CaptureStatus } from '../../platforms/capture-protocol';
import type {
  ChipInfoRequest,
  ChipInfoResponse,
  ExplainRequest,
  ExplainResponse,
  SearchRequest,
  SearchResponse,
} from '../../core/search/types';

/** Bump on a breaking change to the envelope or to a method's shape. */
export const RPC_VERSION = 1;

export type RpcErrorCode =
  | 'BAD_REQUEST' //     malformed envelope or params
  | 'NOT_IMPLEMENTED' // declared in the contract, arrives in a later milestone
  | 'SUPERSEDED' //      a newer search replaced this one before it ran; ignore the result
  | 'BUSY' //            a sync is already running
  | 'ACCOUNT_MISMATCH' // the library belongs to a different signed-in account (wipe it to switch)
  | 'UNAVAILABLE' //     the database owner is not reachable / failed to start
  | 'INTERNAL'; //       the operation failed

export interface RpcError {
  code: RpcErrorCode;
  message: string;
}

export interface SyncOptions {
  /** 'incremental' stops a collection at videos already stored; 'full' re-reads everything and reconciles. */
  mode?: 'incremental' | 'full';
}

type Void = void;

/** Every method: its parameters and its result. */
export interface Methods {
  // ---- implemented in M1
  ping: { params: Void; result: { pong: true; rpcVersion: number; schemaVersion: number; storage: string } };
  getStats: { params: Void; result: StorageStats };
  getCollections: { params: Void; result: StoredCollection[] };
  getItem: { params: { platform: string; externalId: string }; result: StoredItem | null };
  /** The account the library is bound to on this platform (null until the first capture). */
  getAccount: { params: { platform: string }; result: AccountRef | null };
  exportData: { params: Void; result: ExportBundle };
  importData: { params: ExportBundle; result: null };
  /** Deletes every row AND reclaims the storage file. */
  wipeData: { params: Void; result: null };
  /** Extension-internal (the capture/sync pipeline). UIs should not call this. */
  upsertBatch: { params: ParsedBatch; result: UpsertResult };
  /** Extension-internal. */
  reconcile: { params: ReconcileInput; result: ReconcileResult };

  // ---- search (M2). Three calls, results first: see docs/UI_CONTRACT.md §4
  search: { params: SearchRequest; result: SearchResponse };
  getChipInfo: { params: ChipInfoRequest; result: ChipInfoResponse };
  explainMatch: { params: ExplainRequest; result: ExplainResponse };

  // ---- capture (M3). Answered by the service worker, not the database: what the page hook has captured so far and whether the platform's format drifted.
  getCaptureStatus: { params: Void; result: CaptureStatus };

  // ---- declared now, implemented later (calls return NOT_IMPLEMENTED until then)
  // ---- sync (M4). Answered by the service worker. Every call returns the sync state after it; `getSyncStatus` reads it any time,
  // and the service worker also broadcasts it to extension pages as a SyncProgressMessage whenever it changes.
  startSync: { params: SyncOptions; result: SyncState }; //                       BUSY if a sync is already running
  pauseSync: { params: Void; result: SyncState };
  resumeSync: { params: Void; result: SyncState };
  cancelSync: { params: Void; result: SyncState };
  getSyncStatus: { params: Void; result: SyncState };
  // ---- settings (M6). Answered by the service worker; a patch of known keys, unknown or invalid values ignored. Returns the full settings.
  getSettings: { params: Void; result: Settings };
  setSettings: { params: Partial<Settings>; result: Settings };
}

export type MethodName = keyof Methods;

/** Handled inside the database owner (the DB Worker). */
export const WORKER_METHODS = [
  'ping', 'getStats', 'getCollections', 'getItem', 'getAccount', 'exportData', 'importData', 'wipeData', 'upsertBatch', 'reconcile',
  'search', 'getChipInfo', 'explainMatch',
] as const satisfies readonly MethodName[];
export type WorkerMethod = (typeof WORKER_METHODS)[number];

/** Handled by the service worker itself (state that lives outside the database). */
export const SERVICE_WORKER_METHODS = ['getCaptureStatus', 'startSync', 'pauseSync', 'resumeSync', 'cancelSync', 'getSyncStatus', 'getSettings', 'setSettings'] as const satisfies readonly MethodName[];
export type ServiceWorkerMethod = (typeof SERVICE_WORKER_METHODS)[number];

export const IMPLEMENTED_METHODS = [...WORKER_METHODS, ...SERVICE_WORKER_METHODS] as const satisfies readonly MethodName[];
export type ImplementedMethod = (typeof IMPLEMENTED_METHODS)[number];

export interface RpcRequest<M extends MethodName = MethodName> {
  v: typeof RPC_VERSION;
  /** Correlates the response. Unique per call. */
  id: string;
  method: M;
  params: Methods[M]['params'];
}

/** `serverMs` = time spent inside the database owner handling this call (diagnostics; separates DB cost from transport cost). */
export type RpcResponse<M extends MethodName = MethodName> =
  | { v: typeof RPC_VERSION; id: string; ok: true; result: Methods[M]['result']; serverMs?: number }
  | { v: typeof RPC_VERSION; id: string; ok: false; error: RpcError; serverMs?: number };

/** The chrome.runtime message wrapper. `target` routes it: 'db' is handled by the service worker, 'offscreen' by the offscreen document. */
export interface RuntimeMessage {
  target: 'db' | 'offscreen';
  request: RpcRequest;
}

/** Broadcast by the service worker (chrome.runtime.sendMessage) to extension pages whenever the sync state changes. */
export interface SyncProgressMessage {
  target: 'sync-progress';
  state: SyncState;
}
