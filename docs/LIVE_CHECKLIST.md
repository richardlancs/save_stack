# Live checklist: what only your real TikTok account can confirm

Everything in Scroganize was built and tested against a **mock TikTok** that reproduces the response shapes and quirks observed in M0 (`docs/TIKTOK_FINDINGS.md`). Your real account was never touched during the build. This list is the short set of things the mock cannot prove. Each item says what to do, what you should see, and what to tell me if it does not match. Nothing here deletes anything on TikTok; the extension only reads.

Status legend: `[ ]` not yet checked, `[x]` confirmed, `[!]` did not match (write what happened next to it).

## 0. Set-up

- [ ] `npm run build`, then in Chrome open `chrome://extensions`, turn on Developer mode, **Load unpacked**, choose `.output/chrome-mv3`.
- [ ] Be signed in to TikTok in that Chrome profile. Use your own account only.
- [ ] Click the Scroganize toolbar button: the side panel opens. Optional: start from an empty library (the panel's footer, "Wipe library", asks twice).

## 1. Passive capture (M3)

Browse your own profile's **Favorites** the way you normally would, scroll a little, open a collection.

- [ ] **Videos arrive.** The panel's video count grows as you browse and the videos are searchable. For the details: open `chrome://extensions`, click "service worker" under Scroganize, and in its console run `(await chrome.storage.local.get('scroganize.captureStatus'))['scroganize.captureStatus']`. Look at `pages`, `items`, `rejected`, `viewerHandle`.
- [ ] **Nothing is refused for your own pages.** `rejected` should be empty. If you see `identity_unknown`, `not_own_profile` or `owner_mismatch` while on your own profile, the identity checks read the site differently than assumed: tell me which, and the URL you were on.
- [ ] **Identity source.** Confirm the page's `__UNIVERSAL_DATA_FOR_REHYDRATION__` script still contains `webapp.app-context.user.uniqueId` (your handle) and `.uid` (a long number). (`viewerId` in the status should be that number.)
- [ ] **Other people are refused.** Open someone else's profile or public collection: the status must not gain any of their videos (`rejected.not_own_profile` goes up).
- [ ] **Drift.** `drift.unknownItemKeys` lists item fields the parser does not know. A few new keys are normal; please send me the list. `drift.badRecords` should be 0 or tiny.
- [ ] **Collection list vs items.** Open a collection page directly (paste its URL). Its videos should show as members of that collection. (Also checks whether the site loads the collection's items before or after its details; the extension handles either order.)
- [ ] **Order and dates.** Newest-saved order should match the order TikTok lists your favorites. Dates are estimates (see UI contract section 5); the oldest page's videos are labelled `unknown` on purpose.
- [ ] **Empty pages.** A collection with no videos, if you have one, should not raise `bad_envelope` in `rejected`.
- [ ] **Thumbnails.** Re-open a favorites tab a day later: thumbnails should refresh.

## 2. Sync (M4)

Press **Sync** in the side panel (tick "Full re-sync" for a full pass). Watch the sync window; **do not minimise or cover it.**

- [ ] **The window opens on the TikTok home page and finds who you are** (not "login required" while you are signed in).
- [ ] **It reaches your Favorites list by itself.** The URL used is `https://www.tiktok.com/@you?tab=favorites`; the driver also tries to click a Favorites tab (`data-e2e="favorites-tab"`). If the list does not load, the sync stops with "The list did not load. Open it yourself in the sync window ..." and continues by itself once you click Favorites. **Please tell me which of these happened**, and, if you had to click, what the tab's HTML looks like (right-click, Inspect) so the selector can be fixed.
- [ ] **The collection list arrives.** If the sync asks you to "open the collections view", tell me where that view is on your profile.
- [ ] **Each collection opens from its URL.** The URL is built as `/@you/collection/<name-slug>-<id>`. If a collection page does not open, tell me what the address bar shows for a collection you open by hand.
- [ ] **Pace.** It should scroll like a person: a pause of about a second between scrolls, roughly one new page every 1 to 3 seconds. TikTok should not ask for a captcha during a normal sync. If it does, the sync stops and says so; solve it in the sync window and press Resume.
- [ ] **Completion.** When it finishes: the number of videos and collections matches your app (a few "unavailable" is normal: TikTok silently drops deleted videos, `docs/TIKTOK_FINDINGS.md` section 3.1). Note the declared-vs-stored totals for each collection.
- [ ] **A second sync is incremental and quick** (it should stop after two pages with nothing new).
- [ ] **Save one new video on TikTok, then run an incremental sync.** It should appear at the top of "recently saved".
- [ ] **Un-save a video on TikTok, then run a FULL sync.** It should become unavailable (kept, never deleted).
- [ ] **Pause, Resume and Cancel** behave, and the window closes when the run ends.
- [ ] **Programmatic scrolling in a visible window really loads pages** (M0 could only test a hidden tab, where it did not). If the driver's scrolling does not load more pages the sync reports "stalled": tell me, and I will add the wheel-event fallback tuning.
- [ ] **A hidden window** (minimise it): the sync should stop and say the window is hidden, then continue when you bring it back.
- [ ] **Account with private collections / thousands of favorites:** does anything time out or challenge? (M0 only inspected one account.)
- [ ] **The unresolved M0 question:** `collection_list.total` said 6 while 5 collections were listed. Is there a hidden or private collection? (The extension leaves unlisted collections alone on purpose.)

## 3. The side panel (M5, M6)

The panel was tested in a real Chromium against the mock, so this list is about what only your library shows.

- [ ] **The toolbar button opens the panel** and it opens on "everything you saved, newest first".
- [ ] **Search feels right on YOUR videos.** Try 3 to 5 categories you actually use (food, makeup, travel, workout ...). Are the first results the ones you expected? Anything obviously missing, or obviously wrong? (`docs/RELATED_TERMS.md` lists the related words behind each category: mark the ones you disagree with.)
- [ ] **Chips.** Enter and comma make a chip; the x changes nothing until you press Search, and the panel says so.
- [ ] **"Why this matched"** on a result explains itself sensibly.
- [ ] **Open** takes you to the right video on TikTok (the link is built from the author and video id).
- [ ] **Thumbnails.** Fresh ones show; old ones (about two days) fall back to a placeholder without any error.
- [ ] **Preferences** (related words, sort, results per page) are still set after closing and reopening the panel.
- [ ] **Export, then Import** on a scratch copy of your library restores the same numbers. (Import replaces the whole library.)
- [ ] **Dates.** A video's "saved" date is an estimate; the newest saves should sort first. Note any video whose position looks wrong.

## 4. What to send me

For anything marked `[!]`: what you did, what you saw, the console output of `(await chrome.storage.local.get(['scroganize.captureStatus','scroganize.sync.state']))`, and, for selector or URL problems, the relevant snippet of the page's HTML. Please do not send your cookies, tokens or account data.
