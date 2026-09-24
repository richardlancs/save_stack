// The offscreen document: hosts the DB Worker and relays RPC between the service worker and it.
// It contains no logic of its own, only a request/response correlator with a timeout.
import { RPC_VERSION, type RpcResponse, type RuntimeMessage } from '../../rpc/protocol';

const REQUEST_TIMEOUT_MS = 120_000; // generous: import / wipe of a large library

let worker: Worker | null = null;
const pending = new Map<string, (r: RpcResponse) => void>();

const unavailable = (id: string, message: string): RpcResponse => ({ v: RPC_VERSION, id, ok: false, error: { code: 'UNAVAILABLE', message } });

function failAll(message: string): void {
  for (const [id, resolve] of pending) resolve(unavailable(id, message));
  pending.clear();
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('./db.worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (ev: MessageEvent<RpcResponse>) => {
    pending.get(ev.data.id)?.(ev.data);
    pending.delete(ev.data.id);
  };
  w.onerror = (ev) => {
    // A crashed worker released its OPFS handles; the next request starts a fresh one.
    failAll(`database worker crashed: ${ev.message}`);
    w.terminate();
    if (worker === w) worker = null;
  };
  worker = w;
  return w;
}

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return false; // not ours; let the right listener answer
  const { request } = message;
  const answer = new Promise<RpcResponse>((resolve) => {
    const timer = setTimeout(() => { pending.delete(request.id); resolve(unavailable(request.id, 'database request timed out')); }, REQUEST_TIMEOUT_MS);
    pending.set(request.id, (r) => { clearTimeout(timer); resolve(r); });
    try { getWorker().postMessage(request); } catch (e) { pending.delete(request.id); clearTimeout(timer); resolve(unavailable(request.id, String(e))); }
  });
  void answer.then(sendResponse);
  return true; // respond asynchronously
});
