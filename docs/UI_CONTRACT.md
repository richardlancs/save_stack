# UI contract (v1: written in M1, extended through M6)

For whoever builds the real UI. The side panel in the repo (`src/ui/`, M5) is a thin reference UI built ONLY on this contract, so it doubles as a worked example; **this document, plus the files it points to, is the actual interface.** You should never need to read `src/core/` internals, and your UI must not import from `src/core/` or `src/platforms/` (types excepted).

## 1. Status: what works today

| Area | Status |
|---|---|
| Storage, ingest, stats, export/import, wipe | **Works** (M1) |
| `search`, `getChipInfo`, `explainMatch` | **Works** (M2). Measured against a 50,000-video library: see `docs/SEARCH_PERFORMANCE.md` |
| Capture: the extension reads the signed-in user's own saved videos while they browse tiktok.com; `getCaptureStatus` reports what it has read and whether TikTok changed its format | **Works** (M3), tested against a mock TikTok |
| Sync: read the whole saved list and every collection in a dedicated window, at a human pace, pausable, resumable after the service worker is killed | **Works** (M4), tested end to end against a mock TikTok. `startSync`, `pauseSync`, `resumeSync`, `cancelSync`, `getSyncStatus` and a progress broadcast (section 3a) |
| Side panel (reference UI): chips, results with "why this matched", sync card, export / import / wipe, preferences | **Works** (M5, M6), tested in a real Chromium against a mock TikTok (`e2e/panel.ts`). Its layering (no runtime imports from `core/` or `platforms/`, `chrome.*` only in `ui/api.ts`, no `innerHTML`, no platform name) is enforced by `tests/architecture.test.ts` |
| Settings (`getSettings` / `setSettings`) | **Works** (M6), section 3b |
| Result links (`ResultItem.url`) | **Works** (M6), section 5 |

## 2. How your UI talks to the backend

There is no server. Everything is local: **UI → service worker → offscreen document → SQLite worker**, all inside the extension.

```ts
import { createClient } from '<repo>/src/extension/rpc/client';
import { chromeTransport } from '<repo>/src/extension/rpc/chrome-transport';

const api = createClient(chromeTransport);   // works from a side panel, popup, options page, or an extension page
const stats = await api.getStats();
```

- `client.ts` has **no UI and no `chrome.*` dependency**. The transport is injected. `chrome-transport.ts` is the only file that touches `chrome.runtime`.
- All types live in `src/extension/rpc/protocol.ts` (methods), `src/core/model.ts` (data) and `src/core/search/types.ts` (search).
- Every call returns a promise. Failures throw `RpcCallError` with a `code`: `BAD_REQUEST` (your bug; for search this includes an empty chip, a chip over 64 characters, more than 20 chips, or a bad `mode`/`sort`/`limit`/`cursor`), `SUPERSEDED` (a newer search replaced this one before it ran: **not an error to show**, just ignore it; `isSuperseded(e)` in `client.ts`), `BUSY` (a sync is already running), `ACCOUNT_MISMATCH` (the library belongs to another signed-in account; wipe it to switch), `NOT_IMPLEMENTED` (a method declared in the contract but not built: none today), `UNAVAILABLE` (database not reachable / failed to start; retry or show "open the extension again"), `INTERNAL` (operation failed; message is safe to log).
- The database is owned by one process. Your UI **cannot** and must not open the database itself.

## 3. Methods

| Method | Result | Notes |
|---|---|---|
| `ping()` | `{ pong, rpcVersion, schemaVersion, storage }` | health check; `rpcVersion` is the contract version |
| `getStats()` | `StorageStats` | counts, `dbBytes`, `schemaVersion` |
| `getCollections()` | `StoredCollection[]` | each has `declaredTotal` (what TikTok *claims*) and `itemsSeen` (what we hold). They differ; see §5 |
| `getItem(platform, externalId)` | `StoredItem \| null` | includes `collections` |
| `exportData()` / `importData(bundle)` | JSON bundle / `null` | import **replaces** everything |
| `wipeData()` | `null` | deletes all rows **and** reclaims the storage file |
| `search(req)` | `SearchResponse` | one page (default 30, max 100) + capped total + suggested chips. Page with `nextCursor` (opaque: pass it back unchanged with the **same chips and the same `sort`**; a cursor replayed under a different sort is refused with `BAD_REQUEST`) |
| `getChipInfo(req)` | `ChipInfoResponse` | per-chip counts, related terms used, did-you-mean. Call it right after `search` with the same `requestId` and fill the chip badges in when it arrives |
| `explainMatch(req)` | `ExplainResponse` | why ONE result matched, per chip: `direct` / `related` (+ the related term) / `none`, and which fields. Call it only for a row the user expands |
| `getCaptureStatus()` | `CaptureStatus` | answered by the service worker (not the database). `pages`/`items`/`inserted` read so far, `duplicates` skipped, `rejected` (by reason: `not_own_profile`, `identity_unknown`, `account_mismatch`, `owner_mismatch`, `bad_envelope`, ...), `viewerHandle` (the account the library is bound to), `lastPage` (`hasMore`, `itemsDelivered`, `declaredTotal`) and `drift` (unknown fields / bad records: the "TikTok changed something" signal). Type in `src/platforms/capture-protocol.ts` |
| `startSync({ mode? })` | `SyncState` | `mode`: `'incremental'` (default) or `'full'`. **BUSY** if a sync is running. See section 3a |
| `pauseSync()` / `resumeSync()` / `cancelSync()` | `SyncState` | see section 3a |
| `getSyncStatus()` | `SyncState` | the current (or last) run |
| `getAccount(platform)` | `AccountRef \| null` | who the library belongs to: `{ platform, handle, id? }`. `null` until the first capture. Wipe clears it |
| `getSettings()` / `setSettings(patch)` | `Settings` | answered by the service worker; see section 3b |
| `upsertBatch`, `reconcile` | | extension-internal (capture/sync). **UIs must not call these.** |

Requests are handled **one at a time, in order**, by the database owner.

## 3a. Sync (M4)

Sync is **user-initiated only**. It opens a dedicated browser window on the platform, scrolls the saved list and then each collection the way a person would (a random 0.7 to 1.5 s pause before every scroll), and the extension reads what the platform's own page loads. It never runs by itself.

- Every sync call returns the new `SyncState` (`src/core/sync/types.ts`). The service worker also **broadcasts** it to extension pages on every change: `chrome.runtime.onMessage` receives `{ target: 'sync-progress', state }` (`SyncProgressMessage` in `protocol.ts`). Ignore a state whose `seq` is lower than one you already showed. `getSyncStatus()` reads it any time (open your UI mid-run and call it once).
- `state.status`: `idle` | `running` | `paused` | `needs_attention` | `completed` | `failed` | `cancelled`.
- **`needs_attention`** means the sync stopped until something is fixed. `state.attention = { reason, message, at }`; `message` is ready to show. Reasons: `login_required`, `captcha`, `wrong_account`, `not_own_profile`, `tab_hidden` (**clears itself** when the sync window is visible again), `tab_closed`, `stalled` (the list did not load: the user can open it in the sync window and the sync **continues by itself**, or press Resume), `blocked`, `open_collections` (continues by itself when the list arrives). For the others, show the message and a **Resume** button (`resumeSync`); `cancelSync` always works.
- **Progress:** `state.phase` (`start` | `saved` | `collections` | `done`), `state.saved = { pages, items, inserted, done }`, `state.collections[] = { id, name, status: pending|active|done|skipped, pages, items, declaredTotal? }`, `state.totals` (pages, items, **inserted = new videos**, reindexed). A good headline: "Collection 2 of 4: Recipes, 31 new videos so far."
- **`state.mode`** may differ from `state.requestedMode`: an incremental request runs as a full pass until one full pass has completed (`warnings` says so). An incremental pass stops the saved list after two pages with nothing new; a full pass also marks videos that are no longer saved as unavailable and drops memberships that no longer exist.
- `state.warnings[]` are things to tell the user after a run (a list that could not be read completely, a refusal to mark videos unavailable). `state.error` is set when `status === 'failed'`.
- The sync window is the extension's to manage: it closes itself when the run ends. Do not open or navigate it from the UI. **The sync window must stay visible** (a hidden window stalls scrolling; the sync notices and waits).
- **Wiping or importing cancels a run in progress.**

## 3b. Settings (M6)

Three preferences, stored by the service worker in `chrome.storage.local`, so any UI (and the next browser session) sees the same values:

| Key | Values | Default |
|---|---|---|
| `relatedWords` | `true` / `false`: new categories also match related words | `true` |
| `sort` | `relevance` / `recently_saved` / `newest` / `most_viewed`: the sort the UI starts with | `relevance` |
| `pageSize` | `10` / `30` / `50` / `100`: videos per page | `30` |

`getSettings()` returns all three. `setSettings(patch)` takes any subset, **ignores unknown keys and invalid values one by one** (a bad value never blocks a good one, and never damages what is stored) and returns the full result. Nothing is stored that is not on this list. The reference panel reads them before its first search, saves a change the moment the user makes it (a failed save is silent: a preference is not worth an error), and applies `pageSize` as the `limit` of every search.

## 4. Search: three calls, not one (accepted decision)

The first paint must be fast, so search is split. This is a contract you build to, not an implementation detail.

```
user presses Search
  ├─ search(req)         -> results, capped total, suggested chips      render immediately
  ├─ getChipInfo(req)    -> per-chip counts, related terms, did-you-mean   fill in chip badges when it arrives
  └─ explainMatch(...)   -> why ONE result matched                         only when the user expands a row
```

**The UI owns the chip list. The backend is stateless.** Every call sends the full list of chips; "remove a chip and search again" is just a new request with fewer chips.

```ts
const chips: Chip[] = [{ id: 'c1', text: 'food' }, { id: 'c2', text: 'makeup' }];
const res = await api.search({ requestId: crypto.randomUUID(), chips, mode: 'all' });
```

Behaviour to implement (this is the product spec from the brief, as agreed):

1. Typing does **not** search. Enter/comma turns text into a chip; the **Search** button (or Enter on an empty input) runs it. Any text left in the input is committed as a chip first.
2. **Pressing x on a chip only edits the chip list. Results do not change until Search is pressed again.** Show a "filters changed, press Search" indicator while the list differs from the last-searched one.
3. Chips combine with **AND** by default. `mode: 'any'` is supported; a UI toggle is optional.
4. Empty chip list + Search = browse everything, newest saved first.
5. `SearchResponse.tooBroad === true` (more than 10,000 matches): relevance ranking is skipped and results are newest-saved first. **Tell the user to add chips to narrow.** Show the total as "10,000+" when `totalIsCapped`. In this mode the list is newest-saved among the videos that match the chips' **own words** (related terms are left out, which is what keeps it fast); `orderedBy` says `recently_saved`. Paging continues through `nextCursor` as usual.
6. `ChipInfo.count === 0` for a chip means that chip alone matches nothing: flag it ("remove this chip?") and show `didYouMean` if present as a **suggestion**, never auto-applied.
7. `suggestedChips` are one-click "+ chip" hints. Adding one must **not** trigger a search.
8. **Cancellation:** use a new `requestId` for each search *cycle* (`search` and its `getChipInfo` share one). A newer cycle supersedes older ones: an older search still waiting in the queue is answered `SUPERSEDED` without touching the database. A search that has already started still finishes, so **also ignore any response whose `requestId` is not the latest** in your own code.
9. Chip text is free-form (any language, emoji, `#tag`, `@name` all fine; a leading `#` or `@` is dropped, since v1 treats them as plain text). Cleanup is done server-side; reject empty text and cap at 64 chars / 20 chips in the UI so users get instant feedback (the reference panel keeps its own copy of the two limits in `src/ui/state/query.ts`, so it imports no runtime code from `core/`; the backend enforces the same limits with `BAD_REQUEST`).
10. **Related terms are shared across chips.** With 1 or 2 chips each chip may use up to 30 related terms; with more chips the same budget (60 terms) is split, so five chips get 12 each. `getChipInfo.expandedTerms` always shows the terms actually used, so a tooltip is never wrong.
11. **A chip with CJK text or emoji** (`メイク`, `🍝`) matches by substring instead of by word, and cannot be ranked by relevance: such a search is ordered newest-saved (`orderedBy: 'recently_saved'`). It is also slower (see `docs/SEARCH_PERFORMANCE.md`), so a spinner is appropriate.
12. `nextCursor` carries the total from the first page, so later pages are cheap and `total` stays constant while paging.

## 5. Data facts your UI has to respect

- **Never render captured text as HTML.** Captions, authors and collection names are untrusted. `HighlightSegment[]` is structured, not markup.
- **Thumbnails expire in about two days** (TikTok's signed URLs). Always render a placeholder and fall back to it on an image error; never treat a failed image as an app error.
- **Declared totals are unreliable.** A collection may claim 48 videos and we hold 45. Show what we hold (`itemsSeen`) and, if you like, "3 unavailable". Do not show an error.
- `StoredItem.available === false` means the video vanished or went private at the last complete sync. It is kept, not deleted.
- **A video that was unsaved on the platform** stays in the library with `available === false` after a full sync. **A collection deleted on the platform is not removed** (see DECISIONS.md), and its videos keep the membership until the library is wiped.
- **Photo posts** (`mediaType: 'photo'`, ~22% of a real library) have no `durationSec`.
- **`savedAt` is an estimate**, with provenance in `savedAtSource`: `interpolated` (coarse: days to months), `first_seen` (a NEW save at the head of the list, dated by when it was first seen: accurate to the sync interval), `exact`, `unknown` (the times only keep the ORDER, e.g. the oldest page of the list: do not show a date). Don't display it as a precise timestamp unless the source is `exact`; "saved about March" is honest.
- **`ResultItem.url`** is the link back to the original post, built by the platform's adapter (`canonicalUrl`). Use it as-is, open it in a new tab with `rel="noopener noreferrer"`, and show no link when it is absent (an adapter that cannot build one costs that result its link, never the search its results). Do not build links from author + id in the UI, and never hard-code a platform.
- Times are epoch **milliseconds**.

## 6. Building the UI without the extension running (mocks)

```ts
import { createClient } from '<repo>/src/extension/rpc/client';
import { RPC_VERSION } from '<repo>/src/extension/rpc/protocol';

const mock = createClient(async (req) => {
  if (req.method === 'search')
    return { v: RPC_VERSION, id: req.id, ok: true, result: { requestId: req.params.requestId, results: [], total: 0, totalIsCapped: false, tookMs: 1, orderedBy: 'relevance', tooBroad: false, suggestedChips: [] } };
  return { v: RPC_VERSION, id: req.id, ok: false, error: { code: 'NOT_IMPLEMENTED', message: 'mock' } };
});
```

`src/platforms/tiktok/fixtures/` holds realistic (synthetic) payloads if you need sample data shapes, and `bench/synth.ts` generates a seeded library of any size.

## 7. Versioning

`RPC_VERSION` (currently **1**) bumps on any breaking change to the envelope or a method's shape. `ping()` returns it; a UI should refuse to run against a different major version and say so. Additive changes (new optional fields, new methods) do not bump it.

## 8. What the UI must not do

No matching, ranking, SQL, related-term lookup, date parsing, or platform-specific logic. If you find yourself wanting one of those, it is a missing method in this contract: ask for it here.
