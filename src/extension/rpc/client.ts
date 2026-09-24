// The client SDK. ZERO UI dependencies and no chrome.* import: the transport is injected, so it works from a
// side panel, a popup, a page injected into tiktok.com, or a unit test. See docs/UI_CONTRACT.md.

import type {
  ChipInfoRequest,
  ChipInfoResponse,
  ExplainRequest,
  ExplainResponse,
  SearchRequest,
  SearchResponse,
} from '../../core/search/types';
import type { ExportBundle, ParsedBatch, ReconcileInput } from '../../core/model';
import {
  RPC_VERSION,
  type MethodName,
  type Methods,
  type RpcErrorCode,
  type RpcRequest,
  type RpcResponse,
  type Settings,
  type SyncOptions,
} from './protocol';

/** Send one request to the database owner and resolve with its response. */
export type Transport = (request: RpcRequest) => Promise<RpcResponse>;

export class RpcCallError extends Error {
  constructor(readonly code: RpcErrorCode, message: string) {
    super(message);
    this.name = 'RpcCallError';
  }
}

let counter = 0;
const newId = (): string => `${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function createClient(send: Transport) {
  async function call<M extends MethodName>(method: M, params?: Methods[M]['params']): Promise<Methods[M]['result']> {
    const request = { v: RPC_VERSION, id: newId(), method, params } as RpcRequest<M>;
    let response: RpcResponse;
    try {
      response = await send(request);
    } catch (e) {
      throw new RpcCallError('UNAVAILABLE', e instanceof Error ? e.message : String(e));
    }
    if (response.id !== request.id && response.id !== '') throw new RpcCallError('INTERNAL', 'response id does not match the request');
    if (!response.ok) throw new RpcCallError(response.error.code, response.error.message);
    return response.result as Methods[M]['result'];
  }

  return {
    call,
    ping: () => call('ping'),
    getStats: () => call('getStats'),
    getCollections: () => call('getCollections'),
    getItem: (platform: string, externalId: string) => call('getItem', { platform, externalId }),
    exportData: () => call('exportData'),
    importData: (bundle: ExportBundle) => call('importData', bundle),
    wipeData: () => call('wipeData'),
    // Search (M2): results first, extras after.
    search: (req: SearchRequest): Promise<SearchResponse> => call('search', req),
    getChipInfo: (req: ChipInfoRequest): Promise<ChipInfoResponse> => call('getChipInfo', req),
    explainMatch: (req: ExplainRequest): Promise<ExplainResponse> => call('explainMatch', req),
    // Sync (M4)
    startSync: (opts: SyncOptions = {}) => call('startSync', opts),
    pauseSync: () => call('pauseSync'),
    resumeSync: () => call('resumeSync'),
    cancelSync: () => call('cancelSync'),
    // Settings (M6)
    getSettings: () => call('getSettings'),
    setSettings: (s: Settings) => call('setSettings', s),
    // Extension-internal (capture / sync pipeline). UIs should not call these.
    upsertBatch: (batch: ParsedBatch) => call('upsertBatch', batch),
    reconcile: (input: ReconcileInput) => call('reconcile', input),
  };
}

export type ScroganizeClient = ReturnType<typeof createClient>;
