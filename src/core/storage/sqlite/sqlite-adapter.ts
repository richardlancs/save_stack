// SQLite implementation of StorageAdapter. Takes any sqlite-wasm `Database`, so the same code runs against an
// in-memory DB in Node (the contract tests) and against the OPFS-backed DB inside the extension's Worker.
//
// Ingest shape (from the M0 spike, hardened):
//   lookup -> insert | touch | reindex, keyed by content_hash, in one transaction per batch;
//   full-text writes happen AFTER memberships so the `collections` column is right the first time.

import type { Database, PreparedStatement } from '@sqlite.org/sqlite-wasm';
import {
  contentHash,
  ftsColumns,
  isBetterSavedAt,
  mediaTypeOf,
  normalizeHashtags,
  textOrNull,
  toIntOrNull,
} from '../../ingest/normalize';
import type {
  Collection,
  ExportBundle,
  Membership,
  ParsedBatch,
  ReconcileInput,
  ReconcileResult,
  SavedAtSource,
  SavedItem,
  StorageStats,
  StoredCollection,
  StoredItem,
  UpsertResult,
} from '../../model';
import type { StorageAdapter } from '../adapter';
import { migrate, schemaVersion } from './migrate';

export interface SqliteAdapterOptions {
  /** Injectable clock: defaults to Date.now(). */
  now?: () => number;
}

const key = (platform: string, id: string) => `${platform}\u0000${id}`;
const CHUNK = 500;

interface ItemMeta {
  syncedAt: number;
  firstSeenAt: number;
  lastSeenAt: number;
  savedAt: number;
  savedAtSource: SavedAtSource;
  available: boolean;
}

export class SqliteAdapter implements StorageAdapter {
  private readonly stmts = new Map<string, PreparedStatement>();
  private readonly tagIds = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly db: Database, opts: SqliteAdapterOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  // ------------------------------------------------------------------ statement helpers

  private stmt(sql: string): PreparedStatement {
    let s = this.stmts.get(sql);
    if (!s) { s = this.db.prepare(sql); this.stmts.set(sql, s); }
    return s;
  }

  /** Run a statement that returns no rows. */
  private run(sql: string, params: readonly (string | number | null)[] = []): void {
    const s = this.stmt(sql);
    s.bind(params as (string | number | null)[]);
    try { s.step(); } finally { s.reset(true); }
  }

  /** Run a statement and return its first row as raw values, or undefined. */
  private first(sql: string, params: readonly (string | number | null)[] = []): unknown[] | undefined {
    const s = this.stmt(sql);
    s.bind(params as (string | number | null)[]);
    try {
      if (!s.step()) return undefined;
      const n = s.columnCount;
      const row: unknown[] = [];
      for (let i = 0; i < n; i++) row.push(s.get(i));
      return row;
    } finally { s.reset(true); }
  }

  private changes(): number { return Number(this.db.changes()); }

  // ------------------------------------------------------------------ StorageAdapter

  async migrate(): Promise<{ from: number; to: number }> {
    return migrate(this.db);
  }

  async upsertBatch(batch: ParsedBatch): Promise<UpsertResult> {
    try {
      return this.db.transaction(() => this.upsertSync(batch));
    } catch (e) {
      this.tagIds.clear(); // the rolled-back transaction may have created hashtag rows this cache still points at
      throw e;
    }
  }

  async getItem(platform: string, externalId: string): Promise<StoredItem | null> {
    const row = this.db.selectObject('SELECT * FROM items WHERE platform = ?1 AND external_id = ?2', [platform, externalId]);
    if (!row) return null;
    const id = Number(row.id);
    const hashtags = this.db.selectValues('SELECT h.tag FROM item_hashtags ih JOIN hashtags h ON h.id = ih.hashtag_id WHERE ih.item_id = ?1 ORDER BY h.tag', [id]).map(String);
    const collections = this.db.selectObjects(
      'SELECT c.external_id AS externalId, c.name AS name, ic.position AS position FROM item_collections ic JOIN collections c ON c.id = ic.collection_id WHERE ic.item_id = ?1 ORDER BY c.name',
      [id],
    ).map((c) => ({ externalId: String(c.externalId), name: String(c.name), position: Number(c.position) }));
    return { ...this.rowToItem(row, hashtags), id, collections };
  }

  async listCollections(): Promise<StoredCollection[]> {
    return this.db.selectObjects('SELECT * FROM collections ORDER BY name').map((r) => ({
      platform: String(r.platform),
      externalId: String(r.external_id),
      name: String(r.name),
      declaredTotal: r.declared_total === null ? null : Number(r.declared_total),
      itemsSeen: Number(r.items_seen),
      lastSyncedAt: r.last_synced_at === null ? null : Number(r.last_synced_at),
    }));
  }

  async stats(): Promise<StorageStats> {
    const n = (sql: string) => Number(this.db.selectValue(sql) ?? 0);
    return {
      schemaVersion: schemaVersion(this.db),
      items: n('SELECT count(*) FROM items'),
      availableItems: n('SELECT count(*) FROM items WHERE available = 1'),
      collections: n('SELECT count(*) FROM collections'),
      memberships: n('SELECT count(*) FROM item_collections'),
      hashtags: n('SELECT count(*) FROM hashtags'),
      dbBytes: n('PRAGMA page_count') * n('PRAGMA page_size'),
    };
  }

  async reconcile(input: ReconcileInput): Promise<ReconcileResult> {
    if (input.seenExternalIds.length === 0 && !input.allowEmpty) {
      throw new Error('reconcile refused: empty seenExternalIds (pass allowEmpty: true if the platform list is really empty)');
    }
    return this.db.transaction(() => this.reconcileSync(input));
  }

  async exportAll(): Promise<ExportBundle> {
    const tagsByItem = new Map<number, string[]>();
    for (const r of this.db.selectArrays('SELECT ih.item_id, h.tag FROM item_hashtags ih JOIN hashtags h ON h.id = ih.hashtag_id ORDER BY ih.item_id, h.tag')) {
      const id = Number(r[0]);
      (tagsByItem.get(id) ?? tagsByItem.set(id, []).get(id)!).push(String(r[1]));
    }
    const items = this.db.selectObjects('SELECT * FROM items ORDER BY id').map((row) => this.rowToItem(row, tagsByItem.get(Number(row.id)) ?? []));
    const collections = (await this.listCollections()).map(({ itemsSeen: _seen, ...c }) => c);
    const memberships: Membership[] = this.db.selectObjects(
      `SELECT i.platform AS platform, i.external_id AS itemExternalId, c.external_id AS collectionExternalId, ic.position AS position
         FROM item_collections ic JOIN items i ON i.id = ic.item_id JOIN collections c ON c.id = ic.collection_id
        ORDER BY i.id, c.id`,
    ).map((m) => ({ platform: String(m.platform), itemExternalId: String(m.itemExternalId), collectionExternalId: String(m.collectionExternalId), position: Number(m.position) }));
    return { format: 'scroganize-export', version: 1, schemaVersion: schemaVersion(this.db), exportedAt: this.now(), items, collections, memberships };
  }

  async importAll(bundle: ExportBundle): Promise<void> {
    if (bundle?.format !== 'scroganize-export' || bundle.version !== 1) throw new Error('not a Scroganize export (unknown format/version)');
    if (bundle.schemaVersion > schemaVersion(this.db)) throw new Error(`export was written by a newer schema (v${bundle.schemaVersion})`);
    try { this.importSync(bundle); } catch (e) { this.tagIds.clear(); throw e; }
  }

  private importSync(bundle: ExportBundle): void {
    this.db.transaction(() => {
      this.wipeSync();
      const collIds = new Map<string, number>();
      for (const c of bundle.collections) {
        const id = this.insertCollection(c, null);
        collIds.set(key(c.platform, c.externalId), id);
        if (c.lastSyncedAt != null) this.run('UPDATE collections SET last_synced_at = ?1 WHERE id = ?2', [c.lastSyncedAt, id]);
      }
      const itemIds = new Map<string, number>();
      const namesByItem = new Map<string, string[]>();
      const collName = new Map(bundle.collections.map((c) => [key(c.platform, c.externalId), c.name]));
      for (const m of bundle.memberships) {
        const n = collName.get(key(m.platform, m.collectionExternalId));
        if (n !== undefined) (namesByItem.get(key(m.platform, m.itemExternalId)) ?? namesByItem.set(key(m.platform, m.itemExternalId), []).get(key(m.platform, m.itemExternalId))!).push(n);
      }
      for (const it of bundle.items) {
        const tags = normalizeHashtags(it.hashtags);
        const meta: ItemMeta = { syncedAt: it.lastSeenAt, firstSeenAt: it.firstSeenAt, lastSeenAt: it.lastSeenAt, savedAt: it.savedAt, savedAtSource: it.savedAtSource, available: it.available };
        const id = this.insertItemRow(it, tags, meta);
        itemIds.set(key(it.platform, it.externalId), id);
        this.insertFts(id, ftsColumns(it, tags, namesByItem.get(key(it.platform, it.externalId)) ?? []));
      }
      for (const m of bundle.memberships) {
        const itemId = itemIds.get(key(m.platform, m.itemExternalId));
        const collId = collIds.get(key(m.platform, m.collectionExternalId));
        if (itemId !== undefined && collId !== undefined) this.run('INSERT OR REPLACE INTO item_collections (item_id, collection_id, position) VALUES (?1, ?2, ?3)', [itemId, collId, m.position]);
      }
      this.recountCollections([...collIds.values()], null);
    });
  }

  async wipe(): Promise<void> {
    this.db.transaction(() => this.wipeSync());
  }

  async close(): Promise<void> {
    for (const s of this.stmts.values()) { try { s.finalize(); } catch { /* already finalized */ } }
    this.stmts.clear();
    this.db.close();
  }

  // ------------------------------------------------------------------ upsert

  private upsertSync(batch: ParsedBatch): UpsertResult {
    const syncedAt = batch.syncedAt ?? this.now();
    const result: UpsertResult = { inserted: 0, reindexed: 0, touched: 0, membershipsWritten: 0, skippedMemberships: 0 };

    // ---- 1. collections (create / rename / refresh declared total)
    const collIds = new Map<string, number>();
    const renamed: number[] = [];
    for (const c of batch.collections ?? []) {
      const row = this.first('SELECT id, name FROM collections WHERE platform = ?1 AND external_id = ?2', [c.platform, c.externalId]);
      if (!row) {
        collIds.set(key(c.platform, c.externalId), this.insertCollection(c, null));
      } else {
        const id = Number(row[0]);
        collIds.set(key(c.platform, c.externalId), id);
        if (String(row[1]) !== c.name) { this.run('UPDATE collections SET name = ?1 WHERE id = ?2', [c.name, id]); renamed.push(id); }
        if (c.declaredTotal != null) this.run('UPDATE collections SET declared_total = ?1 WHERE id = ?2', [c.declaredTotal, id]);
      }
    }

    // ---- 2. items (rows + hashtags only; full-text is written after memberships)
    const itemIds = new Map<string, number>();
    const ftsQueue: Array<{ id: number; item: SavedItem; tags: string[]; isNew: boolean }> = [];
    for (const it of batch.items) {
      const tags = normalizeHashtags(it.hashtags);
      const hash = contentHash(it, tags);
      const existing = this.first('SELECT id, content_hash, saved_at_source FROM items WHERE platform = ?1 AND external_id = ?2', [it.platform, it.externalId]);
      if (!existing) {
        const source: SavedAtSource = it.savedAt != null ? it.savedAtSource ?? 'unknown' : 'first_seen';
        const id = this.insertItemRow(it, tags, { syncedAt, firstSeenAt: syncedAt, lastSeenAt: syncedAt, savedAt: it.savedAt ?? syncedAt, savedAtSource: source, available: true }, hash);
        itemIds.set(key(it.platform, it.externalId), id);
        ftsQueue.push({ id, item: it, tags, isNew: true });
        result.inserted++;
        continue;
      }
      const id = Number(existing[0]);
      itemIds.set(key(it.platform, it.externalId), id);
      const better = it.savedAt != null && isBetterSavedAt(existing[2] as SavedAtSource, it.savedAtSource ?? 'unknown');
      this.updateItemStats(id, it, syncedAt, better);
      if (String(existing[1]) === hash) {
        result.touched++;
      } else {
        this.run(
          'UPDATE items SET caption = ?1, author_handle = ?2, author_name = ?3, sound_title = ?4, sound_author = ?5, content_hash = ?6 WHERE id = ?7',
          [it.caption ?? '', it.authorHandle ?? '', textOrNull(it.authorName), textOrNull(it.soundTitle), textOrNull(it.soundAuthor), hash, id],
        );
        this.run('DELETE FROM item_hashtags WHERE item_id = ?1', [id]);
        for (const t of tags) this.run('INSERT OR IGNORE INTO item_hashtags (item_id, hashtag_id) VALUES (?1, ?2)', [id, this.tagId(t)]);
        ftsQueue.push({ id, item: it, tags, isNew: false });
        result.reindexed++;
      }
    }

    // ---- 3. memberships
    const collectionsTouched = new Set<number>();
    const membershipChanged = new Set<number>(); // items whose set of collections changed
    for (const m of batch.memberships ?? []) {
      const itemId = itemIds.get(key(m.platform, m.itemExternalId)) ?? this.lookupItemId(m.platform, m.itemExternalId);
      const collId = collIds.get(key(m.platform, m.collectionExternalId)) ?? this.lookupCollectionId(m.platform, m.collectionExternalId);
      if (itemId === undefined || collId === undefined) { result.skippedMemberships++; continue; }
      const prev = this.first('SELECT position FROM item_collections WHERE item_id = ?1 AND collection_id = ?2', [itemId, collId]);
      if (!prev) {
        this.run('INSERT INTO item_collections (item_id, collection_id, position) VALUES (?1, ?2, ?3)', [itemId, collId, m.position]);
        membershipChanged.add(itemId);
        result.membershipsWritten++;
      } else if (Number(prev[0]) !== m.position) {
        this.run('UPDATE item_collections SET position = ?1 WHERE item_id = ?2 AND collection_id = ?3', [m.position, itemId, collId]);
        result.membershipsWritten++;
      }
      collectionsTouched.add(collId);
    }

    // ---- 4. full-text rows. Queued items get a full write; items that only changed collections get a one-column refresh.
    const queuedIds = new Set(ftsQueue.map((q) => q.id));
    const refresh = new Set<number>();
    for (const id of membershipChanged) if (!queuedIds.has(id)) refresh.add(id);
    for (const collId of renamed) {
      for (const r of this.db.selectValues('SELECT item_id FROM item_collections WHERE collection_id = ?1', [collId])) {
        const id = Number(r);
        if (!queuedIds.has(id)) refresh.add(id);
      }
    }
    const names = this.collectionNames([...queuedIds, ...refresh]);
    for (const q of ftsQueue) {
      const cols = ftsColumns(q.item, q.tags, names.get(q.id) ?? []);
      if (q.isNew) this.insertFts(q.id, cols);
      else this.run('UPDATE items_fts SET caption = ?1, hashtags = ?2, author = ?3, sound = ?4, collections = ?5 WHERE rowid = ?6', [cols.caption, cols.hashtags, cols.author, cols.sound, cols.collections, q.id]);
    }
    for (const id of refresh) {
      this.run('UPDATE items_fts SET collections = ?1 WHERE rowid = ?2', [(names.get(id) ?? []).sort().join(' '), id]);
    }

    // ---- 5. what we actually hold, per touched collection
    this.recountCollections([...collectionsTouched, ...renamed], syncedAt);
    return result;
  }

  private insertCollection(c: { platform: string; externalId: string; name: string; declaredTotal?: number | null }, lastSyncedAt: number | null): number {
    const row = this.first(
      'INSERT INTO collections (platform, external_id, name, declared_total, items_seen, last_synced_at) VALUES (?1, ?2, ?3, ?4, 0, ?5) RETURNING id',
      [c.platform, c.externalId, c.name, c.declaredTotal ?? null, lastSyncedAt],
    );
    return Number(row![0]);
  }

  /** Insert an items row + its hashtag links. Returns the new id. */
  private insertItemRow(it: SavedItem, tags: readonly string[], meta: ItemMeta, hash = contentHash(it, tags)): number {
    const s = it.stats ?? {};
    const row = this.first(
      `INSERT INTO items (platform, external_id, author_handle, author_name, caption, sound_title, sound_author, media_type, duration_sec,
                          posted_at, views, likes, comments, shares, saves, thumbnail_url, language, is_ad, saved_at, saved_at_source,
                          first_seen_at, last_seen_at, available, content_hash, raw_json)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25) RETURNING id`,
      [
        it.platform, it.externalId, it.authorHandle ?? '', textOrNull(it.authorName), it.caption ?? '', textOrNull(it.soundTitle), textOrNull(it.soundAuthor),
        mediaTypeOf(it), toIntOrNull(it.durationSec), toIntOrNull(it.postedAt), toIntOrNull(s.views), toIntOrNull(s.likes), toIntOrNull(s.comments),
        toIntOrNull(s.shares), toIntOrNull(s.saves), textOrNull(it.thumbnailUrl), textOrNull(it.language), it.isAd ? 1 : 0, meta.savedAt, meta.savedAtSource,
        meta.firstSeenAt, meta.lastSeenAt, meta.available ? 1 : 0, hash, textOrNull(it.rawJson),
      ],
    );
    const id = Number(row![0]);
    for (const t of tags) this.run('INSERT OR IGNORE INTO item_hashtags (item_id, hashtag_id) VALUES (?1, ?2)', [id, this.tagId(t)]);
    return id;
  }

  /** Refresh everything that is NOT searchable text: partial data never nulls out what we already hold. */
  private updateItemStats(id: number, it: SavedItem, syncedAt: number, replaceSavedAt: boolean): void {
    const s = it.stats ?? {};
    this.run(
      `UPDATE items SET last_seen_at = ?1, available = 1,
              views = COALESCE(?2, views), likes = COALESCE(?3, likes), comments = COALESCE(?4, comments),
              shares = COALESCE(?5, shares), saves = COALESCE(?6, saves),
              thumbnail_url = COALESCE(?7, thumbnail_url), posted_at = COALESCE(?8, posted_at),
              duration_sec = COALESCE(?9, duration_sec), language = COALESCE(?10, language), is_ad = ?11,
              media_type = CASE WHEN ?12 IS NULL THEN media_type ELSE ?12 END
        WHERE id = ?13`,
      [syncedAt, toIntOrNull(s.views), toIntOrNull(s.likes), toIntOrNull(s.comments), toIntOrNull(s.shares), toIntOrNull(s.saves),
        textOrNull(it.thumbnailUrl), toIntOrNull(it.postedAt), toIntOrNull(it.durationSec), textOrNull(it.language), it.isAd ? 1 : 0, it.mediaType ?? null, id],
    );
    if (replaceSavedAt) this.run('UPDATE items SET saved_at = ?1, saved_at_source = ?2 WHERE id = ?3', [it.savedAt!, it.savedAtSource ?? 'unknown', id]);
  }

  private insertFts(id: number, c: ReturnType<typeof ftsColumns>): void {
    this.run('INSERT INTO items_fts (rowid, caption, hashtags, author, sound, collections) VALUES (?1, ?2, ?3, ?4, ?5, ?6)', [id, c.caption, c.hashtags, c.author, c.sound, c.collections]);
  }

  private tagId(tag: string): number {
    let id = this.tagIds.get(tag);
    if (id === undefined) {
      this.run('INSERT INTO hashtags (tag) VALUES (?1) ON CONFLICT (tag) DO NOTHING', [tag]);
      id = Number(this.first('SELECT id FROM hashtags WHERE tag = ?1', [tag])![0]);
      this.tagIds.set(tag, id);
    }
    return id;
  }

  private lookupItemId(platform: string, externalId: string): number | undefined {
    const r = this.first('SELECT id FROM items WHERE platform = ?1 AND external_id = ?2', [platform, externalId]);
    return r ? Number(r[0]) : undefined;
  }

  private lookupCollectionId(platform: string, externalId: string): number | undefined {
    const r = this.first('SELECT id FROM collections WHERE platform = ?1 AND external_id = ?2', [platform, externalId]);
    return r ? Number(r[0]) : undefined;
  }

  /** Collection names per item id, in chunks so the query stays small. */
  private collectionNames(itemIds: readonly number[]): Map<number, string[]> {
    const out = new Map<number, string[]>();
    for (let i = 0; i < itemIds.length; i += CHUNK) {
      const rows = this.db.selectArrays(
        'SELECT ic.item_id, c.name FROM item_collections ic JOIN collections c ON c.id = ic.collection_id WHERE ic.item_id IN (SELECT value FROM json_each(?1))',
        [JSON.stringify(itemIds.slice(i, i + CHUNK))],
      );
      for (const r of rows) {
        const id = Number(r[0]);
        (out.get(id) ?? out.set(id, []).get(id)!).push(String(r[1]));
      }
    }
    return out;
  }

  private recountCollections(collectionIds: readonly number[], syncedAt: number | null): void {
    for (const id of new Set(collectionIds)) {
      this.run(
        'UPDATE collections SET items_seen = (SELECT count(*) FROM item_collections WHERE collection_id = ?1), last_synced_at = COALESCE(?2, last_synced_at) WHERE id = ?1',
        [id, syncedAt],
      );
    }
  }

  // ------------------------------------------------------------------ reconcile / wipe

  private reconcileSync(input: ReconcileInput): ReconcileResult {
    const seen = JSON.stringify(input.seenExternalIds);
    const out: ReconcileResult = { markedUnavailable: 0, revived: 0, membershipsRemoved: 0 };

    if (input.collectionExternalId !== undefined) {
      const collId = this.lookupCollectionId(input.platform, input.collectionExternalId);
      if (collId === undefined) return out;
      const stale = this.db.selectValues(
        `SELECT ic.item_id FROM item_collections ic JOIN items i ON i.id = ic.item_id
          WHERE ic.collection_id = ?1 AND i.external_id NOT IN (SELECT value FROM json_each(?2))`,
        [collId, seen],
      ).map(Number);
      for (const id of stale) this.run('DELETE FROM item_collections WHERE item_id = ?1 AND collection_id = ?2', [id, collId]);
      out.membershipsRemoved = stale.length;
      const names = this.collectionNames(stale);
      for (const id of stale) this.run('UPDATE items_fts SET collections = ?1 WHERE rowid = ?2', [(names.get(id) ?? []).sort().join(' '), id]);
      this.recountCollections([collId], null);
      return out;
    }

    this.run('UPDATE items SET available = 1 WHERE platform = ?1 AND available = 0 AND external_id IN (SELECT value FROM json_each(?2))', [input.platform, seen]);
    out.revived = this.changes();
    this.run('UPDATE items SET available = 0 WHERE platform = ?1 AND available = 1 AND external_id NOT IN (SELECT value FROM json_each(?2))', [input.platform, seen]);
    out.markedUnavailable = this.changes();
    return out;
  }

  private wipeSync(): void {
    for (const t of ['item_hashtags', 'item_collections', 'items_fts', 'items', 'hashtags', 'collections']) this.db.exec(`DELETE FROM ${t}`);
    this.tagIds.clear();
  }

  // ------------------------------------------------------------------ row mapping

  private rowToItem(row: Record<string, unknown>, hashtags: string[]): Omit<StoredItem, 'id' | 'collections'> {
    const num = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));
    const str = (v: unknown) => (v === null || v === undefined ? undefined : String(v));
    const stats = { views: num(row.views), likes: num(row.likes), comments: num(row.comments), shares: num(row.shares), saves: num(row.saves) };
    return {
      platform: String(row.platform),
      externalId: String(row.external_id),
      authorHandle: String(row.author_handle),
      authorName: str(row.author_name),
      caption: String(row.caption),
      hashtags,
      soundTitle: str(row.sound_title),
      soundAuthor: str(row.sound_author),
      durationSec: num(row.duration_sec),
      mediaType: row.media_type === 'photo' ? 'photo' : 'video',
      postedAt: num(row.posted_at),
      stats: Object.values(stats).some((v) => v !== undefined) ? stats : undefined,
      thumbnailUrl: str(row.thumbnail_url),
      language: str(row.language),
      isAd: Number(row.is_ad) === 1,
      savedAt: Number(row.saved_at),
      savedAtSource: String(row.saved_at_source) as SavedAtSource,
      rawJson: str(row.raw_json),
      firstSeenAt: Number(row.first_seen_at),
      lastSeenAt: Number(row.last_seen_at),
      available: Number(row.available) === 1,
    };
  }
}
