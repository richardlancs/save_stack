// The database owner. Exactly one of these exists at a time: opfs-sahpool holds exclusive file handles, so a second
// installer is refused (measured: ~40 ms, "Access Handles cannot be created ..."). It runs inside the singleton
// offscreen document, never in the service worker (MV3 workers can't spawn workers or stay alive).
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { SAHPoolUtil, Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import { applyPragmas } from '../../../core/storage/sqlite/migrate';
import { SqliteAdapter } from '../../../core/storage/sqlite/sqlite-adapter';
import { RPC_VERSION, type RpcResponse } from '../../rpc/protocol';
import { createRpcServer } from '../../rpc/server';

const POOL = { name: 'scroganize', directory: '.scroganize', initialCapacity: 8 } as const;
const DB_FILE = '/scroganize.db';
const HANDLE_WAIT_MS = 15_000; // how long to wait for a previous owner (a closing offscreen doc) to release the handles

const post = (message: RpcResponse) => (self as unknown as Worker).postMessage(message);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BUSY = /Access Handle|createSyncAccessHandle|NoModificationAllowed/i;

let pool: SAHPoolUtil;
let adapter: SqliteAdapter;

/** Install the OPFS pool, waiting (bounded) if a previous owner still holds the handles. Any other failure is immediate. */
async function installPool(sqlite3: Sqlite3Static): Promise<SAHPoolUtil> {
  const deadline = performance.now() + HANDLE_WAIT_MS;
  for (;;) {
    try {
      return await sqlite3.installOpfsSAHPoolVfs(POOL);
    } catch (e) {
      if (!BUSY.test(String((e as Error)?.message ?? e)) || performance.now() > deadline) throw e;
      await sleep(25);
    }
  }
}

async function openDb(): Promise<void> {
  const db = new pool.OpfsSAHPoolDb(DB_FILE);
  applyPragmas(db);
  adapter = new SqliteAdapter(db);
  await adapter.migrate();
}

/** wipeData: close, drop the file's contents (reclaims space), reopen empty. */
async function resetStorage(): Promise<void> {
  await adapter.close();
  await pool.wipeFiles();
  await openDb();
}

const ready = (async () => {
  const sqlite3 = await sqlite3InitModule();
  pool = await installPool(sqlite3);
  await openDb();
  return createRpcServer({ adapter: () => adapter, resetStorage, storage: 'opfs-sahpool' });
})();
ready.catch(() => { /* reported per request below */ });

/** One request at a time: a wipe must never interleave with another call. */
let queue: Promise<void> = Promise.resolve();

async function handle(request: unknown): Promise<void> {
  const id = typeof (request as { id?: unknown })?.id === 'string' ? (request as { id: string }).id : '';
  try {
    post(await (await ready)(request));
  } catch (e) {
    post({ v: RPC_VERSION, id, ok: false, error: { code: 'UNAVAILABLE', message: `database failed to start: ${(e as Error)?.message ?? e}` } });
  }
}

self.addEventListener('message', (ev: MessageEvent) => {
  queue = queue.then(() => handle(ev.data));
});
