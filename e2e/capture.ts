/// <reference types="node" />
// M3 end-to-end: the REAL extension (content scripts, service worker, offscreen document, SQLite in OPFS) against a mock
// tiktok.com. Never touches a real account.   npm run e2e:capture
import type { Page } from 'playwright';
import { assertHermetic, captureStatus, cleanup, drain, launch, makeChecker, newProfile, outcomes, pageSeenMessages, rejectedTotal, rpc, settle, type Session } from './harness';
import { STRANGER, THEMES, VIEWER, createMockTikTok, uidFor } from './mock-tiktok';
import { itemId } from '../tests/support/tiktok-payloads';

const { failures, check } = makeChecker();
const profile = newProfile();
let s: Session | undefined;
const mock = createMockTikTok();
const server = await mock.start();
const exp = mock.expected;
const chip = (id: string, text: string, expand = true) => ({ id, text, expand });
let searchSeq = 0;
const search = (s: Session, chips: ReturnType<typeof chip>[], extra: Record<string, unknown> = {}) => rpc(s, 'search', { requestId: `cap-${searchSeq++}`, chips, limit: 100, ...extra });

/** Open a URL in a fresh tab, run `fn`, wait until the pipeline has an outcome for everything the mock served, return the status delta. */
async function visit(s: Session, url: string, fn?: (p: Page) => Promise<void>) {
  const before = await captureStatus(s);
  const servedBefore = mock.allowedServed();
  const page = await s.ctx.newPage();
  await page.goto(url);
  if (fn) await fn(page);
  else await drain(page);
  const after = await settle(s, outcomes(before), servedBefore, () => mock.allowedServed());
  return { page, before, after, served: mock.allowedServed() - servedBefore };
}

try {
  s = await launch(profile, server);
  await assertHermetic(s, check);
  const seenByPages: string[] = [];

  // -------------------------------------------------------------- 1. favorites + collection list, read while scrolling
  {
    const { page, after, served } = await visit(s, mock.urls.favorites());
    seenByPages.push(...(await pageSeenMessages(page)));
    await page.close();
    check(mock.state.served.favorites === Math.ceil(exp.items / 30) && mock.state.served.collection_list === 1, `the mock served ${mock.state.served.favorites} favorites pages and 1 collection list (${served} allowed responses in total)`);
    check(mock.state.served.blocked >= 2, `the page also requested ${mock.state.served.blocked} endpoints outside the allowlist (uploads, playlists)`);
    check(after.pages === served && after.duplicates === 0 && rejectedTotal(after) === 0, `every allowed response was accepted exactly once (${after.pages} pages, ${after.duplicates} duplicates, ${rejectedTotal(after)} rejected)`);
    check(after.byKind.favorites?.pages === 4 && after.byKind.favorites?.items === exp.items, `favorites: ${after.byKind.favorites?.pages} pages, ${after.byKind.favorites?.items} items (expected 4 pages, ${exp.items} items)`);
    check(after.byKind.collection_list?.items === exp.collections, `collection list delivered ${after.byKind.collection_list?.items} collections`);
    check(after.viewerHandle === VIEWER, `the library is bound to the signed-in user "${after.viewerHandle}"`);
    check(after.lastPage?.hasMore === false, 'the final page reports hasMore = false (that, not the count, is how completion is known)');

    const stats = await rpc(s, 'getStats');
    check(stats.items === exp.items && stats.collections === exp.collections && stats.memberships === 0, `library: ${stats.items} items, ${stats.collections} collections, ${stats.memberships} memberships (expected ${exp.items}, ${exp.collections}, 0)`);
    const all = await search(s, []);
    check(all.total === exp.items, `browse-all sees ${all.total} items`);
    check(JSON.stringify(all.results.map((r: any) => r.item.externalId)) === JSON.stringify(exp.externalIdsNewestFirst.slice(0, 100)), 'newest-saved-first order equals the order TikTok listed them (saved-at interpolated from cursors)');
    const unknown = all.results.filter((r: any) => r.item.savedAtSource === 'unknown').length;
    check(all.results.every((r: any) => r.item.savedAtSource === 'interpolated' || r.item.savedAtSource === 'unknown') && unknown === exp.items % 30, `saved-at is "interpolated" for every page with both bounds, and honestly "unknown" for the ${unknown} videos of the last page (no lower bound)`);
    const times: number[] = all.results.map((r: any) => r.item.savedAt);
    check(times.every((t, i) => i === 0 || t < times[i - 1]!), 'saved-at strictly decreases down the list');
    check((await rpc(s, 'getItem', { platform: 'tiktok', externalId: itemId(999) })) === null, 'the private upload the page also requested was never captured');
    const photo = await rpc(s, 'getItem', { platform: 'tiktok', externalId: itemId(14) });
    check(photo?.mediaType === 'photo' && photo.durationSec === undefined, 'a photo carousel is stored as a photo without a duration');
    check((await rpc(s, 'getItem', { platform: 'tiktok', externalId: itemId(mock.account.dropped[0]!) })) === null, 'a video TikTok did not deliver (unavailable) is not invented');
  }

  // -------------------------------------------------------------- 2. every collection, scrolled to its end
  {
    for (const c of mock.account.collections) {
      const { page, after } = await visit(s, mock.urls.collection(c));
      seenByPages.push(...(await pageSeenMessages(page)));
      await page.close();
      check(rejectedTotal(after) === 0, `collection "${c.name}" read without any rejection`);
    }
    const st = await captureStatus(s);
    check(st.byKind.collection_items?.items === exp.memberships, `collection pages delivered ${st.byKind.collection_items?.items} items (expected ${exp.memberships})`);
    const stats = await rpc(s, 'getStats');
    check(stats.items === exp.items, `collections did not add or duplicate videos (${stats.items} items)`);
    check(stats.memberships === exp.memberships && stats.collections === exp.collections, `memberships written: ${stats.memberships} (expected ${exp.memberships})`);
    const cols = await rpc(s, 'getCollections');
    for (const c of mock.account.collections) {
      const got = cols.find((x: any) => x.name === c.name);
      check(got && got.declaredTotal === c.declaredTotal && got.itemsSeen === c.members.length, `"${c.name}": declared ${got?.declaredTotal}, stored ${got?.itemsSeen} (expected ${c.declaredTotal} / ${c.members.length}; the difference is what TikTok no longer delivers)`);
    }
    const big = mock.account.collections[3]!;
    const atOffset = await rpc(s, 'getItem', { platform: 'tiktok', externalId: itemId(big.members[31]!) });
    check(atOffset?.collections.find((x: any) => x.name === big.name)?.position === 31, 'positions continue across a collection\'s pages (item 31 sits at position 31, on page 2)');
  }

  // -------------------------------------------------------------- 3. search over what was captured
  {
    for (const theme of ['makeup', 'travel', 'fitness', 'pets']) {
      const r = await search(s, [chip('a', theme, false)]);
      const want = exp.byTheme(theme).slice().sort();
      const got = r.results.map((x: any) => x.item.externalId).sort();
      check(r.total === want.length && JSON.stringify(got) === JSON.stringify(want), `search "${theme}" returns exactly the ${want.length} ${theme} videos`);
    }
    const recipes = await search(s, [chip('a', 'recipes'), chip('b', 'pasta')], { mode: 'all' });
    check(recipes.total === exp.byTheme('cooking').length, `chips "recipes" AND "pasta" -> ${recipes.total} videos`);
    const any = await search(s, [chip('a', 'makeup', false), chip('b', 'travel', false)], { mode: 'any' });
    check(any.total === exp.byTheme('makeup').length + exp.byTheme('travel').length, `chips "makeup" ANY "travel" -> ${any.total} videos`);
    const collectionChip = await search(s, [chip('a', 'everything odd', false)]);
    check(collectionChip.total === mock.account.collections[3]!.members.length, `a collection name is searchable (${collectionChip.total} videos in "Everything odd")`);
  }

  // -------------------------------------------------------------- 4. re-opening a tab re-fetches the first pages: duplicates, not double counting
  {
    const before = await captureStatus(s);
    const statsBefore = await rpc(s, 'getStats');
    const { page, after, served } = await visit(s, mock.urls.favorites(), async (p) => { await p.waitForFunction(() => (window as any).__mock?.state.ready && !(window as any).__mock.state.loading); });
    await page.close();
    check(after.pages - before.pages === served && after.duplicates - before.duplicates === 1, `re-opening the tab: the ${served} re-fetched pages were applied again; the one with videos added nothing new (${after.duplicates - before.duplicates} duplicate)`);
    const statsAfter = await rpc(s, 'getStats');
    check(statsAfter.items === statsBefore.items && statsAfter.memberships === statsBefore.memberships, 're-sent pages changed nothing in the library');
  }

  // -------------------------------------------------------------- 5. the "Please wait..." interstitial before the real page
  {
    mock.state.interstitial = true;
    const before = await captureStatus(s);
    const { page, after } = await visit(s, mock.urls.favorites() + '&interstitial=1', async (p) => { await p.waitForFunction(() => (window as any).__mock?.state.ready && !(window as any).__mock.state.loading, undefined, { timeout: 20_000 }); });
    await page.close();
    mock.state.interstitial = false;
    check(outcomes(after) > outcomes(before) && rejectedTotal(after) === rejectedTotal(before), 'capture works after the interstitial reloads into the real page');
  }

  // -------------------------------------------------------------- 6. only the signed-in user's own data
  {
    const statsBefore = await rpc(s, 'getStats');
    // a) someone else's public collection
    let r = await visit(s, mock.urls.strangerCollection(), async (p) => { await p.waitForFunction(() => (window as any).__mock?.state.ready); await p.waitForTimeout(300); });
    seenByPages.push(...(await pageSeenMessages(r.page)));
    await r.page.close();
    check((r.after.rejected.not_own_profile ?? 0) - (r.before.rejected.not_own_profile ?? 0) === r.served && r.served >= 2, `another user's collection page: all ${r.served} responses refused (not_own_profile)`);
    check((await rpc(s, 'getItem', { platform: 'tiktok', externalId: itemId(901) })) === null, 'none of the other user\'s videos entered the library');
    // b) signed out
    mock.state.viewer = null;
    r = await visit(s, mock.urls.favorites() + '&signedout=1', async (p) => { await p.waitForFunction(() => (window as any).__mock?.state.ready); await p.waitForTimeout(300); });
    await r.page.close();
    check((r.after.rejected.identity_unknown ?? 0) - (r.before.rejected.identity_unknown ?? 0) === r.served, `signed out: all ${r.served} responses refused (identity_unknown)`);
    // c) a different signed-in account than the one the library belongs to
    mock.state.viewer = 'secondaccount';
    r = await visit(s, mock.urls.favorites('secondaccount'), async (p) => { await p.waitForFunction(() => (window as any).__mock?.state.ready); await p.waitForTimeout(300); });
    await r.page.close();
    check((r.after.rejected.account_mismatch ?? 0) - (r.before.rejected.account_mismatch ?? 0) === r.served, `a second account: all ${r.served} responses refused (account_mismatch)`);
    // d) the same person after a username change (same stable id): accepted, and the library follows the new name
    mock.state.viewer = 'renamed';
    mock.state.viewerUid = uidFor(VIEWER);
    r = await visit(s, mock.urls.favorites('renamed') + '&rename=1', async (p) => { await p.waitForFunction(() => (window as any).__mock?.state.ready); await p.waitForTimeout(300); });
    await r.page.close();
    check((r.after.rejected.account_mismatch ?? 0) === (r.before.rejected.account_mismatch ?? 0) && r.after.pages - r.before.pages === r.served, `a username change (same stable id) is accepted (${r.served} responses)`);
    check((await rpc(s, 'getAccount', { platform: 'tiktok' }))?.handle === 'renamed', 'and the library now records the new name');
    // e) someone else who took the old name (a different stable id): refused
    mock.state.viewer = VIEWER;
    mock.state.viewerUid = uidFor('somebody-else');
    r = await visit(s, mock.urls.favorites() + '&squat=1', async (p) => { await p.waitForFunction(() => (window as any).__mock?.state.ready); await p.waitForTimeout(300); });
    await r.page.close();
    check((r.after.rejected.account_mismatch ?? 0) - (r.before.rejected.account_mismatch ?? 0) === r.served, `a different person using the old name is refused (${r.served} responses)`);
    mock.state.viewer = VIEWER;
    mock.state.viewerUid = null; // back to the original name (the library follows: same stable id)
    const statsAfter = await rpc(s, 'getStats');
    check(statsAfter.items === statsBefore.items && statsAfter.collections === statsBefore.collections, 'none of those visits changed the library');
  }

  // -------------------------------------------------------------- 7. forged messages from script running in the page
  {
    const before = await captureStatus(s);
    const statsBefore = await rpc(s, 'getStats');
    const page = await s.ctx.newPage();
    await page.goto(mock.urls.favorites());
    await page.waitForFunction(() => (window as any).__mock?.state.ready && !(window as any).__mock.state.loading);
    const settleBase = await settle(s, outcomes(before), 0, () => 0);
    // A string, not a function: tsx would inject helper references into a serialized function that the page does not have.
    await page.evaluate(`(() => {
      const base = { channel: 'scroganize:capture', v: 1, platform: 'tiktok', capturedAt: Date.now(), body: '{"itemList":[]}', pageHandle: 'testuser', viewerHandle: 'testuser' };
      const send = (o) => window.postMessage(Object.assign({}, base, o), location.origin);
      send({ kind: 'post_item_list' }); //                   outside the allowlist
      send({ kind: 'favorites', platform: 'instagram' }); // unknown platform
      send({ kind: 'favorites', requestCursor: '1; DROP TABLE items' });
      send({ kind: 'favorites', body: 'x'.repeat(13000000) }); // oversized
      send({ kind: 'favorites', capturedAt: 1 }); //          stale
      send({ kind: 'favorites', cookie: 'sessionid=SECRETCOOKIE', body: JSON.stringify({ itemList: [], cookie: 'x' }) }); // extras
      window.postMessage('a string', location.origin);
      window.postMessage(null, location.origin);
    })()`);
    await page.waitForTimeout(600);
    const st = await captureStatus(s);
    await page.close();
    // only the (empty-page) message with the cookie extra is well-formed; everything else must have been dropped before the pipeline
    check(outcomes(st) - outcomes(settleBase) <= 1, `forged messages: ${outcomes(st) - outcomes(settleBase)} reached the pipeline (only the well-formed one may)`);
    const statsAfter = await rpc(s, 'getStats');
    check(statsAfter.items === statsBefore.items && statsAfter.memberships === statsBefore.memberships, 'forged messages changed nothing in the library');
    check(!JSON.stringify(st).includes('SECRETCOOKIE'), 'a forged cookie field was not carried into the extension');
  }

  // -------------------------------------------------------------- 8. nothing sensitive was ever visible on the wire the hook uses
  {
    const joined = seenByPages.join('\n');
    check(seenByPages.length > 0, `the hook posted ${seenByPages.length} messages the page could observe`);
    check(!/SECRET/.test(joined), 'no message contained a token, device id, signature or header value (all were in the requests)');
    const kinds = new Set(seenByPages.map((m) => (JSON.parse(m) as { kind: string }).kind));
    check([...kinds].every((k) => ['favorites', 'collection_items', 'collection_list', 'collection_detail'].includes(k)), `only allowlisted kinds were posted (${[...kinds].join(', ')})`);
    const keys = new Set(seenByPages.flatMap((m) => Object.keys(JSON.parse(m) as object)));
    check([...keys].every((k) => ['channel', 'v', 'platform', 'kind', 'requestCursor', 'collectionId', 'capturedAt', 'body', 'pageHandle', 'viewerHandle', 'viewerId'].includes(k)), `messages carry only known fields (${[...keys].sort().join(', ')})`);
  }

  // -------------------------------------------------------------- 9. the service worker being killed
  {
    const before = await captureStatus(s);
    const statsBefore = await rpc(s, 'getStats');
    const servedBefore = mock.allowedServed();
    const probe = await s.ctx.newPage();
    const cdp = await s.ctx.newCDPSession(probe);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await probe.waitForTimeout(500);
    // Nothing talks to the extension until the page does: the relay's first message must wake the stopped service worker.
    const page = await s.ctx.newPage();
    await page.goto(mock.urls.favorites() + '&afterkill=1');
    await page.waitForFunction(() => (window as any).__mock?.state.ready && !(window as any).__mock.state.loading);
    const r = { page, after: await settle(s, outcomes(before), servedBefore, () => mock.allowedServed()), served: mock.allowedServed() - servedBefore };
    await r.page.close();
    await probe.close();
    check(r.after.viewerHandle === VIEWER && r.after.pages >= before.pages + r.served, `service worker restarted by the next capture; counters continued from storage (${before.pages} -> ${r.after.pages} pages)`);
    const statsAfter = await rpc(s, 'getStats');
    check(statsAfter.items === statsBefore.items && statsAfter.memberships === statsBefore.memberships, 'the re-read pages were applied idempotently after the restart (library unchanged)');
  }

  // -------------------------------------------------------------- 10. survives a full browser restart
  {
    const before = await captureStatus(s);
    await s.ctx.close();
    s = await launch(profile, server);
    const after = await captureStatus(s);
    check(after.viewerHandle === before.viewerHandle && after.pages === before.pages && after.items === before.items, `capture status persisted across a browser restart (${after.pages} pages, bound to "${after.viewerHandle}")`);
    const stats = await rpc(s, 'getStats');
    check(stats.items === exp.items && stats.memberships === exp.memberships, 'library persisted across a browser restart');
  }

  // -------------------------------------------------------------- 11. wipe resets capture state, and a different account can then be captured
  {
    await rpc(s, 'wipeData');
    const st = await captureStatus(s);
    check(st.pages === 0 && st.viewerHandle === undefined && (await rpc(s, 'getStats')).items === 0, 'wipeData empties the library AND resets the capture counters and the bound account');
    mock.state.viewer = 'secondaccount';
    const r = await visit(s, mock.urls.favorites('secondaccount'));
    await r.page.close();
    check(r.after.viewerHandle === 'secondaccount' && (await rpc(s, 'getStats')).items === exp.items, 'after a wipe the library can be rebuilt for a different account');
  }

  // -------------------------------------------------------------- 12. the STRANGER handle really is what the mock served (guards against a vacuous test)
  check(mock.strangerCollection.owner === STRANGER && THEMES.length === 5, 'test data sanity: the stranger collection belongs to a different user');

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
