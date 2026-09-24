/// <reference types="node" />
// M4 end-to-end: a REAL sync (dedicated window, page driver scrolling, capture, reconcile) of the extension against the mock tiktok.com.
// Never touches a real account.   npm run e2e:sync
import type { Page } from 'playwright';
import { assertHermetic, cleanup, FAST_DRIVER, launch, makeChecker, newProfile, rpc, rpcRaw, setSyncOptions, syncStatus, terminal, tiktokPages, waitSync, type Session } from './harness';
import { createMockTikTok, expectedLibrary, VIEWER } from './mock-tiktok';
import { itemId } from '../tests/support/tiktok-payloads';

const { failures, check } = makeChecker();
const profile = newProfile();
let s: Session | undefined;
const mock = createMockTikTok();
const server = await mock.start();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chip = (id: string, text: string) => ({ id, text, expand: false });
let searchSeq = 0;
const browse = (limit = 100) => rpc(s!, 'search', { requestId: `sync-${searchSeq++}`, chips: [], limit });
const startSync = (mode: 'incremental' | 'full') => rpc(s!, 'startSync', { mode });
const reset = () => {
  Object.assign(mock.state, { viewer: VIEWER, loginWall: false, captchaAfter: null, failFavoritesAfter: null, requireFavoritesClick: false, tabSelectorBroken: false, latencyMs: 0, interstitial: false });
};
async function windowClosed(timeoutMs = 8000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (tiktokPages(s!).length === 0) return true; await sleep(100); }
  return false;
}
const requestsNow = () => mock.state.requests.length;
async function stableFor(ms: number, what: () => number): Promise<boolean> {
  const v = what();
  await sleep(ms);
  return what() === v;
}
async function syncPage(): Promise<Page> {
  for (let i = 0; i < 50; i++) { const p = tiktokPages(s!)[0]; if (p) return p; await sleep(100); }
  throw new Error('no sync window page');
}

try {
  s = await launch(profile, server);
  await assertHermetic(s, check);
  await rpc(s, 'wipeData');

  // ------------------------------------------------------------ 1. a first sync at human pace: everything, exactly
  {
    await setSyncOptions(s, null); // production pacing (700 to 1,500 ms between steps)
    const t0 = Date.now();
    const started = await startSync('incremental');
    check(started.status === 'running', 'startSync returns the running state');
    const busy = await rpcRaw(s, 'startSync', { mode: 'full' });
    check(busy.ok === false && busy.error.code === 'BUSY', 'a second sync cannot start while one is running (BUSY)');
    const st = await waitSync(s, terminal, 'the first sync completes', 180_000);
    const took = Date.now() - t0;
    const exp = expectedLibrary(mock.account);
    check(st.status === 'completed', `the first sync completed in ${(took / 1000).toFixed(1)} s`);
    check(st.requestedMode === 'incremental' && st.mode === 'full' && st.warnings.some((w: string) => /reads everything/.test(w)), 'an incremental request with no earlier complete pass ran as a full pass, and said so');
    const stats = await rpc(s, 'getStats');
    check(stats.items === exp.items && stats.collections === exp.collections && stats.memberships === exp.memberships, `library: ${stats.items} items, ${stats.collections} collections, ${stats.memberships} memberships (expected ${exp.items}, ${exp.collections}, ${exp.memberships})`);
    check(st.saved.done === 'complete' && st.collections.every((c: any) => c.status === 'done'), 'the saved list and all four collections were read to their end');
    check(st.totals.pages === 9, `${st.totals.pages} pages read (expected 4 saved + 5 collection pages)`);
    const cols = await rpc(s, 'getCollections');
    check(cols.every((c: any) => mock.account.collections.find((m) => m.name === c.name && m.declaredTotal === c.declaredTotal && m.members.length === c.itemsSeen)), 'each collection holds what was delivered and remembers what was declared');
    const all = await browse();
    check(JSON.stringify(all.results.map((r: any) => r.item.externalId)) === JSON.stringify(exp.externalIdsNewestFirst.slice(0, 100)), 'newest-saved order equals the platform\'s list order');
    check(stats.availableItems === stats.items, 'nothing was marked unavailable');
    check(await windowClosed(), 'the sync window closed itself when the run completed');

    // pacing, from the server's point of view
    const req = mock.state.requests;
    const gaps: number[] = [];
    for (let i = 1; i < req.length; i++) {
      const a = req[i - 1]!; const b = req[i]!;
      const sameList = (a.kind === 'favorites' && b.kind === 'favorites') || (a.kind === 'collection_items' && b.kind === 'collection_items' && a.collectionId === b.collectionId);
      if (sameList) gaps.push(b.at - a.at);
    }
    check(gaps.length >= 3 && Math.min(...gaps) >= 650, `consecutive pages of one list were at least ${Math.round(Math.min(...gaps))} ms apart (a person, not a burst; minimum step delay 700 ms)`);
    check(Math.max(...gaps) < 20_000, `and never more than ${Math.round(Math.max(...gaps))} ms apart`);
  }

  // ------------------------------------------------------------ 2. an incremental sync stops early, and finds only what is new
  await setSyncOptions(s, { driver: FAST_DRIVER });
  {
    reset();
    const added = mock.addSaved(3);
    const favBefore = mock.state.served.favorites;
    await startSync('incremental');
    const st = await waitSync(s, terminal, 'the incremental sync completes');
    const exp = expectedLibrary(mock.account);
    check(st.status === 'completed' && st.mode === 'incremental' && st.saved.done === 'early', `incremental pass stopped early (${st.saved.done}) after ${mock.state.served.favorites - favBefore} of ${Math.ceil(exp.items / 30)} favorites pages`);
    check(mock.state.served.favorites - favBefore === 3, 'it read exactly one page with news and two known pages, not the whole list');
    check(st.totals.inserted === 3, `it found exactly the ${st.totals.inserted} new saves`);
    const all = await browse(10);
    check(JSON.stringify(all.results.slice(0, 3).map((r: any) => r.item.externalId)) === JSON.stringify([itemId(added[2]!), itemId(added[1]!), itemId(added[0]!)]), 'the new saves are at the top of "recently saved"');
    const stats = await rpc(s, 'getStats');
    check(stats.items === exp.items && stats.memberships === exp.memberships, `library now ${stats.items} items, ${stats.memberships} memberships`);
    check(!st.warnings.some((w: string) => /reads everything/.test(w)), 'no "reads everything" warning once a complete pass exists');
  }

  // ------------------------------------------------------------ 3. a full sync notices what was removed
  {
    reset();
    const before = await rpc(s, 'getStats');
    mock.removeSaved(10); // un-saved on the platform (was also in "Recipes")
    mock.removeFromCollection(3, 21); // taken out of "Everything odd" but still saved
    await startSync('full');
    const st = await waitSync(s, terminal, 'the full re-sync completes');
    const removed = await rpc(s, 'getItem', { platform: 'tiktok', externalId: itemId(10) });
    const stillSaved = await rpc(s, 'getItem', { platform: 'tiktok', externalId: itemId(21) });
    const stats = await rpc(s, 'getStats');
    check(st.status === 'completed' && st.mode === 'full', 'the full re-sync completed');
    check(removed !== null && removed.available === false, 'a video no longer saved is marked unavailable (kept, never deleted)');
    check(removed !== null && removed.collections.length === 0, 'and dropped from the collection it was in');
    check(stillSaved !== null && stillSaved.available === true && !stillSaved.collections.some((c: any) => c.name === 'Everything odd'), 'a video taken out of a collection stays saved but leaves that collection');
    check(stats.items === before.items && stats.availableItems === before.items - 1, `library keeps all ${stats.items} videos, ${stats.availableItems} available`);
    const inCollection = await rpc(s, 'search', { requestId: `sync-${searchSeq++}`, chips: [chip('a', 'everything odd')], limit: 100 });
    check(!inCollection.results.some((r: any) => r.item.externalId === itemId(21)), 'searching the collection no longer finds the removed membership');
    check(st.warnings.length === 0, 'no warnings');
  }

  // ------------------------------------------------------------ 4. another account is refused
  {
    reset();
    const before = await rpc(s, 'getStats');
    mock.state.viewer = 'secondaccount';
    await startSync('full');
    const st = await waitSync(s, (x) => x.status === 'needs_attention', 'a different account is refused');
    check(st.attention.reason === 'wrong_account', `a different signed-in account is refused (${st.attention.reason})`);
    await rpc(s, 'cancelSync');
    check((await syncStatus(s)).status === 'cancelled' && (await windowClosed()), 'cancelling closes the window');
    const after = await rpc(s, 'getStats');
    check(after.items === before.items && after.memberships === before.memberships, 'nothing was read from the other account');
    reset();
  }

  // ------------------------------------------------------------ 5. pause and resume, with an unrelated tab open on the platform
  {
    mock.state.latencyMs = 150;
    await startSync('full');
    await waitSync(s, (x) => x.saved.pages >= 1, 'the first page arrives');
    const bystander = await s.ctx.newPage();
    await bystander.goto('https://www.tiktok.com/foryou');
    await sleep(400);
    await rpc(s, 'pauseSync');
    await sleep(700); // an in-flight request may still land
    const paused = await syncStatus(s);
    const pagesAtPause = paused.totals.pages;
    const requestsAtPause = requestsNow();
    const navigationsAtPause = mock.state.served.pages;
    check(paused.status === 'paused', 'pause is reported');
    check(await stableFor(1500, requestsNow), `while paused nothing more is requested (${requestsNow() - requestsAtPause} extra requests)`);
    check((await syncStatus(s)).totals.pages === pagesAtPause, 'and no page is counted');
    await rpc(s, 'resumeSync');
    const st = await waitSync(s, terminal, 'the paused sync finishes after resume');
    check(st.status === 'completed', 'resume continued to the end');
    check(mock.state.served.pages - navigationsAtPause <= 4, `resume did not reload the list it was on (${mock.state.served.pages - navigationsAtPause} page loads since, all for collections)`);
    await bystander.close();
    const stats = await rpc(s, 'getStats');
    const expNow = expectedLibrary(mock.account).items;
    check(stats.items === expNow + 1 && stats.availableItems === expNow, `the library is exactly as expected (${stats.items} kept, ${stats.availableItems} available; the one un-saved video is kept but unavailable)`);
    reset();
  }

  // ------------------------------------------------------------ 6. cancel
  {
    mock.state.latencyMs = 150;
    await startSync('full');
    await waitSync(s, (x) => x.saved.pages >= 1, 'a page arrives');
    await rpc(s, 'cancelSync');
    const st = await syncStatus(s);
    check(st.status === 'cancelled' && st.finishedAt > 0, 'cancel is reported');
    check(await windowClosed(), 'the sync window closed');
    const r = requestsNow();
    check(await stableFor(1200, requestsNow), `nothing is requested after cancel (${requestsNow() - r} extra)`);
    reset();
    await startSync('full');
    check((await syncStatus(s)).status === 'running', 'a new sync can start after a cancelled one');
    await rpc(s, 'cancelSync');
    await windowClosed();
  }

  // ------------------------------------------------------------ 7. wiping the library cancels a run in progress
  {
    mock.state.latencyMs = 150;
    await startSync('full');
    await waitSync(s, (x) => x.saved.pages >= 1, 'a page arrives');
    await rpc(s, 'wipeData');
    const st = await syncStatus(s);
    check(st.status === 'cancelled', 'wiping the library cancelled the run');
    check(await windowClosed(), 'and closed the window');
    await sleep(800);
    check((await rpc(s, 'getStats')).items === 0, 'and the library stayed empty');
    reset();
  }

  // ------------------------------------------------------------ 8. the service worker is killed in the middle of a sync
  {
    mock.state.latencyMs = 120;
    await startSync('full');
    await waitSync(s, (x) => x.saved.pages >= 1 && x.saved.pages < 3, 'the sync is under way');
    const probe = await s.ctx.newPage();
    const cdp = await s.ctx.newCDPSession(probe);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await probe.close();
    const st = await waitSync(s, terminal, 'the sync finishes although the service worker was killed', 90_000);
    const exp = expectedLibrary(mock.account);
    const stats = await rpc(s, 'getStats');
    check(st.status === 'completed' && st.saved.done === 'complete', 'the run resumed from its persisted state and completed');
    check(stats.items === exp.items && stats.memberships === exp.memberships, `and the library is exact (${stats.items} items, ${stats.memberships} memberships)`);
    check(stats.availableItems === stats.items, 'and nothing was marked unavailable by the interrupted run (ids seen before the kill survived)');
    reset();
  }

  // ------------------------------------------------------------ 9. a hidden window pauses by itself and continues by itself
  {
    mock.state.latencyMs = 600; // slow enough that the run is still going when the window is hidden
    await startSync('full');
    await waitSync(s, (x) => x.saved.pages >= 1, 'a page arrives');
    const syncTab = await syncPage();
    // (the end-to-end browser reports every tab as visible, so its build lets the test force "hidden" with a DOM attribute)
    await syncTab.evaluate("document.documentElement.setAttribute('data-scroganize-e2e-hidden', '1')");
    const st = await waitSync(s, (x) => x.status === 'needs_attention', 'the hidden window is noticed', 15_000);
    check(st.attention.reason === 'tab_hidden', `a hidden sync window is noticed (${st.attention.reason})`);
    await sleep(600);
    check(await stableFor(1500, requestsNow), 'and scrolling stops while it is hidden');
    await syncTab.evaluate("document.documentElement.removeAttribute('data-scroganize-e2e-hidden'); document.dispatchEvent(new Event('visibilitychange'))");
    const done = await waitSync(s, terminal, 'the run continues once the window is visible again');
    check(done.status === 'completed', 'it continued by itself and completed');
    reset();
  }

  // ------------------------------------------------------------ 10. not signed in
  {
    mock.state.viewer = null;
    await startSync('full');
    let st = await waitSync(s, (x) => x.status === 'needs_attention', 'a signed-out window is noticed');
    check(st.attention.reason === 'login_required', `signed out (no account on the page): ${st.attention.reason}`);
    await rpc(s, 'cancelSync');
    await windowClosed();
    reset();

    mock.state.loginWall = true;
    await startSync('full');
    st = await waitSync(s, (x) => x.status === 'needs_attention', 'a login wall is noticed');
    check(st.attention.reason === 'login_required', `a login wall on the page: ${st.attention.reason}`);
    mock.state.loginWall = false;
    const page = await syncPage();
    await page.reload(); // the user logged in: the page reloads
    await rpc(s, 'resumeSync');
    st = await waitSync(s, terminal, 'the run completes after signing in');
    check(st.status === 'completed', 'after the user signs in and presses Resume, the run completes');
    reset();
  }

  // ------------------------------------------------------------ 11. a verification challenge in the middle of the run
  {
    mock.state.captchaAfter = requestsNow() + 3;
    await startSync('full');
    let st = await waitSync(s, (x) => x.status === 'needs_attention', 'the challenge is noticed', 30_000);
    check(st.attention.reason === 'captcha' || st.attention.reason === 'blocked', `a verification challenge is noticed (${st.attention.reason})`);
    const r = requestsNow();
    check(await stableFor(1200, requestsNow), `and the sync stops asking (${requestsNow() - r} extra requests)`);
    mock.state.captchaAfter = null;
    const page = await syncPage();
    await page.evaluate("document.getElementById('captcha_container') && document.getElementById('captcha_container').remove()"); // the user solves it
    await rpc(s, 'resumeSync');
    st = await waitSync(s, terminal, 'the run completes after the challenge is solved');
    const stats = await rpc(s, 'getStats');
    check(st.status === 'completed' && stats.items === expectedLibrary(mock.account).items, 'after the user solves it and presses Resume, the run completes with the library exact');
    reset();
  }

  // ------------------------------------------------------------ 12. the list sits behind a tab
  {
    mock.state.requireFavoritesClick = true;
    await startSync('full');
    const st = await waitSync(s, terminal, 'the driver opens the Favorites tab itself');
    check(st.status === 'completed', 'when the list needs a click on the Favorites tab, the driver clicks it and the sync completes');
    reset();

    // the driver cannot find the tab: the user opens the list and the sync continues by itself
    mock.state.requireFavoritesClick = true;
    mock.state.tabSelectorBroken = true;
    await setSyncOptions(s, { driver: { ...FAST_DRIVER, settleMaxMs: 400, stallSteps: 3 }, sync: { maxStallRetries: 1 } });
    await startSync('full');
    const stalled = await waitSync(s, (x) => x.status === 'needs_attention', 'the unloaded list is noticed', 60_000);
    check(stalled.attention.reason === 'stalled' && /Favorites/.test(stalled.attention.message), 'a list that never loads stops and tells the user how to open it');
    const page = await syncPage();
    await page.click('#favtab'); // the user opens the Favorites tab
    const done = await waitSync(s, terminal, 'the sync continues once the user opens the list', 60_000);
    check(done.status === 'completed', 'once the user opens the list, the sync continues by itself and completes');
    reset();
    await setSyncOptions(s, { driver: FAST_DRIVER });
  }

  // ------------------------------------------------------------ 13. the state survives a browser restart
  {
    await s.ctx.close();
    s = await launch(profile, server);
    const st = await syncStatus(s);
    check(st.status === 'completed' && st.startedAt > 0, `the last run's result is still there after a restart (${st.status})`);
    check(tiktokPages(s).length === 0, 'and no sync window was left open');
  }

  await s.ctx.close();
} catch (e) {
  console.error('E2E ERROR:', e);
  failures.push(`exception: ${(e as Error).message}`);
} finally {
  await s?.ctx.close().catch(() => undefined);
  cleanup(profile);
  await server.stop();
}

console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : `\n${failures.length} CHECK(S) FAILED:\n - ${failures.join('\n - ')}`);
process.exit(failures.length === 0 ? 0 : 1);
