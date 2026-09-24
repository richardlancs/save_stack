// M0 SPIKE. Not production code: it exists to answer "is SQLite-WASM + OPFS + FTS5 fast enough,
// and which schema/pragma/query shapes should M1/M2 commit to?".
// It runs inside a dedicated Worker (see extension/entrypoints/offscreen/db.worker.ts).

import type { Database, PreparedStatement, SAHPoolUtil, Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import schemaSql from './spike-schema.sql?raw';
import { CATEGORIES, generateLibrary, type SynthItem, type SynthLibrary } from './synth';

const now = () => performance.now();
const r2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- stats

export interface Stat { n: number; mean: number; p50: number; p95: number; max: number }
export function stat(samples: number[]): Stat {
  const s = [...samples].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  return { n: s.length, mean: r2(s.reduce((a, b) => a + b, 0) / Math.max(1, s.length)), p50: r2(q(0.5)), p95: r2(q(0.95)), max: r2(s[s.length - 1] ?? 0) };
}

// ---------------------------------------------------------------- open / environment

export interface OpenResult {
  sqlite3: Sqlite3Static;
  poolUtil: SAHPoolUtil;
  timings: { wasmInitMs: number; vfsInstallMs: number };
}

export async function openPool(init: () => Promise<Sqlite3Static>, opts: { retryMs?: number } = {}): Promise<OpenResult & { installAttempts: number; waitedMs: number }> {
  const t0 = now();
  const sqlite3 = await init();
  const t1 = now();
  const deadline = t1 + (opts.retryMs ?? 0);
  let attempts = 0;
  for (;;) {
    attempts++;
    try {
      const poolUtil = await sqlite3.installOpfsSAHPoolVfs({ name: 'scroganize', directory: '.scroganize', initialCapacity: 10 });
      const t2 = now();
      return { sqlite3, poolUtil, timings: { wasmInitMs: r2(t1 - t0), vfsInstallMs: r2(t2 - t1) }, installAttempts: attempts, waitedMs: r2(t2 - t1) };
    } catch (e) {
      if (now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

export function environment(db: Database): Record<string, unknown> {
  const opts = db.selectValues('SELECT compile_options FROM pragma_compile_options') as string[];
  const want = ['ENABLE_FTS5', 'ENABLE_DBSTAT_VTAB', 'ENABLE_MATH_FUNCTIONS', 'ENABLE_JSON1', 'THREADSAFE'];
  return {
    sqliteVersion: db.selectValue('SELECT sqlite_version()'),
    compileOptionsOfInterest: opts.filter((o) => want.some((w) => o.includes(w))),
    fts5Tokenizers: 'porter unicode61 trigram (verified by schema creation)',
    userAgent: (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent,
    hardwareConcurrency: (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator?.hardwareConcurrency,
    crossOriginIsolated: (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated,
    hasSharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
  };
}

// ---------------------------------------------------------------- schema + ingest

export type TrigramMode = 'contentless-delete' | 'none';

export interface VariantSpec { name: string; pragmasBeforeSchema: string[]; pragmasAfterOpen: string[] }

export function createSchema(db: Database, tri: TrigramMode): { trigram: string; notes: string[] } {
  const notes: string[] = [];
  db.exec(schemaSql);
  let trigram = 'none';
  if (tri === 'contentless-delete') {
    try {
      db.exec("CREATE VIRTUAL TABLE items_tri USING fts5(text, content='', contentless_delete=1, tokenize='trigram')");
      trigram = 'contentless-delete';
    } catch (e) {
      notes.push('contentless trigram failed: ' + String(e));
    }
  }
  return { trigram, notes };
}

const fnv = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
};

const ITEM_COLS = 'platform, external_id, url, author_handle, author_name, caption, sound_title, sound_author, duration_sec, posted_at, views, likes, comments, shares, saves, thumbnail_url, language, first_seen_at, last_seen_at, available, content_hash, raw_json';

export class Ingester {
  private sel: PreparedStatement;
  private insItem: PreparedStatement;
  private updSeen: PreparedStatement;
  private updText: PreparedStatement;
  private delFts: PreparedStatement;
  private insFts: PreparedStatement;
  private delTri?: PreparedStatement;
  private insTri?: PreparedStatement;
  private insTag: PreparedStatement;
  private selTag: PreparedStatement;
  private insIH: PreparedStatement;
  private delIH: PreparedStatement;
  private insMem: PreparedStatement;
  private tagIds = new Map<string, number>();
  private collectionName = new Map<number, string>();
  private memberPos = new Map<number, number>();

  constructor(private db: Database, private lib: SynthLibrary, hasTri: boolean, private lean = false) {
    this.sel = db.prepare('SELECT id, content_hash FROM items WHERE platform = ?1 AND external_id = ?2');
    this.insItem = db.prepare(`INSERT INTO items (${ITEM_COLS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22) RETURNING id`);
    this.updSeen = db.prepare('UPDATE items SET last_seen_at = ?1, views = ?2, likes = ?3, comments = ?4, shares = ?5, saves = ?6, thumbnail_url = ?7, available = 1 WHERE id = ?8');
    this.updText = db.prepare('UPDATE items SET caption = ?1, content_hash = ?2, last_seen_at = ?3 WHERE id = ?4');
    this.delFts = db.prepare('DELETE FROM items_fts WHERE rowid = ?1');
    this.insFts = db.prepare('INSERT INTO items_fts (rowid, caption, hashtags, author, sound, collections) VALUES (?1,?2,?3,?4,?5,?6)');
    if (hasTri) {
      this.delTri = db.prepare('DELETE FROM items_tri WHERE rowid = ?1');
      this.insTri = db.prepare('INSERT INTO items_tri (rowid, text) VALUES (?1, ?2)');
    }
    this.insTag = db.prepare('INSERT INTO hashtags (tag) VALUES (?1) ON CONFLICT (tag) DO NOTHING');
    this.selTag = db.prepare('SELECT id FROM hashtags WHERE tag = ?1');
    this.insIH = db.prepare('INSERT OR IGNORE INTO item_hashtags (item_id, hashtag_id) VALUES (?1, ?2)');
    this.delIH = db.prepare('DELETE FROM item_hashtags WHERE item_id = ?1');
    this.insMem = db.prepare('INSERT INTO item_collections (item_id, collection_id, position) VALUES (?1,?2,?3) ON CONFLICT (item_id, collection_id) DO UPDATE SET position = excluded.position');
    for (const c of lib.collections) this.collectionName.set(c.id, c.name);
  }

  upsertCollections(): Map<number, number> {
    const map = new Map<number, number>();
    const ins = this.db.prepare('INSERT INTO collections (platform, external_id, name, item_count, last_synced_at) VALUES (?1,?2,?3,?4,?5) ON CONFLICT (platform, external_id) DO UPDATE SET name = excluded.name RETURNING id');
    for (const c of this.lib.collections) {
      ins.bind(['tiktok', c.externalId, c.name, null, 0]);
      ins.step();
      map.set(c.id, Number(ins.get(0)));
      ins.reset();
    }
    ins.finalize();
    return map;
  }

  private tagId(tag: string): number {
    let id = this.tagIds.get(tag);
    if (id !== undefined) return id;
    this.insTag.bind([tag]).stepReset();
    this.selTag.bind([tag]);
    this.selTag.step();
    id = Number(this.selTag.get(0));
    this.selTag.reset();
    this.tagIds.set(tag, id);
    return id;
  }

  private rawJson(it: SynthItem): string {
    return JSON.stringify({ v: 1, id: it.externalId, music: { t: it.soundTitle, a: it.soundAuthor }, st: [it.views, it.likes, it.comments, it.shares, it.saves], vid: { d: it.durationSec, c: it.thumbnailUrl }, tx: it.hashtags.map((h, i) => ({ h, s: i * 9, e: i * 9 + h.length })) });
  }

  private ftsRow(it: SynthItem, id: number): [number, string, string, string, string, string] {
    return [id, it.caption, it.hashtags.join(' '), `${it.authorHandle} ${it.authorName}`, `${it.soundTitle} ${it.soundAuthor}`, it.collectionIds.map((c) => this.collectionName.get(c)).join(' ')];
  }

  private triText(it: SynthItem): string {
    return `${it.caption} ${it.authorHandle} ${it.collectionIds.map((c) => this.collectionName.get(c)).join(' ')}`.toLowerCase();
  }

  /** The M1 ingest contract in miniature: lookup -> insert | touch | reindex. Returns counters. */
  upsertBatch(items: SynthItem[], colIdMap: Map<number, number>, syncMs: number, mutate?: (it: SynthItem) => SynthItem): { inserted: number; touched: number; reindexed: number } {
    let inserted = 0, touched = 0, reindexed = 0;
    this.db.transaction(() => {
      for (const src of items) {
        const it = mutate ? mutate(src) : src;
        const hash = fnv(`${it.caption}|${it.authorHandle}|${it.soundTitle}|${it.hashtags.join(',')}|${it.collectionIds.join(',')}`);
        this.sel.bind(['tiktok', it.externalId]);
        const found = this.sel.step();
        const existingId = found ? Number(this.sel.get(0)) : 0;
        const existingHash = found ? String(this.sel.get(1)) : '';
        this.sel.reset();

        if (!found) {
          this.insItem.bind(['tiktok', it.externalId, this.lean ? '' : it.url, it.authorHandle, it.authorName, it.caption, it.soundTitle, it.soundAuthor, it.durationSec, it.postedAt, it.views, it.likes, it.comments, it.shares, it.saves, it.thumbnailUrl, it.language, it.firstSeenAt, syncMs, 1, hash, this.lean ? null : this.rawJson(it)]);
          this.insItem.step();
          const id = Number(this.insItem.get(0));
          this.insItem.reset();
          for (const t of it.hashtags) this.insIH.bind([id, this.tagId(t)]).stepReset();
          for (const cid of it.collectionIds) {
            const pos = this.memberPos.get(cid) ?? 0;
            this.memberPos.set(cid, pos + 1);
            this.insMem.bind([id, colIdMap.get(cid) ?? cid, pos]).stepReset();
          }
          this.insFts.bind(this.ftsRow(it, id)).stepReset();
          this.insTri?.bind([id, this.triText(it)]).stepReset();
          inserted++;
        } else if (existingHash === hash) {
          this.updSeen.bind([syncMs, it.views, it.likes, it.comments, it.shares, it.saves, it.thumbnailUrl, existingId]).stepReset();
          touched++;
        } else {
          this.updText.bind([it.caption, hash, syncMs, existingId]).stepReset();
          this.delFts.bind([existingId]).stepReset();
          this.insFts.bind(this.ftsRow(it, existingId)).stepReset();
          if (this.delTri && this.insTri) {
            this.delTri.bind([existingId]).stepReset();
            this.insTri.bind([existingId, this.triText(it)]).stepReset();
          }
          this.delIH.bind([existingId]).stepReset();
          for (const t of it.hashtags) this.insIH.bind([existingId, this.tagId(t)]).stepReset();
          reindexed++;
        }
      }
    });
    return { inserted, touched, reindexed };
  }

  finalize(): void {
    for (const s of [this.sel, this.insItem, this.updSeen, this.updText, this.delFts, this.insFts, this.delTri, this.insTri, this.insTag, this.selTag, this.insIH, this.delIH, this.insMem]) s?.finalize();
  }
}

export function ingestAll(db: Database, lib: SynthLibrary, tri: TrigramMode, batchSize: number, syncMs: number, mutate?: (it: SynthItem) => SynthItem, limit?: number, lean = false) {
  const ing = new Ingester(db, lib, tri !== 'none' && hasTable(db, 'items_tri'), lean);
  const colMap = ing.upsertCollections();
  const items = limit ? lib.items.slice(0, limit) : lib.items;
  const t0 = now();
  let inserted = 0, touched = 0, reindexed = 0;
  for (let i = 0; i < items.length; i += batchSize) {
    const r = ing.upsertBatch(items.slice(i, i + batchSize), colMap, syncMs, mutate);
    inserted += r.inserted; touched += r.touched; reindexed += r.reindexed;
  }
  const ms = now() - t0;
  ing.finalize();
  return { ms: r2(ms), itemsPerSec: Math.round(items.length / (ms / 1000)), inserted, touched, reindexed };
}

function hasTable(db: Database, name: string): boolean {
  return Number(db.selectValue("SELECT count(*) FROM sqlite_master WHERE name = ?1", [name])) > 0;
}

export function dbSizes(db: Database): Record<string, unknown> {
  const pageSize = Number(db.selectValue('PRAGMA page_size'));
  const pages = Number(db.selectValue('PRAGMA page_count'));
  const out: Record<string, unknown> = { pageSize, pages, totalMB: r2((pageSize * pages) / 1048576) };
  try {
    const rows = db.selectArrays('SELECT name, sum(pgsize) FROM dbstat GROUP BY name ORDER BY 2 DESC LIMIT 14');
    out.byObjectMB = Object.fromEntries(rows.map((r) => [String(r[0]), r2(Number(r[1]) / 1048576)]));
  } catch (e) {
    out.dbstat = 'unavailable: ' + String(e);
  }
  return out;
}

// ---------------------------------------------------------------- search (spike-grade planner)

export interface Chip { text: string; expand: boolean }
export interface SearchReq { chips: Chip[]; mode: 'all' | 'any'; sort: 'relevance' | 'recently_saved' | 'most_viewed'; limit: number }

const tokenize = (s: string): string[] => s.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Spike lexicon: derived from the generator's categories (M2 ships a hand-authored JSON file). */
const LEXICON = new Map<string, string[]>();
for (const c of CATEGORIES) {
  const all = [...c.core, ...c.related];
  LEXICON.set(c.key, all);
  for (const w of c.core) LEXICON.set(w, all);
}
// Stress knob: pad each known category's related list up to N terms with other categories' words, to test
// the design cap (<= 30 related terms per chip), which the small spike lexicon never reaches on its own.
let expandTarget = 0;
export const setExpandTarget = (n: number): void => { expandTarget = n; };
const PAD_POOL = CATEGORIES.flatMap((c) => c.related);
export const expandChip = (text: string): string[] => {
  const key = tokenize(text).join(' ');
  const base = (LEXICON.get(key) ?? []).filter((t) => t !== key);
  if (!base.length || expandTarget <= base.length) return base;
  const out = [...base];
  for (let i = 0; out.length < expandTarget && i < PAD_POOL.length; i++) if (!out.includes(PAD_POOL[i]!)) out.push(PAD_POOL[i]!);
  return out;
};

const ownExpr = (text: string): string | null => {
  const t = tokenize(text);
  if (!t.length) return null;
  const parts = t.map((w, i) => `"${w}"${i === t.length - 1 ? '*' : ''}`);
  if (parts.length === 1) return parts[0]!;
  // Hashtags are usually one concatenated token (#mealprep), so "meal prep" must also try "mealprep".
  return `((${parts.join(' AND ')}) OR "${t.join('')}"*)`;
};
const relExpr = (term: string): string | null => {
  const t = tokenize(term);
  if (!t.length) return null;
  return t.length === 1 ? `"${t[0]}"` : `"${t.join(' ')}"`;
};

export interface ChipPlan { text: string; own: string; related: string[]; expr: string; directExpr: string }
export function planChips(chips: Chip[]): ChipPlan[] {
  const out: ChipPlan[] = [];
  for (const c of chips) {
    const own = ownExpr(c.text);
    if (!own) continue;
    const related = c.expand ? expandChip(c.text).map(relExpr).filter((x): x is string => !!x).slice(0, 30) : [];
    out.push({ text: c.text, own, related, expr: `(${[own, ...related].join(' OR ')})`, directExpr: own });
  }
  return out;
}
const combine = (parts: string[], mode: 'all' | 'any') => parts.join(mode === 'all' ? ' AND ' : ' OR ');

export interface SearchOut { total: number; page: number; chipCounts: number[]; timings: Record<string, number>; firstIds: number[] }

const W = '2.0, 4.0, 1.5, 1.0, 0.5'; // caption, hashtags, author, sound, collections

export function runSearch(db: Database, req: SearchReq, opts: { attribution: 'rowid-eq' | 'json-in' | 'none'; candidates?: number; cappedTotal?: boolean } = { attribution: 'rowid-eq' }): SearchOut {
  const T: Record<string, number> = {};
  const time = <R>(k: string, f: () => R): R => { const t = now(); const r = f(); T[k] = (T[k] ?? 0) + (now() - t); return r; };
  const plans = planChips(req.chips);
  const candLimit = opts.candidates ?? 300;

  // ---- no chips: browse everything
  if (plans.length === 0) {
    const ids = time('page', () => db.selectValues(`SELECT id FROM items ORDER BY ${req.sort === 'most_viewed' ? 'views' : 'first_seen_at'} DESC LIMIT ?1`, [req.limit]).map(Number));
    const total = time('total', () => Number(db.selectValue('SELECT count(*) FROM items')));
    time('hydrate', () => hydrate(db, ids));
    return { total, page: ids.length, chipCounts: [], timings: rounded(T), firstIds: ids.slice(0, 5) };
  }

  const full = combine(plans.map((p) => p.expr), req.mode);
  const direct = combine(plans.map((p) => p.directExpr), req.mode);

  // ---- candidates + page
  let pageIds: number[];
  let candIds: number[];
  if (req.sort === 'relevance') {
    // One FTS pass ranks the top-N candidates; a second pass (direct-only expression) tiers them so
    // videos matching a chip's own words outrank ones matching only via related terms.
    // The ordered candidate list feeds both the page (first `limit`) and the facets (all N).
    candIds = time('candidates', () => db.selectValues(
      `WITH cand AS (SELECT rowid AS id, bm25(items_fts, ${W}) AS s FROM items_fts WHERE items_fts MATCH ?1 ORDER BY s LIMIT ?2)
       SELECT id FROM cand ORDER BY (id IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?3)) DESC, s`,
      [full, candLimit, direct]).map(Number));
    pageIds = candIds.slice(0, req.limit);
  } else {
    const col = req.sort === 'most_viewed' ? 'i.views DESC' : 'i.first_seen_at DESC';
    pageIds = time('candidates', () => db.selectValues(`SELECT i.id FROM items_fts JOIN items i ON i.id = items_fts.rowid WHERE items_fts MATCH ?1 ORDER BY ${col} LIMIT ?2`, [full, req.limit]).map(Number));
    candIds = pageIds;
  }

  // ---- totals and per-chip counts
  const total = time('total', () => opts.cappedTotal
    ? Number(db.selectValue('SELECT count(*) FROM (SELECT 1 FROM items_fts WHERE items_fts MATCH ?1 LIMIT 10001)', [full]))
    : Number(db.selectValue('SELECT count(*) FROM items_fts WHERE items_fts MATCH ?1', [full])));
  const chipCounts = plans.length === 1
    ? [total]
    : time('chipCounts', () => plans.map((p) => Number(db.selectValue('SELECT count(*) FROM items_fts WHERE items_fts MATCH ?1', [p.expr]))));

  // ---- hydrate page rows
  time('hydrate', () => hydrate(db, pageIds));

  // ---- facets over the candidate set (suggested chips)
  time('facets', () => {
    const j = JSON.stringify(candIds);
    db.selectArrays('SELECT h.tag, count(*) c FROM item_hashtags ih JOIN hashtags h ON h.id = ih.hashtag_id WHERE ih.item_id IN (SELECT value FROM json_each(?1)) GROUP BY ih.hashtag_id ORDER BY c DESC LIMIT 8', [j]);
    db.selectArrays('SELECT ic.collection_id, count(*) c FROM item_collections ic WHERE ic.item_id IN (SELECT value FROM json_each(?1)) GROUP BY ic.collection_id ORDER BY c DESC LIMIT 5', [j]);
    db.selectArrays('SELECT author_handle, count(*) c FROM items WHERE id IN (SELECT value FROM json_each(?1)) GROUP BY author_handle ORDER BY c DESC LIMIT 5', [j]);
  });

  // ---- attribution for the page rows: which chips matched directly vs only via related terms
  if (opts.attribution !== 'none') {
    time('attribution', () => {
      for (const p of plans) {
        if (opts.attribution === 'rowid-eq') {
          for (const id of pageIds) {
            const d = db.selectValue('SELECT 1 FROM items_fts WHERE items_fts MATCH ?1 AND rowid = ?2', [p.directExpr, id]);
            if (!d && p.related.length) db.selectValue('SELECT 1 FROM items_fts WHERE items_fts MATCH ?1 AND rowid = ?2', [p.expr, id]);
          }
        } else {
          const j = JSON.stringify(pageIds);
          db.selectValues('SELECT rowid FROM items_fts WHERE items_fts MATCH ?1 AND rowid IN (SELECT value FROM json_each(?2))', [p.directExpr, j]);
          if (p.related.length) db.selectValues('SELECT rowid FROM items_fts WHERE items_fts MATCH ?1 AND rowid IN (SELECT value FROM json_each(?2))', [p.expr, j]);
        }
      }
    });
  }
  return { total, page: pageIds.length, chipCounts, timings: rounded(T), firstIds: pageIds.slice(0, 5) };
}

function hydrate(db: Database, ids: number[]): void {
  const j = JSON.stringify(ids);
  db.selectObjects('SELECT * FROM items WHERE id IN (SELECT value FROM json_each(?1))', [j]);
  db.selectArrays('SELECT ic.item_id, c.name FROM item_collections ic JOIN collections c ON c.id = ic.collection_id WHERE ic.item_id IN (SELECT value FROM json_each(?1))', [j]);
  db.selectArrays('SELECT ih.item_id, h.tag FROM item_hashtags ih JOIN hashtags h ON h.id = ih.hashtag_id WHERE ih.item_id IN (SELECT value FROM json_each(?1))', [j]);
}

const rounded = (t: Record<string, number>) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, r2(v)]));

// ---------------------------------------------------------------- workloads

export interface Workload { id: string; label: string; req: SearchReq }
const c = (text: string, expand = true): Chip => ({ text, expand });
export const WORKLOADS: Workload[] = [
  { id: 'W01', label: '1 chip: "food" (+related)', req: { chips: [c('food')], mode: 'all', sort: 'relevance', limit: 30 } },
  { id: 'W02', label: '2 chips AND: food + easy', req: { chips: [c('food'), c('easy')], mode: 'all', sort: 'relevance', limit: 30 } },
  { id: 'W03', label: '5 chips AND: food dinner easy quick chicken', req: { chips: [c('food'), c('dinner'), c('easy'), c('quick'), c('chicken')], mode: 'all', sort: 'relevance', limit: 30 } },
  { id: 'W04', label: '4 chips ANY: makeup skincare hair fashion', req: { chips: [c('makeup'), c('skincare'), c('hair'), c('fashion')], mode: 'any', sort: 'relevance', limit: 30 } },
  { id: 'W05', label: '5 chips ANY (broad): food makeup fitness travel fashion', req: { chips: [c('food'), c('makeup'), c('fitness'), c('travel'), c('fashion')], mode: 'any', sort: 'relevance', limit: 30 } },
  { id: 'W06', label: 'rare term: "airfryer"', req: { chips: [c('airfryer')], mode: 'all', sort: 'relevance', limit: 30 } },
  { id: 'W07', label: 'ubiquitous term: "fyp"', req: { chips: [c('fyp')], mode: 'all', sort: 'relevance', limit: 30 } },
  { id: 'W08', label: 'collection-name chip: "recipes"', req: { chips: [c('recipes')], mode: 'all', sort: 'relevance', limit: 30 } },
  { id: 'W09', label: 'multiword chip: "meal prep"', req: { chips: [c('meal prep')], mode: 'all', sort: 'relevance', limit: 30 } },
  { id: 'W10', label: 'sort by views: food', req: { chips: [c('food')], mode: 'all', sort: 'most_viewed', limit: 30 } },
  { id: 'W11', label: 'sort recently saved: food + easy', req: { chips: [c('food'), c('easy')], mode: 'all', sort: 'recently_saved', limit: 30 } },
  { id: 'W12', label: 'no chips: browse all (recently saved)', req: { chips: [], mode: 'all', sort: 'recently_saved', limit: 30 } },
  { id: 'W13', label: 'zero-result chip: "makup" (typo)', req: { chips: [c('makup')], mode: 'all', sort: 'relevance', limit: 30 } },
  { id: 'W14', label: 'prefix: single letter-pair "fo"', req: { chips: [c('fo', false)], mode: 'all', sort: 'relevance', limit: 30 } },
];

export interface WorkloadReport { id: string; label: string; total: number; page: number; chipCounts: number[]; ms: Stat; meanComponentsMs: Record<string, number> }

export function benchWorkloads(db: Database, runs: number, opts: Parameters<typeof runSearch>[2] = { attribution: 'rowid-eq' }, subset?: string[]): WorkloadReport[] {
  const out: WorkloadReport[] = [];
  for (const w of WORKLOADS) {
    if (subset && !subset.includes(w.id)) continue;
    for (let i = 0; i < 3; i++) runSearch(db, w.req, opts); // warmup
    const totals: number[] = [];
    const comp: Record<string, number> = {};
    let last: SearchOut | undefined;
    for (let i = 0; i < runs; i++) {
      const t = now();
      last = runSearch(db, w.req, opts);
      totals.push(now() - t);
      for (const [k, v] of Object.entries(last.timings)) comp[k] = (comp[k] ?? 0) + v / runs;
    }
    out.push({ id: w.id, label: w.label, total: last!.total, page: last!.page, chipCounts: last!.chipCounts, ms: stat(totals), meanComponentsMs: rounded(comp) });
  }
  return out;
}

// ---------------------------------------------------------------- search v2: tiered + deferred work

export interface SearchV2Opts { candidates?: number; cappedTotal?: boolean; chipCounts?: boolean; explainRows?: number }

/** Attribution for a set of rows: per chip, matched by its own words ('direct'), only via related terms, or not at all. */
export function explainRows(db: Database, plans: ChipPlan[], ids: number[]): void {
  for (const id of ids) {
    for (const p of plans) {
      const d = db.selectValue('SELECT 1 FROM items_fts WHERE items_fts MATCH ?1 AND rowid = ?2', [p.directExpr, id]);
      if (!d && p.related.length) db.selectValue('SELECT 1 FROM items_fts WHERE items_fts MATCH ?1 AND rowid = ?2', [p.expr, id]);
    }
  }
}

/**
 * Tiered pipeline:
 *   tier 1 = videos whose OWN words match the chips (cheap: few terms, small doclists)
 *   tier 2 = videos matching only via related terms, via FTS5's `(full) NOT (direct)`; only queried to fill the page
 * so the FTS pass over the big related-term expression is bounded by what is actually needed.
 * chipCounts and attribution are optional so callers can defer them off the first-paint path.
 */
export function runSearchV2(db: Database, req: SearchReq, opts: SearchV2Opts = {}): SearchOut {
  const T: Record<string, number> = {};
  const time = <R>(k: string, f: () => R): R => { const t = now(); const r = f(); T[k] = (T[k] ?? 0) + (now() - t); return r; };
  const plans = planChips(req.chips);
  if (plans.length === 0) return runSearch(db, req, { attribution: 'none' });
  const candLimit = opts.candidates ?? 300;
  const full = combine(plans.map((p) => p.expr), req.mode);
  const direct = combine(plans.map((p) => p.directExpr), req.mode);
  const hasRelated = plans.some((p) => p.related.length > 0);

  let candIds: number[];
  let pageIds: number[];
  if (req.sort === 'relevance') {
    candIds = time('tier1', () => db.selectValues(`SELECT rowid FROM items_fts WHERE items_fts MATCH ?1 ORDER BY bm25(items_fts, ${W}) LIMIT ?2`, [direct, candLimit]).map(Number));
    if (candIds.length < candLimit && hasRelated) {
      const more = time('tier2', () => db.selectValues(`SELECT rowid FROM items_fts WHERE items_fts MATCH ?1 ORDER BY bm25(items_fts, ${W}) LIMIT ?2`, [`(${full}) NOT (${direct})`, candLimit - candIds.length]).map(Number));
      candIds = candIds.concat(more);
    }
    pageIds = candIds.slice(0, req.limit);
  } else {
    const col = req.sort === 'most_viewed' ? 'i.views DESC' : 'i.first_seen_at DESC';
    pageIds = time('candidates', () => db.selectValues(`SELECT i.id FROM items_fts JOIN items i ON i.id = items_fts.rowid WHERE items_fts MATCH ?1 ORDER BY ${col} LIMIT ?2`, [full, req.limit]).map(Number));
    candIds = pageIds;
  }
  const total = time('total', () => opts.cappedTotal
    ? Number(db.selectValue('SELECT count(*) FROM (SELECT 1 FROM items_fts WHERE items_fts MATCH ?1 LIMIT 10001)', [full]))
    : Number(db.selectValue('SELECT count(*) FROM items_fts WHERE items_fts MATCH ?1', [full])));
  time('hydrate', () => hydrate(db, pageIds));
  time('facets', () => {
    const j = JSON.stringify(candIds);
    db.selectArrays('SELECT h.tag, count(*) c FROM item_hashtags ih JOIN hashtags h ON h.id = ih.hashtag_id WHERE ih.item_id IN (SELECT value FROM json_each(?1)) GROUP BY ih.hashtag_id ORDER BY c DESC LIMIT 8', [j]);
    db.selectArrays('SELECT ic.collection_id, count(*) c FROM item_collections ic WHERE ic.item_id IN (SELECT value FROM json_each(?1)) GROUP BY ic.collection_id ORDER BY c DESC LIMIT 5', [j]);
    db.selectArrays('SELECT author_handle, count(*) c FROM items WHERE id IN (SELECT value FROM json_each(?1)) GROUP BY author_handle ORDER BY c DESC LIMIT 5', [j]);
  });
  let chipCounts: number[] = [];
  if (opts.chipCounts) {
    chipCounts = plans.length === 1 ? [total] : time('chipCounts', () => plans.map((p) => Number(db.selectValue('SELECT count(*) FROM items_fts WHERE items_fts MATCH ?1', [p.expr]))));
  }
  if (opts.explainRows) time('explain', () => explainRows(db, plans, pageIds.slice(0, opts.explainRows)));
  return { total, page: pageIds.length, chipCounts, timings: rounded(T), firstIds: pageIds.slice(0, 5) };
}

export interface CompareRow { id: string; label: string; total: number; v1: Stat; v2Fast: Stat; v2Capped: Stat; v2Expand30Capped: Stat; v2Components: Record<string, number>; v2ChipCounts: Stat | null; v2Explain1: Stat | null; v2Explain30: Stat | null; firstPageAgreement: string }

export function benchCompare(db: Database, runs: number): CompareRow[] {
  const out: CompareRow[] = [];
  const timeIt = (f: () => unknown): Stat => {
    for (let i = 0; i < 3; i++) f();
    const s: number[] = [];
    for (let i = 0; i < runs; i++) { const t = now(); f(); s.push(now() - t); }
    return stat(s);
  };
  for (const w of WORKLOADS) {
    const plans = planChips(w.req.chips);
    const v1 = timeIt(() => runSearch(db, w.req, { attribution: 'rowid-eq' }));
    const v2Fast = timeIt(() => runSearchV2(db, w.req));
    const v2Capped = timeIt(() => runSearchV2(db, w.req, { cappedTotal: true }));
    setExpandTarget(30);
    const v2Expand30Capped = timeIt(() => runSearchV2(db, w.req, { cappedTotal: true }));
    setExpandTarget(0);
    const probe = runSearchV2(db, w.req);
    const probeV1 = runSearch(db, w.req, { attribution: 'none' });
    const overlap = probe.firstIds.filter((x) => probeV1.firstIds.includes(x)).length;
    const comp: Record<string, number> = {};
    for (let i = 0; i < runs; i++) for (const [k, v] of Object.entries(runSearchV2(db, w.req).timings)) comp[k] = (comp[k] ?? 0) + v / runs;
    const hasChips = plans.length > 0;
    out.push({
      id: w.id, label: w.label, total: probe.total, v1, v2Fast, v2Capped, v2Expand30Capped, v2Components: rounded(comp),
      v2ChipCounts: hasChips ? timeIt(() => runSearchV2(db, w.req, { chipCounts: true })) : null,
      v2Explain1: hasChips ? timeIt(() => runSearchV2(db, w.req, { explainRows: 1 })) : null,
      v2Explain30: hasChips ? timeIt(() => runSearchV2(db, w.req, { explainRows: 30 })) : null,
      firstPageAgreement: `${overlap}/${Math.min(5, probe.firstIds.length)} of first 5 ids agree with v1`,
    });
  }
  return out;
}

export async function runBenchOnly(o: OpenResult & { installAttempts: number }, runs: number): Promise<Record<string, unknown>> {
  const db = new o.poolUtil.OpfsSAHPoolDb('/scroganize.db');
  applyPragmas(db, VARIANTS['C']!);
  const rows = Number(db.selectValue('SELECT count(*) FROM items'));
  const compare = benchCompare(db, runs);
  db.close();
  return { rows, compare };
}

// ---------------------------------------------------------------- did-you-mean micro-benchmark

function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

export function didYouMeanBench(vocabSize: number): { vocabSize: number; ms: Stat; example: string | null } {
  const vocab: string[] = [...CATEGORIES.flatMap((c) => [...c.core, ...c.related, ...c.tags])];
  let s = 12345;
  const rnd = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
  while (vocab.length < vocabSize) vocab.push(Array.from({ length: 4 + Math.floor(rnd() * 9) }, () => String.fromCharCode(97 + Math.floor(rnd() * 26))).join(''));
  const samples: number[] = [];
  let example: string | null = null;
  for (let i = 0; i < 20; i++) {
    const t = now();
    let best: string | null = null, bestD = 3;
    for (const v of vocab) { const d = editDistance('makup', v, 2); if (d < bestD) { bestD = d; best = v; } }
    samples.push(now() - t);
    example = best;
  }
  return { vocabSize, ms: stat(samples), example };
}

// ---------------------------------------------------------------- the full spike

export interface SpikeOptions { items: number; variantItems: number; seed: number; runs: number; batchSize: number; mainVariant: string }
export const DEFAULT_OPTIONS: SpikeOptions = { items: 50000, variantItems: 15000, seed: 1337, runs: 25, batchSize: 1000, mainVariant: 'C' };

export const VARIANTS: Record<string, VariantSpec> = {
  A: { name: 'A: defaults (journal=DELETE, sync=FULL)', pragmasBeforeSchema: [], pragmasAfterOpen: [] },
  B: { name: 'B: journal=TRUNCATE, sync=NORMAL', pragmasBeforeSchema: [], pragmasAfterOpen: ['journal_mode=TRUNCATE', 'synchronous=NORMAL'] },
  C: { name: 'C: journal=TRUNCATE, sync=NORMAL, exclusive lock, 64MB cache, temp in memory', pragmasBeforeSchema: [], pragmasAfterOpen: ['journal_mode=TRUNCATE', 'synchronous=NORMAL', 'locking_mode=EXCLUSIVE', 'cache_size=-65536', 'temp_store=MEMORY'] },
  D: { name: 'D: C + journal_mode=MEMORY (crash-unsafe reference)', pragmasBeforeSchema: [], pragmasAfterOpen: ['journal_mode=MEMORY', 'synchronous=NORMAL', 'locking_mode=EXCLUSIVE', 'cache_size=-65536', 'temp_store=MEMORY'] },
  E: { name: 'E: C + page_size=8192', pragmasBeforeSchema: ['page_size=8192'], pragmasAfterOpen: ['journal_mode=TRUNCATE', 'synchronous=NORMAL', 'locking_mode=EXCLUSIVE', 'cache_size=-65536', 'temp_store=MEMORY'] },
  F: { name: 'F: C + page_size=16384', pragmasBeforeSchema: ['page_size=16384'], pragmasAfterOpen: ['journal_mode=TRUNCATE', 'synchronous=NORMAL', 'locking_mode=EXCLUSIVE', 'cache_size=-65536', 'temp_store=MEMORY'] },
};

export function applyPragmas(db: Database, v: VariantSpec): void {
  for (const p of v.pragmasBeforeSchema) db.exec(`PRAGMA ${p}`);
  for (const p of v.pragmasAfterOpen) db.exec(`PRAGMA ${p}`);
}

export async function runFullSpike(o: OpenResult, opts: SpikeOptions, log: (m: string) => void): Promise<Record<string, unknown>> {
  const { poolUtil } = o;
  const report: Record<string, unknown> = { options: opts, open: o.timings };
  await poolUtil.wipeFiles();

  const tGen = now();
  const lib = generateLibrary(opts.items, opts.seed);
  report.generateMs = r2(now() - tGen);
  log(`generated ${lib.items.length} items`);

  // ---- pragma / page-size variants: same ingest workload, different settings
  const variantReports: Record<string, unknown>[] = [];
  const small: SynthLibrary = { items: lib.items.slice(0, opts.variantItems), collections: lib.collections };
  for (const key of Object.keys(VARIANTS)) {
    const v = VARIANTS[key]!;
    const db = new poolUtil.OpfsSAHPoolDb('/variant.db');
    try {
      applyPragmas(db, v);
      const schema = createSchema(db, 'contentless-delete');
      const ing = ingestAll(db, small, 'contentless-delete', opts.batchSize, 1);
      variantReports.push({ variant: v.name, itemsPerSec: ing.itemsPerSec, ingestMs: ing.ms, size: dbSizes(db), trigram: schema.trigram });
      log(`variant ${key}: ${ing.itemsPerSec} items/s`);
    } catch (e) {
      variantReports.push({ variant: v.name, error: String(e) });
    } finally {
      db.close();
      poolUtil.unlink('/variant.db');
      poolUtil.unlink('/variant.db-journal');
    }
  }
  report.variants = variantReports;

  // ---- schema matrix: what do the trigram table and the url/raw_json columns cost?
  const matrix: Record<string, unknown>[] = [];
  for (const [label, tri, lean] of [['trigram + full columns', 'contentless-delete', false], ['no trigram + full columns', 'none', false], ['no trigram + lean (no url/raw_json)', 'none', true], ['trigram + lean', 'contentless-delete', true]] as const) {
    const m = new poolUtil.OpfsSAHPoolDb('/variant.db');
    applyPragmas(m, VARIANTS[opts.mainVariant]!);
    createSchema(m, tri);
    const a = ingestAll(m, small, tri, opts.batchSize, 1, undefined, undefined, lean);
    matrix.push({ label, itemsPerSec: a.itemsPerSec, totalMB: (dbSizes(m) as { totalMB: number }).totalMB, bytesPerItem: Math.round(((dbSizes(m) as { totalMB: number }).totalMB * 1048576) / small.items.length) });
    m.close();
    poolUtil.unlink('/variant.db');
    poolUtil.unlink('/variant.db-journal');
    log(`schema matrix: ${label}`);
  }
  report.schemaMatrix = matrix;

  // ---- main DB at full size
  const v = VARIANTS[opts.mainVariant]!;
  const db = new poolUtil.OpfsSAHPoolDb('/scroganize.db');
  applyPragmas(db, v);
  const schema = createSchema(db, 'contentless-delete');
  report.schema = schema;
  report.environment = environment(db);
  report.mainVariant = v.name;

  const ingestNew = ingestAll(db, lib, 'contentless-delete', opts.batchSize, 1);
  report.ingestNew = ingestNew;
  log(`ingest new: ${ingestNew.itemsPerSec} items/s`);
  report.sizeAfterIngest = dbSizes(db);
  report.rowCounts = Object.fromEntries(['items', 'collections', 'item_collections', 'hashtags', 'item_hashtags'].map((t) => [t, Number(db.selectValue(`SELECT count(*) FROM ${t}`))]));

  // ---- pre-optimize query sample (FTS5 segment count effect)
  report.queriesPreOptimize = benchWorkloads(db, 15, { attribution: 'rowid-eq' }, ['W01', 'W03', 'W07']);
  const tOpt = now();
  db.exec("INSERT INTO items_fts (items_fts) VALUES ('optimize')");
  report.ftsOptimizeMs = r2(now() - tOpt);
  log(`fts optimize ${report.ftsOptimizeMs} ms`);
  report.sizeAfterOptimize = dbSizes(db);

  // ---- re-sync paths
  report.resyncUnchanged = ingestAll(db, lib, 'contentless-delete', opts.batchSize, 2);
  const changedCount = 5000;
  report.resyncTextChanged = ingestAll(db, lib, 'contentless-delete', opts.batchSize, 3, (it) => ({ ...it, caption: it.caption + ' edited' }), changedCount);
  log(`resync unchanged: ${(report.resyncUnchanged as { itemsPerSec: number }).itemsPerSec} items/s`);

  // ---- query workloads: full pipeline per search
  report.queries = benchWorkloads(db, opts.runs, { attribution: 'rowid-eq' });
  report.queriesAttributionJsonIn = benchWorkloads(db, opts.runs, { attribution: 'json-in' }, ['W01', 'W03', 'W05']);
  report.queriesNoAttribution = benchWorkloads(db, opts.runs, { attribution: 'none' }, ['W01', 'W03', 'W05', 'W07']);
  report.queriesCappedTotal = benchWorkloads(db, opts.runs, { attribution: 'rowid-eq', cappedTotal: true }, ['W01', 'W05', 'W07']);
  report.queriesCandidates100 = benchWorkloads(db, opts.runs, { attribution: 'rowid-eq', candidates: 100 }, ['W01', 'W03', 'W05', 'W07']);

  // ---- trigram (CJK fallback) queries
  const triSamples: Record<string, unknown> = {};
  for (const q of ['レシピ', 'メイク', '筋トレ', 'receta']) {
    const times: number[] = [];
    let hits = 0;
    for (let i = 0; i < 15; i++) {
      const t = now();
      hits = db.selectValues('SELECT rowid FROM items_tri WHERE items_tri MATCH ?1 LIMIT 30', [`"${q}"`]).length;
      times.push(now() - t);
    }
    triSamples[q] = { hitsFirstPage: hits, ms: stat(times) };
  }
  // 2-char CJK: cannot be served by trigram, and unicode61 treats a CJK run as one token
  triSamples['簡単 via FTS5 prefix'] = { hits: Number(db.selectValue('SELECT count(*) FROM items_fts WHERE items_fts MATCH \'"簡単"*\'')) };
  triSamples['レシピ via FTS5 (mid-token)'] = { hits: Number(db.selectValue('SELECT count(*) FROM items_fts WHERE items_fts MATCH \'"レシピ"*\'')) };
  triSamples['emoji 🍝 via FTS5'] = { hits: Number(db.selectValue('SELECT count(*) FROM items_fts WHERE items_fts MATCH ?1', ['"🍝"'])) };
  report.cjkAndEmoji = triSamples;

  // ---- LIKE-scan fallback: can it replace the trigram table for CJK / emoji / 1-2 char substrings?
  const likeReport: Record<string, unknown> = {};
  for (const q of ['レシピ', '簡単', '🍝', 'メイク']) {
    const times: number[] = [], countTimes: number[] = [];
    let hits = 0, total = 0;
    for (let i = 0; i < 10; i++) {
      let t = now();
      hits = db.selectValues('SELECT id FROM items WHERE caption LIKE ?1 LIMIT 30', ['%' + q + '%']).length;
      times.push(now() - t);
      t = now();
      total = Number(db.selectValue('SELECT count(*) FROM items WHERE caption LIKE ?1', ['%' + q + '%']));
      countTimes.push(now() - t);
    }
    likeReport[q] = { hitsFirstPage: hits, total, firstPageMs: stat(times), countMs: stat(countTimes) };
  }
  // mixed chips: FTS chip AND a substring chip in one statement
  {
    const times: number[] = [];
    let total = 0;
    const fullExpr = planChips([{ text: 'food', expand: true }])[0]!.expr;
    for (let i = 0; i < 10; i++) {
      const t = now();
      total = Number(db.selectValue('SELECT count(*) FROM items WHERE id IN (SELECT rowid FROM items_fts WHERE items_fts MATCH ?1) AND caption LIKE ?2', [fullExpr, '%レシピ%']));
      times.push(now() - t);
    }
    likeReport['food (FTS) AND レシピ (LIKE)'] = { total, ms: stat(times) };
  }
  report.likeFallback = likeReport;

  report.didYouMean = [didYouMeanBench(5000), didYouMeanBench(50000)];

  // ---- export (backup) cost
  db.close();
  const tExp = now();
  const bytes = await poolUtil.exportFile('/scroganize.db');
  report.export = { ms: r2(now() - tExp), sizeMB: r2(bytes.byteLength / 1048576) };
  report.poolCapacity = poolUtil.getCapacity();
  report.poolFiles = poolUtil.getFileNames();
  return report;
}

/** Cold-open phase: run in a FRESH worker to model "browser restarted / offscreen doc recreated". */
export async function runReopen(o: OpenResult & { installAttempts: number; waitedMs: number }, runs: number): Promise<Record<string, unknown>> {
  const t0 = now();
  const db = new o.poolUtil.OpfsSAHPoolDb('/scroganize.db');
  applyPragmas(db, VARIANTS['C']!);
  const openMs = now() - t0;
  const tFirst = now();
  const count = Number(db.selectValue('SELECT count(*) FROM items'));
  const first = runSearch(db, WORKLOADS[0]!.req, { attribution: 'rowid-eq' });
  const firstQueryMs = now() - tFirst;
  const second = benchWorkloads(db, runs, { attribution: 'rowid-eq' }, ['W01', 'W03']);
  const integrity = db.selectValue('PRAGMA quick_check');
  db.close();
  return { wasmInitMs: o.timings.wasmInitMs, vfsInstallMs: o.timings.vfsInstallMs, installAttempts: o.installAttempts, waitedForHandlesMs: o.waitedMs, dbOpenMs: r2(openMs), rowsAfterReopen: count, firstQueryMs: r2(firstQueryMs), firstQueryTotal: first.total, warmSample: second, quickCheck: integrity };
}
