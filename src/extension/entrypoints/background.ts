// M0 SPIKE service worker: creates the offscreen document and exposes a debug hook for the
// Playwright driver (bench/run-spike.mjs). M1 replaces the hook with the typed RPC router.

const logs: string[] = [];

async function ensureOffscreen(): Promise<void> {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType] });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS' as chrome.offscreen.Reason],
    justification: 'Owns the local SQLite database in a dedicated Worker (OPFS sync access handles).',
  });
}

async function sendToOffscreen(message: unknown): Promise<any> {
  // The offscreen page may not have registered its listener yet right after creation.
  for (let i = 0; ; i++) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (e) {
      if (i > 50 || !String(e).includes('Receiving end does not exist')) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

async function runSpike(opts?: unknown) {
  await ensureOffscreen();
  // MV3 workers die after ~30 s idle; an extension API call resets the timer. Spike runs longer than that.
  const keepAlive = setInterval(() => void chrome.runtime.getPlatformInfo(), 10_000);
  try {
    return await sendToOffscreen({ target: 'offscreen', type: 'spike:run', opts });
  } finally {
    clearInterval(keepAlive);
  }
}

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.target === 'background' && msg.type === 'log') logs.push(String(msg.text));
  });
  (globalThis as any).__scroganize = { runSpike, drainLogs: () => logs.splice(0) };
});
