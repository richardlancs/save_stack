# Decisions

One line of "why" per decision. Newest at the bottom of each section. Status: **proposed** until the milestone that owns it is accepted.

## Tooling (M0)

| Decision | Why |
|---|---|
| **WXT 0.21 (Vite 8)** builds the MV3 extension, with `srcDir: 'src'` and `entrypointsDir: 'extension/entrypoints'`. | Matches the brief's repo layout; handles offscreen page, MAIN-world scripts and side panel entrypoints; WASM asset emission worked first try. |
| **Tests load the extension in Playwright's bundled Chromium, not branded Chrome.** | Branded Chrome 137+ ignores `--load-extension`. Chromium 153 (Chrome for Testing family) honours it and runs extensions headless. |
| **TypeScript 7 needs `"types": ["chrome"]` in `tsconfig.json`.** | TS 6+ no longer auto-includes `@types/*`; without it the `chrome` global is undefined. |
| **`content_security_policy.extension_pages` = `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`.** | MV3's default CSP blocks `WebAssembly.instantiate` (hit in the first spike run). `wasm-unsafe-eval` permits compiling `.wasm` only. It does not allow JS `eval`, inline scripts or remote code. |
| **`@sqlite.org/sqlite-wasm` 3.53.4 with the `opfs-sahpool` VFS.** | No COOP/COEP or SharedArrayBuffer requirement, so no extra manifest headers. FTS5, DBSTAT and math functions are compiled in. The wasm is 869 KB. |
| **Storage tests in Node use the package's Node build (`dist/node.mjs`) with in-memory DBs.** | Lets the storage contract suite run under Vitest against the real engine, without a browser. |

## Storage (M0 spike; **proposed**, evidence in `STORAGE_SPIKE.md`)

| Decision | Why |
|---|---|
| **SQLite-WASM (`opfs-sahpool`) + FTS5 behind `StorageAdapter`; IndexedDB fallback not needed.** | Whole path (SW → offscreen → Worker → OPFS → FTS5) works in a real MV3 extension: 50k rows, persistence across worker restart, `quick_check` ok, ~120 ms cold start. |
| **Exactly one DB owner: a singleton offscreen document + one dedicated Worker.** | The pool is exclusive; a second installer is refused in ~40 ms. On startup the owner retries install with a short bounded backoff. |
| **Safe pragmas only:** default page size, `journal_mode=TRUNCATE`, `synchronous=NORMAL`, `temp_store=MEMORY`, `cache_size≈-32768`. | Six variants were within noise of each other (2.5k to 2.8k items/s), so exotic settings buy nothing. `journal_mode=MEMORY/OFF` risks corruption on a crash for no gain. |
| **Drop the trigram table; use a `LIKE` substring fallback for CJK/emoji chips and edit-distance for did-you-mean.** | Trigram cost ~20% of DB size and ~30% of ingest speed, and can't match 2-char CJK or emoji. `LIKE` did all of it: 2 to 3 ms first page, ~20 ms count at 50k. |
| **Drop `items.url`; make `raw_json` opt-in.** | ~1.9 KB to ~1.2 KB per item (≈ 60 MB at 50k instead of 97 MB). URL is derivable via `adapter.canonicalUrl`. |
| **Tiered search: own-word matches first, related-only matches via FTS5 `(full) NOT (direct)` only to fill the page; total capped at 10,001.** | The single-pass pipeline hit 266 to 479 ms for multi-chip ANY searches. Tiered runs at 34 to 73 ms p95 in the worst case and ≤ 35 ms for most searches. |
| **Per-chip counts and per-row "why matched" leave the first-paint path** (follow-up call; lazy per-row `explain`). | In SQL they cost ~1 ms per (row, chip) for broad chips: 130 to 290 ms for a 30-row page. |
| **Multiword chips also try the concatenated hashtag** (`meal prep` → `mealprep`). | Hashtags are one token; without this "meal prep" matched 0 videos in the benchmark, with it 3,183. |

## TikTok ingestion (M0 findings; **proposed**, evidence in `TIKTOK_FINDINGS.md`)

| Decision | Why |
|---|---|
| **Capture only four endpoints:** `/api/user/collection_list/`, `/api/user/collect/item_list/`, `/api/collection/detail/`, `/api/collection/item_list/`. Drop everything else in the MAIN-world hook. | Those carry all the data. The other `/api/*` calls on the page are the user's own uploads/reposts, which are out of scope and more private. |
| **Sync the flat favorites list as the base set; treat collections as membership tags.** | Collections are a subset of favorites (45/45); ~2/3 of saves are in no collection; the favorites cursor is the only saved-time signal. |
| **Never trust declared totals. Completion = `hasMore === false`.** Store `declared_total` and `items_seen` separately. | 263 declared vs 227 delivered; 48 vs 45; `collection_list.total` 6 vs 5 delivered. |
| **`saved_at` is estimated from favorites cursors and labeled `interpolated`;** later syncs use `first_seen_at`. | No per-video saved time exists; cursors are saved-time page boundaries (inferred). |
| **De-duplicate re-fetched pages by `(cursor, first id)`; upsert by `(platform, external_id)`.** | Re-opening the tab re-requests the first pages. |
| **Sync tab must be visible (active tab, focused window).** | In a hidden tab, programmatic scrolling and lazy loading silently stall; real wheel events worked. |
| **Refuse to sync unless the profile's `uniqueId` equals `webapp.app-context.user.uniqueId`.** | Enforces "only the signed-in user's own data". |
| **Parser treats every field except `id` as optional; photo posts (22%) have `duration = 0` and `imagePost`.** | Observed optional-field rates 0.2 to 87%. |
| **Fixtures are reconstructed from observed structure, not raw captures.** | Raw captures contain a real person's saved videos and signed URLs; my in-page scrubber failed its own leak audit, so it was not used. |

## Operational notes

- `save_stack/` (an unrelated clone of `richardlancs/save_stack`, an Instagram-saves project) is present in the working tree. It is not part of Scroganize. Commits stage explicit paths and never `git add -A`, so it is never embedded in this repo.
