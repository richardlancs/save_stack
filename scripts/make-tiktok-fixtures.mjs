// Generates src/platforms/tiktok/fixtures/*.json.
//
// These are RECONSTRUCTED from the structure observed in M0 (docs/TIKTOK_FINDINGS.md): real field names, types,
// nesting, optional-field patterns and pagination quirks, but every value is synthetic. They are NOT raw captures.
// (Raw captures contain a real user's saved videos, authors and signed URLs, so none are stored in the repo.)
//
//   node scripts/make-tiktok-fixtures.mjs
//
// The generated fixtures are used in unit tests and in the "tiktok" platform's mock server (for local development).
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('src/platforms/tiktok/fixtures');
fs.mkdirSync(OUT, { recursive: true });

const NOW_MS = 1_787_000_000_000; // fixed "server time"
const url = (kind, n) => `https://example.invalid/${kind}/${n}`;
const pad = (n, len) => '7' + String(n).padStart(len - 1, '0');
const str = (n) => String(n);

const AUTHORS = [1, 2, 3, 4, 5].map((n) => ({
  n,
  id: pad(100 + n, 19),
  uniqueId: `author_${String(n).padStart(3, '0')}`,
  nickname: `Nickname ${n}`,
  secUid: `SECUID_${n}`,
}));

/** Build hashtag textExtra + caption with consistent offsets. */
function caption(base, tags, mention) {
  let text = base;
  const extra = [];
  if (mention) {
    if (text) text += ' ';
    const start = text.length;
    text += `@${mention}`;
    extra.push({ end: text.length, isCommerce: false, start, subType: 0, type: 0, userId: pad(900, 19), userUniqueId: mention, secUid: 'SECUID_M' });
  }
  for (const t of tags) {
    if (text) text += ' ';
    const start = text.length;
    text += `#${t}`;
    extra.push({ awemeId: '', end: text.length, hashtagName: t, isCommerce: false, start, subType: 0, type: 1 });
  }
  return { text, extra };
}

/**
 * One item as returned by both /api/user/collect/item_list/ and /api/collection/item_list/.
 * `kind`: 'video' | 'photo'. Optional keys are omitted the way TikTok omits them.
 */
function item(n, o = {}) {
  const author = AUTHORS[o.author ?? (n % AUTHORS.length)];
  const id = pad(1000 + n, 19);
  const tags = o.tags ?? [`tag${n}`, 'fyp'];
  const cap = caption(o.desc === undefined ? `Sample caption ${n}` : o.desc, tags, o.mention);
  cap.extra.forEach((e) => { if (e.type === 1) e.awemeId = id; });
  const stats = { collectCount: 100 * n, commentCount: 10 * n, diggCount: 1000 * n, playCount: 10000 * n, shareCount: 50 * n };
  const s2 = Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, str(v)]));
  const photo = o.kind === 'photo';
  const it = {
    AIGCDescription: '',
    CategoryType: 0,
    IsHDBitrate: false,
    ShowAIGC: false,
    author: {
      avatarLarger: url('avatarLarger', author.n), avatarMedium: url('avatarMedium', author.n), avatarThumb: url('avatarThumb', author.n),
      commentSetting: 0, downloadSetting: 0, duetSetting: 0, ftc: false, id: author.id, isADVirtual: false, isEmbedBanned: false,
      nickname: author.nickname, openFavorite: false, privateAccount: false, relation: 0, secUid: author.secUid, secret: false,
      shortDramaCreator: {}, signature: '', stitchSetting: 0, uniqueId: author.uniqueId, verified: author.n === 2,
    },
    authorStats: { diggCount: 0, followerCount: 1000 * author.n, followingCount: 10, friendCount: 5, heart: 90000 * author.n, heartCount: 90000 * author.n, videoCount: 40 },
    authorStatsV2: { diggCount: '0', followerCount: str(1000 * author.n), followingCount: '10', friendCount: '5', heart: str(90000 * author.n), heartCount: str(90000 * author.n), videoCount: '40' },
    backendSourceEventTracking: '',
    collected: true,
    createTime: o.createTime ?? 1_780_000_000 - n * 86400,
    creatorAIComment: {},
    desc: cap.text,
    digged: false,
    duetDisplay: 0,
    forFriend: false,
    id,
    isAd: !!o.isAd,
    isProhibited: false,
    isReviewing: false,
    itemCommentStatus: 0,
    item_control: {},
    music: {
      authorName: `Sound Author ${author.n}`, coverLarge: url('musicLarge', n), coverMedium: url('musicMedium', n), coverThumb: url('musicThumb', n),
      duration: 30, id: pad(2000 + n, 19), isCopyrighted: true, is_commerce_music: false, is_unlimited_music: false, original: n % 2 === 0,
      playUrl: url('musicPlay', n), private: false, shoot_duration: 30, title: `Sound ${n}`, tt2dsp: {},
    },
    officalItem: false,
    originalItem: false,
    privateItem: false,
    secret: false,
    shareEnabled: true,
    stats,
    statsV2: { ...s2, repostCount: '0' },
    stitchDisplay: 0,
    textLanguage: o.lang ?? 'en',
    textTranslatable: true,
    video: {
      VQScore: '55.10', bitrate: 280000, bitrateInfo: [], claInfo: {}, codecType: 'h264', cover: url('cover', n), definition: '540p',
      downloadAddr: url('download', n), duration: photo ? 0 : (o.duration ?? 15 + n), dynamicCover: url('dynamicCover', n), encodeUserTag: '',
      encodedType: 'normal', format: 'mp4', height: 576, id: id, originCover: url('originCover', n), playAddr: url('play', n), ratio: '540p',
      size: 561625, videoQuality: 'normal', volumeInfo: {}, width: 576, zoomCover: {}, PlayAddrStruct: {},
    },
  };
  // optional keys: present on most items but not all
  if (!o.omitChallenges) it.challenges = tags.map((t, i) => ({ coverLarger: '', coverMedium: '', coverThumb: '', desc: '', id: pad(3000 + n * 10 + i, 19), profileLarger: '', profileMedium: '', profileThumb: '', title: t }));
  if (!o.omitTextExtra) it.textExtra = cap.extra;
  if (!o.omitContents) it.contents = [{ desc: cap.text, textExtra: cap.extra }];
  if (!o.omitDuet) { it.duetEnabled = true; it.stitchEnabled = true; }
  it.diversificationId = 10000 + n;
  it.penaltyContext = {};
  it.videoSuggestWordsList = {};
  it.effectStickers = [];
  it.stickersOnItem = [];
  if (photo) {
    it.imagePost = {
      cover: { imageURL: { urlList: [url('imageCover', n), url('imageCover2', n)] }, imageHeight: 1080, imageWidth: 1080 },
      images: [1, 2, 3].map((k) => ({ imageHeight: 1080, imageURL: { urlList: [url(`image${k}`, n), url(`image${k}b`, n)] }, imageWidth: 1080 })),
      shareCover: { imageURL: { urlList: [url('shareCover', n)] } },
      title: o.imageTitle ?? '',
    };
    it.titleLanguage = 'en';
    it.titleTranslatable = true;
    it.poi = { address: 'REDACTED', city: 'REDACTED', name: 'REDACTED' };
    it.playlistId = '';
  }
  if (o.isAd) it.adAuthorization = { reason: 'REDACTED' };
  return it;
}

const extra = (extraNow = NOW_MS) => ({ fatal_item_ids: [], logid: 'FAKELOGID0000', now: extraNow });
const envelope = { log_pb: { impr_id: 'FAKELOGID0000' }, statusCode: 0, status_code: 0, status_msg: '' };
const page = (cursor, hasMore, items, more = {}) => ({ cursor, extra: extra(), hasMore, itemList: items, ...envelope, ...more });

const files = {};

// ---- flat favorites (Posts tab): cursor = epoch SECONDS of the last item's save time (strictly decreasing, "0" at the end)
files['favorites_item_list.page1.json'] = page('1750000000', true, [item(1), item(2, { kind: 'photo' }), item(3, { desc: 'Sample caption 3 with a much longer body '.repeat(5) }), item(4, { tags: ['a', 'b', 'c', 'd', 'e'] })], { total: 263 });
files['favorites_item_list.last_page.json'] = page('0', false, [item(5), item(6, { kind: 'photo', imageTitle: 'Sample photo title' })], { total: 263 });

// ---- edge cases seen in real data (all in one page so parser tests can iterate)
files['favorites_item_list.edge_cases.json'] = page('1740000000', true, [
  item(11, { desc: '', tags: [] , omitChallenges: true, omitTextExtra: true }),                     // no caption, no hashtags, optional keys absent
  item(12, { tags: [], omitChallenges: true }),                                                      // no hashtags, textExtra still present
  item(13, { isAd: true }),                                                                           // saved ad (14 of 227 in the real sample)
  item(14, { lang: 'un' }),                                                                           // undetermined language (36 of 227)
  item(15, { desc: '日本語のサンプルキャプション', tags: ['タグ'] }),                                    // CJK caption + CJK hashtag
  item(16, { desc: 'Sample caption 16 🍝', mention: 'author_002' }),                                 // emoji + @mention (textExtra type 0)
  item(17, { kind: 'photo', omitDuet: true, omitContents: true }),                                    // photo carousel: video.duration = 0, imagePost present
], { total: 263 });

// ---- collections
const coll = (i, name, total, status = 1) => ({ collectionId: pad(500 + i, 19), cover: { urlList: [url('collCover', i), url('collCover2', i), url('collCover3', i)] }, name, status, total: str(total), userId: pad(99, 19), userName: 'testuser' });
files['collection_list.json'] = {
  collectionList: [coll(1, 'Collection A', 48), coll(2, 'Collection B', 9), coll(3, 'Collection C', 37), coll(4, 'Collection D', 1, 0), coll(5, 'Collection E', 2)],
  cursor: '6', // quirk: cursor and total say 6, list has 5
  extra: extra(), hasMore: false, ...envelope, total: 6,
};
files['collection_detail.json'] = { collectionInfo: { collectionId: pad(501, 19), cover: { urlList: [url('collCover', 1)] }, name: 'Collection A', status: 1, total: '48', userId: pad(99, 19), userName: 'testuser' }, extra: { logid: 'FAKELOGID0000', now: NOW_MS }, ...envelope };

// ---- collection items: cursor = OFFSET (count=30), pages can be shorter than `count`, declared total > items delivered
files['collection_item_list.page1.json'] = page('30', true, [item(21), item(22), item(23, { kind: 'photo' })]);       // real page: 28 items, cursor "30"
files['collection_item_list.last_page.json'] = page('48', false, [item(24), item(25)]);                            // real page: 17 items, cursor "48", hasMore=false, 45 of 48 delivered

// ---- signed-in user, from the page's hydration blob: __DEFAULT_SCOPE__['webapp.app-context'].user
files['hydration.app_context_user.json'] = { uid: pad(99, 19), uniqueId: 'testuser', nickName: 'Test User', secUid: 'SECUID_ME', hasCollectionsAccess: true, region: 'US' };

for (const [name, obj] of Object.entries(files)) fs.writeFileSync(path.join(OUT, name), JSON.stringify(obj, null, 2) + '\n');
console.log(`wrote ${Object.keys(files).length} fixtures to ${path.relative(process.cwd(), OUT)}`);
