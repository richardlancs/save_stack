// Versioned schema migrations, applied in order and tracked with PRAGMA user_version.
// They are TypeScript strings (not .sql files) so they load identically under Vite, Vitest and plain Node.
// NEVER edit a shipped migration: add a new one.

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `
-- Scroganize schema v1 (M1). Design evidence: docs/STORAGE_SPIKE.md, docs/TIKTOK_FINDINGS.md.
--  * Integer surrogate key: items.id is also the FTS rowid. (platform, external_id) is the natural key adapters upsert on.
--  * Counts are INTEGER and times are epoch-ms so sort / range filters use indexes.
--  * No stored url (derived by the platform adapter) and raw_json is NULL unless a platform opts in.
--  * No trigram table: substring search for CJK / emoji is a LIKE scan (2-3 ms first page at 50k).

CREATE TABLE items (
  id              INTEGER PRIMARY KEY,
  platform        TEXT    NOT NULL,
  external_id     TEXT    NOT NULL,
  author_handle   TEXT    NOT NULL DEFAULT '',
  author_name     TEXT,
  caption         TEXT    NOT NULL DEFAULT '',
  sound_title     TEXT,
  sound_author    TEXT,
  media_type      TEXT    NOT NULL DEFAULT 'video' CHECK (media_type IN ('video', 'photo')),
  duration_sec    INTEGER,
  posted_at       INTEGER,
  views           INTEGER,
  likes           INTEGER,
  comments        INTEGER,
  shares          INTEGER,
  saves           INTEGER,
  thumbnail_url   TEXT,
  language        TEXT,
  is_ad           INTEGER NOT NULL DEFAULT 0,
  saved_at        INTEGER NOT NULL,
  saved_at_source TEXT    NOT NULL DEFAULT 'unknown' CHECK (saved_at_source IN ('unknown', 'interpolated', 'first_seen', 'exact')),
  first_seen_at   INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  available       INTEGER NOT NULL DEFAULT 1,
  content_hash    TEXT    NOT NULL,
  raw_json        TEXT,
  UNIQUE (platform, external_id)
);
CREATE INDEX idx_items_saved    ON items (saved_at);
CREATE INDEX idx_items_posted   ON items (platform, posted_at);
CREATE INDEX idx_items_views    ON items (views);
CREATE INDEX idx_items_likes    ON items (likes);
CREATE INDEX idx_items_duration ON items (duration_sec);
CREATE INDEX idx_items_author   ON items (author_handle);

CREATE TABLE collections (
  id             INTEGER PRIMARY KEY,
  platform       TEXT    NOT NULL,
  external_id    TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  declared_total INTEGER,                 -- what the platform CLAIMS; unreliable (48 declared vs 45 delivered)
  items_seen     INTEGER NOT NULL DEFAULT 0, -- what we actually hold
  last_synced_at INTEGER,
  UNIQUE (platform, external_id)
);

-- Many-to-many: a video can be in several collections. position = order the platform returned (0 = first).
CREATE TABLE item_collections (
  item_id       INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  collection_id INTEGER NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  PRIMARY KEY (item_id, collection_id)
) WITHOUT ROWID;
CREATE INDEX idx_ic_collection ON item_collections (collection_id, position);

CREATE TABLE hashtags (
  id  INTEGER PRIMARY KEY,
  tag TEXT NOT NULL UNIQUE
);
CREATE TABLE item_hashtags (
  item_id    INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  hashtag_id INTEGER NOT NULL REFERENCES hashtags (id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, hashtag_id)
) WITHOUT ROWID;
CREATE INDEX idx_ih_tag ON item_hashtags (hashtag_id, item_id);

-- Main text index, rowid = items.id. CONTENTFUL because hashtags/collections are derived columns.
-- Column order is the order of bm25() weight arguments (M2): caption, hashtags, author, sound, collections.
CREATE VIRTUAL TABLE items_fts USING fts5 (
  caption,
  hashtags,
  author,
  sound,
  collections,
  tokenize = "porter unicode61 remove_diacritics 2",
  prefix = '2 3 4'
);
`,
  },
  {
    version: 2,
    name: 'meta',
    sql: `
-- Scroganize schema v2 (M3 review). Key/value metadata. Currently holds the account binding ("account.<platform>"), so the binding
-- lives in the same database, and the same transactions, as the data it protects: wipe and import clear or restore it atomically.
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
`,
  },
];
