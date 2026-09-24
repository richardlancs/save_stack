// The ONLY place the UI touches the backend. Everything goes through the typed RPC client; the UI never imports database, search or
// platform code (types excepted), so it can be replaced by another UI without touching the core. See docs/UI_CONTRACT.md.

import type { SyncState } from '../core/sync/types';
import { RpcCallError, createClient, isSuperseded } from '../extension/rpc/client';
import { chromeTransport } from '../extension/rpc/chrome-transport';
import type { SyncProgressMessage } from '../extension/rpc/protocol';

export const api = createClient(chromeTransport);
export { isSuperseded, RpcCallError };

/** Sync progress pushed by the service worker on every change. Returns an unsubscribe function. */
export function onSyncProgress(cb: (state: SyncState) => void): () => void {
  const listener = (message: unknown): void => {
    const m = message as Partial<SyncProgressMessage> | null;
    if (m && m.target === 'sync-progress' && m.state) cb(m.state);
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

export function errorMessage(e: unknown): string {
  if (e instanceof RpcCallError) {
    if (e.code === 'UNAVAILABLE') return 'The local database is not reachable right now. Try again in a moment.';
    if (e.code === 'BUSY') return 'A sync is already running.';
    if (e.code === 'ACCOUNT_MISMATCH') return e.message;
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}

/** Save a JSON document as a file (export). */
export function downloadJson(filename: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function readJsonFile(file: File): Promise<unknown> {
  return JSON.parse(await file.text());
}
