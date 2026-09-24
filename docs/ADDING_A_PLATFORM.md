# Adding a platform

Everything platform-specific lives behind one interface, `PlatformAdapter` (`src/platforms/types.ts`). The database, search, capture pipeline, sync state machine and the UI know only `platform: string` and the normalised model, so adding a platform means writing an adapter and listing it in `src/platforms/registry.ts`. TikTok (`src/platforms/tiktok/`) is the reference implementation; `tests/platforms/contract.test.ts` runs a contract suite over every registered adapter plus a small fake `example` adapter that proves the core does not depend on TikTok.

## What an adapter provides

```ts
interface PlatformAdapter {
  id: string;                    // 'tiktok'. Stored on every item.
  displayName: string;
  parserVersion: number;         // bump when your understanding of the platform's payloads changes
  hostMatches: readonly string[];        // Chrome match patterns of the pages whose traffic is read
  captureRules: readonly CaptureRule[];  // { kind, path }: EXACT url paths of the responses that may be read
  parse(capture: RawCapture): ParsedCapture;   // PURE and TOTAL: never throws, whatever the input
  sync: SyncPlatformSpec & SyncPageSpec;       // where the lists live, how to tell what page it is (below)
  canonicalUrl(item): string;    // link back to the original post
}
```

### 1. `captureRules` and `parse` (passive capture)

- List the exact URL **paths** (no query) of the responses that carry the user's saved items, their collections, and each collection's items. Nothing outside these rules is ever read, forwarded or stored; the hook drops every other request inside the page before anything crosses into the extension. Give each rule a `kind` (your own vocabulary).
- Only digits-only values from the request may travel with a capture (a `cursor` and a `collectionId`). If your platform needs another request value, that is a design change to `capture-protocol.ts`, with a security argument.
- `parse` turns one response body into a `ParsedBatch` (`items`, `collections`, `memberships`) plus `PageInfo` (`hasMore`, cursors, counts) and problems. It must be **pure and total**: no `chrome.*`, no DOM, no clock, and it must not throw on any input. Drop bad records and report them; treat every field except the item id as optional; leave a field `undefined` when the record does not provide it (storage then keeps what it already holds); cap the number of items per page.
- Set `ParsedBatch.headOfList` on the page that holds the newest end of an ordered saved list, so new saves are dated by first sight (see `docs/DECISIONS.md`).
- For platforms that name the account a response belongs to, return `ownerHandle` so the pipeline can refuse another user's data.
- Fixtures: write reconstructed payloads with synthetic values (never commit raw captures, tokens or personal identifiers) and tests including a fuzz pass like `tests/platforms/tiktok-fuzz.test.ts`.

### 2. Identity

The pipeline needs to know who is signed in and whose page it is: the hook reports `pageHandle` (from the URL), `viewerHandle` and, ideally, a stable `viewerId`. Read them from the page's own data in the platform's MAIN-world entrypoint (see `tiktok-main.content.ts` and `platforms/tiktok/page-identity.ts`).

### 3. `sync` (active sync)

`SyncPlatformSpec`: `homeUrl`, `savedUrl(handle)`, `collectionUrl(handle, collection)` and `roles` mapping each capture `kind` to one of `saved`, `collections`, `collection`, `collection_info`. `SyncPageSpec`: pure `detectPageState(snapshot)` (`ok`, `login`, `captcha`, `interstitial`, `unknown`) and `classifyPage(snapshot)` (`home`, `profile`, `collection`, `other`), the CSS `probes` the in-page driver tests to build the snapshot, and best-effort selectors to reveal the saved list. Whatever you cannot verify against the live site must degrade into asking the user (a stalled list continues by itself once the user opens it).

### 4. Wiring

1. Add the adapter to `registry.ts`.
2. Add a manifest content-script entrypoint per world (`src/extension/entrypoints/<platform>-main.content.ts`, `-relay`, `-driver`) with the platform's `matches`; update `EXPECTED` in `scripts/check-build.mjs` (permissions and content scripts are asserted exactly) and justify any permission in `docs/DECISIONS.md`.
3. Add a mock of the platform to `e2e/` if you want end-to-end coverage (`e2e/mock-tiktok.ts` is the model: a local HTTPS server, hermetic).

## The contract test

`tests/platforms/contract.test.ts` checks, for every adapter in the registry and for the fake `example` adapter: unique id, every capture rule has a role, `parse` never throws on garbage and on mutated fixtures, output is bounded and serialisable, items never exceed the caps, `canonicalUrl` stays on the platform's own host, sync URLs cannot be steered off the platform by hostile names or ids, page classification is total. If your adapter passes it, the rest of the system will accept it.
