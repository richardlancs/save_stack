# M0 storage spike: SQLite-WASM + OPFS + FTS5

**Verdict: viable, with changes to the query pipeline and schema (below).** The stack works end to end inside a real MV3 extension: service worker → offscreen document → dedicated Worker → OPFS (`opfs-sahpool`) → FTS5. The naive query pipeline does *not* meet the 50 ms budget for multi-chip ANY searches (266 to 479 ms). A tiered pipeline with deferred work does for 12 of 14 workloads; the two exceptions are ANY over 4 to 5 broad chips (48 to 73 ms p95), see §4.

Reproduce: the spike wiring was removed from the production entrypoints in M1. Check out git tag `m0-spike`, then `npx wxt build && node bench/run-spike.mjs` (full run, ~2 min), or `PROFILE_DIR=bench/.tmp/profile` once and then `MODE=bench PROFILE_DIR=bench/.tmp/profile node bench/run-spike.mjs` for query-only runs. Raw results: `bench/results/`. The query shapes it measured are the starting point for M2 (`bench/spike-core.ts`, `runSearchV2`).

## 1. Setup and caveats (read before trusting any number)

- **Data is synthetic:** 50,000 videos, seed 1337, Zipf authors, ~8.3k distinct hashtags plus a long tail of rare words, 20 collections, 66.6k memberships, ~5% Japanese/Spanish/Portuguese captions, emoji. 40% of captions never contain their category word (the case related-terms exist for). Real captions may be longer and more varied.
- **Machine:** Windows 11, 16 logical cores, Chromium 153 (Playwright, new headless), SQLite 3.53.4 (`THREADSAFE=0`, FTS5 and DBSTAT compiled in).
- **Noise is large.** Repeat runs on the same build moved individual workloads by 30 to 80%. Treat numbers within ~30% of a budget as "borderline", not "pass".
- The spike lexicon has 15 categories with ≤14 related terms. A separate 30-term-expansion stress run (the design cap) is reported in §4.

## 2. Ingest, size, and durability

| Metric | Result | Budget |
|---|---|---|
| Ingest, 50k, full schema incl. trigram table | **2,616 and 1,816 items/s** (two runs) | ≥ 2,000 (borderline) |
| Ingest, 15k, no trigram, full columns | 3,984 items/s | ≥ 2,000 ✓ |
| Ingest, 15k, no trigram, lean columns | 4,331 items/s | ✓ |
| Re-sync, 50k unchanged | 14k to 20k items/s (2.5 to 3.6 s) | "near-free" ✓ |
| Re-sync with FTS reindex (5k changed captions) | 3,375 items/s | n/a |
| DB size, 50k, trigram + full columns | **96.6 MB** (~1.9 KB/item) | n/a |
| DB size, 15k: trigram+full / no-trigram+full / no-trigram+lean | 29.3 / 23.1 / 17.2 MB (2,045 / 1,618 / 1,202 B/item) | n/a |
| Cold start (fresh worker → first result, 50k) | wasm init 47 ms + VFS install 20 ms + DB open 3 ms + first query 50 ms ≈ **120 ms** | < 300 ms ✓ |
| Persistence across worker termination | 50,000 rows intact, `PRAGMA quick_check` = ok | ✓ |
| Second concurrent owner | **rejected in ~40 ms**: "Access Handles cannot be created if there is another open Access Handle" | (single-owner model confirmed) |
| Raw DB export | 117 MB in 66 ms (`poolUtil.exportFile`) | n/a |
| Bundle | 1.36 MB total (0.87 MB is the wasm; 0.49 MB JS incl. ~245 KB of unused sqlite worker helpers we can trim) | < 3 MB excl. wasm ✓ |

Size breakdown at 50k (MB): `items` 35.8, trigram index 19.0, FTS data 16.3, FTS content 10.9, all secondary indexes ≈ 9.

**Pragmas do not matter here.** Six variants (journal DELETE/TRUNCATE/MEMORY, synchronous FULL/NORMAL, exclusive locking, 64 MB cache, page size) all landed between 2.5k and 2.8k items/s at 15k rows. This build's default page size is already 8192. Choose the *safe* set: default page size, `journal_mode=TRUNCATE` (avoids create/delete churn in the fixed-slot pool), `synchronous=NORMAL`, `temp_store=MEMORY`, `cache_size≈-32768`. Do not use `journal_mode=MEMORY`/`OFF`: no measurable gain, real corruption risk on a crash.

**Findings that are not performance:**
1. MV3's default CSP blocks WebAssembly. The manifest needs `'wasm-unsafe-eval'` on `extension_pages` (done in `wxt.config.ts`).
2. `opfs-sahpool` needs no COOP/COEP headers and no SharedArrayBuffer.
3. The pool is exclusive: exactly one live owner. The M1 design needs a singleton offscreen document and, on startup, a bounded retry (25 ms polling worked; the terminated worker's handles were free on the first attempt).
4. A contentful FTS5 table is required because `hashtags` and `collections` are derived columns. External-content FTS would need denormalized copies on `items`.

## 3. Proposed schema changes for M1 (need your OK; `schema.sql` is unchanged so the spike stays reproducible)

1. **Drop the trigram table.** It costs ~20% of DB size and ~30% of ingest speed (2,718 → 3,984 items/s at 15k). A plain `LIKE '%…%'` scan over `items.caption` covers what it was for: first page 2 to 3 ms, exact count ~20 ms at 50k, and it also handles **2-character CJK (`簡単`) and emoji (`🍝`)**, which trigrams cannot. FTS5's unicode61 can't do those at all: a CJK run is one token, so mid-token matches fail (`レシピ` in `簡単レシピ` → 0 hits) and emoji index to nothing. *Rule:* any chip containing characters unicode61 can't tokenize (CJK/kana/hangul/emoji/symbols) additionally matches by substring; mixing FTS and LIKE chips in one query measured 13 ms.
2. **Drop `items.url`.** It is derivable (`adapter.canonicalUrl`) and costs ~90 bytes/row.
3. **Make `raw_json` opt-in (NULL by default).** ~300 bytes/row, and mostly duplicates columns. Items 1–3 take the DB from ~1.9 KB to ~1.2 KB per item (**≈ 60 MB at 50k** vs 97 MB).
4. **Keep** the integer surrogate `items.id` (= FTS rowid) with `UNIQUE(platform, external_id)`, contentful `items_fts` with prefix indexes, the `hashtags`/`item_hashtags` tables (used for suggested chips and did-you-mean), `content_hash` (skips FTS work on unchanged re-syncs), and `item_collections.position`.
5. *Open question for M0's TikTok half:* `position` is only comparable *within* a collection, so "recently saved" across all collections needs a real saved-at from TikTok or a normalized rank. See `TIKTOK_FINDINGS.md`.

## 4. Search latency (50k items; **p95 ms**, shown as the range across two full runs on the same build)

Run-to-run spread on this machine was up to 1.8x (5 broad chips ANY: V1 266 to 479 ms, V2 34 to 60 ms), so ranges are shown instead of a single "best" number. Medians and every raw sample are in `bench/results/bench-*.json`.

**V1** = the pipeline as the brief describes it: one bm25-ranked FTS pass over the *full* related-term expression, a second pass to tier direct matches, exact total, per-chip counts, facets, and per-row/per-chip attribution.
**V2** = tiered: tier 1 ranks videos whose *own* words match (small expression); tier 2 (`(full) NOT (direct)`, FTS5's set difference) is queried only to fill the page; total capped at 10,001; per-chip counts and attribution moved off the critical path.

| Workload | matches | V1 | V2 (capped total) | V2 + 30-term expansion (1 run) |
|---|---|---|---|---|
| 1 chip "food" (+related) | 11,211 | 32 to 37 | 19 to 20 | 17 |
| 2 chips AND | 851 | **41 to 53** | 17 to 20 | 21 |
| 5 chips AND | 8 | **49 to 51** | 30 to 34 | 37 |
| 4 chips ANY | 18,731 | **327 to 339** | 48 to 49 | **59** |
| 5 broad chips ANY | 31,367 | **266 to 479** | 34 to **60** | **73** |
| rare term "airfryer" | 2,481 | 15 to 22 | 7 to 19 | 13 |
| ubiquitous term "fyp" | 6,741 | 12 to 29 | 12 to 18 | 16 |
| collection-name chip "recipes" | 9,497 | 30 to **57** | 15 to 25 | 22 |
| multiword chip "meal prep" | 3,183 | 13 to 32 | 8 to 15 | 16 |
| prefix "fo" | 19,443 | 47 | 33 to 35 | 32 |
| sort by views ("food") | 11,211 | 37 to **53** | 21 to 28 | 39 |
| sort recently saved (2 chips) | 851 | 24 to 30 | 15 to 17 | 28 |
| no chips (browse all) | 50,000 | 3 to 5 | 4 to 5 | 5 |
| zero-result typo chip | 0 | ≤ 1 | ≤ 1 | ≤ 1 |

**Scorecard against "search p95 < 50 ms for up to 5 chips with expansion":**
- **V1 fails or sits at the limit** on 6 of 14 workloads, and is 5 to 10x over budget for ANY-mode multi-chip searches.
- **V2 meets it for 12 of 14 workloads in both runs.** The exceptions are ANY over 4 to 5 broad chips: 48 to 60 ms p95 with the spike's 14-term expansions and up to 73 ms with 30-term expansions. That case matches 37 to 63% of the whole library (each chip a broad category), so relevance ranking is nearly meaningless there anyway. *Proposed M2 mitigation, untested and a product decision:* when the capped count hits 10,001, skip bm25 and order by recency, and tell the user to add chips to narrow.

**Costs that must stay off the first-paint path:**
- **Per-row, per-chip attribution in SQL is unaffordable in ANY mode:** ~1 ms per (row, chip) check for broad chips → 130 to 290 ms for a 30-row page; single-row "why matched" is 6 to 20 ms. → Compute attribution **lazily** (`explain(itemId, chips)` for the row being expanded), or in JS with a Porter stemmer verified against FTS in tests.
- **Per-chip counts** cost +5 to 20 ms (one count per chip). → Return them from a **second, follow-up call** so results paint first, and chip badges (`food · 212`) fill in a moment later.
- **Exact totals** cost up to 25 ms on broad matches. → Cap at 10,001 ("10,000+").
- **V2 ranks differently from V1 by design** (own-word matches ranked among themselves first), so first-page ids do not agree; M2's labeled precision tests define "correct", not V1 parity.
- Skip tier 2 when the (cheap) capped total already equals the tier-1 count. Otherwise a 5-chip AND with 8 matches still pays ~14 ms for an empty tier 2.

## 5. Two planner details M2 must include

1. **Multiword chips also match the concatenated hashtag.** Hashtags are usually one token (`#mealprep`), so "meal prep" must become `((meal AND prep*) OR "mealprep"*)`. Without it, the synthetic `meal prep` chip returned 0 results; with it, 3,183.
2. **Did-you-mean is not a trigram job.** Typos (`makup` → `makeup`) can't be recovered by trigram phrase queries (they need all trigrams). Edit distance over hashtags + authors + collection names + lexicon keys took 8 ms p50 / 12 ms p95 for a 50k-term vocabulary and 1 ms for 5k, well within budget, and only runs on zero-result chips.

## 6. What this changes in the brief

| Brief said | Spike says |
|---|---|
| Trigram FTS table for CJK/emoji/typos (§4, §6.5) | Drop it. LIKE fallback for CJK/emoji, edit-distance for typos. |
| `SearchResponse` includes `chipInfo` and per-result `matches` (§6.1) | Split: fast `search`, then follow-up `chipInfo`; `matches` via lazy `explain`. |
| `items.url`, `raw_json` columns (§4) | Drop `url`; `raw_json` opt-in. |
| Pragma tuning "document what you chose" (§4) | Done: safe set above; no exotic settings needed. |
| Ingest ≥ 2,000 items/s | Met, but only with margin once the trigram table is gone (~4k/s). |
