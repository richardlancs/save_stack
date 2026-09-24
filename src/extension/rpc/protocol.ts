// The typed RPC contract between any UI surface and the database owner.
//
//   side panel / popup / content script  --chrome.runtime-->  service worker  --chrome.runtime-->  offscreen doc  --postMessage-->  DB Worker
//
// This file is TYPES + constants only, so a UI in any framework can import it without pulling in the extension.
// See docs/UI_CONTRACT.md.

import type {
  ExportBundle,
  ParsedBatch,
  ReconcileInput,
  ReconcileResult,
  StorageStats,
  StoredCollection,
  StoredItem,
  UpsertResult,
} from '../../core/model';
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

export interface Settings {
  /** Reserved. Nothing is configurable in v1 yet. */
  [key: string]: unknown;
}

type Void = void;

/** Every method: its parameters and its result. */
export interface Methods {
  // ---- implemented in M1
  ping: { params: Void; result: { pong: true; rpcVersion: number; schemaVersion: number; storage: string } };
  getStats: { params: Void; result: StorageStats };
  getCollections: { params: Void; result: StoredCollection[] };
  getItem: { params: { platform: string; externalId: string }; result: StoredItem | null };
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

  // ---- declared now, implemented later (calls return NOT_IMPLEMENTED until then)
  startSync: { params: SyncOptions; result: null }; //                            M4
  pauseSync: { params: Void; result: null }; //                                   M4
  resumeSync: { params: Void; result: null }; //                                  M4
  cancelSync: { params: Void; result: null }; //                                  M4
  getSettings: { params: Void; result: Settings }; //                             M6
  setSettings: { params: Settings; result: Settings }; //                         M6
}

export type MethodName = keyof Methods;

export const IMPLEMENTED_METHODS = [
  'ping', 'getStats', 'getCollections', 'getItem', 'exportData', 'importData', 'wipeData', 'upsertBatch', 'reconcile',
  'search', 'getChipInfo', 'explainMatch',
] as const satisfies readonly MethodName[];
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
