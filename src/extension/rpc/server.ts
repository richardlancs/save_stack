// The RPC server: validates an envelope, dispatches to the StorageAdapter, and maps every outcome (including
// exceptions) to an RpcResponse. It has no chrome.* dependency, so it is tested in plain Node.

import { SearchInputError } from '../../core/search/chips';
import { defaultExpander, type TermExpander } from '../../core/search/expander';
import { SearchService } from '../../core/search/service';
import type { StorageAdapter } from '../../core/storage/adapter';
import {
  IMPLEMENTED_METHODS,
  RPC_VERSION,
  type ImplementedMethod,
  type MethodName,
  type Methods,
  type RpcErrorCode,
  type RpcRequest,
  type RpcResponse,
} from './protocol';

export interface RpcServerDeps {
  /** A getter, because wipeData replaces the adapter. */
  adapter: () => StorageAdapter;
  /** Delete the storage file and reopen empty. If absent, wipeData falls back to adapter.wipe(). */
  resetStorage?: () => Promise<void>;
  /** Reported by ping. */
  storage: string;
  /** Override the related-terms layer (tests). */
  expander?: TermExpander;
  /**
   * True if a NEWER search has arrived since `requestId` was issued. Checked when the request starts running, so a stale
   * search queued behind a long operation is dropped instead of wasting the database.
   */
  isSuperseded?: (requestId: string) => boolean;
}

class RpcFailure extends Error {
  constructor(readonly code: RpcErrorCode, message: string) { super(message); }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isImplemented = (m: string): m is ImplementedMethod => (IMPLEMENTED_METHODS as readonly string[]).includes(m);

const need = (cond: boolean, message: string): void => { if (!cond) throw new RpcFailure('BAD_REQUEST', message); };

const ok = <M extends MethodName>(id: string, result: Methods[M]['result']): RpcResponse<M> => ({ v: RPC_VERSION, id, ok: true, result });
const fail = (id: string, code: RpcErrorCode, message: string): RpcResponse => ({ v: RPC_VERSION, id, ok: false, error: { code, message } });

export function createRpcServer(deps: RpcServerDeps): (raw: unknown) => Promise<RpcResponse> {
  const service = () => new SearchService(deps.adapter(), deps.expander ?? defaultExpander);
  const notStale = (p: unknown) => {
    const id = isObject(p) ? p.requestId : undefined;
    if (typeof id === 'string' && deps.isSuperseded?.(id)) throw new RpcFailure('SUPERSEDED', 'a newer search replaced this one');
  };

  const handlers: { [K in ImplementedMethod]: (params: Methods[K]['params']) => Promise<Methods[K]['result']> } = {
    ping: async () => ({ pong: true, rpcVersion: RPC_VERSION, schemaVersion: (await deps.adapter().stats()).schemaVersion, storage: deps.storage }),
    getStats: () => deps.adapter().stats(),
    getCollections: () => deps.adapter().listCollections(),
    getItem: (p) => {
      need(isObject(p) && typeof p.platform === 'string' && typeof p.externalId === 'string', 'getItem needs { platform, externalId }');
      return deps.adapter().getItem(p.platform, p.externalId);
    },
    exportData: () => deps.adapter().exportAll(),
    importData: async (p) => {
      need(isObject(p) && p.format === 'scroganize-export', 'importData needs a Scroganize export bundle');
      await deps.adapter().importAll(p);
      return null;
    },
    wipeData: async () => {
      if (deps.resetStorage) await deps.resetStorage();
      else await deps.adapter().wipe();
      return null;
    },
    upsertBatch: (p) => {
      need(isObject(p) && Array.isArray(p.items), 'upsertBatch needs { items: [...] }');
      return deps.adapter().upsertBatch(p);
    },
    search: async (p) => { notStale(p); return service().search(p); },
    getChipInfo: async (p) => { notStale(p); return service().chipInfo(p); },
    explainMatch: (p) => service().explain(p),
    reconcile: (p) => {
      need(isObject(p) && typeof p.platform === 'string' && Array.isArray(p.seenExternalIds), 'reconcile needs { platform, seenExternalIds: [...] }');
      return deps.adapter().reconcile(p);
    },
  };

  const dispatch = async (raw: unknown): Promise<RpcResponse> => {
    if (!isObject(raw) || raw.v !== RPC_VERSION || typeof raw.id !== 'string' || typeof raw.method !== 'string') {
      return fail(isObject(raw) && typeof raw.id === 'string' ? raw.id : '', 'BAD_REQUEST', `malformed request (expected envelope v${RPC_VERSION} with string id and method)`);
    }
    const { id, method } = raw as unknown as RpcRequest;
    if (!isImplemented(method)) {
      // 'method' is a string here; anything not in the contract at all is a client bug, anything declared is "not yet".
      return fail(id, method in NOT_YET ? 'NOT_IMPLEMENTED' : 'BAD_REQUEST', method in NOT_YET ? `${method} arrives in ${NOT_YET[method]}` : `unknown method "${method}"`);
    }
    try {
      const handler = handlers[method] as (p: unknown) => Promise<unknown>;
      return ok(id, (await handler((raw as { params?: unknown }).params)) as never);
    } catch (e) {
      if (e instanceof RpcFailure) return fail(id, e.code, e.message);
      if (e instanceof SearchInputError) return fail(id, 'BAD_REQUEST', e.message);
      return fail(id, 'INTERNAL', e instanceof Error ? e.message : String(e));
    }
  };

  return async (raw) => {
    const t0 = performance.now();
    const response = await dispatch(raw);
    return { ...response, serverMs: Math.round((performance.now() - t0) * 100) / 100 };
  };
}

/** Declared in the contract, implemented in a later milestone. */
const NOT_YET: Record<string, string> = {
  startSync: 'M4', pauseSync: 'M4', resumeSync: 'M4', cancelSync: 'M4',
  getSettings: 'M6', setSettings: 'M6',
};
