# Milestone gates

After every milestone the same gate is run before the next one starts. This file records what was actually re-run, the numbers, and **every problem the gate found**, including the ones that were my own mistakes.

**The gate (8 steps):** (1) typecheck + every test; (2) mutation spot-checks (break critical logic on purpose; every break must be caught); (3) regression: ingest benchmark and the real-extension e2e; (4) production build check (exact permissions/CSP, no test hook, no remote code, size); (5) acceptance re-read against fresh evidence; (6) hygiene (leak scan, `git status`, docs re-derived from the code); (7) independent code review of the diff; (8) this record.

Commands: `npm run gate` runs steps 1, 3 and 4 plus the search benchmark; `npm run mutate` is step 2; step 7 is the `code-review` skill.

---

## M2: Search. Gate: **PASSED**

| Step | Result |
|---|---|
| 1. Typecheck + tests | clean; **148 tests, 9 files** (storage contract, SQLite specifics, RPC, search units, search integration, substring, search gate, review-fix regressions) |
| 2. Mutation checks | **27 of 27 caught** (`scripts/mutation-check.mjs`): planner (hashtag concatenation, prefix, AND/OR, related-terms budget), search (tier 2, LIKE escaping, saved-at ordering, cursor total, cursor sort, too-broad threshold, own-words `d:` cursor, >500 hashtag and collection matches, `raw_json` hydration), service (noise hashtags, did-you-mean, duplicate chips), expander cap, CJK routing, chip de-duplication, vocabulary cache invalidation, search gate, RPC error mapping, plus 3 from M1 |
| 3. Regression | `bench:ingest`: 4,927 items/s in memory. `e2e:storage` on real OPFS: **ALL CHECKS PASSED**; ingest through the real path 3,153 items/s (budget 2,000; end-to-end including my Playwright harness 1,588); restart durability, offscreen recovery and wipe all pass; 6 search workloads return results **identical to the in-memory engine**; `SUPERSEDED` verified in the real worker |
| 3b. Search benchmark | 15 of 18 search workloads within the 50 ms p95 budget, the tightest (5 broad chips ANY) at 49 ms; **3 documented exceptions** (CJK 66, emoji 60, mixed 90 ms; ceiling 120). Details in `SEARCH_PERFORMANCE.md` |
| 4. Production build | `npm run check:build` passes: permissions exactly `[offscreen, unlimitedStorage]`, no host permissions, no content scripts, CSP unchanged, no test hook, no remote code; 1.34 MB total, 0.51 MB excluding the wasm (budget 3 MB) |
| 5. Acceptance re-read | see below |
| 6. Hygiene | leak scan of 67 files: no handle, real collection name, or token (the word "eats" is an ordinary lexicon term); docs re-derived: lexicon = 87 categories / 167 aliases / ≤ 30 terms, labeled quality = 96.3% recall / 90.8% precision, "food" exact-only 17% vs 100% with related terms |
| 7. Independent code review | 7 findings, **all 7 verified real and fixed** with regression tests |

### Acceptance re-read (prompt §12 M2)

- *Chip normalization, planner AND/OR, related terms, ranker, attribution, `chipInfo`/`didYouMean`, `suggestedChips`, substring fallback, cancellation:* all implemented and tested.
- *All unit tests green including the precision/recall test:* yes (recall 96.3%, precision 90.8%, every category ≥ 70% recall).
- *Search budget met on 50k:* **mostly, not entirely.** 15 of 18 workloads meet p95 < 50 ms. The three exceptions are CJK/emoji substring searches; they are held to a looser ceiling and documented rather than hidden.
- *The three methods live:* yes, through the real extension.
- Non-goals re-read: no semantic/embedding search, no LLM, no remote code, no network. Privacy: nothing leaves the machine.

### Problems the gate found (none hidden)

1. **A superseded search was not dropped by the real worker.** My in-process unit test passed because it faked the message ordering; only the real-extension e2e failed. Root cause: a busy worker cannot dispatch later messages, so an older queued search ran before the newer one registered. Fixed with a gate that yields one event-loop turn (`rpc/search-gate.ts`), plus a unit test that models the busy worker.
2. **A mutation escaped:** ordering "recently saved" by `id` instead of `saved_at` broke nothing, because every fixture saved videos in insertion order. A test where they disagree was added and now catches it.
3. **My first query rewrite made things slower.** Comparing runs across a noisy machine misled me twice; interleaved in-process A/B measurement showed which shapes really won, and the losing ones were removed (`SEARCH_PERFORMANCE.md`).
4. **The hand-labeled set showed the "pets" category was too thin** (6 of 9); fixed in the lexicon.
5. **The code review's 7 findings** (see `SEARCH_PERFORMANCE.md`): the most serious were silent truncation of substring matches beyond 500 hashtags/collections, duplicate chips getting no `chipInfo`/`explainMatch` entry, and cursors not tied to their sort.
6. Two of my own mutation-runner targets went stale after refactors; the runner refused to silently no-op and failed loudly, as designed.
7. Bash rejected long inline scripts three times (quoting); nothing was applied on those failures, and the edits were redone with file-based tools.

### Known limits carried forward

- Related-term quality is a judgment call until you review `related-terms.json` (a review table is generated in M6).
- The 60-term budget trades a little recall on many-chip queries for bounded latency.
- Benchmarks are on synthetic data on a shared, noisy machine.
