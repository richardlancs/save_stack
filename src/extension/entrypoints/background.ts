// The service worker: an RPC ROUTER. It owns no data and keeps no state that must survive being killed (MV3 workers
// die after ~30 s idle). It makes sure the offscreen document exists and forwards requests to it.
import { RPC_VERSION, type RpcRequest, type RpcResponse, type RuntimeMessage } from '../rpc/protocol';

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

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
    if (message?.target !== 'db') return false;
    // NB (M3): when content scripts start sending capture batches, check `_sender.tab` / origin here.
    void forward(message.request).then(sendResponse);
    return true;
  });

  // Test-only hooks. Present ONLY in builds made with WXT_E2E_HOOKS=1 (which go to .output-e2e), never in a normal build.
  if (import.meta.env.WXT_E2E_HOOKS) {
    (globalThis as Record<string, unknown>).__scroganize = {
      forward,
      /** Same as forward, plus how long the SW -> offscreen -> worker -> back round trip took (excludes the Playwright transfer). */
      forwardTimed: async (request: RpcRequest) => {
        const t0 = performance.now();
        const response = await forward(request);
        return { response, swMs: performance.now() - t0 };
      },
      closeOffscreen: () => chrome.offscreen.closeDocument(),
    };
  }
});
