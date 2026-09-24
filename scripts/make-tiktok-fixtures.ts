/// <reference types="node" />
// Generates src/platforms/tiktok/fixtures/*.json.
//
// These are RECONSTRUCTED from the structure observed in M0 (docs/TIKTOK_FINDINGS.md): real field names, types,
// nesting, optional-field patterns and pagination quirks, but every value is synthetic. They are NOT raw captures.
// (Raw captures contain a real user's saved videos, authors and signed URLs, so none are stored in the repo.)
//
//   npm run fixtures:tiktok
//
// The builders live in tests/support/tiktok-payloads.ts, shared with the parser tests and the mock TikTok server.
import fs from 'node:fs';
import path from 'node:path';
import { coll, collectionDetail, collectionList, item, page, pad } from '../tests/support/tiktok-payloads';

const OUT = path.resolve('src/platforms/tiktok/fixtures');
fs.mkdirSync(OUT, { recursive: true });

const files: Record<string, unknown> = {};

// ---- flat favorites (Posts tab): cursor = epoch SECONDS of the last item's save time (strictly decreasing, "0" at the end)
files['favorites_item_list.page1.json'] = page('1750000000', true, [item(1), item(2, { kind: 'photo' }), item(3, { desc: 'Sample caption 3 with a much longer body '.repeat(5) }), item(4, { tags: ['a', 'b', 'c', 'd', 'e'] })], { total: 263 });
files['favorites_item_list.last_page.json'] = page('0', false, [item(5), item(6, { kind: 'photo', imageTitle: 'Sample photo title' })], { total: 263 });

// ---- edge cases seen in real data (all in one page so parser tests can iterate)
files['favorites_item_list.edge_cases.json'] = page('1740000000', true, [
  item(11, { desc: '', tags: [], omitChallenges: true, omitTextExtra: true }), // no caption, no hashtags, optional keys absent
  item(12, { tags: [], omitChallenges: true }), // no hashtags, textExtra still present
  item(13, { isAd: true }), // saved ad (14 of 227 in the real sample)
  item(14, { lang: 'un' }), // undetermined language (36 of 227)
  item(15, { desc: '日本語のサンプルキャプション', tags: ['タグ'] }), // CJK caption + CJK hashtag
  item(16, { desc: 'Sample caption 16 🍝', mention: 'author_002' }), // emoji + @mention (textExtra type 0)
  item(17, { kind: 'photo', omitDuet: true, omitContents: true }), // photo carousel: video.duration = 0, imagePost present
], { total: 263 });

// ---- collections
const list = [coll(1, 'Collection A', 48), coll(2, 'Collection B', 9), coll(3, 'Collection C', 37), coll(4, 'Collection D', 1, 0), coll(5, 'Collection E', 2)];
files['collection_list.json'] = collectionList(list, '6', 6); // quirk: cursor and total say 6, the list has 5
files['collection_detail.json'] = collectionDetail(list[0]!);

// ---- collection items: cursor = OFFSET (count=30), pages can be shorter than `count`, declared total > items delivered
files['collection_item_list.page1.json'] = page('30', true, [item(21), item(22), item(23, { kind: 'photo' })]); // real page: 28 items, cursor "30"
files['collection_item_list.last_page.json'] = page('48', false, [item(24), item(25)]); // real page: 17 items, cursor "48", hasMore=false, 45 of 48 delivered

// ---- signed-in user, from the page's hydration blob: __DEFAULT_SCOPE__['webapp.app-context'].user
files['hydration.app_context_user.json'] = { uid: pad(99, 19), uniqueId: 'testuser', nickName: 'Test User', secUid: 'SECUID_ME', hasCollectionsAccess: true, region: 'US' };

for (const [name, obj] of Object.entries(files)) fs.writeFileSync(path.join(OUT, name), JSON.stringify(obj, null, 2) + '\n');
console.log(`wrote ${Object.keys(files).length} fixtures to ${path.relative(process.cwd(), OUT)}`);
