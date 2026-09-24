/// <reference types="node" />
// Ingest benchmark on the REAL adapter (in-memory SQLite in Node): measures the adapter's own cost.
// The OPFS / real-RPC number is bench/run-ingest.mjs (it adds storage and messaging overhead on top).
//
//   npm run bench:ingest            # 50k
//   ITEMS=10000 npm run bench:ingest
//
// Exits non-zero if first-time ingest is below the M1 budget (2,000 items/s) or the full-text index is inconsistent.
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { assertFtsConsistent } from '../tests/storage/helpers';
import { applyPragmas } from '../src/core/storage/sqlite/migrate';
import { SqliteAdapter } from '../src/core/storage/sqlite/sqlite-adapter';
import { synthBatches, synthLibrary } from './synth-batches';

const ITEMS = Number(process.env.ITEMS ?? 50_000);
const BATCH = Number(process.env.BATCH ?? 1000);
const BUDGET_ITEMS_PER_SEC = 2000;
const DAY = 86_400_000;

const sqlite3 = await sqlite3InitModule();
const db = new sqlite3.oo1.DB(':memory:');
applyPragmas(db);
const adapter = new SqliteAdapter(db);
await adapter.migrate();

const t0 = performance.now();
const lib = synthLibrary(ITEMS);
const batches = synthBatches(lib, BATCH);
console.log(`generated ${ITEMS} items in ${Math.round(performance.now() - t0)} ms (${batches.length} batches of ${BATCH})`);

const rate = (n: number, ms: number) => Math.round(n / (ms / 1000));
const timed = async (label: string, n: number, f: () => Promise<unknown>) => {
  const t = performance.now();
  const r = await f();
  const ms = performance.now() - t;
  console.log(`${label.padEnd(34)} ${String(Math.round(ms)).padStart(7)} ms  ${String(rate(n, ms)).padStart(8)} items/s`);
  return { ms, perSec: rate(n, ms), r };
};

const insert = await timed('first ingest (insert)', ITEMS, async () => { for (const b of batches) await adapter.upsertBatch(b); });
const resync = await timed('re-sync, nothing changed', ITEMS, async () => { for (const b of batches) await adapter.upsertBatch({ ...b, syncedAt: (b.syncedAt ?? 0) + DAY }); });
const EDIT = Math.min(5000, ITEMS);
const edited = batches.flatMap((b) => b.items).slice(0, EDIT).map((i) => ({ ...i, caption: `${i.caption} edited` }));
const reindex = await timed(`re-sync, ${EDIT} captions edited`, EDIT, async () => {
  for (let i = 0; i < edited.length; i += BATCH) await adapter.upsertBatch({ items: edited.slice(i, i + BATCH), syncedAt: Date.UTC(2026, 8, 26) });
});

const stats = await adapter.stats();
const t1 = performance.now();
const problems = assertFtsConsistent(db);
console.log(`full-text consistency check over ${stats.items} items: ${problems.length === 0 ? 'OK' : problems.length + ' PROBLEMS'} (${Math.round(performance.now() - t1)} ms)`);
console.log('stats', JSON.stringify(stats));

const summary = { items: ITEMS, batch: BATCH, insertPerSec: insert.perSec, resyncUnchangedPerSec: resync.perSec, reindexPerSec: reindex.perSec, dbMB: Math.round(stats.dbBytes / 1048576), budgetPerSec: BUDGET_ITEMS_PER_SEC };
console.log(JSON.stringify(summary));
await adapter.close();

if (problems.length) { console.error(problems.slice(0, 5).join('\n')); process.exit(1); }
if (insert.perSec < BUDGET_ITEMS_PER_SEC) { console.error(`FAIL: first ingest ${insert.perSec}/s is below the ${BUDGET_ITEMS_PER_SEC}/s budget`); process.exit(1); }
