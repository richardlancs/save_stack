import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import type { Database } from '@sqlite.org/sqlite-wasm';
import { ftsColumns, normalizeHashtags } from '../../src/core/ingest/normalize';
import type { ParsedBatch, SavedItem } from '../../src/core/model';
import { applyPragmas } from '../../src/core/storage/sqlite/migrate';
import { SqliteAdapter } from '../../src/core/storage/sqlite/sqlite-adapter';

export const T0 = 1_780_000_000_000;
export const DAY = 86_400_000;

let modulePromise: ReturnType<typeof sqlite3InitModule> | undefined;

/** A fresh, migrated, in-memory database + adapter. */
export async function memoryAdapter(now: () => number = () => T0): Promise<{ adapter: SqliteAdapter; db: Database }> {
  modulePromise ??= sqlite3InitModule();
  const sqlite3 = await modulePromise;
  const db = new sqlite3.oo1.DB(':memory:');
  applyPragmas(db);
  const adapter = new SqliteAdapter(db, { now });
  await adapter.migrate();
  return { adapter, db };
}

export const item = (n: number, o: Partial<SavedItem> = {}): SavedItem => ({
  platform: 'tiktok',
  externalId: `id${n}`,
  authorHandle: `author${n % 3}`,
  authorName: `Author ${n % 3}`,
  caption: `caption ${n} #Food`,
  hashtags: ['#Food', 'food', 'Recipe'],
  soundTitle: `sound ${n}`,
  soundAuthor: 'sa',
  durationSec: 20,
  postedAt: 1_700_000_000_000 + n,
  stats: { views: 100 * n, likes: 10 * n },
  thumbnailUrl: `thumb${n}`,
  language: 'en',
  ...o,
});

export const items = (from: number, to: number, o: Partial<SavedItem> = {}): SavedItem[] =>
  Array.from({ length: to - from + 1 }, (_, i) => item(from + i, o));

export const coll = (n: number, name = `Collection ${n}`, declaredTotal?: number) => ({ platform: 'tiktok', externalId: `col${n}`, name, declaredTotal });
export const member = (itemN: number, collN: number, position = 0) => ({ platform: 'tiktok', itemExternalId: `id${itemN}`, collectionExternalId: `col${collN}`, position });

export const batch = (b: Partial<ParsedBatch> & { items: SavedItem[] }, syncedAt = T0): ParsedBatch => ({ syncedAt, ...b });

/**
 * The invariant the whole search layer rests on: every items row has exactly one items_fts row whose five columns
 * equal what the normalizer would produce from the database's current state. Returns a list of problems (empty = ok).
 */
export function assertFtsConsistent(db: Database): string[] {
  const problems: string[] = [];
  const nItems = Number(db.selectValue('SELECT count(*) FROM items'));
  const nFts = Number(db.selectValue('SELECT count(*) FROM items_fts'));
  if (nItems !== nFts) problems.push(`items=${nItems} but items_fts=${nFts}`);
  for (const r of db.selectObjects('SELECT * FROM items')) {
    const id = Number(r.id);
    const tags = db.selectValues('SELECT h.tag FROM item_hashtags ih JOIN hashtags h ON h.id = ih.hashtag_id WHERE ih.item_id = ?1', [id]).map(String);
    const names = db.selectValues('SELECT c.name FROM item_collections ic JOIN collections c ON c.id = ic.collection_id WHERE ic.item_id = ?1', [id]).map(String);
    const want = ftsColumns(
      {
        platform: String(r.platform),
        externalId: String(r.external_id),
        authorHandle: String(r.author_handle),
        authorName: (r.author_name as string | null) ?? undefined,
        caption: String(r.caption),
        soundTitle: (r.sound_title as string | null) ?? undefined,
        soundAuthor: (r.sound_author as string | null) ?? undefined,
      },
      normalizeHashtags(tags),
      names,
    );
    const got = db.selectObject('SELECT caption, hashtags, author, sound, collections FROM items_fts WHERE rowid = ?1', [id]);
    if (!got) { problems.push(`item ${id} has no FTS row`); continue; }
    const sortedTags = (s: unknown) => String(s).split(' ').filter(Boolean).sort().join(' ');
    if (got.caption !== want.caption) problems.push(`item ${id} caption differs`);
    if (sortedTags(got.hashtags) !== sortedTags(want.hashtags)) problems.push(`item ${id} hashtags differ: "${got.hashtags}" vs "${want.hashtags}"`);
    if (got.author !== want.author) problems.push(`item ${id} author differs`);
    if (got.sound !== want.sound) problems.push(`item ${id} sound differs`);
    if (got.collections !== want.collections) problems.push(`item ${id} collections differ: "${got.collections}" vs "${want.collections}"`);
  }
  return problems;
}

export const ftsMatch = (db: Database, expr: string): number[] =>
  db.selectValues('SELECT rowid FROM items_fts WHERE items_fts MATCH ?1 ORDER BY rowid', [expr]).map(Number);
