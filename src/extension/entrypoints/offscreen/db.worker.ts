// M0 SPIKE worker. Owns SQLite for the spike run. M1 replaces this with the real DB worker
// (typed RPC, StorageAdapter) but keeps the same shape: offscreen doc -> dedicated Worker -> OPFS.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { DEFAULT_OPTIONS, openPool, runBenchOnly, runFullSpike, runReopen, type SpikeOptions } from '../../../../bench/spike-core';

type Req =
  | { id: number; type: 'full'; opts?: Partial<SpikeOptions> }
  | { id: number; type: 'reopen'; runs?: number; retryMs?: number }
  | { id: number; type: 'bench'; runs?: number }
  | { id: number; type: 'contend' };

const post = (m: unknown) => (self as unknown as Worker).postMessage(m);
const log = (text: string) => post({ log: text });

self.addEventListener('message', async (ev: MessageEvent<Req>) => {
  const req = ev.data;
  try {
    if (req.type === 'full') {
      const open = await openPool(sqlite3InitModule);
      const result = await runFullSpike(open, { ...DEFAULT_OPTIONS, ...req.opts }, log);
      post({ id: req.id, ok: true, result });
    } else if (req.type === 'reopen') {
      const open = await openPool(sqlite3InitModule, { retryMs: req.retryMs ?? 0 });
      post({ id: req.id, ok: true, result: await runReopen(open, req.runs ?? 15) });
      // Deliberately keep the VFS installed (handles held) so the contention test can observe it.
    } else if (req.type === 'bench') {
      const open = await openPool(sqlite3InitModule, { retryMs: 15000 });
      post({ id: req.id, ok: true, result: await runBenchOnly(open, req.runs ?? 25) });
    } else if (req.type === 'contend') {
      const t = performance.now();
      try {
        await openPool(sqlite3InitModule, { retryMs: 0 });
        post({ id: req.id, ok: true, result: { second_install: 'SUCCEEDED (unexpected: handles were not exclusive)', ms: performance.now() - t } });
      } catch (e) {
        post({ id: req.id, ok: true, result: { second_install: 'rejected', error: String((e as Error)?.message ?? e), ms: Math.round((performance.now() - t) * 100) / 100 } });
      }
    }
  } catch (e) {
    post({ id: req.id, ok: false, error: String((e as Error)?.stack ?? e) });
  }
});
