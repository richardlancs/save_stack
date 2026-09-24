// The SQL behind search. Query shapes come from the M0 spike (bench/spike-core.ts `runSearchV2`, docs/STORAGE_SPIKE.md §4):
//   * total is capped (10,001) so a broad query never pays for an exact count
//   * above 10,000 matches relevance ranking is skipped and results are newest-saved first ("too broad")
//   * relevance = tier 1 (the chips' own words) ranked by bm25, then tier 2 (`(full) NOT (direct)`) only to fill the page
//   * per-chip counts and "why matched" are separate, lazy calls so they never delay first paint
//   * chips FTS5 cannot serve (CJK, emoji) are matched as substrings over the plain `items` table

import type { Database } from '@sqlite.org/sqlite-wasm';
import type { StoredItem } from '../../model';
import { SearchInputError } from '../../search/chips';
import type { ChipPlan, SearchPlan } from '../../search/planner';
import type { ChipCount, ChipExplanation, FacetCounts, SearchStore, StoreResult, Vocabulary } from '../../search/store';
import type { MatchField, SearchSort } from '../../search/types';
import { rowToItem } from './rows';

export const TOTAL_CAP = 10_001;
export const TOO_BROAD = 10_000;
/** How many leading matches are gathered for facets and for tier filling. */
export const CANDIDATES = 300;
export const MAX_RELEVANCE_DEPTH = 1000;
/** Tier-2 (related-only) matches score below tier-1 matches of similar bm25. */
const RELATED_DISCOUNT = 0.4;

// Column order = the order of items_fts's columns = the bm25 weight arguments: caption, hashtags, author, sound, collections.
const BM25 = 'bm25(items_fts, 2.0, 4.0, 1.5, 1.0, 0.5)';
const FIELDS: ReadonlyArray<readonly [column: string, field: MatchField]> = [
  ['caption', 'caption'],
  ['hashtags', 'hashtags'],
  ['author', 'author'],
  ['sound', 'sound'],
  ['collections', 'collection'],
];

const SORT_EXPR: Record<Exclude<SearchSort, 'relevance'>, string> = {
  recently_saved: 'i.saved_at',
  newest: 'COALESCE(i.posted_at, 0)',
  most_viewed: 'COALESCE(i.views, 0)',
};

type Param = string | number;
interface Sql { sql: string; params: Param[] }

/** `!` is the LIKE escape character (chosen over a backslash so no quoting layer can mangle it). */
const likePattern = (word: string): string => `%${word.replace(/[!%_]/g, (c) => `!${c}`)}%`;
const LIKE = "LIKE ? ESCAPE '!'";

/**
 * Substring chips (CJK / emoji, which FTS5 cannot serve) are matched by one scan over `items` with a plain WHERE, no set algebra
 * (an INTERSECT/UNION formulation measured 2-3x slower). Mixed queries put the full-text part in the same WHERE as `i.id IN (...)`. Hashtag and collection-name matches are resolved to (few) ids first and appended only when they
 * exist, so the common case (caption/author/sound only) adds nothing. Returns the condition over `items i`.
 */
/** Up to this many matching hashtags/collections are inlined as ids; beyond it a join is used (still correct, just slower). */
const INLINE_IDS = 500;

function fastWordCondition(db: Database, word: string): Sql {
  const p = likePattern(word);
  const parts = [`i.caption ${LIKE}`, `i.author_handle ${LIKE}`, `i.author_name ${LIKE}`, `i.sound_title ${LIKE}`, `i.sound_author ${LIKE}`];
  const params: Param[] = [p, p, p, p, p];
  // (parameters are appended in the same order as their placeholders appear in `parts`)
  const tags = db.selectValues(`SELECT id FROM hashtags WHERE tag ${LIKE} LIMIT ${INLINE_IDS + 1}`, [p]).map(Number);
  if (tags.length > INLINE_IDS) {
    parts.push(`i.id IN (SELECT ih.item_id FROM item_hashtags ih JOIN hashtags h ON h.id = ih.hashtag_id WHERE h.tag ${LIKE})`);
    params.push(p);
  } else if (tags.length > 0) {
    parts.push(`i.id IN (SELECT item_id FROM item_hashtags WHERE hashtag_id IN (${tags.join(',')}))`);
  }
  const cols = db.selectValues(`SELECT id FROM collections WHERE name ${LIKE} LIMIT ${INLINE_IDS + 1}`, [p]).map(Number);
  if (cols.length > INLINE_IDS) {
    parts.push(`i.id IN (SELECT ic.item_id FROM item_collections ic JOIN collections c ON c.id = ic.collection_id WHERE c.name ${LIKE})`);
    params.push(p);
  } else if (cols.length > 0) {
    parts.push(`i.id IN (SELECT item_id FROM item_collections WHERE collection_id IN (${cols.join(',')}))`);
  }
  return { sql: `(${parts.join(' OR ')})`, params };
}

function fastCondition(db: Database, plan: SearchPlan): Sql {
  const parts: Sql[] = [];
  if (plan.fullExpr) parts.push({ sql: 'i.id IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?)', params: [plan.fullExpr] });
  for (const chip of plan.chips) {
    if (chip.substrings.length === 0) continue;
    const words = chip.substrings.map((w) => fastWordCondition(db, w));
    parts.push({ sql: `(${words.map((w) => w.sql).join(' AND ')})`, params: words.flatMap((w) => w.params) });
  }
  return { sql: `(${parts.map((c) => c.sql).join(plan.mode === 'all' ? ' AND ' : ' OR ')})`, params: parts.flatMap((c) => c.params) };
}

/** The full-text match set of the plan (FTS chips only), for ordering a too-broad relevance search. */
function ftsSet(plan: SearchPlan): Sql | null {
  return plan.fullExpr ? { sql: 'SELECT rowid AS id FROM items_fts WHERE items_fts MATCH ?', params: [plan.fullExpr] } : null;
}

/**
 * Cursors describe themselves and carry the total from the first page, so later pages never recount:
 *   r:<offset>:<total>                  relevance pages
 *   k:<sort>:<value>:<id>:<total>       column-ordered pages (keyset: stable even if rows arrive between pages)
 *   d:<sort>:<value>:<id>:<total>       the same, over the chips' OWN-word matches only (a too-broad relevance search whose
 *                                       own words alone exceed the limit; see `query`), so every page uses the same set
 * <sort> is s (recently saved), n (newest posted) or v (most viewed): a cursor replayed with a different sort is refused,
 * because comparing one column's value against another's would silently skip or repeat rows. The total is display-only and
 * is clamped, so a hand-edited cursor cannot report an absurd count.
 */
const SORT_LETTER = { recently_saved: 's', newest: 'n', most_viewed: 'v' } as const;
type Cursor =
  | { kind: 'r'; offset: number; total: number }
  | { kind: 'k'; sort: string; direct: boolean; v: number; id: number; total: number };
function parseCursor(cursor: string | undefined): Cursor | null {
  if (!cursor) return null;
  let m = /^r:(\d+):(\d+)$/.exec(cursor);
  if (m) return { kind: 'r', offset: Math.min(Number(m[1]), MAX_RELEVANCE_DEPTH), total: Math.min(Number(m[2]), TOTAL_CAP) };
  m = /^([kd]):([snv]):(-?\d+):(\d+):(\d+)$/.exec(cursor);
  if (m) return { kind: 'k', direct: m[1] === 'd', sort: m[2]!, v: Number(m[3]), id: Number(m[4]), total: Math.min(Number(m[5]), TOTAL_CAP) };
  throw new SearchInputError('malformed cursor');
}

const EMPTY = (orderedBy: SearchSort): StoreResult => ({ ids: [], scores: [], candidateIds: [], total: 0, totalIsCapped: false, orderedBy, tooBroad: false });
const WRONG_CURSOR = 'this cursor belongs to a different kind of search';

/** Every `items` column a search result shows. `raw_json` is deliberately absent: it is opt-in, can be several KB, and would cross the RPC boundary for nothing. */
const RESULT_COLUMNS = 'id, platform, external_id, author_handle, author_name, caption, sound_title, sound_author, media_type, duration_sec, posted_at, views, likes, comments, shares, saves, thumbnail_url, language, is_ad, saved_at, saved_at_source, first_seen_at, last_seen_at, available';

export class SqliteSearch implements SearchStore {
  private vocab?: { version: number; data: Vocabulary };

  /** `dataVersion` changes whenever the data does (the adapter bumps it on every write), so cached vocabulary is never stale. */
  constructor(private readonly db: Database, private readonly dataVersion: () => number = () => 0) {}

  // The SearchStore methods are async for engine-agnosticism; SQLite runs synchronously underneath.

  // ------------------------------------------------------------------ query

  async searchQuery(plan: SearchPlan): Promise<StoreResult> {
    const cur = parseCursor(plan.cursor);
    const set = ftsSet(plan);

    if (plan.chips.length === 0) {
      // browse everything
      if (cur?.kind === 'r' || cur?.direct) throw new SearchInputError(WRONG_CURSOR);
      const orderedBy = (plan.sort === 'relevance' ? 'recently_saved' : plan.sort) as Exclude<SearchSort, 'relevance'>;
      return this.ordered(plan, { orderedBy, cur });
    }

    // relevance is available only when every chip is an FTS chip
    if (plan.sort === 'relevance' && !plan.hasSubstring) {
      if (cur?.kind === 'r') return this.ranked(plan, cur.total, cur.offset);
      const ownSet: Sql = { sql: 'SELECT rowid AS id FROM items_fts WHERE items_fts MATCH ?', params: [plan.directExpr!] };
      // A continuation page carries the decision made on page 1 (in the cursor), so it is never recomputed.
      if (cur?.kind === 'k') return this.ordered(plan, { set: cur.direct ? ownSet : set!, orderedBy: 'recently_saved', cur, direct: cur.direct });
      // If the chips' OWN words already match more than the limit, the search is too broad whatever the related terms add.
      // Ordering only those matches skips the (expensive) related-terms expression entirely: 21 ms vs 47 ms measured.
      if (plan.hasRelated && this.capped(plan.directExpr!) > TOO_BROAD) {
        return this.ordered(plan, { set: ownSet, orderedBy: 'recently_saved', cur: null, knownTotal: TOTAL_CAP, direct: true });
      }
      const total = this.capped(plan.fullExpr!);
      if (total === 0) return EMPTY('relevance');
      if (total > TOO_BROAD) return this.ordered(plan, { set: set!, orderedBy: 'recently_saved', cur: null, knownTotal: total });
      return this.ranked(plan, total, 0);
    }

    // an explicit column sort, or substring chips (relevance is unavailable there)
    if (cur?.kind === 'r' || cur?.direct) throw new SearchInputError(WRONG_CURSOR);
    const orderedBy = (plan.sort === 'relevance' ? 'recently_saved' : plan.sort) as Exclude<SearchSort, 'relevance'>;
    if (plan.hasSubstring) return this.ordered(plan, { where: fastCondition(this.db, plan), orderedBy, cur });
    return this.ordered(plan, { set, orderedBy, cur });
  }

  /** Matches of a full-text expression, counting no further than the cap. */
  private capped(expr: string): number {
    return Number(this.db.selectValue(`SELECT count(*) FROM (SELECT 1 FROM items_fts WHERE items_fts MATCH ?1 LIMIT ${TOTAL_CAP})`, [expr]) ?? 0);
  }

  /** Relevance: tier 1 ranked by bm25 over the chips' own words, then tier 2 (related-only) only if the page is not full. */
  private ranked(plan: SearchPlan, total: number, offset: number): StoreResult {
    const need = offset + plan.limit;
    const depth = Math.min(MAX_RELEVANCE_DEPTH, Math.max(CANDIDATES, need));
    const ids: number[] = [];
    const scores: number[] = [];
    const t1 = this.db.selectArrays(`SELECT rowid, ${BM25} AS s FROM items_fts WHERE items_fts MATCH ?1 ORDER BY s, rowid LIMIT ?2`, [plan.directExpr!, depth]);
    for (const r of t1) { ids.push(Number(r[0])); scores.push(-Number(r[1])); }
    if (ids.length < depth && plan.hasRelated && total > ids.length) {
      // FTS5 set difference: matches through a related term but NOT through the chips' own words
      const t2 = this.db.selectArrays(
        `SELECT rowid, ${BM25} AS s FROM items_fts WHERE items_fts MATCH ?1 ORDER BY s, rowid LIMIT ?2`,
        [`(${plan.fullExpr}) NOT (${plan.directExpr})`, depth - ids.length],
      );
      for (const r of t2) { ids.push(Number(r[0])); scores.push(-Number(r[1]) * RELATED_DISCOUNT); }
    }
    const more = need < Math.min(total, MAX_RELEVANCE_DEPTH);
    return {
      ids: ids.slice(offset, need),
      scores: scores.slice(offset, need),
      candidateIds: offset === 0 ? ids.slice(0, CANDIDATES) : [],
      total,
      totalIsCapped: total > TOO_BROAD,
      orderedBy: 'relevance',
      tooBroad: false,
      nextCursor: more ? `r:${need}:${total}` : undefined,
    };
  }

  /**
   * Column ordering with keyset pagination. The match set is materialized ONCE and used for both the page and the
   * (capped) total, so a broad query never evaluates the full-text expression twice. Later pages take the total
   * from the cursor and only run the page query.
   */
  private ordered(
    plan: SearchPlan,
    o: {
      orderedBy: Exclude<SearchSort, 'relevance'>;
      cur: Cursor | null;
      /** A full-text match set (`SELECT ... AS id`), or null for "every item" / when `where` is given. */
      set?: Sql | null;
      /** A plain WHERE over `items i` (substring searches). */
      where?: Sql;
      /** The total is already known (from a count made while deciding how to order). */
      knownTotal?: number;
      /** Mark issued cursors as belonging to the own-words listing (see the `d:` cursor). */
      direct?: boolean;
    },
  ): StoreResult {
    const { orderedBy, cur, where, knownTotal } = o;
    const set = o.set ?? null;
    const expr = SORT_EXPR[orderedBy];
    const ks = cur?.kind === 'k' ? cur : null;
    if (ks && ks.sort !== SORT_LETTER[orderedBy]) throw new SearchInputError('this cursor was issued for a different sort');
    const first = ks === null;
    const fetch = first ? Math.max(plan.limit, CANDIDATES) : plan.limit;
    const keyset = ks ? `AND (${expr} < ? OR (${expr} = ? AND i.id < ?))` : '';
    const keysetParams: Param[] = ks ? [ks.v, ks.v, ks.id] : [];
    const needTotal = first && knownTotal === undefined;

    let rows: unknown[][];
    let total: number;
    if (where) {
      // one scan; the count rides along as a window function (evaluated over the whole filtered set, before LIMIT)
      const withTotal = needTotal ? ', count(*) OVER () AS total' : '';
      rows = this.db.selectArrays(`SELECT i.id, ${expr} AS k${withTotal} FROM items i WHERE ${where.sql} ${keyset} ORDER BY k DESC, i.id DESC LIMIT ?`, [...where.params, ...keysetParams, fetch + 1]);
      total = ks ? ks.total : needTotal ? Math.min(TOTAL_CAP, Number(rows[0]?.[2] ?? 0)) : knownTotal!;
    } else if (set === null) {
      rows = this.db.selectArrays(`SELECT i.id, ${expr} AS k FROM items i WHERE 1 = 1 ${keyset} ORDER BY k DESC, i.id DESC LIMIT ?`, [...keysetParams, fetch + 1]);
      total = ks ? ks.total : needTotal ? Number(this.db.selectValue(`SELECT count(*) FROM (SELECT 1 FROM items LIMIT ${TOTAL_CAP})`) ?? 0) : knownTotal!;
    } else if (needTotal) {
      // total unknown: materialize the match set ONCE and use it for both the page and the capped count
      rows = this.db.selectArrays(
        `WITH m(id) AS MATERIALIZED (${set.sql})
         SELECT i.id, ${expr} AS k, (SELECT count(*) FROM (SELECT 1 FROM m LIMIT ${TOTAL_CAP})) AS total FROM items i JOIN m ON m.id = i.id WHERE 1 = 1 ${keyset} ORDER BY k DESC, i.id DESC LIMIT ?`,
        [...set.params, ...keysetParams, fetch + 1],
      );
      total = Number(rows[0]?.[2] ?? 0);
    } else {
      // total already known (a too-broad continuation): a plain IN is cheaper than materializing again (measured)
      rows = this.db.selectArrays(
        `SELECT i.id, ${expr} AS k FROM items i WHERE i.id IN (${set.sql}) ${keyset} ORDER BY k DESC, i.id DESC LIMIT ?`,
        [...set.params, ...keysetParams, fetch + 1],
      );
      total = ks ? ks.total : knownTotal!;
    }
    if (first && rows.length === 0) return EMPTY(orderedBy);
    const page = rows.slice(0, plan.limit);
    const last = page[page.length - 1];
    return {
      ids: page.map((r) => Number(r[0])),
      scores: page.map(() => 0),
      candidateIds: first ? rows.slice(0, CANDIDATES).map((r) => Number(r[0])) : [],
      total,
      totalIsCapped: total > TOO_BROAD,
      orderedBy,
      tooBroad: total > TOO_BROAD,
      nextCursor: rows.length > plan.limit && last ? `${o.direct ? 'd' : 'k'}:${SORT_LETTER[orderedBy]}:${Number(last[1])}:${Number(last[0])}:${total}` : undefined,
    };
  }

  // ------------------------------------------------------------------ pages, facets

  async hydrateItems(ids: readonly number[]): Promise<StoredItem[]> {
    if (ids.length === 0) return [];
    const json = JSON.stringify(ids);
    const rows = new Map<number, Record<string, unknown>>();
    for (const r of this.db.selectObjects(`SELECT ${RESULT_COLUMNS} FROM items WHERE id IN (SELECT value FROM json_each(?1))`, [json])) rows.set(Number(r.id), r);
    const tags = new Map<number, string[]>();
    for (const r of this.db.selectArrays('SELECT ih.item_id, h.tag FROM item_hashtags ih JOIN hashtags h ON h.id = ih.hashtag_id WHERE ih.item_id IN (SELECT value FROM json_each(?1)) ORDER BY h.tag', [json])) {
      const id = Number(r[0]);
      (tags.get(id) ?? tags.set(id, []).get(id)!).push(String(r[1]));
    }
    const cols = new Map<number, StoredItem['collections']>();
    for (const r of this.db.selectArrays(
      'SELECT ic.item_id, c.external_id, c.name, ic.position FROM item_collections ic JOIN collections c ON c.id = ic.collection_id WHERE ic.item_id IN (SELECT value FROM json_each(?1)) ORDER BY c.name',
      [json],
    )) {
      const id = Number(r[0]);
      (cols.get(id) ?? cols.set(id, []).get(id)!).push({ externalId: String(r[1]), name: String(r[2]), position: Number(r[3]) });
    }
    const out: StoredItem[] = [];
    for (const id of ids) {
      const row = rows.get(id);
      if (row) out.push({ ...rowToItem(row, tags.get(id) ?? []), id, collections: cols.get(id) ?? [] });
    }
    return out;
  }

  async facetCandidates(ids: readonly number[]): Promise<FacetCounts> {
    if (ids.length === 0) return { hashtags: [], collections: [], authors: [] };
    const json = JSON.stringify(ids);
    const pick = (sql: string) => this.db.selectArrays(sql, [json]).map((r) => ({ text: String(r[0]), count: Number(r[1]) }));
    return {
      hashtags: pick('SELECT h.tag, count(*) c FROM item_hashtags ih JOIN hashtags h ON h.id = ih.hashtag_id WHERE ih.item_id IN (SELECT value FROM json_each(?1)) GROUP BY ih.hashtag_id ORDER BY c DESC, h.tag LIMIT 24'),
      collections: pick('SELECT c.name, count(*) k FROM item_collections ic JOIN collections c ON c.id = ic.collection_id WHERE ic.item_id IN (SELECT value FROM json_each(?1)) GROUP BY ic.collection_id ORDER BY k DESC, c.name LIMIT 8'),
      authors: pick("SELECT author_handle, count(*) c FROM items WHERE author_handle != '' AND id IN (SELECT value FROM json_each(?1)) GROUP BY author_handle ORDER BY c DESC, author_handle LIMIT 8"),
    };
  }

  // ------------------------------------------------------------------ per-chip info

  async countChip(chip: ChipPlan): Promise<ChipCount> {
    let n: number;
    if (chip.expr !== null) {
      n = Number(this.db.selectValue(`SELECT count(*) FROM (SELECT 1 FROM items_fts WHERE items_fts MATCH ?1 LIMIT ${TOTAL_CAP})`, [chip.expr]) ?? 0);
    } else {
      const words = chip.substrings.map((w) => fastWordCondition(this.db, w));
      n = Number(this.db.selectValue(`SELECT count(*) FROM (SELECT 1 FROM items i WHERE ${words.map((w) => w.sql).join(' AND ')} LIMIT ${TOTAL_CAP})`, words.flatMap((w) => w.params)) ?? 0);
    }
    return { count: n, capped: n >= TOTAL_CAP };
  }

  /** Words a mistyped chip could have meant. Built with full-table scans, so it is cached until the data changes. */
  async vocabulary(): Promise<Vocabulary> {
    const version = this.dataVersion();
    if (this.vocab?.version === version) return this.vocab.data;
    const data: Vocabulary = {
      hashtags: this.db.selectValues('SELECT tag FROM hashtags').map(String),
      authors: this.db.selectValues("SELECT DISTINCT author_handle FROM items WHERE author_handle != ''").map(String),
      collections: this.db.selectValues('SELECT name FROM collections').map(String),
    };
    this.vocab = { version, data };
    return data;
  }

  // ------------------------------------------------------------------ why did this match?

  async explainItem(platform: string, externalId: string, chips: readonly ChipPlan[]): Promise<ChipExplanation[] | null> {
    const idRow = this.db.selectValue('SELECT id FROM items WHERE platform = ?1 AND external_id = ?2', [platform, externalId]);
    if (idRow === undefined || idRow === null) return null;
    const id = Number(idRow);
    const matches = (expr: string): boolean => this.db.selectValue('SELECT 1 FROM items_fts WHERE items_fts MATCH ?1 AND rowid = ?2', [expr, id]) !== undefined;
    const like = (column: string, word: string): boolean =>
      this.db.selectValue(`SELECT 1 FROM items_fts WHERE rowid = ?1 AND items_fts.${column} LIKE ?2 ESCAPE '!'`, [id, likePattern(word)]) !== undefined;

    return chips.map((chip): ChipExplanation => {
      if (chip.substrings.length > 0) {
        const fields = new Set<MatchField>();
        let every = true;
        for (const word of chip.substrings) {
          const hit = FIELDS.filter(([c]) => like(c, word));
          if (hit.length === 0) every = false;
          hit.forEach(([, f]) => fields.add(f));
        }
        return { chipId: chip.chipId, via: every ? 'direct' : 'none', fields: every ? [...fields] : [] };
      }
      if (chip.own !== null && matches(chip.own)) {
        return { chipId: chip.chipId, via: 'direct', fields: FIELDS.filter(([c]) => matches(`${c} : (${chip.own})`)).map(([, f]) => f) };
      }
      if (chip.related.length > 0 && chip.expr !== null && matches(chip.expr)) {
        const at = chip.related.findIndex((r) => matches(r)); // which related term did it (lazy call, so a few queries are fine)
        return { chipId: chip.chipId, via: 'related', fields: FIELDS.filter(([c]) => matches(`${c} : ${chip.expr}`)).map(([, f]) => f), term: at >= 0 ? chip.relatedTerms[at] : undefined };
      }
      return { chipId: chip.chipId, via: 'none', fields: [] };
    });
  }
}
