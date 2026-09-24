-- Scroganize candidate schema (M0 draft; finalized after the spike numbers are reviewed).
--
-- Design notes
--  * Integer surrogate keys: items.id is the FTS rowid, keeps join indexes small.
--    (platform, external_id) stays UNIQUE, which is the natural key adapters upsert on.
--  * Counts are INTEGER and times are epoch-ms so sort/range filters use indexes.
--  * items_fts is CONTENTFUL. Its columns (hashtags, collections) are derived from other
--    tables, so an external-content table could not serve delete/snippet from `items`.
--  * items_tri is a small contentless trigram index used only as a fallback for
--    CJK / emoji / typo recovery.

CREATE TABLE items (
  id            INTEGER PRIMARY KEY,
  platform      TEXT    NOT NULL,
  external_id   TEXT    NOT NULL,
  url           TEXT    NOT NULL,
  author_handle TEXT    NOT NULL,
  author_name   TEXT,
  caption       TEXT    NOT NULL DEFAULT '',
  sound_title   TEXT,
  sound_author  TEXT,
  duration_sec  INTEGER,
  posted_at     INTEGER,
  views         INTEGER,
  likes         INTEGER,
  comments      INTEGER,
  shares        INTEGER,
  saves         INTEGER,
  thumbnail_url TEXT,
  language      TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  available     INTEGER NOT NULL DEFAULT 1,
  content_hash  TEXT    NOT NULL,          -- hash of the text fields that feed FTS
  raw_json      TEXT,
  UNIQUE (platform, external_id)
);

CREATE INDEX idx_items_posted   ON items (platform, posted_at);
CREATE INDEX idx_items_views    ON items (views);
CREATE INDEX idx_items_likes    ON items (likes);
CREATE INDEX idx_items_duration ON items (duration_sec);
CREATE INDEX idx_items_author   ON items (author_handle);
CREATE INDEX idx_items_seen     ON items (first_seen_at);

CREATE TABLE collections (
  id             INTEGER PRIMARY KEY,
  platform       TEXT    NOT NULL,
  external_id    TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  item_count     INTEGER,
  last_synced_at INTEGER,
  UNIQUE (platform, external_id)
);

-- Many-to-many: a video can be in several collections.
-- position: order inside the collection as TikTok returned it (0 = first).
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

-- Main text index. rowid = items.id.
-- Column order matters: it is the order of the bm25() weight arguments.
CREATE VIRTUAL TABLE items_fts USING fts5 (
  caption,
  hashtags,
  author,
  sound,
  collections,
  tokenize = "porter unicode61 remove_diacritics 2",
  prefix = '2 3 4'
);
