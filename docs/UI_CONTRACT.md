# UI contract (v0, written in M1)

For whoever builds the real UI. The side panel in the repo (M5) is a throwaway test harness; **this document, plus the files it points to, is the actual interface.** You should never need to read `src/core/` internals, and your UI must not import from `src/core/` or `src/platforms/` (types excepted).

## 1. Status: what works today

| Area | Status |
|---|---|
| Storage, ingest, stats, export/import, wipe | **Works** (M1) |
| `search`, `getChipInfo`, `explainMatch` | **Works** (M2). Measured against a 50,000-video library: see `docs/SEARCH_PERFORMANCE.md` |
| Sync controls | `NOT_IMPLEMENTED` until M4 |
| Settings | `NOT_IMPLEMENTED` until M6 |

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
- Every call returns a promise. Failures throw `RpcCallError` with a `code`: `BAD_REQUEST` (your bug; for search this includes an empty chip, a chip over 64 characters, more than 20 chips, or a bad `mode`/`sort`/`limit`/`cursor`), `SUPERSEDED` (a newer search replaced this one before it ran: **not an error to show**, just ignore it; `isSuperseded(e)` in `client.ts`), `NOT_IMPLEMENTED` (later milestone), `UNAVAILABLE` (database not reachable / failed to start; retry or show "open the extension again"), `INTERNAL` (operation failed; message is safe to log).
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
| `startSync/pauseSync/resumeSync/cancelSync` | `null` | **M4** |
| `getSettings/setSettings` | `Settings` | **M6** |
| `upsertBatch`, `reconcile` | | extension-internal (capture/sync). **UIs must not call these.** |

Requests are handled **one at a time, in order**, by the database owner.

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
9. Chip text is free-form (any language, emoji, `#tag`, `@name` all fine; a leading `#` or `@` is dropped, since v1 treats them as plain text). Cleanup is done server-side; reject empty text and cap at 64 chars / 20 chips in the UI so users get instant feedback (`src/core/search/chips.ts` has `validateChipText`, `splitPasted`, `MAX_CHIPS`; it is pure, so importing it is fine).
10. **Related terms are shared across chips.** With 1 or 2 chips each chip may use up to 30 related terms; with more chips the same budget (60 terms) is split, so five chips get 12 each. `getChipInfo.expandedTerms` always shows the terms actually used, so a tooltip is never wrong.
11. **A chip with CJK text or emoji** (`メイク`, `🍝`) matches by substring instead of by word, and cannot be ranked by relevance: such a search is ordered newest-saved (`orderedBy: 'recently_saved'`). It is also slower (see `docs/SEARCH_PERFORMANCE.md`), so a spinner is appropriate.
12. `nextCursor` carries the total from the first page, so later pages are cheap and `total` stays constant while paging.

## 5. Data facts your UI has to respect

- **Never render captured text as HTML.** Captions, authors and collection names are untrusted. `HighlightSegment[]` is structured, not markup.
- **Thumbnails expire in about two days** (TikTok's signed URLs). Always render a placeholder and fall back to it on an image error; never treat a failed image as an app error.
- **Declared totals are unreliable.** A collection may claim 48 videos and we hold 45. Show what we hold (`itemsSeen`) and, if you like, "3 unavailable". Do not show an error.
- `StoredItem.available === false` means the video vanished or went private at the last complete sync. It is kept, not deleted.
- **Photo posts** (`mediaType: 'photo'`, ~22% of a real library) have no `durationSec`.
- **`savedAt` is an estimate**, with provenance in `savedAtSource`: `interpolated` (coarse: days to months), `first_seen` (accurate to the sync interval), `exact`, `unknown`. Don't display it as a precise timestamp unless the source is `exact`; "saved about March" is honest.
- The link to open a video is built from author + id: `https://www.tiktok.com/@{authorHandle}/video/{externalId}` (M3 exposes this per platform via `canonicalUrl`; do not hard-code TikTok in shared UI code).
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
