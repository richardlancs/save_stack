import { describe, expect, it } from 'vitest';
import collectionDetail from '../../src/platforms/tiktok/fixtures/collection_detail.json';
import collectionItemsLast from '../../src/platforms/tiktok/fixtures/collection_item_list.last_page.json';
import collectionItems1 from '../../src/platforms/tiktok/fixtures/collection_item_list.page1.json';
import collectionListFixture from '../../src/platforms/tiktok/fixtures/collection_list.json';
import favEdge from '../../src/platforms/tiktok/fixtures/favorites_item_list.edge_cases.json';
import favLast from '../../src/platforms/tiktok/fixtures/favorites_item_list.last_page.json';
import fav1 from '../../src/platforms/tiktok/fixtures/favorites_item_list.page1.json';
import { tiktokAdapter } from '../../src/platforms/tiktok/adapter';
import { TIKTOK_CAPTURE_RULES, classifyRequest } from '../../src/platforms/tiktok/capture-rules';
import { parseTikTokCapture } from '../../src/platforms/tiktok/parse';
import { interpolateSavedAt } from '../../src/platforms/tiktok/saved-at';
import type { RawCapture } from '../../src/platforms/types';
import { collectionId, itemId } from '../support/tiktok-payloads';

const NOW = 1_787_000_000_000;
const cap = (kind: string, body: unknown, extra: Partial<RawCapture> = {}): RawCapture => ({ platform: 'tiktok', kind, body, capturedAt: NOW, ...extra });

describe('capture allowlist: what may ever be read', () => {
  it('lists exactly the four endpoints that carry favorites and collections', () => {
    expect(TIKTOK_CAPTURE_RULES.map((r) => `${r.kind} ${r.path}`).sort()).toEqual([
      'collection_detail /api/collection/detail/',
      'collection_items /api/collection/item_list/',
      'collection_list /api/user/collection_list/',
      'favorites /api/user/collect/item_list/',
    ]);
  });

  it.each([
    ['https://www.tiktok.com/api/user/collect/item_list/?cursor=1750000000&count=15', { kind: 'favorites', requestCursor: '1750000000' }],
    ['/api/user/collect/item_list/?cursor=0', { kind: 'favorites', requestCursor: '0' }],
    ['/api/collection/item_list/?collectionId=7000000000000000501&cursor=30&count=30', { kind: 'collection_items', requestCursor: '30', collectionId: '7000000000000000501' }],
    ['/api/user/collection_list/?cursor=0&count=30', { kind: 'collection_list', requestCursor: '0' }],
    ['/api/collection/detail/?collectionId=7000000000000000501', { kind: 'collection_detail', collectionId: '7000000000000000501' }],
    ['/api/user/collect/item_list/', { kind: 'favorites' }],
  ])('classifies %s', (input, want) => {
    expect(classifyRequest(input)).toEqual(want);
  });

  it('NEVER classifies the account\'s own uploads, reposts, stories, playlists or anything else on the page', () => {
    for (const path of [
      '/api/post/item_list/', '/api/repost/item_list/', '/api/story/item_list/', '/api/user/playlist/', '/api/user/list/',
      '/api/drama/favorite/drama_list/', '/api/recommend/item_list/', '/api/user/detail/', '/api/comment/list/', '/api/search/general/full/',
      '/api/user/collect/item_list', '/api/user/collect/item_list/extra/', '/API/USER/COLLECT/ITEM_LIST/', '/x/api/user/collect/item_list/', '/', '',
    ]) {
      expect(classifyRequest(`https://www.tiktok.com${path}?cursor=0`), path).toBeNull();
    }
  });

  it('refuses other origins, even with an allowed path', () => {
    for (const origin of ['https://tiktok.com', 'http://www.tiktok.com', 'https://www.tiktok.com.evil.example', 'https://evil.example', 'https://m.tiktok.com', 'https://www.tiktok.com:8443']) {
      expect(classifyRequest(`${origin}/api/user/collect/item_list/?cursor=0`), origin).toBeNull();
    }
    expect(classifyRequest('//evil.example/api/user/collect/item_list/')).toBeNull();
  });

  it('forwards ONLY the cursor and collection id, and only when they are digits: tokens and signatures never leave', () => {
    const c = classifyRequest('/api/user/collect/item_list/?cursor=12&msToken=SECRET&X-Bogus=SECRET&verifyFp=SECRET&device_id=7&odinId=9&secUid=X&cursor2=5')!;
    expect(c).toEqual({ kind: 'favorites', requestCursor: '12' });
    expect(JSON.stringify(c)).not.toContain('SECRET');
    for (const bad of ['abc', '1e5', '-1', '1 2', '<script>', '', '99999999999999999', '1;2']) {
      expect(classifyRequest(`/api/user/collect/item_list/?cursor=${encodeURIComponent(bad)}`)).toEqual({ kind: 'favorites' });
    }
    expect(classifyRequest(`/api/collection/item_list/?collectionId=${'1'.repeat(25)}`)).toEqual({ kind: 'collection_items' });
  });

  it('accepts URL and Request-like inputs, and is total for junk', () => {
    expect(classifyRequest(new URL('https://www.tiktok.com/api/collection/detail/?collectionId=5'))).toEqual({ kind: 'collection_detail', collectionId: '5' });
    expect(classifyRequest({ url: '/api/user/collection_list/' })).toEqual({ kind: 'collection_list' });
    for (const junk of [null, undefined, 5, {}, [], { url: 5 }, 'http://[bad', Symbol.iterator, () => 1]) expect(classifyRequest(junk as never)).toBeNull();
  });
});

describe('saved-at estimate from cursors', () => {
  const REQ = String(1_750_000_000); // upper bound (seconds)
  const RESP = String(1_745_000_000); // lower end (seconds)

  it('spreads a page evenly between the request cursor and the response cursor, newest first, preserving order', () => {
    const t = interpolateSavedAt(4, REQ, RESP, NOW);
    expect(t).toHaveLength(4);
    expect(t[3]).toBe(1_745_000_000_000); // the last video is saved AT the response cursor
    for (let i = 1; i < 4; i++) expect(t[i]!).toBeLessThan(t[i - 1]!);
    expect(t[0]!).toBeLessThan(1_750_000_000_000);
    expect(t[0]!).toBeGreaterThan(1_745_000_000_000);
  });

  it('the first page (no request cursor) is bounded above by the capture time', () => {
    const t = interpolateSavedAt(3, '0', RESP, NOW);
    expect(t[0]!).toBeLessThan(NOW);
    expect(t[0]!).toBeGreaterThan(1_745_000_000_000);
    expect(interpolateSavedAt(3, undefined, RESP, NOW)).toEqual(t);
  });

  it('the last page (response cursor "0") has no lower end: order is kept, spaced one second apart below the upper bound', () => {
    expect(interpolateSavedAt(3, REQ, '0', NOW)).toEqual([1_750_000_000_000 - 1000, 1_750_000_000_000 - 2000, 1_750_000_000_000 - 3000]);
  });

  it('an inconsistent or implausible cursor falls back safely instead of producing nonsense', () => {
    const upper = 1_750_000_000_000;
    for (const [req, resp] of [[REQ, String(1_760_000_000)], [REQ, REQ], [REQ, 'abc'], ['junk', RESP], [REQ, '5']] as const) {
      const t = interpolateSavedAt(3, req, resp, NOW);
      expect(t.every(Number.isFinite), `${req}/${resp}`).toBe(true);
      for (let i = 1; i < 3; i++) expect(t[i]!).toBeLessThan(t[i - 1]!);
      expect(t[0]!).toBeLessThanOrEqual(req === 'junk' ? NOW : upper);
    }
    expect(interpolateSavedAt(0, REQ, RESP, NOW)).toEqual([]);
    expect(interpolateSavedAt(-1, REQ, RESP, NOW)).toEqual([]);
  });
});

describe('parse: favorites', () => {
  it('reads the first page: ids, captions, hashtags, stats, sound, author, thumbnails', () => {
    const r = parseTikTokCapture(cap('favorites', fav1, { requestCursor: '0' }));
    expect(r.problems).toEqual([]);
    expect(r.page).toMatchObject({ kind: 'favorites', hasMore: true, responseCursor: '1750000000', itemsDelivered: 4, declaredTotal: 263 });
    const [a, photo, long, many] = r.batch.items;
    expect(a).toMatchObject({
      platform: 'tiktok', externalId: itemId(1), authorHandle: 'author_002', authorName: 'Nickname 2', caption: 'Sample caption 1 #tag1 #fyp',
      hashtags: ['tag1', 'fyp'], soundTitle: 'Sound 1', soundAuthor: 'Sound Author 2', mediaType: 'video', durationSec: 16,
      stats: { views: 10000, likes: 1000, comments: 10, shares: 50, saves: 100 }, thumbnailUrl: 'https://example.invalid/cover/1', language: 'en', isAd: false,
    });
    expect(a!.postedAt).toBe((1_780_000_000 - 86400) * 1000);
    expect(photo).toMatchObject({ mediaType: 'photo', durationSec: undefined });
    expect(long!.caption!.length).toBeGreaterThan(150);
    expect(many!.hashtags).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(r.batch.items.every((i) => i.savedAtSource === 'interpolated' && typeof i.savedAt === 'number')).toBe(true);
    expect(r.batch.memberships).toBeUndefined();
  });

  it('estimates saved times from the cursors: strictly decreasing, between the request and response cursors', () => {
    const r = parseTikTokCapture(cap('favorites', fav1, { requestCursor: '1770000000' }));
    const t = r.batch.items.map((i) => i.savedAt!);
    for (let i = 1; i < t.length; i++) expect(t[i]!).toBeLessThan(t[i - 1]!);
    expect(t[0]!).toBeLessThan(1_770_000_000_000);
    expect(t.at(-1)!).toBe(1_750_000_000_000);
  });

  it('the last page: hasMore false and cursor "0" (the only reliable end-of-list signal)', () => {
    const r = parseTikTokCapture(cap('favorites', favLast, { requestCursor: '1740000000' }));
    expect(r.page).toMatchObject({ hasMore: false, responseCursor: '0', itemsDelivered: 2 });
    expect(r.batch.items[1]).toMatchObject({ mediaType: 'photo' });
  });

  it('handles every edge case seen in real data', () => {
    const r = parseTikTokCapture(cap('favorites', favEdge, { requestCursor: '0' }));
    expect(r.problems).toEqual([]);
    const byNo = (n: number) => r.batch.items.find((i) => i.externalId === itemId(n))!;
    expect(byNo(11)).toMatchObject({ caption: '', hashtags: [] }); // no caption, optional keys absent
    expect(byNo(12)).toMatchObject({ hashtags: [] });
    expect(byNo(13)).toMatchObject({ isAd: true });
    expect(byNo(14)).toMatchObject({ language: undefined }); // 'un' = undetermined
    expect(byNo(15)).toMatchObject({ caption: '日本語のサンプルキャプション #タグ', hashtags: ['タグ'] });
    expect(byNo(16).caption).toContain('@author_002');
    expect(byNo(16).hashtags).toEqual(['tag16', 'fyp']); // the @mention (textExtra type 0) is not a hashtag
    expect(byNo(17)).toMatchObject({ mediaType: 'photo', durationSec: undefined });
    expect(r.shape.missing).toBeDefined();
  });

  it('falls back to #tags in the caption when the structured hashtag fields are absent', () => {
    const body = JSON.parse(JSON.stringify(fav1));
    delete body.itemList[0].challenges;
    delete body.itemList[0].textExtra;
    body.itemList[0].desc = 'made this #Pasta and #夕飯 tonight';
    const r = parseTikTokCapture(cap('favorites', body));
    expect(r.batch.items[0]!.hashtags).toEqual(['pasta', '夕飯']);
  });

  it('accepts numbers as numeric strings (statsV2) and seconds or milliseconds for createTime', () => {
    const body = JSON.parse(JSON.stringify(fav1));
    delete body.itemList[0].stats;
    body.itemList[1].createTime = 1_780_000_000_000; // already milliseconds
    body.itemList[2].createTime = '1780000000'; // a string
    const r = parseTikTokCapture(cap('favorites', body));
    expect(r.batch.items[0]!.stats).toMatchObject({ views: 10000, likes: 1000 }); // from statsV2 strings
    expect(r.batch.items[1]!.postedAt).toBe(1_780_000_000_000);
    expect(r.batch.items[2]!.postedAt).toBe(1_780_000_000_000);
  });

  it('reports unknown item fields (the platform changed) and counts missing ones (drift signals)', () => {
    const body = JSON.parse(JSON.stringify(fav1));
    body.itemList[0].brandNewField = { x: 1 };
    body.itemList[1].anotherNewOne = 5;
    delete body.itemList[2].desc;
    delete body.itemList[3].music;
    const r = parseTikTokCapture(cap('favorites', body));
    expect(r.shape.unknownItemKeys).toEqual(['anotherNewOne', 'brandNewField']);
    expect(r.shape.missing).toMatchObject({ desc: 1, 'music.title': 1 });
    expect(r.shape.items).toBe(4);
    expect(parseTikTokCapture(cap('favorites', fav1)).shape.unknownItemKeys).toEqual([]); // known payloads raise no false alarm
  });

  it('drops records with no usable id, keeps the rest, and says so', () => {
    const body = JSON.parse(JSON.stringify(fav1));
    body.itemList.splice(1, 0, null, 5, {}, { id: 'abc' }, { id: '' }, { id: [1] }, { id: 1234 });
    const r = parseTikTokCapture(cap('favorites', body));
    expect(r.batch.items).toHaveLength(4);
    expect(r.problems.filter((p) => p.code === 'bad_record')).toHaveLength(7);
    expect(r.problems[0]).toMatchObject({ code: 'bad_record', index: 1 });
    expect(r.page.itemsDelivered).toBe(4);
  });

  it('keeps the first of a video that appears twice in one page', () => {
    const body = JSON.parse(JSON.stringify(fav1));
    body.itemList.push(JSON.parse(JSON.stringify(body.itemList[0])));
    expect(parseTikTokCapture(cap('favorites', body)).batch.items).toHaveLength(4);
  });

  it('bounds hostile values: caption, hashtags, handle, URLs', () => {
    const body = JSON.parse(JSON.stringify(fav1));
    body.itemList[0].desc = 'x'.repeat(50_000);
    body.itemList[0].challenges = Array.from({ length: 500 }, (_, i) => ({ title: `t${i}` }));
    body.itemList[0].author.uniqueId = 'a'.repeat(500);
    body.itemList[0].video.cover = 'javascript:alert(1)';
    body.itemList[0].video.originCover = 'http://insecure.example/x.jpg';
    const it = parseTikTokCapture(cap('favorites', body)).batch.items[0]!;
    expect(it.caption!.length).toBe(10_000);
    expect(it.hashtags!.length).toBe(64);
    expect(it.authorHandle.length).toBe(64);
    expect(it.thumbnailUrl).toBe('https://example.invalid/dynamicCover/1'); // only https URLs are kept
  });
});

describe('parse: collections', () => {
  it('reads a collection list, including the "total says 6, list has 5" quirk', () => {
    const r = parseTikTokCapture(cap('collection_list', collectionListFixture));
    expect(r.problems).toEqual([]);
    expect(r.batch.collections).toEqual([
      { platform: 'tiktok', externalId: collectionId(1), name: 'Collection A', declaredTotal: 48 },
      { platform: 'tiktok', externalId: collectionId(2), name: 'Collection B', declaredTotal: 9 },
      { platform: 'tiktok', externalId: collectionId(3), name: 'Collection C', declaredTotal: 37 },
      { platform: 'tiktok', externalId: collectionId(4), name: 'Collection D', declaredTotal: 1 },
      { platform: 'tiktok', externalId: collectionId(5), name: 'Collection E', declaredTotal: 2 },
    ]);
    expect(r.page).toMatchObject({ kind: 'collection_list', hasMore: false, itemsDelivered: 5, declaredTotal: 6 }); // 6 declared, 5 delivered
    expect(r.ownerHandle).toBe('testuser');
    expect(r.batch.items).toEqual([]);
  });

  it('reads a collection detail', () => {
    const r = parseTikTokCapture(cap('collection_detail', collectionDetail, { collectionId: collectionId(1) }));
    expect(r.batch.collections).toEqual([{ platform: 'tiktok', externalId: collectionId(1), name: 'Collection A', declaredTotal: 48 }]);
    expect(r.ownerHandle).toBe('testuser');
  });

  it('collection pages produce memberships at OFFSET positions, and mark saved time unknown (favorites will supply it)', () => {
    const r = parseTikTokCapture(cap('collection_items', collectionItems1, { collectionId: collectionId(1), requestCursor: '30' }));
    expect(r.page).toMatchObject({ kind: 'collection_items', hasMore: true, responseCursor: '30', itemsDelivered: 3 });
    expect(r.batch.memberships).toEqual([0, 1, 2].map((i) => ({ platform: 'tiktok', itemExternalId: itemId(21 + i), collectionExternalId: collectionId(1), position: 30 + i })));
    expect(r.batch.items.every((i) => i.savedAtSource === 'unknown')).toBe(true);
    const last = parseTikTokCapture(cap('collection_items', collectionItemsLast, { collectionId: collectionId(1), requestCursor: '48' }));
    expect(last.page).toMatchObject({ hasMore: false, responseCursor: '48' });
    expect(last.batch.memberships!.map((m) => m.position)).toEqual([48, 49]);
  });

  it('a collection page without its collection id still stores the videos, and reports why memberships are missing', () => {
    const r = parseTikTokCapture(cap('collection_items', collectionItems1));
    expect(r.batch.items).toHaveLength(3);
    expect(r.batch.memberships).toBeUndefined();
    expect(r.problems).toEqual([expect.objectContaining({ code: 'missing_collection_id' })]);
  });

  it('bad collection records are dropped one by one', () => {
    const body = JSON.parse(JSON.stringify(collectionListFixture));
    body.collectionList.push(null, { name: 'no id' }, { collectionId: 'x', name: 'bad id' }, { collectionId: '123', name: '   ' });
    const r = parseTikTokCapture(cap('collection_list', body));
    expect(r.batch.collections).toHaveLength(5);
    expect(r.problems.filter((p) => p.code === 'bad_record')).toHaveLength(4);
  });
});

describe('parse: never throws', () => {
  const junk: unknown[] = [null, undefined, 0, 1, 'str', true, [], [1, 2], {}, { itemList: 5 }, { itemList: 'x' }, { itemList: {} }, { itemList: [null, undefined, 1, 'a', [], {}] }, { collectionList: 7 }, { collectionInfo: 9 }, { collectionInfo: { collectionId: 5, name: 5 } }];

  it.each(['favorites', 'collection_items', 'collection_list', 'collection_detail', 'nonsense', '', undefined as unknown as string])('every junk body, kind %j', (kind) => {
    for (const body of junk) {
      const r = parseTikTokCapture(cap(kind, body, { collectionId: '1' }));
      expect(r.batch.items.every((i) => typeof i.externalId === 'string')).toBe(true);
      expect(Array.isArray(r.problems)).toBe(true);
    }
  });

  it('an unusable response is reported as bad_envelope rather than silently ignored', () => {
    for (const kind of ['favorites', 'collection_items', 'collection_list', 'collection_detail']) {
      expect(parseTikTokCapture(cap(kind, { hello: 'world' }, { collectionId: '1' })).problems).toEqual([expect.objectContaining({ code: 'bad_envelope' })]);
    }
    expect(parseTikTokCapture(cap('nonsense', {})).problems[0]).toMatchObject({ code: 'bad_envelope', message: expect.stringContaining('unknown capture kind') });
  });

  it('survives a body that throws when read (hostile getters)', () => {
    const evil = { get itemList(): never { throw new Error('boom'); } };
    const r = parseTikTokCapture(cap('favorites', evil));
    expect(r.batch.items).toEqual([]);
    expect(r.problems[0]).toMatchObject({ code: 'bad_envelope', message: expect.stringContaining('boom') });
  });
});

describe('adapter', () => {
  it('describes TikTok and builds links back to the post', () => {
    expect(tiktokAdapter).toMatchObject({ id: 'tiktok', hostMatches: ['https://www.tiktok.com/*'] });
    expect(tiktokAdapter.canonicalUrl({ authorHandle: 'chefjo', externalId: '123', mediaType: 'video' })).toBe('https://www.tiktok.com/@chefjo/video/123');
    expect(tiktokAdapter.canonicalUrl({ authorHandle: 'chefjo', externalId: '123', mediaType: 'photo' })).toBe('https://www.tiktok.com/@chefjo/photo/123');
  });
});

// ---------------------------------------------------------------------------------------------- review fixes
import { estimateSavedAt } from '../../src/platforms/tiktok/saved-at';
import { item, page as pageOf } from '../support/tiktok-payloads';

describe('parser: partial records do not pretend to carry data', () => {
  it('a record with no caption leaves caption and hashtags undefined (storage keeps what it holds); an explicit empty caption is real', () => {
    const stub = { id: itemId(1), createTime: 1_700_000_000 };
    const explicitEmpty = { ...item(2), desc: '', challenges: [], textExtra: [], contents: undefined };
    const r = parseTikTokCapture(cap('favorites', pageOf('0', false, [stub, explicitEmpty])));
    const [a, b] = r.batch.items;
    expect(a!.caption).toBeUndefined();
    expect(a!.hashtags).toBeUndefined();
    expect(a!.authorHandle).toBe(''); // "not provided": storage treats '' as missing
    expect(b!.caption).toBe('');
    expect(b!.hashtags).toEqual([]);
  });

  it('a caption falls back to contents[0].desc; hashtags come from challenges even without a caption', () => {
    const viaContents = { ...item(3), desc: undefined, contents: [{ desc: 'from contents #food', textExtra: [] }] };
    const onlyChallenges = { id: itemId(4), challenges: [{ title: 'Pasta' }] };
    const r = parseTikTokCapture(cap('favorites', pageOf('0', false, [viaContents, onlyChallenges])));
    expect(r.batch.items[0]!.caption).toBe('from contents #food');
    expect(r.batch.items[1]!.hashtags).toEqual(['pasta']);
  });
});

describe('parser: one message can not flood the library', () => {
  it('reads at most 300 items from a page and reports the rest', () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ id: itemId(10_000 + i) }));
    const r = parseTikTokCapture(cap('favorites', pageOf('0', true, many)));
    expect(r.batch.items).toHaveLength(300);
    expect(r.page.itemsDelivered).toBe(300);
    expect(r.problems.some((p) => /only the first 300/.test(p.message))).toBe(true);
  });

  it('reads at most 500 collections from a list', () => {
    const many = Array.from({ length: 2000 }, (_, i) => ({ collectionId: String(7_000_000_000_000_000_000 + i), name: `c${i}`, total: '1', userName: 'me' }));
    const r = parseTikTokCapture(cap('collection_list', { collectionList: many, hasMore: false, cursor: '0', statusCode: 0 }));
    expect(r.batch.collections).toHaveLength(500);
  });

  it('caps the length of an unknown item key it reports', () => {
    const odd = { ...item(1), ['x'.repeat(100_000)]: 1 };
    const r = parseTikTokCapture(cap('favorites', pageOf('0', false, [odd])));
    expect(r.shape.unknownItemKeys).toHaveLength(1);
    expect(r.shape.unknownItemKeys[0]!.length).toBeLessThanOrEqual(64);
  });
});

describe('parser: an empty page may leave its list out', () => {
  it.each([['favorites'], ['collection_items'], ['collection_list']])('%s with hasMore:false and statusCode 0 and no list is an empty page, not a bad envelope', (kind) => {
    const r = parseTikTokCapture(cap(kind, { cursor: '0', hasMore: false, statusCode: 0 }, { collectionId: collectionId(1) }));
    expect(r.problems).toEqual([]);
    expect(r.page).toMatchObject({ hasMore: false, itemsDelivered: 0 });
  });

  it('but an error answer or a body that says nothing is still a bad envelope', () => {
    for (const body of [{ statusCode: 10000, hasMore: false }, { cursor: '0' }, { hasMore: true }, {}, { hasMore: false, statusCode: 5 }]) {
      expect(parseTikTokCapture(cap('favorites', body)).problems.map((p) => p.code), JSON.stringify(body)).toEqual(['bad_envelope']);
    }
  });
});

describe('saved-at: the bounds are honest', () => {
  const T = 1_787_000_000_000;
  it('flags whether both ends of the interval were known', () => {
    expect(estimateSavedAt(3, '1786000000', '1785000000', T).bounded).toBe(true);
    expect(estimateSavedAt(3, '1786000000', '0', T).bounded).toBe(false); // the last page has no lower bound
    expect(estimateSavedAt(3, '0', '0', T).bounded).toBe(false); // an only page
  });

  it('labels order-only estimates "unknown" and interpolations "interpolated"', () => {
    const only = parseTikTokCapture(cap('favorites', pageOf('0', false, [item(1), item(2)]), { requestCursor: '0' }));
    expect(only.batch.items.map((i) => i.savedAtSource)).toEqual(['unknown', 'unknown']);
    const middle = parseTikTokCapture(cap('favorites', pageOf('1785000000', true, [item(1), item(2)]), { requestCursor: '1786000000' }));
    expect(middle.batch.items.map((i) => i.savedAtSource)).toEqual(['interpolated', 'interpolated']);
    expect(middle.batch.items[0]!.savedAt).toBeGreaterThan(middle.batch.items[1]!.savedAt!);
  });

  it('never dates anything in the future, whatever cursor the page claims', () => {
    for (const cursor of ['99999999999', '9999999999', String(Math.floor(T / 1000) + 86_400 * 30)]) {
      const est = estimateSavedAt(4, cursor, '1785000000', T);
      expect(Math.max(...est.times), cursor).toBeLessThanOrEqual(T);
      expect(est.times.every((t, i) => i === 0 || t < est.times[i - 1]!), cursor).toBe(true);
    }
    expect(Math.max(...estimateSavedAt(3, '0', '99999999999', T).times)).toBeLessThanOrEqual(T);
  });
});

describe('parser: which batches are the head of the saved list', () => {
  it('only the first page of the favorites list (cursor 0 or none) is the head', () => {
    const body = pageOf('1785000000', true, [item(1)]);
    expect(parseTikTokCapture(cap('favorites', body, { requestCursor: '0' })).batch.headOfList).toBe(true);
    expect(parseTikTokCapture(cap('favorites', body)).batch.headOfList).toBe(true);
    expect(parseTikTokCapture(cap('favorites', body, { requestCursor: '1785000000' })).batch.headOfList).toBeUndefined();
    expect(parseTikTokCapture(cap('collection_items', body, { requestCursor: '0', collectionId: collectionId(1) })).batch.headOfList).toBeUndefined();
  });
});
