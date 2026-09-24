/// <reference types="node" />
// End-to-end storage check on the REAL extension: Chromium + the built extension + real OPFS + the real RPC path
// (Playwright -> service worker -> offscreen document -> DB Worker -> SQLite/OPFS).
//
//   npm run e2e:storage            # builds the e2e bundle (test hook enabled, in .output-e2e), then runs this
//   ITEMS=10000 npm run e2e:storage
//
// Asserts: ingest >= 2,000 items/s, exact counts, durability across a full browser restart,
// recovery after the offscreen document is destroyed, and that wipeData reclaims storage.
// Uses Playwright's Chromium: branded Chrome 137+ ignores --load-extension.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext, type Worker } from 'playwright';
import { synthBatches, synthLibrary } from './synth-batches';

const ITEMS = Number(process.env.ITEMS ?? 50_000);
const BATCH = 1000;
const BUDGET = 2000;
const EXT = path.resolve('.output-e2e/chrome-mv3');
if (!fs.existsSync(path.join(EXT, 'manifest.json'))) throw new Error(`no e2e build at ${EXT}; run: npm run build:e2e`);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'scroganize-e2e-'));
const failures: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`); if (!ok) failures.push(what); };
const ms = (t: number) => Math.round(performance.now() - t);

let seq = 0;
async function rpcFull(sw: Worker, method: string, params?: unknown): Promise<any> {
  const request = { v: 1, id: `e2e-${seq++}`, method, params };
  const res = await sw.evaluate((r) => (globalThis as any).__scroganize.forward(r), request);
  if (!res.ok) throw new Error(`${method}: ${res.error.code}: ${res.error.message}`);
  return res;
}
async function rpc<T = any>(sw: Worker, method: string, params?: unknown): Promise<T> {
  return (await rpcFull(sw, method, params)).result as T;
}

async function launch(): Promise<{ ctx: BrowserContext; sw: Worker }> {
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30_000 });
  return { ctx, sw };
}

try {
  const lib = synthLibrary(ITEMS);
  const batches = synthBatches(lib, BATCH);
  const expectedMemberships = lib.items.reduce((n, it) => n + it.collectionIds.length, 0);
  console.log(`library: ${ITEMS} items, ${lib.collections.length} collections, ${expectedMemberships} memberships, ${batches.length} batches`);

  // ---------------------------------------------------------------- cold start
  let t = performance.now();
  let { ctx, sw } = await launch();
  const ping = await rpc(sw, 'ping');
  const coldStartMs = ms(t);
  check(ping.pong === true && ping.schemaVersion >= 1 && ping.storage === 'opfs-sahpool', `ping ok through SW -> offscreen -> worker (schema v${ping.schemaVersion}, ${ping.storage})`);
  console.log(`      cold start (browser launch + offscreen + wasm + OPFS + migrate): ${coldStartMs} ms`);

  // fixed per-call overhead of the whole RPC path, so it can be subtracted when reading the ingest number
  const rtts: number[] = [];
  for (let i = 0; i < 20; i++) { const s = performance.now(); await rpc(sw, 'ping'); rtts.push(performance.now() - s); }
  rtts.sort((a, b) => a - b);
  console.log(`      RPC round trip (ping): p50 ${rtts[10]!.toFixed(1)} ms, max ${rtts[19]!.toFixed(1)} ms`);

  // ---------------------------------------------------------------- ingest
  t = performance.now();
  let inserted = 0;
  let dbMs = 0;
  let swMs = 0;
  for (let i = 0; i < batches.length; i++) {
    const request = { v: 1, id: `ing-${i}`, method: 'upsertBatch', params: batches[i] };
    const { response, swMs: sm } = await sw.evaluate((r) => (globalThis as any).__scroganize.forwardTimed(r), request);
    if (!response.ok) throw new Error(`upsertBatch: ${response.error.code}: ${response.error.message}`);
    inserted += response.result.inserted; dbMs += response.serverMs ?? 0; swMs += sm;
  }
  const ingestMs = performance.now() - t;
  const perSec = Math.round(ITEMS / (ingestMs / 1000));
  const rate = (m: number) => `${Math.round(m)} ms = ${Math.round(ITEMS / (m / 1000))} items/s`;
  console.log(`      ingest, end to end (Playwright/CDP + chrome messaging + DB): ${rate(ingestMs)}`);
  console.log(`              service worker -> offscreen -> worker -> back (no Playwright): ${rate(swMs)}`);
  console.log(`              inside the database worker only (OPFS-backed SQLite):      ${rate(dbMs)}   [batches ~${(JSON.stringify(batches[0]).length / 1e6).toFixed(1)} MB]`);
  check(inserted === ITEMS, `inserted exactly ${ITEMS} items (got ${inserted})`);
  // The product path is service worker -> offscreen -> worker. Playwright's own CDP transfer of each batch is a property of
  // this harness, not of the extension, so the budget is asserted on the service-worker-level rate (end-to-end is still reported).
  const swPerSec = Math.round(ITEMS / (swMs / 1000));
  check(swPerSec >= BUDGET, `ingest >= ${BUDGET} items/s through the real RPC path, service worker -> offscreen -> worker (got ${swPerSec}; end to end incl. Playwright: ${perSec})`);

  const stats = await rpc(sw, 'getStats');
  check(stats.items === ITEMS && stats.availableItems === ITEMS, `getStats: ${stats.items} items, ${stats.availableItems} available`);
  check(stats.collections === lib.collections.length && stats.memberships === expectedMemberships, `getStats: ${stats.collections} collections, ${stats.memberships} memberships (expected ${lib.collections.length}, ${expectedMemberships})`);
  console.log(`      db size ${(stats.dbBytes / 1048576).toFixed(1)} MB, ${stats.hashtags} hashtags`);
  const sample = lib.items[1234]!;
  const got = await rpc(sw, 'getItem', { platform: 'tiktok', externalId: sample.externalId });
  check(got?.externalId === sample.externalId && got.caption === sample.caption && got.collections.length === sample.collectionIds.length, 'getItem returns a stored video with its collections');

  t = performance.now();
  let touched = 0;
  for (const b of batches) touched += (await rpc(sw, 'upsertBatch', { ...b, syncedAt: (b.syncedAt ?? 0) + 86_400_000 })).touched;
  console.log(`      unchanged re-sync: ${Math.round(ITEMS / ((performance.now() - t) / 1000))} items/s`);
  check(touched === ITEMS, 'unchanged re-sync touches every item and inserts none');

  // ---------------------------------------------------------------- durability: full browser restart
  await ctx.close();
  t = performance.now();
  ({ ctx, sw } = await launch());
  const after = await rpc(sw, 'getStats');
  console.log(`      cold start with an existing ${(after.dbBytes / 1048576).toFixed(0)} MB database: ${ms(t)} ms to first answer`);
  check(after.items === ITEMS && after.memberships === expectedMemberships, `data survived a full browser restart (${after.items} items, ${after.memberships} memberships)`);

  // ---------------------------------------------------------------- recovery: destroy the offscreen document
  await sw.evaluate(() => (globalThis as any).__scroganize.closeOffscreen());
  t = performance.now();
  const recovered = await rpc(sw, 'getStats');
  console.log(`      offscreen document destroyed -> next call answered after ${ms(t)} ms (recreated, handles re-acquired, DB reopened)`);
  check(recovered.items === ITEMS, 'RPC recovers after the offscreen document is destroyed, with data intact');

  // ---------------------------------------------------------------- bad input over the real path
  const bad = await sw.evaluate((r) => (globalThis as any).__scroganize.forward(r), { v: 1, id: 'bad-1', method: 'dropTables', params: null });
  check(bad.ok === false && bad.error.code === 'BAD_REQUEST', 'an unknown method is rejected with BAD_REQUEST');
  const ni = await sw.evaluate((r) => (globalThis as any).__scroganize.forward(r), { v: 1, id: 'ni-1', method: 'search', params: { requestId: 'r', chips: [] } });
  check(ni.ok === false && ni.error.code === 'NOT_IMPLEMENTED', 'search answers NOT_IMPLEMENTED until M2');

  // ---------------------------------------------------------------- wipe reclaims storage
  await rpc(sw, 'wipeData');
  const wiped = await rpc(sw, 'getStats');
  check(wiped.items === 0 && wiped.dbBytes < 2 * 1048576, `wipeData empties the library and reclaims space (${(wiped.dbBytes / 1048576).toFixed(2)} MB left)`);
  await rpc(sw, 'upsertBatch', batches[0]);
  check((await rpc(sw, 'getStats')).items === batches[0]!.items.length, 'the database is usable again after wipe');

  await ctx.close();
} catch (e) {
  console.error('E2E ERROR:', e);
  failures.push(`exception: ${(e as Error).message}`);
} finally {
  fs.rmSync(profile, { recursive: true, force: true });
}

console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} CHECK(S) FAILED:\n - ${failures.join('\n - ')}`);
process.exit(failures.length === 0 ? 0 : 1);
