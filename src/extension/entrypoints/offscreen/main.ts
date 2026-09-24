// M0 SPIKE offscreen document: spawns DB workers and relays results to the service worker.
import type { SpikeOptions } from '../../../../bench/spike-core';

const spawn = () => new Worker(new URL('./db.worker.ts', import.meta.url), { type: 'module' });

function call<T>(w: Worker, msg: Record<string, unknown>): Promise<T> {
  const id = Math.floor(Math.random() * 1e9);
  return new Promise<T>((resolve, reject) => {
    const onMsg = (ev: MessageEvent) => {
      const d = ev.data as { id?: number; ok?: boolean; result?: T; error?: string; log?: string };
      if (d.log !== undefined) { relayLog(d.log); return; }
      if (d.id !== id) return;
      w.removeEventListener('message', onMsg);
      d.ok ? resolve(d.result as T) : reject(new Error(d.error));
    };
    w.addEventListener('message', onMsg);
    w.addEventListener('error', (e) => reject(new Error('worker error: ' + e.message)), { once: true });
    w.postMessage({ id, ...msg });
  });
}

const relayLog = (text: string) => {
  console.log('[spike]', text);
  chrome.runtime.sendMessage({ target: 'background', type: 'log', text }).catch(() => {});
};

async function runSpike(opts: (Partial<SpikeOptions> & { mode?: 'full' | 'bench' }) | undefined) {
  if (opts?.mode === 'bench') {
    // Query-only benchmark against the database a previous full run left in OPFS.
    const w = spawn();
    const bench = await call<Record<string, unknown>>(w, { type: 'bench', runs: opts.runs });
    w.terminate();
    return { bench };
  }
  // Phase 1: build + benchmark in worker A, then drop it (terminate releases the OPFS handles).
  const a = spawn();
  const full = await call<Record<string, unknown>>(a, { type: 'full', opts });
  a.terminate();
  const tTerminated = performance.now();

  // Phase 2: cold reopen in a fresh worker. Retries until the old worker's handles are released.
  relayLog('cold reopen in fresh worker');
  const b = spawn();
  const reopen = await call<Record<string, unknown>>(b, { type: 'reopen', retryMs: 15000, runs: 20 });
  reopen.msFromTerminateToReady = Math.round((performance.now() - tTerminated) * 100) / 100;

  // Phase 3: while B still holds the pool, a second worker must be refused (single-owner model).
  relayLog('contention check');
  const c = spawn();
  const contention = await call<Record<string, unknown>>(c, { type: 'contend' });
  c.terminate();
  b.terminate();
  return { full, reopen, contention };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || msg.type !== 'spike:run') return;
  runSpike(msg.opts).then(
    (result) => sendResponse({ ok: true, result }),
    (e) => sendResponse({ ok: false, error: String(e?.stack ?? e) }),
  );
  return true; // async response
});

console.log('[offscreen] ready');
