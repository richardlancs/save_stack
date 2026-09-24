# Search performance (M2)

Measured with `npm run bench:search`: the **whole** search service (plan → query → hydrate → snippets → suggestions) over the real SQLite engine, in-memory, on the seeded 50,000-video synthetic library (20 collections, ~8.3k distinct hashtags, 66.6k memberships, CJK/emoji/Spanish/Portuguese captions). The same searches through the real extension (Chromium, real OPFS, service worker → offscreen document → worker) are in `npm run e2e:storage`.

## How to read these numbers

- **Best of 3 rounds, 30 runs each, p95.** This machine is shared: a background `python` job that is not part of this project had used 45,000 CPU-seconds while I measured, and runs swung 1.5 to 2x. Contention can only ever make a run slower, so the round with the lowest p95 is reported (every round's p95 is printed next to it).
- A **calibration probe** (a fixed 50k-row scan) is printed at the top. It read 24.5 ms in the final run below and 21.7 ms on a quiet moment earlier, so the run was close to quiet.
- Synthetic data. Real captions are longer and more varied, and only one real account was ever inspected.

## Results (final gate run; ms; budget: p95 < 50)

| Workload | matches | p50 | p95 | note |
|---|---|---|---|---|
| 1 chip "food" (+related) | 10,001+ | 35 | 43 | too broad → newest saved first |
| 2 chips AND | 862 | 18 | 25 | relevance |
| 5 chips AND | 8 | 29 | 35 | relevance |
| 4 chips ANY | 10,001+ | 37 | 43 | too broad |
| 5 broad chips ANY | 10,001+ | 42 | **49** | too broad; the tightest case, no headroom |
| rare word / ubiquitous word | 2.5k / 6.7k | 14 / 17 | 19 / 23 | relevance |
| "recipes" (alias + collection name) | 10,001+ | 38 | 45 | too broad |
| multiword "meal prep" | 10,001+ | 33 | 42 | too broad |
| sort by views | 10,001+ | 29 | 39 | |
| sort recently saved | 862 | 18 | 23 | |
| no chips (browse) | 10,001+ | 8 | 10 | |
| zero-result typo chip | 0 | 0 | 0 | |
| page 2 (cursor, timed alone) | 10,001+ | 27 | 32 | |
| `getChipInfo`, 5 chips | | 20 | 23 | separate call |
| `getChipInfo`, typo + did-you-mean | | 6 | 10 | separate call; vocabulary is cached until the data changes |
| `explainMatch`, 1 result × 5 chips | | 8 | 10 | lazy, per row |

**Within the 50 ms budget:** everything above.

Through the real extension (adds messaging; p95 measured at the service worker): 1 chip 72 ms, 2 chips 34 ms, 4 chips ANY 52 ms, zero results 2 ms. Those are looser than the in-memory numbers because of OPFS and the message hops, and because the e2e uses 15 runs each.

### Documented exceptions (over 50 ms; held to a 120 ms ceiling)

| Workload | p50 | p95 |
|---|---|---|
| CJK chip `レシピ` (substring) | 49 | **66** |
| emoji chip `🍝` (substring) | 48 | **60** |
| mixed: `food` OR `レシピ` | 77 | **90** |

**Why:** full-text search cannot serve CJK or emoji (a run of CJK is one token; emoji index to nothing), so those chips are matched by substring with a scan over all 50,000 rows (five columns each). A single-column scan alone takes ~23 ms on this machine; five columns plus ordering ~50 ms. **Options if this matters:** store one pre-lower-cased search column (a migration plus ~15 MB) so the scan reads one column; or restrict substring matching to caption + author. Neither is done: I judged CJK/emoji chips a minority use and did not trade storage and a schema change for it. Say so if you disagree.

## What was tried (so it is not repeated)

Measured interleaved A/B in one process (the machine drifts too much to compare separate runs):

| Change | Result |
|---|---|
| Scan the plain `items` table instead of the full-text table's stored content for substring chips | 164 → 112 ms, then → ~50 ms after dropping set algebra |
| INTERSECT/UNION set formulation of substring matching | 2 to 3x **slower** than one WHERE; removed |
| `WITH … AS MATERIALIZED` for the match set | Faster only when the total is unknown (47 vs 61 ms); **slower** when it is known (63 vs 61), so it is used only in the first case |
| Total carried inside the cursor | later pages skip the count (page 2: 71 → 31 ms) |
| Share 60 related terms across the chips of a query | bounds the full-text expression by construction |
| Too-broad searches ordered over the chips' **own words** only when those alone exceed 10,000 | 4 chips ANY: 70 → 43 ms; 5 chips ANY: 93 → 49 ms. Trade-off: related-only matches are not in the recency listing of a too-broad search (documented in `UI_CONTRACT.md`) |
| Cache the did-you-mean vocabulary until the data changes | typo `getChipInfo` 43 → 10 ms |

## Bugs the checks found in M2 (kept here because they are instructive)

- **A superseded search was not dropped by the real worker.** The in-process test passed because it faked the message ordering. In the real worker, later messages cannot register while a slow request is running, so an older queued search ran although a newer one was already waiting. Fixed by yielding one event-loop turn before a search (`rpc/search-gate.ts`), with a unit test that models the busy worker, and verified in the real extension.
- Binding an empty parameter list to a statement with no parameters throws in the SQLite binding API (browse-all searches failed until fixed).
- The hand-labeled quality set caught a thin category: "pets" found 6 of 9 videos until `dog`/`cat` were added to its related terms.
- A mutation check found that no test could tell "recently saved" (by `saved_at`) from insertion order, because every fixture inserted videos in save order. A test where the two disagree was added.
- **The independent code review found seven real problems**, all fixed and covered by tests (`tests/search/review-fixes.test.ts`): hashtag/collection substring matches silently truncated at 500; a duplicate chip got no `chipInfo`/`explainMatch` entry; cursors were not tied to their sort and their total was trusted; continuation pages re-counted for nothing; search results loaded `raw_json`; the did-you-mean vocabulary was rebuilt with full scans on every typo; and every search method was declared twice.
