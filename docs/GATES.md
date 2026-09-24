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

---

## M3 to M6: capture, sync, side panel, hardening. Gate: **PASSED** (run once, on the final tree)

M3, M4, M5 and M6 were built in one continuous run and each got its own end-to-end suite and review while it was built, but they share files (the RPC protocol, the service worker, the manifest, the docs), so they are gated and committed together. Every number below is from the final `npm run gate` run alone on the machine (exit 0).

| Step | Result |
|---|---|
| 1. Typecheck + tests | clean; **613 tests, 28 files** (was 148 at M2): adapter/parser fixtures and a 6,000-payload fuzzer, capture pipeline (real SQLite), hook transparency, relay, router, sync state machine (incl. 300 random-event runs), coordinator with fakes (incl. "service worker killed and restarted"), Chrome-env fakes, panel state and static component rendering, settings, the architecture rules |
| 2. Mutation checks | **143 of 143 caught** (`npm run mutate`, about an hour). The full run caught 141; **two escaped and were fixed with tests, then re-run individually and caught**: nothing checked that the pipeline passes the sender's tab to the sync, and nothing checked that result rows are rebuilt for a new search |
| 3. Regression | `bench:ingest` 4,915 items/s in memory. `e2e:storage` on real OPFS, **29 checks**: 3,053 items/s through service worker -> offscreen -> worker (budget 2,000; 1,548 end to end including my Playwright harness); cold start 990 ms, 734 ms with the 60 MB database; offscreen recovery 185 ms; data survives a browser restart. **`e2e:capture` 61 checks, `e2e:sync` 61 checks, `e2e:panel` 49 checks: all pass**, all hermetic |
| 3b. Search benchmark | 15 of 18 workloads within 50 ms p95 (tightest 47.8 ms); the same **3 documented exceptions** as M2 (CJK 57, emoji 61, mixed 94 ms; ceiling 120). Calibration probe 23 ms |
| 3c. Panel cold open | 61, 66 and 68 ms from navigation to the first result (budget 300) |
| 3d. Memory (reported) | 701 MB working set over the 10 processes of the headless test browser with 50,000 videos stored; its renderers, one of which is the offscreen document holding the database, are 117, 87, 83 and 49 MB. The number includes the browser and GPU processes of a test Chromium, so it is an upper bound |
| 4. Production build | `check:build` passes: permissions exactly `[offscreen, unlimitedStorage, storage, alarms, sidePanel]`, no host permissions, CSP unchanged, no test hook, no "force hidden" switch, no announcement to the page, content-script limits; **1.46 MB total, 0.63 MB excluding the 0.83 MB wasm** (budget 3 MB) |
| 5. Acceptance re-read | see below |
| 6. Hygiene | leak scan of the 157 committable files: no handle, no real collection name, no token (the only hits are obviously fake `sessionid=SECRET...` strings in the tests that prove cookies are never forwarded, and the origin repository's name); `git status` reviewed; docs re-derived from the code (permissions, test counts, budgets) |
| 7. Independent code review | **two passes.** Pass 1 (M3): 15 findings, all real, all fixed. Pass 2 (M4, M5, M6): 15 findings, **all 15 real (most of them reproduced by driving the real coordinator and UI code), all fixed** with regression tests |
| 8. This record | |

### Acceptance re-read (prompt §12, M3 to M6, and §14)

- **M3 capture:** the MAIN-world hook, relay, tolerant parser and pipeline into the database exist and pass fixtures, fuzzing and a hermetic end to end. *"Browsing my collections on real TikTok populates the DB (verified with me)" is NOT verified: I never touched your account. `docs/LIVE_CHECKLIST.md` section 1 is that verification.*
- **M4 sync:** pacing, incremental and full modes, pause/resume/cancel, persisted state, service-worker-killed resume: all verified end to end against the mock. *"Live smoke on my account" is likewise `docs/LIVE_CHECKLIST.md` section 2.*
- **M5 panel:** the interaction of §8.2 works end to end (chips, staged removal with "Filters changed", All/Any, per-chip counts and did-you-mean, why-this-matched, suggested chips, sync card, empty state, footer, light/dark, aria-live). `ui/` imports nothing from `core/` or `platforms/` at runtime, and that is a test. **Deviations:** results are paged ("Show more"), not virtualized (a decision, `DECISIONS.md`); the link to the video is built by the backend (`ResultItem.url`).
- **M6:** error and empty states, drift banner, export/import/wipe, preferences, `ARCHITECTURE.md`, `ADDING_A_PLATFORM.md`, README, `GETTING_STARTED.md`, the related-terms review table. The performance bench in CI is reported, not blocking, and **the CI workflow itself has never run on a GitHub runner.**
- **§9 budgets:** search, ingest, bundle, panel cold open: met (search with the 3 documented exceptions). Idle memory: reported above.
- **§10 privacy:** stricter than asked: **no host permissions at all** (content scripts declared with `matches`), every permission justified in `DECISIONS.md`, no analytics, no remote code, nothing leaves the machine; the README states the Terms-of-Service caveat plainly.
- **§14 "no TikTok endpoint or field name in code that isn't backed by a fixture and `TIKTOK_FINDINGS.md`": met for capture and parsing; NOT met for sync navigation.** The URL that opens the Favorites list, the collection URL slug, the Favorites-tab selector and the captcha/login selectors are my best guesses, unverified against the live site. They are marked in the code, each has a fallback that hands control to the user instead of failing silently, and `LIVE_CHECKLIST.md` asks you for the facts.

### Problems the gate and the reviews found (none hidden)

1. **I touched the real tiktok.com while debugging M4.** A window opened by the extension itself bypassed Playwright's request interception and loaded the real site: anonymously, from a temporary profile with no login and no account, three page loads. The end-to-end runs are now hermetic (local HTTPS mock, every other host unresolvable) and each run first proves the real internet is unreachable.
2. **The mock crashed on "new saves"** (negative item numbers indexed an author list); the payload builder now wraps, and the fixtures regenerate byte-identical.
3. **Real bugs found by the M4 end to end and tests:** a new run kept the previous run's finish time and attention state; a retry counter reset by progress could loop forever (now separate counters); warnings and failures were dropped when they arrived in the same step that completed a run; the collection list was lost when it arrived while the sync waited for the user; **new saves dated by interpolation sorted below older videos** (now dated by first sight).
4. **M3 review (15):** a partial record blanked stored text; one message could insert 200,000 rows; the account binding kept in `chrome.storage` failed open (now enforced in the database, atomically with the write); fingerprint-based duplicate suppression cannot work on the real site (removed); a content script could reach export and wipe (router and offscreen document now refuse non-extension senders); memberships arriving before their collection were lost.
5. **M4 to M6 review (15), all fixed:** (a) a `running` sync survived a browser restart and would resume on its own, and its stale tab id could point at one of your tabs: the window record now belongs to a browser session and Resume is the only way back; (b) the first page after you opened a list by hand was not remembered for reconciliation, so its newest videos could be marked "no longer saved"; (c) **a forged "last page" from a web page could trigger a destructive reconcile, contradicting the trust model**: only the sync window's own tab moves a run, every collection now gets the same plausibility guard as the saved list, and the trust model text says exactly what remains; (d) any TikTok tab could feed the sync ("wrong page" from a bystander tab); (e) "Show more" could combine an old cursor with new chips; (f) row state (a dead thumbnail, an old "why") survived a new search; (g) wipe and import kept the "a complete pass ran" marker, so the next incremental sync could stop early on a partial library; (h) closing the sync closed the whole window, including your own tabs; (i) a failing per-chip info call replaced loaded results with an error; (j) punctuation-only chips passed the panel and failed the backend; (k) two preference changes at once could lose one (found again by a new e2e check, which fails without the fix); (l) a collection list longer than one page was silently treated as complete (now a warning); (m) the heartbeat alarm was restarted by every event; (n) a hidden window that was then closed was a dead end with only Cancel; (o) duplicate ids from a replayed page inflated the plausibility count.
6. **Found by my own definition-of-done audit, not by a reviewer:** the "related words" checkbox ignored the saved preference until a chip existed (caught by the new persistence e2e); pasting a list did not make chips (now does, with an e2e); the panel's cold open and the offscreen memory were never measured (now reported).
7. **Tooling mistakes, caught by the tooling:** two overlapping gate runs contaminated a benchmark (now one at a time); the mutation runner could not match multi-line targets in Windows (CRLF) files (now normalises and restores byte-exact); serialized test functions carry the bundler's helper names into the page (string scripts); Bash quoting ate backslashes in generated scripts three times (nothing was applied from a failed script).

### Known limits carried forward

- **Everything that only your real account can confirm** is in `docs/LIVE_CHECKLIST.md`; until then the sync's navigation is unverified and TikTok can change its site at any time (the panel then says "TikTok changed something").
- **Related-term quality** is a judgment call until you review `docs/RELATED_TERMS.md` (87 categories).
- **Saved dates are estimates** (interpolated between cursors, or by first sight for new saves; the oldest page has order only).
- **Forged messages:** any script running on tiktok.com can post a capture-shaped message; the defence is limits, not secrecy (`ARCHITECTURE.md`, section 3). A forged first message can pin the account binding to a bogus account (wipe recovers).
- **A collection list longer than one page** only produces a warning; the scroll-the-collections-view behaviour is unverified.
- **CJK, emoji and mixed searches** exceed 50 ms at 50,000 videos (documented; ceiling 120 ms).
- **CI** (`.github/workflows/ci.yml`) mirrors the gate but has never run on a GitHub runner.
- Benchmarks are synthetic, on a shared machine that had an unrelated background job running.
