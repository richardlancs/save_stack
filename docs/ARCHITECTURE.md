# Architecture

Scroganize is a Chrome (Manifest V3) extension that makes the videos you saved on social media searchable. TikTok is the first platform; everything platform-specific sits behind one adapter interface. Everything runs on your machine: there is no server and no network access of its own.

## 1. The pieces and who talks to whom

```
   tiktok.com page (the platform's own web app)
   ┌───────────────────────────────────────────────────────────────┐
   │ MAIN world:      hook.ts      wraps fetch / XHR, forwards only allowed responses
   │ isolated world:  relay        validates the hook's window messages, forwards to the worker
   │ isolated world:  driver       (sync window only) scrolls, waits, reports what page it is on
   └───────────────┬──────────────────────────────────▲────────────┘
     chrome.runtime│ capture / driver events          │ driver commands (tabs.sendMessage)
                   ▼                                  │
   ┌────────────────────────────────────────────────────────────────┐
   │ service worker (background.ts): a ROUTER, keeps nothing that must survive being killed
   │   message-router   who may say what
   │   capture pipeline   validate → identity guard → parse → store → status
   │   sync coordinator   persists the state machine, opens the sync window, performs effects
   └───────┬────────────────────────────────────────────────────────┘
           │ chrome.runtime {target:'offscreen'}                ▲ RPC: side panel / any extension page
           ▼                                                     │ chrome.runtime {target:'db'}
   ┌────────────────────────┐                       ┌───────────┴───────────┐
   │ offscreen document      │                       │ side panel (or any UI) │  typed, stateless client
   │  └─ dedicated Worker    │                       └───────────────────────┘
   │      SQLite (WASM) on OPFS (opfs-sahpool), FTS5; the ONLY database owner
   └────────────────────────┘
```

- **Why an offscreen document and a Worker:** OPFS synchronous access handles only work in a dedicated Worker, and an MV3 service worker can neither spawn workers nor stay alive. The Worker is the single owner and single writer of the database; requests are handled one at a time.
- **The service worker is killed after ~30 s idle**, so it holds no state that must survive: capture counters, the sync state, the sync window's tab id and the ids seen during a run all live in `chrome.storage.local`; the data lives in SQLite. A message from a content script wakes it and it continues.
- **Code layout** (`src/`):
  - `core/` platform-agnostic: model, ingest normalisation, account binding, storage (`StorageAdapter`, the SQLite implementation and its migrations), search (chips, planner, related terms), sync (the pure state machine). No `chrome.*`, no DOM, no platform names.
  - `platforms/` the adapter contract, the capture protocol and validation, and `tiktok/` (allowlist, parser, saved-at estimation, page identity, sync spec). No `chrome.*`.
  - `extension/` everything that touches Chrome: entrypoints, the RPC (protocol, server, client, transports), the capture hook/relay/pipeline, the message router, the sync coordinator and driver.
  - `ui/` the side panel (Preact): pure state modules (`ui/state/`), five small components, and `ui/api.ts`, the only file that touches `chrome.*`. It may import only types from `core/` and `platforms/`, and from `extension/` only the RPC client and its transport; `tests/architecture.test.ts` enforces this.

## 2. Data flows

**Capture (passive).** While you browse tiktok.com, the MAIN-world hook sees the responses of exactly four endpoints (saved list, collection list, collection detail, collection items) and posts the response text plus the request's digits-only cursor and collection id, and who is signed in. The relay validates and forwards it. The service worker pipeline checks the sender, the message shape and size, the identity (the page must be *your own* profile), parses the body with the platform adapter, and asks the database to store it. The database binds the library to your account on first use and refuses any other account, in the same transaction as the write.

**Sync (active, user-initiated).** `startSync` opens a dedicated focused window. A pure state machine (`core/sync/machine.ts`) decides what to do next; the coordinator persists the state and performs the effects (open a URL, tell the driver to scroll). The page driver scrolls at a human pace and the platform's own page loads the next page, which the capture hook reads exactly as in passive capture. The machine is fed by capture outcomes, driver reports and browser events, so a killed service worker resumes from the persisted state. A complete pass (every page of a list chained to a page that said "no more") lets a full sync mark videos that are no longer saved as unavailable and drop stale memberships.

**Search.** The UI sends chips; the worker normalises them, plans an FTS5 query (own words first, then related terms), ranks, and returns a page with a capped total and suggested chips; per-chip counts and "why did this match" are separate calls so the first paint is fast. See `docs/SEARCH_PERFORMANCE.md`.

## 3. Trust model

- **What the extension reads:** only your own saved videos and collections, only the four allowlisted endpoints on `https://www.tiktok.com`, only while you are signed in and on your own profile. Uploads, reposts, stories and other people's data are never read.
- **What leaves the page:** the response body, a digits-only cursor and collection id, and your handle/id. Never headers, cookies, tokens, other query values or request bodies. Nothing leaves your machine.
- **The hook runs in the page's own JavaScript world**, because that is the only place its responses can be seen. Any script on tiktok.com could therefore post a message shaped like ours. A nonce cannot help (it would sit in the same page-readable world). The defence is limits, not secrecy: validation at the relay and again in the service worker, a kind allowlist, size and count caps, the identity guard, the database-enforced account binding, and that capture can only add or refresh saved-video rows (never delete, export or read). A forged message that passes all of those is indistinguishable from a real page and can only add or refresh rows for your own account. A forged first message can pin the binding to a bogus account (recoverable by wiping the library); that requires a script running on tiktok.com itself. One qualification: during a sync you started, a complete read of a list lets the sync mark videos unavailable or drop collection memberships. Only the sync window's own tab can move a run along, and a pass that saw under half of what is stored is refused, so a forged "last page" could at most hide up to half of a library (or the memberships of a small collection) until the next full sync restores them. Nothing is ever deleted.
- **The hook is transparent:** Proxy wrappers over the originals (same name/length/toString), a derived promise that behaves exactly like the page's own, no extension id or name announced to the page.
- **Extension pages only:** database RPC is answered only for our own extension pages; a content script (which lives in a web page) cannot reach export / wipe / import, neither through the service worker nor through the offscreen document.
- **No host permissions.** Content scripts are declared with `matches`, the sync window is opened with permission-free APIs, and the extension never fetches anything itself. Permissions: `offscreen` (hosts the database Worker), `unlimitedStorage` (the database lives in OPFS), `storage` (counters, sync state, preferences), `alarms` (a heartbeat while a sync runs), `sidePanel` (the toolbar button opens the panel). The Content Security Policy allows only `'self'` scripts and `'wasm-unsafe-eval'` (SQLite's WASM); no remote code. `npm run check:build` verifies all of this on the built bundle.

## 4. Resilience

- Parsers are pure and total: bad records are dropped and counted, unknown fields are reported as "drift", a partial record never blanks stored text. Caps bound what one message can insert.
- Every write is an idempotent upsert; every RPC method is safe to retry.
- Completion is `hasMore === false` on a chained list, never a count comparison (declared totals are unreliable). Only a complete pass may mark anything unavailable, and the coordinator refuses when the pass looks implausible.
- Video rows are never deleted by sync (they become `available = 0`); wipe is the only destructive operation and it is explicit.
- `PRAGMA user_version` migrations, each atomic; a database from a newer version is refused.

## 5. Extending

- **A new platform:** write an adapter (`docs/ADDING_A_PLATFORM.md`) and list it in `platforms/registry.ts`. Core, storage, search, the pipeline, the sync machine and the UI do not change.
- **A new UI:** build against `docs/UI_CONTRACT.md` and `src/extension/rpc/client.ts` (no framework or extension dependency). The side panel in this repository is a thin, replaceable reference implementation: it uses nothing a replacement could not use.
- **Better related terms or semantic search:** `TermExpander` (`core/search/expander.ts`) is an interface; the bundled list is data (`related-terms.json`).

## 6. Known limits

See `docs/DECISIONS.md` (each decision states its reason) and `docs/LIVE_CHECKLIST.md` (what only the real site can confirm): the sync's URLs and selectors are unverified against the live site (with guided fallbacks), saved dates are estimates, search over CJK/emoji is a substring scan that exceeds the 50 ms budget on 50,000 videos (documented), and collections deleted on the platform are not removed from the library.
