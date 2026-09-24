// Adapter-agnostic storage contract. Any StorageAdapter implementation (SQLite today, IndexedDB if OPFS ever
// fails) must pass this suite. It only uses the public interface.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExportBundle } from '../../src/core/model';
import type { StorageAdapter } from '../../src/core/storage/adapter';
import { DAY, T0, batch, coll, item, items, member } from './helpers';

export function storageContract(label: string, make: () => Promise<StorageAdapter>): void {
  describe(`StorageAdapter contract: ${label}`, () => {
    let a: StorageAdapter;
    beforeEach(async () => { a = await make(); });
    afterEach(async () => { await a.close(); });

    it('migrate is idempotent and reports the schema version', async () => {
      const again = await a.migrate();
      expect(again.from).toBe(again.to);
      expect((await a.stats()).schemaVersion).toBe(again.to);
      expect(again.to).toBeGreaterThanOrEqual(1);
    });

    it('inserts a new item and normalizes what it stores', async () => {
      const r = await a.upsertBatch(batch({ items: [item(1, { hashtags: ['#Food', 'food', 'Recipe', '', '  #Recipe  '] })] }));
      expect(r).toMatchObject({ inserted: 1, reindexed: 0, touched: 0 });
      const got = await a.getItem('tiktok', 'id1');
      expect(got).toMatchObject({
        platform: 'tiktok', externalId: 'id1', authorHandle: 'author1', caption: 'caption 1 #Food',
        hashtags: ['food', 'recipe'], mediaType: 'video', isAd: false, available: true,
        firstSeenAt: T0, lastSeenAt: T0, savedAt: T0, savedAtSource: 'first_seen', collections: [],
      });
      expect(got!.stats).toEqual({ views: 100, likes: 10, comments: undefined, shares: undefined, saves: undefined });
      expect(got!.rawJson).toBeUndefined(); // raw_json is opt-in
    });

    it('returns null for an unknown item', async () => {
      expect(await a.getItem('tiktok', 'nope')).toBeNull();
    });

    it('re-applying an identical batch is idempotent (only last_seen_at moves)', async () => {
      const b = batch({ items: items(1, 5), collections: [coll(1, 'Recipes', 10)], memberships: [member(1, 1, 0), member(2, 1, 1)] });
      await a.upsertBatch(b);
      const before = await a.stats();
      const r = await a.upsertBatch({ ...b, syncedAt: T0 + DAY });
      expect(r).toMatchObject({ inserted: 0, reindexed: 0, touched: 5, membershipsWritten: 0 });
      expect(await a.stats()).toEqual(before);
      const got = await a.getItem('tiktok', 'id2');
      expect(got).toMatchObject({ firstSeenAt: T0, lastSeenAt: T0 + DAY, savedAt: T0 });
    });

    it('detects a change to searchable text and reports it as reindexed', async () => {
      await a.upsertBatch(batch({ items: [item(1)] }));
      const r = await a.upsertBatch(batch({ items: [item(1, { caption: 'brand new caption', hashtags: ['pasta'] })] }, T0 + DAY));
      expect(r).toMatchObject({ inserted: 0, reindexed: 1, touched: 0 });
      expect(await a.getItem('tiktok', 'id1')).toMatchObject({ caption: 'brand new caption', hashtags: ['pasta'] });
    });

    it('a change to stats alone is not a text change', async () => {
      await a.upsertBatch(batch({ items: [item(1)] }));
      const r = await a.upsertBatch(batch({ items: [item(1, { stats: { views: 999 } })] }, T0 + DAY));
      expect(r).toMatchObject({ reindexed: 0, touched: 1 });
      expect((await a.getItem('tiktok', 'id1'))!.stats!.views).toBe(999);
    });

    it('partial data never erases what is already stored', async () => {
      await a.upsertBatch(batch({ items: [item(1)] }));
      const bare = { platform: 'tiktok', externalId: 'id1', authorHandle: 'author1', authorName: 'Author 1', caption: 'caption 1 #Food', hashtags: ['#Food', 'food', 'Recipe'], soundTitle: 'sound 1', soundAuthor: 'sa' };
      await a.upsertBatch(batch({ items: [bare] }, T0 + DAY));
      expect(await a.getItem('tiktok', 'id1')).toMatchObject({
        thumbnailUrl: 'thumb1', language: 'en', durationSec: 20, postedAt: 1_700_000_000_001,
        stats: expect.objectContaining({ views: 100, likes: 10 }),
      });
    });

    it('tolerates a photo post with no duration, an ad flag, and missing everything else', async () => {
      await a.upsertBatch(batch({ items: [{ platform: 'tiktok', externalId: 'photo1', authorHandle: 'x', mediaType: 'photo', isAd: true }] }));
      expect(await a.getItem('tiktok', 'photo1')).toMatchObject({ mediaType: 'photo', isAd: true, caption: '', hashtags: [], durationSec: undefined, stats: undefined });
    });

    describe('saved_at provenance', () => {
      const put = (source: 'interpolated' | 'first_seen' | 'exact' | undefined, at: number | undefined) =>
        a.upsertBatch(batch({ items: [item(1, { savedAt: at, savedAtSource: source })] }, T0 + DAY));

      it('never downgrades, and upgrades on better provenance', async () => {
        await a.upsertBatch(batch({ items: [item(1, { savedAt: 111, savedAtSource: 'interpolated' })] }));
        expect(await a.getItem('tiktok', 'id1')).toMatchObject({ savedAt: 111, savedAtSource: 'interpolated' });
        await put('interpolated', 222);
        expect(await a.getItem('tiktok', 'id1')).toMatchObject({ savedAt: 111 }); // same rank: keep
        await put('first_seen', 333);
        expect(await a.getItem('tiktok', 'id1')).toMatchObject({ savedAt: 333, savedAtSource: 'first_seen' });
        await put('interpolated', 444);
        expect(await a.getItem('tiktok', 'id1')).toMatchObject({ savedAt: 333 }); // downgrade refused
        await put(undefined, undefined);
        expect(await a.getItem('tiktok', 'id1')).toMatchObject({ savedAt: 333 }); // absent: keep
        await put('exact', 555);
        expect(await a.getItem('tiktok', 'id1')).toMatchObject({ savedAt: 555, savedAtSource: 'exact' });
      });

      it('an item first seen with an explicit estimate but no provenance is marked unknown', async () => {
        await a.upsertBatch(batch({ items: [item(2, { savedAt: 42 })] }));
        expect(await a.getItem('tiktok', 'id2')).toMatchObject({ savedAt: 42, savedAtSource: 'unknown' });
      });
    });

    describe('collections', () => {
      it('stores what the platform claims separately from what we hold', async () => {
        await a.upsertBatch(batch({ items: items(1, 3), collections: [coll(1, 'Collection A', 48)], memberships: [member(1, 1, 0), member(2, 1, 1), member(3, 1, 2)] }));
        const [c] = await a.listCollections();
        expect(c).toMatchObject({ externalId: 'col1', name: 'Collection A', declaredTotal: 48, itemsSeen: 3 });
        expect(c!.lastSyncedAt).toBe(T0);
      });

      it('an item can belong to several collections; positions update in place', async () => {
        await a.upsertBatch(batch({ items: [item(1)], collections: [coll(1, 'A'), coll(2, 'B')], memberships: [member(1, 1, 5), member(1, 2, 0)] }));
        expect((await a.getItem('tiktok', 'id1'))!.collections).toEqual([
          { externalId: 'col1', name: 'A', position: 5 },
          { externalId: 'col2', name: 'B', position: 0 },
        ]);
        const r = await a.upsertBatch(batch({ items: [item(1)], memberships: [member(1, 1, 9)] }, T0 + DAY));
        expect(r.membershipsWritten).toBe(1);
        expect((await a.getItem('tiktok', 'id1'))!.collections[0]).toMatchObject({ name: 'A', position: 9 });
      });

      it('memberships may reference items and collections stored by an earlier batch', async () => {
        await a.upsertBatch(batch({ items: [item(1)], collections: [coll(1, 'A')] }));
        const r = await a.upsertBatch(batch({ items: [], memberships: [member(1, 1, 0)] }, T0 + DAY));
        expect(r).toMatchObject({ membershipsWritten: 1, skippedMemberships: 0 });
        expect((await a.listCollections())[0]!.itemsSeen).toBe(1);
      });

      it('reports (never throws on) memberships that reference unknown items or collections', async () => {
        const r = await a.upsertBatch(batch({ items: [item(1)], collections: [coll(1, 'A')], memberships: [member(1, 1), member(99, 1), member(1, 99)] }));
        expect(r).toMatchObject({ membershipsWritten: 1, skippedMemberships: 2 });
      });

      it('renaming a collection updates its name and keeps its members', async () => {
        await a.upsertBatch(batch({ items: items(1, 2), collections: [coll(1, 'Old')], memberships: [member(1, 1), member(2, 1)] }));
        await a.upsertBatch(batch({ items: [], collections: [coll(1, 'New')] }, T0 + DAY));
        expect((await a.listCollections()).map((c) => [c.name, c.itemsSeen])).toEqual([['New', 2]]);
        expect((await a.getItem('tiktok', 'id2'))!.collections[0]!.name).toBe('New');
      });
    });

    describe('reconcile', () => {
      beforeEach(async () => {
        await a.upsertBatch(batch({ items: items(1, 5), collections: [coll(1, 'A')], memberships: [member(1, 1), member(2, 1), member(3, 1)] }));
      });

      it('a complete favorites pass marks unseen videos unavailable, and revives them when they return', async () => {
        const r = await a.reconcile({ platform: 'tiktok', seenExternalIds: ['id1', 'id2', 'id3'] });
        expect(r).toMatchObject({ markedUnavailable: 2, revived: 0 });
        expect((await a.getItem('tiktok', 'id4'))!.available).toBe(false);
        expect(await a.getItem('tiktok', 'id4')).not.toBeNull(); // never deleted
        expect((await a.stats()).availableItems).toBe(3);
        expect(await a.reconcile({ platform: 'tiktok', seenExternalIds: ['id1', 'id2', 'id3', 'id4', 'id5'] })).toMatchObject({ markedUnavailable: 0, revived: 2 });
        expect((await a.stats()).availableItems).toBe(5);
      });

      it('seeing an unavailable video again in a normal batch revives it', async () => {
        await a.reconcile({ platform: 'tiktok', seenExternalIds: ['id1'] });
        await a.upsertBatch(batch({ items: [item(2)] }, T0 + DAY));
        expect((await a.getItem('tiktok', 'id2'))!.available).toBe(true);
      });

      it('a complete collection pass drops memberships of videos it no longer contains', async () => {
        const r = await a.reconcile({ platform: 'tiktok', seenExternalIds: ['id1', 'id2'], collectionExternalId: 'col1' });
        expect(r.membershipsRemoved).toBe(1);
        expect((await a.getItem('tiktok', 'id3'))!.collections).toEqual([]);
        expect((await a.listCollections())[0]!.itemsSeen).toBe(2);
        expect((await a.getItem('tiktok', 'id3'))!.available).toBe(true); // the video itself is untouched
      });

      it('refuses an empty seen-list (a failed sync must not wipe the library) unless explicitly allowed', async () => {
        await expect(a.reconcile({ platform: 'tiktok', seenExternalIds: [] })).rejects.toThrow(/empty/);
        expect((await a.stats()).availableItems).toBe(5);
        expect(await a.reconcile({ platform: 'tiktok', seenExternalIds: [], allowEmpty: true })).toMatchObject({ markedUnavailable: 5 });
      });

      it('only touches the named platform', async () => {
        await a.upsertBatch(batch({ items: [{ platform: 'other', externalId: 'x1', authorHandle: 'z' }] }));
        await a.reconcile({ platform: 'tiktok', seenExternalIds: ['id1'] });
        expect((await a.getItem('other', 'x1'))!.available).toBe(true);
      });
    });

    it('a failing batch changes nothing (atomic)', async () => {
      const bad = { platform: 'tiktok', externalId: undefined as unknown as string, authorHandle: 'x' };
      await expect(a.upsertBatch(batch({ items: [item(1), bad], collections: [coll(1, 'A')], memberships: [member(1, 1)] }))).rejects.toThrow();
      expect(await a.getItem('tiktok', 'id1')).toBeNull();
      expect(await a.stats()).toMatchObject({ items: 0, collections: 0, memberships: 0, hashtags: 0 });
      // the adapter is still usable, including with hashtags that were created inside the rolled-back transaction
      await a.upsertBatch(batch({ items: [item(1)] }));
      expect((await a.getItem('tiktok', 'id1'))!.hashtags).toEqual(['food', 'recipe']);
    });

    it('export then import reproduces the library exactly', async () => {
      await a.upsertBatch(batch({
        items: [...items(1, 4), item(5, { mediaType: 'photo', durationSec: undefined, isAd: true, savedAt: 123, savedAtSource: 'interpolated' })],
        collections: [coll(1, 'A', 9), coll(2, 'B')],
        memberships: [member(1, 1, 0), member(1, 2, 3), member(2, 1, 1)],
      }));
      await a.reconcile({ platform: 'tiktok', seenExternalIds: ['id1', 'id2', 'id3', 'id4'] }); // id5 becomes unavailable
      const bundle = JSON.parse(JSON.stringify(await a.exportAll())) as ExportBundle; // must survive JSON

      const b = await make();
      try {
        await b.upsertBatch(batch({ items: [item(77)] })); // pre-existing data is replaced
        await b.importAll(bundle);
        expect(await b.stats()).toEqual({ ...(await a.stats()), dbBytes: (await b.stats()).dbBytes });
        for (const n of [1, 2, 3, 4, 5]) expect(await b.getItem('tiktok', `id${n}`)).toEqual(await a.getItem('tiktok', `id${n}`));
        expect(await b.getItem('tiktok', 'id77')).toBeNull();
        expect(await b.listCollections()).toEqual(await a.listCollections());
        expect(await b.getItem('tiktok', 'id5')).toMatchObject({ available: false, isAd: true, mediaType: 'photo', savedAt: 123, savedAtSource: 'interpolated' });
      } finally { await b.close(); }
    });

    it('rejects an import that is not a Scroganize export', async () => {
      await expect(a.importAll({ format: 'something-else', version: 1 } as unknown as ExportBundle)).rejects.toThrow(/not a Scroganize export/);
    });

    it('wipe removes everything and the adapter can be reused', async () => {
      await a.upsertBatch(batch({ items: items(1, 3), collections: [coll(1, 'A')], memberships: [member(1, 1)] }));
      await a.wipe();
      expect(await a.stats()).toMatchObject({ items: 0, collections: 0, memberships: 0, hashtags: 0 });
      await a.upsertBatch(batch({ items: [item(1)] }));
      expect((await a.getItem('tiktok', 'id1'))!.hashtags).toEqual(['food', 'recipe']);
    });
  });
}
