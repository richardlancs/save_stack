// The capture pipeline against the REAL SQLite adapter: what enters the library, what is refused, and what is only counted.
import { describe, expect, it } from 'vitest';
import { createCapturePipeline, type SenderInfo, type StatusStore } from '../../src/extension/capture/pipeline';
import { tiktokAdapter } from '../../src/platforms/tiktok/adapter';
import { CAPTURE_CHANNEL, MAX_BODY_CHARS, type AcceptedPage, type CaptureStatus } from '../../src/platforms/capture-protocol';
import { createRegistry, registry } from '../../src/platforms/registry';
import { itemId, item, page, coll, collectionList, collectionDetail, collectionId, NOW_MS } from '../support/tiktok-payloads';
import { memoryAdapter } from '../storage/helpers';
import type { ParsedBatch, UpsertResult } from '../../src/core/model';

const EXT = 'ext-id-123';
const OK: SenderInfo = { id: EXT, origin: 'https://www.tiktok.com', frameId: 0 };
const VIEWER = 'testuser';

const message = (kind: string, body: unknown, o: Record<string, unknown> = {}) => ({
  channel: CAPTURE_CHANNEL, v: 1, platform: 'tiktok', kind, capturedAt: NOW_MS, body: typeof body === 'string' ? body : JSON.stringify(body),
  pageHandle: VIEWER, viewerHandle: VIEWER, ...o,
});
const favPage = (from: number, to: number, cursor = '1786000000', hasMore = true) =>
  page(cursor, hasMore, Array.from({ length: to - from + 1 }, (_, i) => item(from + i)));

function memStore(initial?: CaptureStatus): StatusStore & { current: CaptureStatus | undefined; saves: number } {
  const s = { current: initial, saves: 0, load: async () => (s.current ? structuredClone(s.current) : undefined), save: async (v: CaptureStatus) => { s.current = structuredClone(v); s.saves++; } };
  return s;
}

async function setup(o: { ingest?: (b: ParsedBatch) => Promise<UpsertResult>; store?: ReturnType<typeof memStore>; registry?: typeof registry } = {}) {
  const mem = await memoryAdapter(() => NOW_MS);
  const store = o.store ?? memStore();
  const pipeline = createCapturePipeline({
    registry: o.registry ?? registry,
    ownExtensionId: EXT,
    store,
    now: () => NOW_MS,
    ingest: o.ingest ?? ((b) => mem.adapter.upsertBatch(b)),
  });
  const count = (sql: string) => Number(mem.db.selectValue(sql));
  return { ...mem, pipeline, store, count, itemsInDb: () => count('SELECT count(*) FROM items') };
}

describe('capture pipeline: ingestion', () => {
  it('stores a favorites page, with an interpolated saved-at, and counts it', async () => {
    const t = await setup();
    const out = await t.pipeline.handle(message('favorites', favPage(1, 5, '1785000000'), { requestCursor: '1786000000' }), OK);
    expect(out).toMatchObject({ accepted: true, kind: 'favorites', items: 5, inserted: 5 });
    expect(t.itemsInDb()).toBe(5);
    expect(t.count("SELECT count(*) FROM items WHERE saved_at_source = 'interpolated'")).toBe(5);
    const s = await t.pipeline.getStatus();
    expect(s).toMatchObject({ viewerHandle: VIEWER, pages: 1, items: 5, inserted: 5, duplicates: 0, rejected: {} });
    expect(await t.adapter.getAccount('tiktok')).toEqual({ platform: 'tiktok', handle: VIEWER }); // bound by the database, with the data
    expect(s.byKind.favorites).toMatchObject({ pages: 1, items: 5 });
    expect(s.lastPage).toMatchObject({ kind: 'favorites', hasMore: true, itemsDelivered: 5 });
  });

  it('a page whose lower bound is unknown (the last or only page) is dated "unknown", not invented', async () => {
    const t = await setup();
    await t.pipeline.handle(message('favorites', page('0', false, [item(1), item(2)]), { requestCursor: '0' }), OK);
    expect(t.count("SELECT count(*) FROM items WHERE saved_at_source = 'unknown'")).toBe(2);
  });

  it('stores collections and their memberships, in list order', async () => {
    const t = await setup();
    const c1 = coll(1, 'Recipes', 4);
    await t.pipeline.handle(message('favorites', favPage(1, 6)), OK);
    expect(await t.pipeline.handle(message('collection_list', collectionList([c1])), OK)).toMatchObject({ accepted: true });
    const out = await t.pipeline.handle(message('collection_items', page('3', false, [item(2), item(4), item(6)]), { collectionId: collectionId(1), requestCursor: '0' }), OK);
    expect(out).toMatchObject({ accepted: true, kind: 'collection_items' });
    expect(t.count('SELECT count(*) FROM collections')).toBe(1);
    expect(t.count('SELECT count(*) FROM item_collections')).toBe(3);
    // collection membership never invents items: still exactly the 6 favorites
    expect(t.itemsInDb()).toBe(6);
    const pos = t.db.selectValues('SELECT position FROM item_collections ORDER BY position').map(Number);
    expect(pos).toEqual([0, 1, 2]);
  });

  it('a later page of a collection continues the positions from its offset cursor', async () => {
    const t = await setup();
    await t.pipeline.handle(message('collection_list', collectionList([coll(1, 'Recipes', 4)])), OK);
    await t.pipeline.handle(message('collection_items', page('2', true, [item(1), item(2)]), { collectionId: collectionId(1), requestCursor: '0' }), OK);
    await t.pipeline.handle(message('collection_items', page('4', false, [item(3), item(4)]), { collectionId: collectionId(1), requestCursor: '2' }), OK);
    expect(t.db.selectValues('SELECT position FROM item_collections ORDER BY position').map(Number)).toEqual([0, 1, 2, 3]);
  });

  it('collection_detail updates the declared total without inventing items', async () => {
    const t = await setup();
    const c = coll(1, 'Recipes', 48);
    await t.pipeline.handle(message('collection_list', collectionList([c])), OK);
    expect(await t.pipeline.handle(message('collection_detail', collectionDetail(c), { collectionId: collectionId(1) }), OK)).toMatchObject({ accepted: true });
    expect(t.itemsInDb()).toBe(0);
    expect(t.count('SELECT declared_total FROM collections')).toBe(48);
  });

  it('an empty final page is accepted and recorded (it is how completion is observed)', async () => {
    const t = await setup();
    const out = await t.pipeline.handle(message('favorites', page('0', false, []), { requestCursor: '1700000000' }), OK);
    expect(out).toMatchObject({ accepted: true, items: 0 });
    expect((await t.pipeline.getStatus()).lastPage).toMatchObject({ hasMore: false, itemsDelivered: 0 });
  });

  it('reports drift: unknown item keys and bad records', async () => {
    const t = await setup();
    const withNew = { ...item(1), brandNewPlatformField: { x: 1 } };
    const broken = { notAnItem: true };
    await t.pipeline.handle(message('favorites', page('1786000000', true, [withNew, broken, item(2)])), OK);
    const s = await t.pipeline.getStatus();
    expect(s.drift.unknownItemKeys).toContain('brandNewPlatformField');
    expect(s.drift.badRecords).toBe(1);
    expect(s.drift.lastReportAt).toBe(NOW_MS);
    expect(s.drift.parserVersion).toBeGreaterThan(0);
    expect(t.itemsInDb()).toBe(2); // the broken record was dropped, the rest stored
  });
});

describe('capture pipeline: re-sent pages are applied, not skipped', () => {
  it('a re-sent page is applied again, counted, and reported as adding nothing new', async () => {
    const t = await setup();
    const m = message('favorites', favPage(1, 3), { requestCursor: '1786000000' });
    expect(await t.pipeline.handle(m, OK)).toMatchObject({ accepted: true, inserted: 3 });
    const second = await t.pipeline.handle(m, OK);
    expect(second).toMatchObject({ accepted: true, duplicate: true, inserted: 0, items: 3 });
    expect(await t.pipeline.getStatus()).toMatchObject({ pages: 2, items: 6, inserted: 3, duplicates: 1 });
    expect(t.itemsInDb()).toBe(3);
  });

  it('applying it again refreshes what expires: a re-signed thumbnail URL replaces the old one', async () => {
    const t = await setup();
    await t.pipeline.handle(message('favorites', favPage(1, 2), { requestCursor: '5' }), OK);
    const before = String(t.db.selectValue('SELECT thumbnail_url FROM items WHERE external_id = ?1', [itemId(1)]));
    const resent = page('1786000000', true, [1, 2].map((n) => { const it = item(n); it.video.cover = 'https://example.invalid/cover/' + n + '?x-expires=NEW'; return it; }));
    await t.pipeline.handle(message('favorites', resent, { requestCursor: '5' }), OK);
    const after = String(t.db.selectValue('SELECT thumbnail_url FROM items WHERE external_id = ?1', [itemId(1)]));
    expect(after).not.toBe(before);
    expect(after).toContain('x-expires=NEW');
  });

  it('per-response envelope fields that change on every request make no difference', async () => {
    const t = await setup();
    const a = favPage(1, 3), b = favPage(1, 3);
    (b as Record<string, any>).extra = { now: 1_999_999_999_999, logid: 'DIFFERENT' };
    await t.pipeline.handle(message('favorites', a, { requestCursor: '5' }), OK);
    const out = await t.pipeline.handle(message('favorites', b, { requestCursor: '5' }), OK);
    expect(out).toMatchObject({ accepted: true, duplicate: true, inserted: 0 });
    expect(t.itemsInDb()).toBe(3);
  });

  it('a page with a new video is not a duplicate', async () => {
    const t = await setup();
    await t.pipeline.handle(message('favorites', favPage(1, 3), { requestCursor: '5' }), OK);
    const out = await t.pipeline.handle(message('favorites', favPage(1, 4), { requestCursor: '5' }), OK);
    expect(out.duplicate).toBeUndefined();
    expect(out.inserted).toBe(1);
    expect(t.itemsInDb()).toBe(4);
  });

  it('a page without videos (the end of a list, a collection list) is never called a duplicate', async () => {
    const t = await setup();
    const end = message('favorites', page('0', false, []), { requestCursor: '5' });
    await t.pipeline.handle(end, OK);
    expect((await t.pipeline.handle(end, OK)).duplicate).toBeUndefined();
    const list = message('collection_list', collectionList([coll(1, 'A', 1)]));
    await t.pipeline.handle(list, OK);
    expect((await t.pipeline.handle(list, OK)).duplicate).toBeUndefined();
  });
});

describe('capture pipeline: observers (the sync listens here)', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('tells an observer about every accepted page: ids, cursors, whether more follows, what was new', async () => {
    const t = await setup();
    const seen: AcceptedPage[] = [];
    t.pipeline.subscribe({ accepted: (p) => { seen.push(p); } });
    await t.pipeline.handle(message('favorites', favPage(1, 3, '1786000000', true), { requestCursor: '0' }), OK);
    await tick();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'favorites', requestCursor: '0', responseCursor: '1786000000', hasMore: true, itemsDelivered: 3, inserted: 3, reindexed: 0, duplicate: false });
    expect(seen[0]!.externalIds).toEqual([itemId(1), itemId(2), itemId(3)]);
  });

  it('reports the collections listed on a collection-list page and the declared total on a detail page', async () => {
    const t = await setup();
    const seen: AcceptedPage[] = [];
    t.pipeline.subscribe({ accepted: (p) => { seen.push(p); } });
    const c = coll(1, 'Recipes', 21);
    await t.pipeline.handle(message('collection_list', collectionList([c])), OK);
    await t.pipeline.handle(message('collection_detail', collectionDetail(c), { collectionId: collectionId(1) }), OK);
    await tick();
    expect(seen[0]!.collections).toEqual([{ id: collectionId(1), name: 'Recipes', declaredTotal: 21 }]);
    expect(seen[1]).toMatchObject({ kind: 'collection_detail', collectionId: collectionId(1), declaredTotal: 21 });
  });

  it('a re-sent page is reported with the same ids, flagged, and nothing new', async () => {
    const t = await setup();
    const seen: AcceptedPage[] = [];
    t.pipeline.subscribe({ accepted: (p) => { seen.push(p); } });
    const m = message('favorites', favPage(1, 3), { requestCursor: '5' });
    await t.pipeline.handle(m, OK);
    await t.pipeline.handle(m, OK);
    await tick();
    expect(seen.map((p) => p.duplicate)).toEqual([false, true]);
    expect(seen[1]!.externalIds).toEqual(seen[0]!.externalIds);
    expect(seen[1]).toMatchObject({ inserted: 0, reindexed: 0, requestCursor: '5', hasMore: true });
  });

  it('tells an observer about rejections, with the reason', async () => {
    const t = await setup();
    const rejected: string[] = [];
    t.pipeline.subscribe({ rejected: (r) => { rejected.push(r); } });
    await t.pipeline.handle(message('favorites', favPage(1, 3), { pageHandle: 'someoneelse' }), OK);
    await t.pipeline.handle(message('favorites', 'not json'), OK);
    await tick();
    expect(rejected).toEqual(['not_own_profile', 'bad_json']);
  });

  it('tells an observer which tab each outcome came from (the sync only listens to its own window), and nothing when the browser gave no tab', async () => {
    const t = await setup();
    const from: Array<{ kind: string; tabId?: number }> = [];
    t.pipeline.subscribe({
      accepted: (_p, src) => { from.push({ kind: 'accepted', ...(src?.tabId !== undefined ? { tabId: src.tabId } : {}) }); },
      rejected: (_r, _k, src) => { from.push({ kind: 'rejected', ...(src?.tabId !== undefined ? { tabId: src.tabId } : {}) }); },
    });
    await t.pipeline.handle(message('favorites', favPage(1, 3)), { ...OK, tabId: 41 });
    await t.pipeline.handle(message('favorites', favPage(4, 6), { pageHandle: 'someoneelse' }), { ...OK, tabId: 42 });
    await t.pipeline.handle(message('favorites', favPage(7, 9)), OK); // no tab: the previous message's tab must not leak into this outcome
    await tick();
    expect(from).toEqual([{ kind: 'accepted', tabId: 41 }, { kind: 'rejected', tabId: 42 }, { kind: 'accepted' }]);
  });

  it('an observer that throws or rejects can neither break a capture nor see it twice; unsubscribing stops delivery', async () => {
    const t = await setup();
    const calls: number[] = [];
    const off = t.pipeline.subscribe({ accepted: () => { calls.push(1); throw new Error('observer bug'); } });
    t.pipeline.subscribe({ accepted: async () => { calls.push(2); throw new Error('async observer bug'); } });
    expect(await t.pipeline.handle(message('favorites', favPage(1, 2), { requestCursor: '1' }), OK)).toMatchObject({ accepted: true, inserted: 2 });
    await tick();
    expect(calls.sort()).toEqual([1, 2]);
    off();
    await t.pipeline.handle(message('favorites', favPage(3, 4), { requestCursor: '2' }), OK);
    await tick();
    expect(calls.sort()).toEqual([1, 2, 2]);
    expect(t.itemsInDb()).toBe(4);
  });

  it('observers are not told about pages that were refused', async () => {
    const t = await setup();
    let accepted = 0;
    t.pipeline.subscribe({ accepted: () => { accepted++; } });
    await t.pipeline.handle(message('favorites', favPage(1, 2), { viewerHandle: '' }), OK);
    await t.pipeline.handle(message('post_item_list', favPage(1, 2)), OK);
    await tick();
    expect(accepted).toBe(0);
  });
});

describe('capture pipeline: who may send', () => {
  const senders: Array<[string, SenderInfo]> = [
    ['another extension', { id: 'other-ext', origin: 'https://www.tiktok.com', frameId: 0 }],
    ['no id', { origin: 'https://www.tiktok.com', frameId: 0 }],
    ['a different site', { id: EXT, origin: 'https://evil.example', frameId: 0 }],
    ['a look-alike host', { id: EXT, origin: 'https://www.tiktok.com.evil.example', frameId: 0 }],
    ['no origin', { id: EXT, frameId: 0 }],
    ['an extension page', { id: EXT, origin: `chrome-extension://${EXT}`, frameId: 0 }],
    ['a sub-frame', { id: EXT, origin: 'https://www.tiktok.com', frameId: 3 }],
  ];
  it.each(senders)('refuses %s and stores nothing', async (_name, sender) => {
    const t = await setup();
    const out = await t.pipeline.handle(message('favorites', favPage(1, 3)), sender);
    expect(out).toMatchObject({ accepted: false, reason: 'sender' });
    expect(t.itemsInDb()).toBe(0);
    expect((await t.pipeline.getStatus()).rejected.sender).toBe(1);
  });
});

describe('capture pipeline: identity guard (own data only)', () => {
  it('refuses when the signed-in user is unknown', async () => {
    const t = await setup();
    const m = message('favorites', favPage(1, 3)); delete (m as Record<string, unknown>).viewerHandle;
    expect(await t.pipeline.handle(m, OK)).toMatchObject({ accepted: false, reason: 'identity_unknown' });
    expect(t.itemsInDb()).toBe(0);
  });

  it("refuses another person's profile page", async () => {
    const t = await setup();
    expect(await t.pipeline.handle(message('favorites', favPage(1, 3), { pageHandle: 'someoneelse' }), OK)).toMatchObject({ accepted: false, reason: 'not_own_profile' });
    expect(await t.pipeline.handle(message('collection_items', page('3', false, [item(1)]), { pageHandle: 'someoneelse', collectionId: collectionId(1) }), OK)).toMatchObject({ reason: 'not_own_profile' });
    expect(t.itemsInDb()).toBe(0);
  });

  it('refuses when the page is not a profile page at all (no page handle)', async () => {
    const t = await setup();
    const m = message('favorites', favPage(1, 3)); delete (m as Record<string, unknown>).pageHandle;
    expect(await t.pipeline.handle(m, OK)).toMatchObject({ reason: 'not_own_profile' });
    expect(t.itemsInDb()).toBe(0);
  });

  it('compares handles case-insensitively', async () => {
    const t = await setup();
    expect(await t.pipeline.handle(message('favorites', favPage(1, 2), { pageHandle: 'TestUser', viewerHandle: 'testUSER' }), OK)).toMatchObject({ accepted: true });
    expect(t.itemsInDb()).toBe(2);
  });

  it('refuses a collection list that names a different account, and stores nothing', async () => {
    const t = await setup();
    const foreign = collectionList([coll(1, 'Theirs', 3, 1, 'someoneelse')]);
    expect(await t.pipeline.handle(message('collection_list', foreign), OK)).toMatchObject({ accepted: false, reason: 'owner_mismatch' });
    expect(t.count('SELECT count(*) FROM collections')).toBe(0);
    const foreignDetail = collectionDetail(coll(1, 'Theirs', 3, 1, 'someoneelse'));
    expect(await t.pipeline.handle(message('collection_detail', foreignDetail, { collectionId: collectionId(1) }), OK)).toMatchObject({ reason: 'owner_mismatch' });
    expect(t.count('SELECT count(*) FROM collections')).toBe(0);
  });

  it('binds the library to the first account and refuses a second one until the library is wiped', async () => {
    const t = await setup();
    await t.pipeline.handle(message('favorites', favPage(1, 2)), OK);
    const other = message('favorites', favPage(3, 4), { pageHandle: 'secondaccount', viewerHandle: 'secondaccount' });
    expect(await t.pipeline.handle(other, OK)).toMatchObject({ accepted: false, reason: 'account_mismatch' });
    expect(t.itemsInDb()).toBe(2);
    await t.pipeline.reset(); // the status alone does not unbind: the DATABASE holds the binding
    expect(await t.pipeline.handle(other, OK)).toMatchObject({ accepted: false, reason: 'account_mismatch' });
    await t.adapter.wipe(); // wipeData empties the library and its binding; the service worker then resets the status
    await t.pipeline.reset();
    expect(await t.pipeline.handle(other, OK)).toMatchObject({ accepted: true });
    expect((await t.pipeline.getStatus()).viewerHandle).toBe('secondaccount');
    expect(t.itemsInDb()).toBe(2);
  });

  it('a refused capture does not bind the library to that account', async () => {
    const t = await setup();
    await t.pipeline.handle(message('favorites', favPage(1, 2), { pageHandle: 'someoneelse' }), OK); // not own profile: refused
    expect((await t.pipeline.getStatus()).viewerHandle).toBeUndefined();
    expect(await t.pipeline.handle(message('favorites', favPage(1, 2), { pageHandle: 'mine', viewerHandle: 'mine' }), OK)).toMatchObject({ accepted: true });
  });
});

describe('capture pipeline: the account binding lives in the database', () => {
  it('still refuses a second account after the service worker lost its cache (a fresh status; the database remembers)', async () => {
    const t = await setup();
    await t.pipeline.handle(message('favorites', favPage(1, 2)), OK);
    const amnesiac = createCapturePipeline({ registry, ownExtensionId: EXT, store: memStore(), now: () => NOW_MS, ingest: (b) => t.adapter.upsertBatch(b) });
    const other = message('favorites', favPage(3, 4), { pageHandle: 'bob', viewerHandle: 'bob' });
    expect(await amnesiac.handle(other, OK)).toMatchObject({ accepted: false, reason: 'account_mismatch' });
    expect(t.itemsInDb()).toBe(2);
    expect(await amnesiac.getStatus()).toMatchObject({ viewerHandle: 'testuser' }); // and it relearned who owns the library
  });

  it('refuses a second account even when the status store cannot be read at all', async () => {
    const t = await setup();
    await t.pipeline.handle(message('favorites', favPage(1, 2)), OK);
    const broken: StatusStore = { load: async () => { throw new Error('storage gone'); }, save: async () => { throw new Error('storage gone'); } };
    const p = createCapturePipeline({ registry, ownExtensionId: EXT, store: broken, now: () => NOW_MS, ingest: (b) => t.adapter.upsertBatch(b) });
    expect(await p.handle(message('favorites', favPage(3, 4), { pageHandle: 'bob', viewerHandle: 'bob' }), OK)).toMatchObject({ reason: 'account_mismatch' });
    expect(t.itemsInDb()).toBe(2);
  });

  it('never overwrites a stored status it could not read', async () => {
    const t = await setup();
    let saves = 0;
    const flaky: StatusStore = { load: async () => { throw new Error('storage gone'); }, save: async () => { saves++; } };
    const p = createCapturePipeline({ registry, ownExtensionId: EXT, store: flaky, now: () => NOW_MS, ingest: (b) => t.adapter.upsertBatch(b) });
    await p.handle(message('favorites', favPage(1, 2)), OK);
    await p.handle(message('favorites', favPage(3, 4), { pageHandle: 'x', viewerHandle: 'x' }), OK);
    expect(saves).toBe(0);
  });

  it('follows a username change (same stable id), and refuses someone else who took the old name', async () => {
    const t = await setup();
    await t.pipeline.handle(message('favorites', favPage(1, 2), { pageHandle: 'oldname', viewerHandle: 'oldname', viewerId: '7000000000000000099' }), OK);
    const renamed = await t.pipeline.handle(message('favorites', favPage(3, 4), { pageHandle: 'newname', viewerHandle: 'newname', viewerId: '7000000000000000099' }), OK);
    expect(renamed).toMatchObject({ accepted: true });
    expect(await t.adapter.getAccount('tiktok')).toEqual({ platform: 'tiktok', handle: 'newname', id: '7000000000000000099' });
    const squatter = await t.pipeline.handle(message('favorites', favPage(5, 6), { pageHandle: 'oldname', viewerHandle: 'oldname', viewerId: '7000000000000000123' }), OK);
    expect(squatter).toMatchObject({ accepted: false, reason: 'account_mismatch' });
    expect(t.itemsInDb()).toBe(4);
  });

  it('an unusable stored status (missing fields, wrong shapes) is repaired instead of breaking captures', async () => {
    const store = memStore({ version: 1, pages: 'many', rejected: 5, drift: null, byKind: [] } as never);
    const t = await setup({ store });
    expect(await t.pipeline.handle(message('favorites', 'not json'), OK)).toMatchObject({ accepted: false, reason: 'bad_json' });
    expect(await t.pipeline.handle(message('favorites', favPage(1, 2)), OK)).toMatchObject({ accepted: true });
    expect(await t.pipeline.getStatus()).toMatchObject({ pages: 1, rejected: { bad_json: 1 }, drift: { unknownItemKeys: [] } });
  });
});

describe('capture pipeline: cheap checks come first', () => {
  const spyRegistry = () => {
    const calls = { parse: 0 };
    return { calls, registry: createRegistry([{ ...tiktokAdapter, parse: (c) => { calls.parse++; return tiktokAdapter.parse(c); } }]) };
  };

  it("a message for someone else's page is refused before its body is parsed (even when the body is garbage)", async () => {
    const { calls, registry: r } = spyRegistry();
    const t = await setup({ registry: r });
    expect(await t.pipeline.handle(message('favorites', '{not json', { pageHandle: 'stranger' }), OK)).toMatchObject({ reason: 'not_own_profile' }); // not bad_json
    expect(await t.pipeline.handle(message('favorites', 'x'.repeat(5_000_000), { viewerHandle: undefined }), OK)).toMatchObject({ reason: 'identity_unknown' });
    expect(calls.parse).toBe(0);
  });

  it('a flood of refused messages writes the status at most one at a time', async () => {
    let saves = 0;
    let inFlight = 0, maxInFlight = 0;
    const slow: StatusStore = {
      load: async () => undefined,
      save: async () => { saves++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; },
    };
    const t = await setup({ store: slow as never });
    for (let i = 0; i < 300; i++) await t.pipeline.handle(message('favorites', favPage(1, 2), { pageHandle: 'stranger' }), OK);
    await new Promise((r) => setTimeout(r, 80));
    expect(maxInFlight).toBe(1);
    expect(saves).toBeLessThan(60); // coalesced: nowhere near one write per message
    expect((await t.pipeline.getStatus()).rejected.not_own_profile).toBe(300);
  });

  it('a page can carry at most 300 videos into the library, however large the message', async () => {
    const t = await setup();
    const flood = page('1786000000', true, Array.from({ length: 20_000 }, (_, i) => ({ id: itemId(50_000 + i), desc: 'spam' })));
    const out = await t.pipeline.handle(message('favorites', flood), OK);
    expect(out).toMatchObject({ accepted: true, items: 300 });
    expect(t.itemsInDb()).toBe(300);
    expect((await t.pipeline.getStatus()).drift.badRecords).toBeGreaterThanOrEqual(1); // "only the first 300 were read" is reported
  });
});

describe('capture pipeline: memberships that arrive before their collection', () => {
  it('are kept and applied when the collection list arrives', async () => {
    const t = await setup();
    const items3 = page('3', false, [item(1), item(2), item(3)]);
    await t.pipeline.handle(message('collection_items', items3, { collectionId: collectionId(1), requestCursor: '0' }), OK);
    expect(t.itemsInDb()).toBe(3);
    expect(t.count('SELECT count(*) FROM item_collections')).toBe(0); // the collection did not exist yet
    expect((await t.pipeline.getStatus()).skippedMemberships).toBe(3);
    await t.pipeline.handle(message('collection_list', collectionList([coll(1, 'Recipes', 3)])), OK);
    expect(t.count('SELECT count(*) FROM item_collections')).toBe(3);
    expect(t.db.selectValues('SELECT position FROM item_collections ORDER BY position').map(Number)).toEqual([0, 1, 2]);
    expect(t.db.selectValues("SELECT rowid FROM items_fts WHERE items_fts MATCH 'collections:recipes'").length).toBe(3); // and the name is searchable on them
  });

  it('are applied by a detail response too, and only once', async () => {
    const t = await setup();
    const c = coll(1, 'Recipes', 2);
    await t.pipeline.handle(message('collection_items', page('2', false, [item(1), item(2)]), { collectionId: collectionId(1), requestCursor: '0' }), OK);
    await t.pipeline.handle(message('collection_detail', collectionDetail(c), { collectionId: collectionId(1) }), OK);
    expect(t.count('SELECT count(*) FROM item_collections')).toBe(2);
    t.db.exec('DELETE FROM item_collections');
    await t.pipeline.handle(message('collection_detail', collectionDetail(c), { collectionId: collectionId(1) }), OK);
    expect(t.count('SELECT count(*) FROM item_collections')).toBe(0); // consumed: not re-applied from memory
  });
});

describe('capture pipeline: malformed and hostile input', () => {
  it.each([
    ['not JSON', 'this is not json'],
    ['a truncated JSON', '{"itemList":[{"id":"1"'],
  ])('%s -> bad_json', async (_n, body) => {
    const t = await setup();
    expect(await t.pipeline.handle(message('favorites', body), OK)).toMatchObject({ accepted: false, reason: 'bad_json' });
    expect(t.itemsInDb()).toBe(0);
  });

  it.each([['null', 'null'], ['a string', '"x"'], ['a number', '5'], ['an array', '[]'], ['an empty object', '{}'], ['an API error', '{"statusCode":10000,"status_msg":"captcha"}']])('a JSON %s is not a page -> bad_envelope, nothing stored', async (_n, body) => {
    const t = await setup();
    expect(await t.pipeline.handle(message('favorites', body), OK)).toMatchObject({ accepted: false, reason: 'bad_envelope' });
    expect(t.itemsInDb()).toBe(0);
    expect((await t.pipeline.getStatus()).pages).toBe(0);
  });

  it('rejects unknown kinds/platforms and malformed messages, counting each reason', async () => {
    const t = await setup();
    await t.pipeline.handle(message('post_item_list', favPage(1, 2)), OK);
    await t.pipeline.handle(message('favorites', favPage(1, 2), { platform: 'instagram' }), OK);
    await t.pipeline.handle(message('favorites', favPage(1, 2), { requestCursor: 'abc' }), OK);
    await t.pipeline.handle(message('favorites', favPage(1, 2), { capturedAt: 5 }), OK);
    await t.pipeline.handle(message('favorites', 'x'.repeat(MAX_BODY_CHARS + 1)), OK);
    await t.pipeline.handle('a string', OK);
    await t.pipeline.handle(null, OK);
    const s = await t.pipeline.getStatus();
    expect(s.rejected).toMatchObject({ unknown_kind: 1, wrong_platform: 1, malformed: 3, stale: 1, too_large: 1 });
    expect(t.itemsInDb()).toBe(0);
    expect(s.pages).toBe(0);
  });

  it('never throws and never stores anything for 300 garbage messages', async () => {
    const t = await setup();
    const junk: unknown[] = [];
    for (let i = 0; i < 300; i++) {
      junk.push([undefined, null, i, `s${i}`, [i], { channel: CAPTURE_CHANNEL }, { ...message('favorites', `{"x":${i}`), v: i }, new Proxy({}, { get() { throw new Error('t'); } })][i % 8]);
    }
    for (const j of junk) await expect(t.pipeline.handle(j, OK)).resolves.toMatchObject({ accepted: false });
    expect(t.itemsInDb()).toBe(0);
  });

  it('hostile payloads inside a valid envelope cannot break ingestion (the parser drops what it cannot read)', async () => {
    const t = await setup();
    const hostile = page('1786000000', true, [
      { id: itemId(1), desc: 'x'.repeat(100_000), author: { uniqueId: 'a'.repeat(500) }, stats: { playCount: 'NaN' } },
      { id: '../../etc/passwd' }, null, 5, 'str', [],
      { ...item(2), video: { duration: -5, cover: 'javascript:alert(1)' } },
    ]);
    const out = await t.pipeline.handle(message('favorites', hostile), OK);
    expect(out.accepted).toBe(true);
    for (const r of t.db.selectObjects('SELECT external_id, caption, thumbnail_url, author_handle FROM items')) {
      expect(String(r.external_id)).toMatch(/^\d+$/);
      expect(String(r.caption ?? '').length).toBeLessThanOrEqual(10_000);
      expect(String(r.thumbnail_url ?? 'https://')).toMatch(/^https:\/\//);
      expect(String(r.author_handle).length).toBeLessThanOrEqual(64);
    }
  });
});

describe('capture pipeline: failures and concurrency', () => {
  it('a failed write is reported and can simply be retried', async () => {
    const mem = await memoryAdapter(() => NOW_MS);
    let failing = true;
    const t = await setup({ ingest: async (b) => { if (failing) throw new Error('database unavailable'); return mem.adapter.upsertBatch(b); } });
    const m = message('favorites', favPage(1, 3), { requestCursor: '9' });
    expect(await t.pipeline.handle(m, OK)).toMatchObject({ accepted: false, reason: 'ingest_failed' });
    expect((await t.pipeline.getStatus()).pages).toBe(0);
    failing = false;
    const retry = await t.pipeline.handle(m, OK);
    expect(retry).toMatchObject({ accepted: true, inserted: 3 });
    expect(retry.duplicate).toBeUndefined(); // it added something new
    expect(mem.db.selectValue('SELECT count(*) FROM items')).toBe(3);
  });

  it('concurrent captures are applied one at a time with no lost counter updates', async () => {
    const t = await setup();
    const outcomes = await Promise.all(Array.from({ length: 30 }, (_, i) => t.pipeline.handle(message('favorites', favPage(i * 3 + 1, i * 3 + 3), { requestCursor: String(1000 + i) }), OK)));
    expect(outcomes.every((o) => o.accepted)).toBe(true);
    expect(t.itemsInDb()).toBe(90);
    const s = await t.pipeline.getStatus();
    expect(s).toMatchObject({ pages: 30, items: 90, inserted: 90 });
  });

  it('pages are stored and reported in arrival order even when storing an earlier one takes longer', async () => {
    const mem = await memoryAdapter(() => NOW_MS);
    let call = 0;
    const t2 = await setup({ ingest: async (b) => { const n = call++; await new Promise((r) => setTimeout(r, n === 0 ? 40 : 0)); return mem.adapter.upsertBatch(b); } });
    const order: string[] = [];
    t2.pipeline.subscribe({ accepted: (p) => { order.push(p.requestCursor ?? ''); } });
    await Promise.all([
      t2.pipeline.handle(message('favorites', favPage(1, 2), { requestCursor: '1' }), OK),
      t2.pipeline.handle(message('favorites', favPage(3, 4), { requestCursor: '2' }), OK),
      t2.pipeline.handle(message('favorites', favPage(5, 6), { requestCursor: '3' }), OK),
    ]);
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual(['1', '2', '3']);
    expect((await t2.pipeline.getStatus()).lastPage).toMatchObject({ kind: 'favorites' });
  });

  it('the same page arriving twice at once: the first inserts, the second adds nothing (serialized)', async () => {
    const t = await setup();
    const m = message('favorites', favPage(1, 3), { requestCursor: '7' });
    const [a, b] = await Promise.all([t.pipeline.handle(m, OK), t.pipeline.handle(m, OK)]);
    expect([a.inserted, b.inserted].sort()).toEqual([0, 3]);
    expect([a.duplicate === true, b.duplicate === true].sort()).toEqual([false, true]);
    expect(await t.pipeline.getStatus()).toMatchObject({ pages: 2, duplicates: 1, inserted: 3 });
  });

  it('a failing status store never fails a capture, and a corrupt saved status is replaced', async () => {
    const store: StatusStore = { load: async () => ({ version: 99 } as never), save: async () => { throw new Error('quota'); } };
    const mem = await memoryAdapter(() => NOW_MS);
    const pipeline = createCapturePipeline({ registry, ownExtensionId: EXT, store, now: () => NOW_MS, ingest: (b) => mem.adapter.upsertBatch(b) });
    expect(await pipeline.handle(message('favorites', favPage(1, 2)), OK)).toMatchObject({ accepted: true });
    expect((await pipeline.getStatus()).pages).toBe(1);
    const throwingLoad: StatusStore = { load: async () => { throw new Error('storage gone'); }, save: async () => undefined };
    const p2 = createCapturePipeline({ registry, ownExtensionId: EXT, store: throwingLoad, now: () => NOW_MS, ingest: (b) => mem.adapter.upsertBatch(b) });
    expect((await p2.getStatus()).pages).toBe(0);
  });

  it('status survives the service worker being killed (a new pipeline reloads it)', async () => {
    const store = memStore();
    const t = await setup({ store });
    await t.pipeline.handle(message('favorites', favPage(1, 4)), OK);
    const revived = createCapturePipeline({ registry, ownExtensionId: EXT, store, now: () => NOW_MS, ingest: (b) => t.adapter.upsertBatch(b) });
    expect(await revived.getStatus()).toMatchObject({ viewerHandle: VIEWER, pages: 1, items: 4 });
    // ...and the account binding survives too
    expect(await revived.handle(message('favorites', favPage(5, 6), { pageHandle: 'x', viewerHandle: 'x' }), OK)).toMatchObject({ reason: 'account_mismatch' });
  });

  it('getStatus returns a copy: callers cannot corrupt the live counters', async () => {
    const t = await setup();
    await t.pipeline.handle(message('favorites', favPage(1, 2)), OK);
    const s = await t.pipeline.getStatus();
    s.pages = 999; s.rejected.sender = 5;
    expect(await t.pipeline.getStatus()).toMatchObject({ pages: 1, rejected: {} });
  });

  it('reset clears the counters, the cached account and anything waiting for a collection', async () => {
    const t = await setup();
    await t.pipeline.handle(message('favorites', favPage(1, 2), { requestCursor: '1' }), OK);
    await t.pipeline.handle(message('collection_items', page('1', false, [item(1)]), { collectionId: collectionId(7), requestCursor: '0' }), OK);
    await t.pipeline.reset();
    expect(await t.pipeline.getStatus()).toMatchObject({ pages: 0, items: 0, duplicates: 0, skippedMemberships: 0 });
    expect((await t.pipeline.getStatus()).viewerHandle).toBeUndefined();
    await t.pipeline.handle(message('collection_list', collectionList([coll(7, 'Late', 1)])), OK);
    expect(t.count('SELECT count(*) FROM item_collections')).toBe(0); // the waiting membership was forgotten with the reset
  });

  it('works with a registry that has a different platform set', async () => {
    const mem = await memoryAdapter(() => NOW_MS);
    const pipeline = createCapturePipeline({ registry: createRegistry([]), ownExtensionId: EXT, store: memStore(), now: () => NOW_MS, ingest: (b) => mem.adapter.upsertBatch(b) });
    expect(await pipeline.handle(message('favorites', favPage(1, 2)), OK)).toMatchObject({ reason: 'wrong_platform' });
  });
});
