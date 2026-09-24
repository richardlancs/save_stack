# UI contract (v0, written in M1)

For whoever builds the real UI. The side panel in the repo (M5) is a throwaway test harness; **this document, plus the files it points to, is the actual interface.** You should never need to read `src/core/` internals, and your UI must not import from `src/core/` or `src/platforms/` (types excepted).

## 1. Status: what works today

| Area | Status |
|---|---|
| Storage, ingest, stats, export/import, wipe | **Works** (M1) |
| `search`, `getChipInfo`, `explainMatch` | **Contract fixed, returns `NOT_IMPLEMENTED`** until M2. Mock them meanwhile (§6) |
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
- Every call returns a promise. Failures throw `RpcCallError` with a `code`: `BAD_REQUEST` (your bug), `NOT_IMPLEMENTED` (later milestone), `UNAVAILABLE` (database not reachable / failed to start; retry or show "open the extension again"), `INTERNAL` (operation failed; message is safe to log).
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
| `search(req)` | `SearchResponse` | **M2** |
| `getChipInfo(req)` | `ChipInfoResponse` | **M2** |
| `explainMatch(req)` | `ExplainResponse` | **M2** |
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
5. `SearchResponse.tooBroad === true` (more than 10,000 matches): relevance ranking is skipped and results are newest-saved first. **Tell the user to add chips to narrow.** Show the total as "10,000+" when `totalIsCapped`.
6. `ChipInfo.count === 0` for a chip means that chip alone matches nothing: flag it ("remove this chip?") and show `didYouMean` if present as a **suggestion**, never auto-applied.
7. `suggestedChips` are one-click "+ chip" hints. Adding one must **not** trigger a search.
8. **Cancellation:** send a new `requestId` for each search; a newer request supersedes older ones and stale responses are never delivered. Ignore any response whose `requestId` is not the latest.
9. Chip text is free-form (any language, emoji, `#tag`, `@name` all fine). `normalizeHashtags`-style cleanup is done server-side; you only need to reject empty text and cap at 64 chars / 20 chips (M2 exports a `normalizeChip()` helper for instant validation).

## 5. Data facts your UI has to respect

- **Never render captured text as HTML.** Captions, authors and collection names are untrusted. `HighlightSegment[]` is structured, not markup.
- **Thumbnails expire in about two days** (TikTok's signed URLs). Always render a placeholder and fall back to it on an image error; never treat a failed image as an app error.
- **Declared totals are unreliable.** A collection may claim 48 videos and we hold 45. Show what we hold (`itemsSeen`) and, if you like, "3 unavailable". Do not show an error.
- `StoredItem.available === false` means the video vanished or went private at the last complete sync. It is kept, not deleted.
- **Photo posts** (`mediaType: 'photo'`, ~22% of a real library) have no `durationSec`.
- **`savedAt` is an estimate**, with provenance in `savedAtSource`: `interpolated` (coarse: days to months), `first_seen` (accurate to the sync interval), `exact`, `unknown`. Don't display it as a precise timestamp unless the source is `exact`; "saved about March" is honest.
- The link to open a video is built from author + id: `https://www.tiktok.com/@{authorHandle}/video/{externalId}` (M3 exposes this per platform via `canonicalUrl`; do not hard-code TikTok in shared UI code).
- Times are epoch **milliseconds**.

## 6. Building against the contract before M2 exists

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
