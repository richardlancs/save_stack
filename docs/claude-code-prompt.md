# Build "Scroganize": a Chrome extension that makes your saved social-media posts searchable

## 0. How to work

- Read this whole brief first. Then produce a short written plan (files, milestones, risks) and **wait for my OK before writing code.**
- Work milestone by milestone (§12). Commit at the end of each one with a clear message. Do not start the next milestone until the current one's acceptance criteria pass.
- Prefer boring, well-supported tech. Do not add features that aren't in this brief. If you think one is worth adding, list it in `docs/IDEAS.md` and move on.
- Ask me only when blocked on something that is genuinely mine to decide (my TikTok login, ambiguous product behaviour). Otherwise pick a sensible default and record it in `docs/DECISIONS.md` with a one-line reason.
- **Do not hard-code TikTok endpoints, field names or response shapes from memory.** Inspect real traffic first (§5.1) and treat anything you remember about TikTok's API as a hint to verify.

## 1. Goal

People save hundreds or thousands of videos into TikTok collections and then can't find anything. Build a Manifest V3 Chrome extension that:

1. **Ingests** the user's own TikTok collections and every video's metadata into a fast local database.
2. **Searches** them with a **chip (category) query builder**:
   - The user types anything they like ("food", "makeup", "study tips"). Pressing Enter or comma turns the text into a **chip** shown beneath the search bar, each with an **x**. A chip represents one category.
   - They can add as many chips as they want, then press **Search**. Results are the saved videos whose **metadata** matches the chips, drawn from all their collections.
   - They can then add more chips and press Search again to narrow further, or press **x** on individual chips to remove those filters. **Removing a chip only edits the chip list. Results update the next time Search is pressed.**

v1 supports **TikTok only**, but the architecture must let another platform (Instagram saved posts, YouTube playlists, Reddit saved, X bookmarks) be added by writing one adapter, with **no changes to core, storage or search.**

## 2. Non-goals for v1

- No backend, no accounts, no telemetry, no remote code. Everything stays on the user's machine.
- No natural-language grammar (dates, numeric ranges, `@author` operators). Chips are plain-text categories in v1. `Chip.kind` reserves room to add typed chips later.
- No semantic/embedding search and no LLM calls (but see the seams in §6.7).
- No downloading or re-hosting of video files.
- No Firefox/Safari builds (keep the build tool capable of it later).
- No polished UI. The side panel is a **test harness** for the core (§8).

## 3. Architecture

```
tiktok.com tab
 ┌────────────────────────┐   window.postMessage   ┌───────────────────────┐
 │ content-main (MAIN)    │ ─────────────────────▶ │ content-isolated      │
 │ hooks fetch/XHR, reads │                        │ validates + relays via│
 │ hydration JSON         │                        │ chrome.runtime        │
 └────────────────────────┘                        └──────────┬────────────┘
                                                              ▼
                                          ┌───────────────────────────────────┐
                                          │ service worker (router + sync     │
                                          │ state machine; NO db, no timers   │
                                          │ that must survive; persists state)│
                                          └───────┬───────────────────┬───────┘
                                       typed RPC  │                   │ typed RPC
                                                  ▼                   ▼
                              ┌────────────────────────────┐  ┌──────────────────┐
                              │ offscreen document         │  │ side panel (UI)  │
                              │ └ dedicated Worker: owns   │  │ uses ONLY the    │
                              │   SQLite (single writer)   │  │ typed client SDK │
                              └────────────────────────────┘  └──────────────────┘
```

Why this shape:
- **Only a dedicated Worker can use OPFS sync access handles**, and MV3 service workers can't spawn workers or be relied on to stay alive. So the database lives in an **offscreen document + dedicated Worker** that is the single owner and single writer. Everything else talks to it through the service worker via typed messages.
- The MAIN-world script (declared with `"world": "MAIN"` at `document_start`) is the only way to see TikTok's own fetch/XHR responses. The ISOLATED-world script is the only one allowed to talk to `chrome.runtime`. Treat everything crossing from MAIN as **untrusted input** and validate it.
- The service worker can be killed after ~30s idle. Sync must be a **resumable state machine persisted in `chrome.storage.local`**, advanced by events (content-script messages), never by in-memory timers.

### 3.1 Tech stack
- TypeScript (strict), Vite-based **WXT** for the MV3 build (manifest generation, entrypoints, MAIN-world content scripts, side panel). If WXT blocks you on WASM assets or offscreen docs, tell me and fall back to Vite + `@crxjs/vite-plugin`.
- `@sqlite.org/sqlite-wasm` with the OPFS `opfs-sahpool` VFS (no COOP/COEP or SharedArrayBuffer needed). Spike it first (M0).
- Vitest for unit tests, Playwright (persistent context, unpacked extension) for e2e.
- UI: Preact (or React) + plain CSS variables. No component library. Keep it deliberately small.

### 3.2 Repo layout
```
src/
  core/                      # platform-agnostic. NO chrome.* and NO DOM imports.
    model.ts                 # SavedItem, Collection, Membership, Chip, SyncState
    storage/
      adapter.ts             # StorageAdapter interface
      sqlite/                # SQLite impl: schema.sql, migrations/, statements
      idb/                   # fallback impl (only if M0 spike fails)
    search/
      chips.ts               # chip normalization/validation (pure)
      expander.ts            # TermExpander + bundled related-terms lookup
      related-terms.json     # DATA, not code: category -> related terms
      planner.ts             # chips + mode -> FTS5 MATCH expr + SQL
      ranker.ts              # scoring / tie-breaks (seam for future rankers)
      attribution.ts         # which chip/term/field matched each result
    ingest/pipeline.ts       # ParsedBatch -> normalized upserts (idempotent, batched)
  platforms/
    types.ts                 # PlatformAdapter interface (§7)
    registry.ts
    tiktok/                  # ALL TikTok-specific strings/selectors/paths live here
      adapter.ts  capture-rules.ts  parse.ts  sync.ts  fixtures/
  extension/                 # MV3 glue only
    entrypoints/ background.ts, offscreen/, content-main.ts, content-isolated.ts, sidepanel/
    rpc/ protocol.ts  client.ts  server.ts   # the typed contract (§8.1)
  ui/sidepanel/              # thin + replaceable
tests/ e2e/ bench/
docs/ ARCHITECTURE.md DECISIONS.md UI_CONTRACT.md ADDING_A_PLATFORM.md IDEAS.md
```
Rule: `core/` and `platforms/*/parse.ts` must be runnable in plain Node under Vitest.

## 4. Storage (SQLite WASM + FTS5)

Define `StorageAdapter` first (`upsertBatch`, `search(plan)`, `getItem`, `listCollections`, `stats`, `exportAll`, `wipe`, `migrate`), then implement it on SQLite. Everything above the adapter is engine-agnostic.

**Data model (normalized, platform-scoped; adjust names as needed but keep the ideas):**
- `items(platform, external_id, url, author_handle, author_name, caption, sound_title, sound_author, duration_sec, posted_at, views, likes, comments, shares, saves, thumbnail_url, language, first_seen_at, last_seen_at, available, raw_json)`, PK `(platform, external_id)`. Integers for counts and epoch-ms for times so they sort using indexes. `available=0` (never delete) when a video disappears/goes private.
- `collections(platform, external_id, name, item_count, last_synced_at)`.
- `item_collections(platform, item_id, collection_id, position)`: **many-to-many**, a video can be in several collections. `position` preserves TikTok's order, which is our best proxy for "recently saved" (verify in M0 whether TikTok exposes a real saved-at; if not, say so and use `position` + `first_seen_at`).
- `hashtags(id, tag)` + `item_hashtags(item, hashtag_id)`, used for suggested chips and (optionally) exact-tag boosting.
- `items_fts`: FTS5 **external-content** table over `caption, hashtags, author, sound, collection_names`, `tokenize = "porter unicode61 remove_diacritics 2"`, prefix indexes (`prefix='2 3 4'`). Because a chip is matched against **all metadata fields at once**, all searchable text must be in this one table, including the names of every collection the video is in (so a chip "recipes" also matches everything in a collection named "Recipes"). Keep collection_names in sync when memberships change. Add a small **trigram** FTS table as a fallback for CJK/emoji-heavy text and typo recovery. Keep FTS in sync via triggers or explicit writes inside the same transaction.
- Indexes on `(platform, posted_at)`, `views`, `likes`, `duration_sec`, `author_handle`, `item_collections(collection_id, position)`.
- BM25 column weights (tune with the benchmark): hashtags > caption > author > sound > collection names.

**Efficiency requirements:**
- All writes in batched transactions (~500 to 1000 rows), using prepared statements. Upserts are idempotent so re-syncs are cheap.
- Choose pragmas appropriate to the VFS (page size, cache size, synchronous), and document what you chose and why in `docs/DECISIONS.md`.
- Versioned migrations from day one (`PRAGMA user_version`).
- `raw_json` stored trimmed/compressed (only fields you might need for reprocessing) to keep the DB small.
- Request `unlimitedStorage`. Expose `stats()` (row counts, DB size).

**M0 spike (must pass before building on it):** in an offscreen doc + Worker, open the DB via `opfs-sahpool`, create the schema, insert 50k synthetic rows, run a multi-group FTS5 `MATCH` (the shape in §6.3) and a filtered sort. Record timings. If OPFS is unusable, implement `idb/` (IndexedDB + MiniSearch or Orama behind the same adapter) and tell me why.

## 5. Ingestion (TikTok)

### 5.1 Discover, don't assume (M0)
Log in to TikTok in a test Chrome profile (ask me to do this step: I'll sign in). Using DevTools/network inspection (or the Claude-in-Chrome tools if available), record what TikTok's web app actually loads for: (a) the list of my collections and (b) the videos in one collection, including pagination (cursor/`hasMore`) behaviour. Also check whether the **initial** page load ships data inside an inline hydration blob (community scrapers often mention `__UNIVERSAL_DATA_FOR_REHYDRATION__` and endpoints like `/api/user/collection_list/` and `/api/collection/item_list/`. Treat those as hints only). Save **sanitized** sample payloads to `src/platforms/tiktok/fixtures/` (strip cookies, tokens, and anything identifying me beyond what's needed). Write `docs/TIKTOK_FINDINGS.md`: URLs, field paths, pagination, ordering, whether a saved-at timestamp exists, and thumbnail URL behaviour.

Why intercept rather than call the API: TikTok signs its own requests with rotating parameters, so replaying calls from the extension is fragile. Capturing the responses the page already receives is much more stable.

### 5.2 Capture
- `content-main.ts` (MAIN world, `document_start`, matches `https://www.tiktok.com/*` only): wrap `window.fetch` and `XMLHttpRequest` non-destructively (never alter the request/response the page sees, use `response.clone()`), forward only responses whose URL matches `captureRules` from the TikTok adapter, and also read the hydration blob on load. Post to the ISOLATED script with a namespaced message envelope + per-page-load nonce.
- `content-isolated.ts`: verify origin/nonce/shape, then relay to the service worker. Chunk large payloads if needed.
- Passive mode: anything the user browses in their collections is captured automatically. Active mode is the sync in §5.3.

### 5.3 Auto-scroll sync
- A **Sync** action (user-initiated only, never automatic or scheduled) that: opens/reuses a TikTok tab, enumerates the user's collections, then for each collection navigates to it and scrolls its list until pagination ends (`hasMore=false` or no new items after N attempts).
- Human-like pacing: randomized delays, gentle scroll steps, exponential backoff on errors/captcha/rate-limit signals, a hard per-session cap, and **pause / resume / cancel**. If a captcha or login wall appears, stop and surface it to the user.
- **Incremental by default:** stop a collection when the sync reaches items already stored with unchanged data; offer "Full re-sync" that also marks vanished videos `available=0`.
- Sync progress (collections done/total, items seen/new) streams to the UI through the RPC contract. State is persisted so a killed service worker resumes.
- Never touch other users' data. Only the signed-in user's own collections.

### 5.4 Robustness
- Parsers are **pure and tolerant**: unknown/missing fields never throw. Validate with a schema (e.g. zod/valibot), drop bad records, and count/report them.
- Record a `parser_version` and `schema_hash` warning when TikTok's shape drifts, and show "TikTok changed something, results may be incomplete" in the UI instead of failing silently.
- Thumbnail (cover) URLs on TikTok's CDN are typically **signed and expire**. Store them, but make the UI tolerate dead thumbnails (placeholder), and don't treat a 403 as an error. (Caching downscaled thumbnails is a stretch goal, not v1.)

## 6. Search: chips, matching, related terms

### 6.1 Model
The **UI owns the chip list** (draft state). The core is **stateless**: every Search call sends the full chip list, and the core returns results. Removing a chip and pressing Search is just a new query with fewer chips. No server-side query sessions.

```ts
interface Chip {
  id: string;                  // stable id for UI keying + per-chip result info
  text: string;                // the category as typed, e.g. "food", "meal prep"
  expand?: boolean;            // use related terms? default true
  kind?: 'text';               // reserved: later 'author' | 'hashtag' | 'collection' | 'date' ...
}

interface SearchRequest {
  requestId: string;           // for cancellation
  chips: Chip[];               // committed chips. [] = browse everything
  mode?: 'all' | 'any';        // default 'all' (AND). 'any' = OR
  sort?: 'relevance' | 'recently_saved' | 'newest' | 'most_viewed';  // default: relevance if chips else recently_saved
  limit?: number; cursor?: string;
}

interface SearchResponse {
  results: ResultItem[];
  total: number; nextCursor?: string; tookMs: number;
  chipInfo: { chipId: string; count: number;              // how many videos match THIS chip alone
              expandedTerms: string[];                    // what "food" also matched, for transparency
              didYouMean?: string }[];                    // only when the chip has 0 matches
  suggestedChips: { text: string; count: number; source: 'hashtag' | 'collection' | 'author' }[];
}

interface ResultItem {
  item: SavedItem; collections: CollectionRef[];
  matches: { chipId: string; via: 'direct' | 'related'; fields: ('caption'|'hashtags'|'author'|'sound'|'collection')[]; term?: string }[];
  snippet: HighlightedText;    // safe, structured (no raw HTML)
  score: number;
}
```

### 6.2 Chip normalization (pure, `chips.ts`, table-tested)
Trim; collapse whitespace; NFKC + lowercase for matching (keep original for display); strip a leading `#` or `@` (v1 treats them as plain text); max length (e.g. 64 chars) and max chip count (e.g. 20), with clear errors; de-duplicate case-insensitively; pasted text containing commas/newlines splits into multiple chips; empty/punctuation-only chips are rejected. **FTS5 syntax characters (`" * ( ) : ^ - + AND OR NOT NEAR`) in user text must be escaped or quoted, never passed through raw.** Must not crash on emoji, CJK, RTL, or very long input.

### 6.3 How one chip matches a video
A chip matches a video if **all of its words** appear (any order, in any searchable field: caption, hashtags, author, sound, or the name of any collection the video is in), using stemming (`recipe` ≈ `recipes`), diacritic folding, and **prefix matching** on the last word. Adjacent-phrase matches score higher than scattered ones. A chip's **predicate** is:

`own-match  OR  (any related-term match, if chip.expand)`

Combine chips into **one FTS5 `MATCH` expression** where possible, so BM25 is computed once:
- `mode: 'all'`: `(chip1 terms OR chip1 related) AND (chip2 terms OR chip2 related) …`
- `mode: 'any'`: same groups joined with `OR`.
FTS5 supports parenthesized boolean groups. If some shape can't be expressed as one MATCH (e.g. mixed column filters), fall back to intersecting per-chip rowid sets and record why in `DECISIONS.md`. **No chips = no FTS**, just the sorted list of everything.

### 6.4 Related terms (the "food" → recipe/pasta layer)
- `TermExpander` interface: `expand(chipText): { terms: string[]; weight: number }`. The v1 implementation reads a **bundled data file** `related-terms.json`: `{ "food": ["recipe","cooking","meal","dinner","lunch","pasta","baking", ...], "makeup": ["grwm","foundation","lipstick","eyeshadow","skincare"?, ...], … }`.
- Author ~60 to 100 broad, common categories (food, makeup, skincare, hair, fashion, fitness, travel, DIY, home decor, cleaning, pets, music, dance, comedy, tech, gaming, finance, study/productivity, parenting, cars, art, books, etc.) as **data, not code**, so it can be edited without touching logic and later replaced by embeddings. Keep entries specific enough to avoid false positives, cap expansion per chip (e.g. ≤ 30 terms), and include phrases as well as words.
- Look up by the **stemmed/normalized** chip text (so "recipes" hits the "food"-family entry if you choose to alias it). Aliases are allowed (`"cooking" → "food"`).
- **Ranking:** direct matches outrank related-only matches (e.g. weight 1.0 vs ~0.4). Each result records `via: 'direct' | 'related'` and the matched `term` so the UI can show *why* it matched.
- **Transparency:** `chipInfo[].expandedTerms` is returned so the UI can show what a chip also matched. Users can switch a chip to exact-only with `chip.expand = false`.
- Ship a **labeled precision test**: a small fixture library with hand-labeled expected matches per category, asserting recall for related-term hits and a bounded false-positive rate.

### 6.5 Ranking & result quality
- BM25 with the column weights from §4, plus the related-term weight from §6.4, plus a small documented recency/engagement tiebreak. Keep it behind `ranker.ts` so it's replaceable.
- **Zero/low results:** `chipInfo[].count` reports how many videos each chip matches *alone*, so when AND yields nothing the UI can say which chip is over-narrowing. For a chip with zero direct matches, try trigram/edit-distance against known terms (hashtags, authors, collection names, lexicon keys) and return `didYouMean` (a **suggestion**, never a silent substitution).
- `suggestedChips`: top hashtags/collections/authors within the current result set (cheap facet query), so the user can add one as a new chip with a click. This is the "narrow further" loop.
- Search must be **cancellable**: a newer `requestId` supersedes older ones, and stale results are never delivered.

### 6.6 Attribution
After the page of results is chosen (≤ 30 rows), compute per-row, per-chip `matches` cheaply (highlight/snippet or a small per-row check). Don't do this over the whole result set.

### 6.7 Seams for later (do NOT build now)
`TermExpander` (above) and a `Retriever` interface (`retrieve(chips, mode) → candidate ids + scores`) exist so an on-device embedding retriever can be added and fused with FTS results later, without touching storage or UI. `Chip.kind` reserves typed chips. Ship only the FTS + related-terms implementations.

## 7. Platform adapter interface (the extensibility contract)

```ts
interface PlatformAdapter {
  id: string;                                  // 'tiktok'
  displayName: string;
  hostMatches: string[];                       // manifest match patterns
  captureRules: { urlPattern: RegExp; kind: string }[];   // what MAIN-world hook forwards
  parse(capture: RawCapture): ParsedBatch;     // PURE. → { items, collections, memberships, hasMore?, cursor? }
  canonicalUrl(item: SavedItem): string;       // deep link back to the original post
  sync: {
    listCollections(ctx: SyncContext): Promise<CollectionRef[]>;
    driveCollection(ctx: SyncContext, c: CollectionRef, signal: AbortSignal): Promise<void>;
  };
}
```
- `core/` and the UI must never mention "tiktok". They only see `platform: string` and the normalized model.
- Write `docs/ADDING_A_PLATFORM.md` and a **contract test suite** (`platforms/contract.test.ts`) that any adapter must pass using its fixtures. Add a tiny fake `example` adapter in tests to prove core is platform-agnostic.

## 8. UI: temporary side panel, built to be replaced

Another developer owns the real UI. My job is to make the core fully usable through a **stable, stateless contract** and provide a minimal side panel that proves it.

### 8.1 The contract (`extension/rpc/protocol.ts` + `client.ts`), fully typed, versioned, documented in `docs/UI_CONTRACT.md`
`search(SearchRequest) → SearchResponse` (§6.1) · `cancelSearch(requestId)` · `getCollections()` · `getItem(id)` · `startSync(opts)` · `pauseSync()` · `resumeSync()` · `cancelSync()` · `onSyncProgress(cb)` · `getStats()` · `exportData()` · `importData(file)` · `wipeData()` · `getSettings()/setSettings()`
- The client SDK (`client.ts`) has **zero UI dependencies**. Any framework (or a content-script-injected bar on tiktok.com later) can consume it.
- The chip **list state lives in the UI**. The core only ever sees a `SearchRequest`.
- No business logic in UI code: no matching, no SQL, no ranking, no related-term lookup, no platform knowledge. (The UI may call the pure `normalizeChip()` helper exported from the client SDK for instant input validation.)

### 8.2 The placeholder side panel (`chrome.sidePanel`, open on toolbar click)
This is the exact interaction to implement:

1. **Input + Search button.** A text box with a **Search** button beside it.
2. **Making chips.** Typing text and pressing **Enter or comma** turns it into a **chip** in a wrapping row **beneath** the search bar. Each chip shows its text and an **x**. Pasting comma/newline-separated text creates several chips. Duplicates are ignored.
3. **Adding as many as they want.** The chip list is unbounded up to the §6.2 cap.
4. **Pressing Search.** Any text still in the input is committed as a chip first. Then the panel sends `search({chips, mode})` and shows results. Pressing Enter on an *empty* input also triggers Search. Search is **never** run while typing.
5. **Refining.** The user can add more chips and press Search again to narrow the results.
6. **Removing chips (staged).** Pressing **x** removes the chip from the draft list **only. Results do not change yet.** The panel shows a subtle "Filters changed, press Search to update" indicator whenever the draft chip list differs from the last-searched list. Pressing Search re-runs with the new list, which is how the filter is removed.
7. **Empty chip list + Search** browses everything (sorted by recently saved).
8. **After a search**, each chip shows its own match count from `chipInfo` (e.g. `food · 212`), tooltips list the related terms it expanded to, and a 0-count chip is visually flagged with the "remove this chip" suggestion and any `didYouMean`.
9. **Match mode.** A small "Match: All | Any" segmented control that sets `mode` (default All), to exercise the API. The other dev may drop or move it.
10. **Results list.** Virtualized. Each row: thumbnail (placeholder on error), highlighted snippet, author, stats, collection tags, a "matched: food (related: recipe)" line from `matches`, and a link that opens the video on TikTok. `suggestedChips` appear as clickable "+ chip" suggestions that add to the draft list (they do not auto-search).
11. **Also:** Sync button with progress/pause/cancel, an empty state that explains how to sync, and a small stats/settings footer (item count, DB size, export, wipe). Keep styling to a few CSS variables, light/dark via `prefers-color-scheme`, keyboard accessible (chips focusable and removable from the keyboard, `aria-live` region announcing result counts). Render all captured text as text, never as HTML.

## 9. Performance budgets (verify in `bench/`, fail loudly if exceeded)
Measured on a synthetic 50k-item library (generate with a seeded script, realistic multilingual captions/hashtags/skewed counts):
- **Search p95 < 50 ms** for up to 5 chips with related-term expansion on (first page of 30, plus `chipInfo` counts and `suggestedChips`). Cap expansion so the FTS expression stays bounded.
- Ingest ≥ 2,000 items/s in batch upserts. Re-sync of unchanged data is near-free.
- Side-panel cold open to first render < 300 ms. Idle memory of the offscreen doc reported in the bench.
- Extension bundle < 3 MB excluding WASM. Report WASM size.

## 10. Privacy, permissions, and compliance
- Permissions: `sidePanel`, `storage`, `unlimitedStorage`, `offscreen`, `scripting` and `tabs` only if needed (justify each in `docs/DECISIONS.md`). Host permission: `https://www.tiktok.com/*` only. No `<all_urls>`.
- No network requests except the ones TikTok's own page makes. No analytics. No remote scripts. Strict CSP. The related-terms file ships **inside** the extension.
- User can **export** all data (JSON) and **wipe** everything at any time.
- README must say plainly: this reads only the signed-in user's own saved data, locally, at a human-like pace, and only when they press Sync. Automated access may conflict with TikTok's Terms of Service, and the user is responsible for their own use.
- Sanitize any text rendered in the UI (captions are untrusted). No `innerHTML` with captured data.

## 11. Testing
- **Unit (Vitest):**
  - `chips.ts` normalization table (§6.2), including FTS-syntax injection strings, emoji/CJK, dedupe, caps.
  - Planner output: AND grouping, OR grouping, expansion caps, escaping, empty chip list.
  - Expander: lookup, aliases, stemming, `expand=false`.
  - **Labeled precision/recall test** for related terms (§6.4).
  - Ranker: direct outranks related-only, tie-breaks.
  - Attribution correctness.
  - Adapter `parse` against fixtures + tolerant-parser fuzzing (missing/extra/wrong-typed fields). Ingest idempotency.
- **Storage contract tests:** run the same suite against every `StorageAdapter` implementation.
- **E2E (Playwright, unpacked extension):** serve a **local mock TikTok** (static pages + fake collection endpoints replaying the fixtures, including pagination and a captcha-like interruption). Assert:
  - capture → DB → chips → Search → results
  - typing does **not** trigger a search
  - **x on a chip does NOT re-query until Search is pressed**, and the "Filters changed" indicator appears/clears correctly
  - AND narrows, All→Any widens
  - a 0-count chip is flagged
  - sync pause/resume/cancel, and service-worker-killed-mid-sync resume
  - wipe/export
- CI must never hit real TikTok. A separate, manual `npm run smoke:live` may, gated behind an env var.

## 12. Milestones (each ends with passing tests + a commit + a short status note)
- **M0: De-risk.** OPFS + FTS5 spike in offscreen Worker with timings (including the multi-group MATCH shape). Real TikTok traffic inspection → `docs/TIKTOK_FINDINGS.md` + sanitized fixtures. *Accept:* I can read the findings and the spike's numbers, and we agree on the schema before M1.
- **M1: Scaffold + storage.** WXT project, manifest, RPC skeleton, `StorageAdapter`, SQLite schema + migrations, batch upsert, seeded 50k benchmark. *Accept:* storage contract tests green; ingest budget met.
- **M2: Search.** Chip normalization, planner (AND/OR), `related-terms.json` + `TermExpander`, ranker, attribution, `chipInfo`/`didYouMean`, `suggestedChips`, trigram fallback, cancellation. *Accept:* all unit tests green incl. precision/recall test; search budget met on 50k.
- **M3: TikTok adapter + capture.** MAIN-world hook, relay, tolerant `parse`, pipeline into DB. *Accept:* browsing my collections on real TikTok populates the DB (verified with me), and fixtures-based tests pass.
- **M4: Sync.** Auto-scroll orchestration, pacing, incremental/full modes, pause/resume/cancel, persisted state. *Accept:* e2e against the mock passes, including SW-restart; live smoke on my account completes for all my collections.
- **M5: Side panel.** UI exactly as §8.2, against the contract only. *Accept:* the chip flow works end to end (add chips, Search, add more, x then Search), including the staged-removal behaviour; `docs/UI_CONTRACT.md` is enough for another dev to build a different UI without reading core code (prove it by keeping `ui/` free of imports from `core/` and `platforms/`).
- **M6: Harden + docs.** Error/empty states, drift warning, export/import/wipe, perf bench in CI, `ARCHITECTURE.md`, `ADDING_A_PLATFORM.md`, README. Show me the related-terms file for review.

## 13. Defaults I've assumed (tell me if any are wrong)
Chrome desktop only · library size 500 to 50k videos · chips AND together by default (`mode:'any'` available) · chip removal is staged until Search is pressed · chips are plain-text categories only · English-first related-terms list but nothing may break on other languages · "saved date" may be unavailable, so "recently saved" uses collection order · no thumbnail caching in v1 · single TikTok account at a time · the extension name and folder are "Scroganize".

## 14. Definition of done
All milestone acceptance criteria met · perf budgets met and reported · no `core/` or `ui/` reference to TikTok · no TikTok endpoint/field name in code that isn't backed by a fixture and `TIKTOK_FINDINGS.md` · docs written · final message summarizing what was built, measured numbers, known limitations, and the top 5 risks (especially TikTok drift and related-terms false positives).

**First step now: read the repo (it's empty), then reply with your plan and any questions from §0/§13. Do not write code yet.**
