// SQLite-only behaviour: migrations, and the invariant that the full-text index always mirrors the tables.
import { describe, expect, it } from 'vitest';
import { synthBatches, synthLibrary } from '../../bench/synth-batches';
import { MIGRATIONS } from '../../src/core/storage/sqlite/migrations';
import { migrate, schemaVersion } from '../../src/core/storage/sqlite/migrate';
import { DAY, T0, assertFtsConsistent, batch, coll, ftsMatch, item, items, member, memoryAdapter } from './helpers';

describe('migrations', () => {
  it('a fresh database ends at the latest version, and migrate() is a no-op afterwards', async () => {
    const { adapter, db } = await memoryAdapter();
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    expect(await adapter.migrate()).toEqual({ from: MIGRATIONS.length, to: MIGRATIONS.length });
  });

  it('refuses to open a database written by a newer build', async () => {
    const { adapter, db } = await memoryAdapter();
    db.exec('PRAGMA user_version = 99');
    await expect(adapter.migrate()).rejects.toThrow(/newer than this build/);
  });

  it('requires contiguous versions starting at 1', async () => {
    const { db } = await memoryAdapter();
    expect(() => migrate(db, [{ version: 2, name: 'gap', sql: 'SELECT 1' }])).toThrow(/contiguous/);
  });

  it('a failing migration rolls back completely and leaves the previous version intact', async () => {
    const { db } = await memoryAdapter();
    const before = schemaVersion(db);
    const bad = [...MIGRATIONS, { version: before + 1, name: 'bad', sql: 'CREATE TABLE half_done (id INTEGER); THIS IS NOT SQL;' }];
    expect(() => migrate(db, bad)).toThrow();
    expect(schemaVersion(db)).toBe(before);
    expect(Number(db.selectValue("SELECT count(*) FROM sqlite_master WHERE name = 'half_done'"))).toBe(0);
  });

  it('a later migration upgrades an existing database without losing data', async () => {
    const { adapter, db } = await memoryAdapter();
    await adapter.upsertBatch(batch({ items: items(1, 3) }));
    const next = [...MIGRATIONS, { version: MIGRATIONS.length + 1, name: 'add-note', sql: 'ALTER TABLE items ADD COLUMN note TEXT' }];
    expect(migrate(db, next)).toEqual({ from: MIGRATIONS.length, to: MIGRATIONS.length + 1 });
    expect(Number(db.selectValue('SELECT count(*) FROM items'))).toBe(3);
    expect(db.selectValue('SELECT note FROM items LIMIT 1')).toBeNull();
  });

  it('foreign keys are enforced (the pragma set is actually applied)', async () => {
    const { db } = await memoryAdapter();
    expect(Number(db.selectValue('PRAGMA foreign_keys'))).toBe(1);
    expect(() => db.exec('INSERT INTO item_collections (item_id, collection_id, position) VALUES (999, 999, 0)')).toThrow();
  });
});

describe('full-text index mirrors the tables (the invariant search depends on)', () => {
  it('after the first ingest, with memberships', async () => {
    const { adapter, db } = await memoryAdapter();
    await adapter.upsertBatch(batch({ items: items(1, 6), collections: [coll(1, 'Recipes'), coll(2, 'Study Notes')], memberships: [member(1, 1), member(2, 1), member(2, 2), member(5, 2)] }));
    expect(assertFtsConsistent(db)).toEqual([]);
  });

  it('after a caption / hashtag / author change (reindex path) on an item that already has collections', async () => {
    const { adapter, db } = await memoryAdapter();
    await adapter.upsertBatch(batch({ items: items(1, 3), collections: [coll(1, 'Recipes')], memberships: [member(1, 1), member(2, 1)] }));
    await adapter.upsertBatch(batch({ items: [item(1, { caption: 'totally different', hashtags: ['x'], authorHandle: 'newauthor' })] }, T0 + DAY));
    expect(assertFtsConsistent(db)).toEqual([]);
    expect(ftsMatch(db, '"newauthor"')).toHaveLength(1);
  });

  it('when memberships are added later, renamed, and removed', async () => {
    const { adapter, db } = await memoryAdapter();
    // NB: collection names must not collide with the fixture text (every fixture item is tagged "recipe")
    await adapter.upsertBatch(batch({ items: items(1, 4), collections: [coll(1, 'Study Notes')] }));
    expect(ftsMatch(db, '"study"')).toEqual([]); // no members yet
    await adapter.upsertBatch(batch({ items: [], memberships: [member(1, 1), member(2, 1), member(3, 1)] }, T0 + DAY));
    expect(assertFtsConsistent(db)).toEqual([]);
    expect(ftsMatch(db, '"study"')).toEqual([1, 2, 3]);

    await adapter.upsertBatch(batch({ items: [], collections: [coll(1, 'Travel Plans')] }, T0 + 2 * DAY));
    expect(assertFtsConsistent(db)).toEqual([]);
    expect(ftsMatch(db, '"study"')).toEqual([]);                    // old name gone from the index
    expect(ftsMatch(db, '"travel" AND "plans"')).toEqual([1, 2, 3]); // new name searchable

    await adapter.reconcile({ platform: 'tiktok', seenExternalIds: ['id1'], collectionExternalId: 'col1' });
    expect(assertFtsConsistent(db)).toEqual([]);
    expect(ftsMatch(db, '"travel"')).toEqual([1]);
  });

  it('an unchanged re-sync does not rewrite full-text rows', async () => {
    const { adapter, db } = await memoryAdapter();
    const b = batch({ items: items(1, 20) });
    await adapter.upsertBatch(b);
    const before = Number(db.selectValue('SELECT total_changes()'));
    await adapter.upsertBatch({ ...b, syncedAt: T0 + DAY });
    // exactly one UPDATE per item (last_seen / stats) and nothing against items_fts, hashtags or memberships
    expect(Number(db.selectValue('SELECT total_changes()')) - before).toBe(20);
  });

  it('after import', async () => {
    const a = await memoryAdapter();
    await a.adapter.upsertBatch(batch({ items: items(1, 5), collections: [coll(1, 'A'), coll(2, 'B')], memberships: [member(1, 1), member(1, 2), member(3, 2)] }));
    const b = await memoryAdapter();
    await b.adapter.importAll(await a.adapter.exportAll());
    expect(assertFtsConsistent(b.db)).toEqual([]);
    expect(ftsMatch(b.db, '"b"')).toEqual(ftsMatch(a.db, '"b"'));
  });

  it('on a realistic synthetic library ingested in batches, then partly re-synced and edited', async () => {
    const { adapter, db } = await memoryAdapter();
    const lib = synthLibrary(3000);
    const batches = synthBatches(lib, 500);
    for (const b of batches) await adapter.upsertBatch(b);
    expect(assertFtsConsistent(db)).toEqual([]);
    const stats = await adapter.stats();
    expect(stats.items).toBe(3000);
    expect(stats.memberships).toBe(lib.items.reduce((n, it) => n + it.collectionIds.length, 0));
    for (const b of batches) await adapter.upsertBatch({ ...b, syncedAt: (b.syncedAt ?? 0) + DAY }); // identical re-sync
    expect((await adapter.stats()).items).toBe(3000);
    const edited = { ...batches[0]!, collections: undefined, memberships: [], items: batches[0]!.items.slice(0, 100).map((i) => ({ ...i, caption: `${i.caption} edited` })) };
    expect(await adapter.upsertBatch({ ...edited, syncedAt: (edited.syncedAt ?? 0) + 2 * DAY })).toMatchObject({ reindexed: 100, inserted: 0 });
    expect(assertFtsConsistent(db)).toEqual([]);
  });
});

describe('what M2 will query', () => {
  it('finds videos by stemmed words, hashtags, authors and collection names, and supports prefix and NOT', async () => {
    const { adapter, db } = await memoryAdapter();
    await adapter.upsertBatch(batch({
      items: [
        item(1, { caption: 'easy pasta recipes for dinner', hashtags: ['mealprep'], authorHandle: 'chefjo' }),
        item(2, { caption: 'gym squat routine', hashtags: ['fitness'], authorHandle: 'liftguy' }),
        item(3, { caption: 'cozy apartment tour', hashtags: [], authorHandle: 'homebody' }),
      ],
      collections: [coll(1, 'Recipes')],
      memberships: [member(3, 1)], // a video in the Recipes collection whose own text never mentions recipes
    }));
    expect(ftsMatch(db, '"recipe"')).toEqual([1, 3]);           // stemming (recipes ~ recipe) + collection-name column
    expect(ftsMatch(db, '"mealprep"')).toEqual([1]);            // hashtag as one token
    expect(ftsMatch(db, '"chefjo"')).toEqual([1]);              // author
    expect(ftsMatch(db, '"sq"*')).toEqual([2]);                 // prefix
    expect(ftsMatch(db, '("recipe" OR "squat") NOT ("squat")')).toEqual([1, 3]); // set difference, used for tier 2
  });

  it('unavailable videos stay in the index (M2 decides whether to show them)', async () => {
    const { adapter, db } = await memoryAdapter();
    await adapter.upsertBatch(batch({ items: items(1, 2) }));
    await adapter.reconcile({ platform: 'tiktok', seenExternalIds: ['id1'] });
    expect(ftsMatch(db, '"caption"')).toHaveLength(2);
  });
});
