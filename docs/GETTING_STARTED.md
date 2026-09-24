# Getting started

## 1. Build and load it

```bash
npm install
npm run build
```

1. In Chrome open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and choose the folder `.output/chrome-mv3`.
3. Pin the Scroganize icon if you like. Clicking it opens the side panel.

Use a normal Chrome window where you are (or will be) signed in to TikTok with **your own** account.

## 2. Fill the library

There are two ways, and they combine.

**Just browse.** Open your TikTok profile, go to **Favorites**, scroll, open a collection. Every page TikTok loads for your own saved videos is read and stored automatically. Nothing happens on other people's pages.

**Press Sync** in the side panel. Scroganize opens a separate window on TikTok, finds who you are, then scrolls your Favorites list and each collection to the end at a human pace (about a second between scrolls). A progress bar shows where it is. Keep that window visible: a hidden window cannot be scrolled, and the sync will wait for you to bring it back. You can pause, resume or cancel at any time; if Chrome or the extension restarts in the middle, the sync continues where it stopped.

- The first sync reads everything. Later syncs are incremental: they stop after two pages with nothing new (so they take seconds).
- Tick **Full re-sync** now and then. It also notices videos you have un-saved on TikTok (they stay in the library, marked "No longer saved") and collection memberships that no longer exist.
- If TikTok asks for a verification (captcha) or you are signed out, the sync stops and tells you what to do. Fix it in the sync window and press **Resume**.

## 3. Search

- Type a category (`food`, `makeup`, `meal prep`, a hashtag, an author, a collection name) and press **Enter** (or type a comma). It becomes a chip under the search bar. Add as many as you like; pasting a list (separated by commas or one per line) makes one chip each.
- Press **Search**. With several chips, videos must match **all** of them by default; choose **Any category** to match at least one.
- **Include related words** (on by default) also finds close words: `food` finds `recipe`, `pasta`, `cooking`, and the panel shows which related words were used. The list is a plain data file you can edit (`src/core/search/related-terms.json`).
- Remove a chip with its ×. The results **do not change until you press Search**; the panel reminds you ("Filters changed").
- No chips means "everything you saved, newest first".
- Your choices for related words, the sort order and results per page are remembered the next time you open the panel.
- **Open** on a result takes you to the video on the original site.
- **Why this matched** on a result explains which field matched and through which word.
- If nothing matches, the panel tells you which category is the narrowest and suggests a correction for a typo ("Did you mean makeup?").
- More than 10,000 matches is "too broad": the newest are shown and you are asked to add a category.

## 4. Your data

- Everything is stored locally in this browser profile (origin-private storage). **Export** saves the whole library as a JSON file, **Import** replaces the library with an export, **Wipe library** deletes everything (it asks twice).
- The library belongs to **one TikTok account**. If a different account is signed in, captures and syncs refuse it (wipe the library first to switch accounts).
- Thumbnails expire after about two days (TikTok's own links). A missing thumbnail is normal; it refreshes when the video is read again.
- "Saved" dates are estimates: TikTok does not publish when you saved a video. Newly saved videos are dated when they were first seen; older ones show an approximate month, or nothing when only their order is known.

## 5. If something looks wrong

- **The sync stops with "The list did not load".** Open the Favorites tab yourself in the sync window; the sync continues by itself once videos start arriving. Tell the developer which page you were on (`docs/LIVE_CHECKLIST.md`).
- **"TikTok changed something, so some results may be incomplete."** TikTok added fields the extension has never seen. Search still works; some data may be missing until the parser is updated.
- **Nothing appears while browsing.** Make sure you are on your own profile and signed in; look at `chrome://extensions`, Scroganize, "service worker" for errors.
