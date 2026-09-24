# Scroganize

Search the videos you saved on social media. Scroganize is a Chrome extension that reads **your own** saved videos and collections (TikTok first), keeps them in a fast local database on your machine, and lets you find them by typing categories such as `food` or `makeup` in a side panel.

- **Local only.** Nothing is uploaded and the extension makes no network requests of its own. The library lives in your browser's private storage.
- **Category search.** Type a category, press Enter, and it becomes a chip. Add as many as you like and press **Search**. `food` also finds `recipe`, `pasta`, and so on (a bundled, editable related-words list; no AI or network involved). Remove a chip with its ×, and the results only change when you press Search again.
- **Two ways in.** Just browse your own Favorites and collections on TikTok while signed in and videos appear in the library by themselves, or press **Sync** to have the extension read everything in a separate window at a human pace.
- **Built to be extended.** Everything TikTok-specific sits behind one adapter interface (`docs/ADDING_A_PLATFORM.md`), and the side panel is a thin, replaceable client of a documented API (`docs/UI_CONTRACT.md`).

## Read this first

- Scroganize reads **only the signed-in user's own saved data**, locally, at a human-like pace, and only when you press Sync (or browse your own pages yourself). It never reads other people's accounts.
- **Automated access may conflict with TikTok's Terms of Service.** Scroganize scrolls pages for you when you press Sync. You are responsible for how you use it. It is a personal tool, not a product, and is not affiliated with TikTok.
- The extension was developed and tested against a **mock** TikTok that reproduces the response shapes observed in a real session. What only your real account can confirm is listed in `docs/LIVE_CHECKLIST.md`. TikTok changes its site without notice; when it does, the panel says "TikTok changed something, so some results may be incomplete" instead of failing silently.

## Getting started

```bash
npm install
npm run build          # production build in .output/chrome-mv3
```

Chrome: open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and select `.output/chrome-mv3`. Sign in to TikTok in that browser, click the Scroganize icon to open the side panel, and press **Sync** (or browse your Favorites). Details: `docs/GETTING_STARTED.md`.

## For developers

| Command | What it does |
|---|---|
| `npm run typecheck` | TypeScript, strict |
| `npm test` | unit and contract tests (plain Node, real SQLite engine) |
| `npm run gate` | the full quality gate: typecheck, tests, ingest and search benchmarks, production build, build check, and the end-to-end runs against a mock TikTok in a real Chromium |
| `npm run mutate` | mutation spot-check: deliberately breaks critical logic and confirms the tests notice |
| `npm run e2e:storage`, `e2e:capture`, `e2e:sync`, `e2e:panel` | the individual end-to-end runs (hermetic: a local HTTPS mock, no real network) |
| `npm run check:build` | verifies the built extension (permissions, CSP, content scripts, no test hooks, size) |
| `npm run dev` | WXT dev mode with reload |

Documentation: `docs/ARCHITECTURE.md` (how it fits together and the trust model), `docs/DECISIONS.md` (every decision and why), `docs/UI_CONTRACT.md` (for building another UI), `docs/ADDING_A_PLATFORM.md`, `docs/SEARCH_PERFORMANCE.md`, `docs/GATES.md` (what was verified at each milestone), `docs/TIKTOK_FINDINGS.md` (what was observed on the real site), `docs/LIVE_CHECKLIST.md`.
