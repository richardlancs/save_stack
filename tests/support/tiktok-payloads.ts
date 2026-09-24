// Builders for TikTok-shaped API payloads, reconstructed from the structure observed in M0 (docs/TIKTOK_FINDINGS.md).
// Real field names, types, nesting and optional-field patterns; every VALUE is synthetic. Shared by:
//   scripts/make-tiktok-fixtures.ts (writes src/platforms/tiktok/fixtures/*.json), the parser tests, and the mock TikTok
// server used by the end-to-end capture tests, so none of them can drift from one another.
// Deterministic: no randomness, no clock.

export const NOW_MS = 1_787_000_000_000; // fixed "server time"
const url = (kind: string, n: number | string) => `https://example.invalid/${kind}/${n}`;
export const pad = (n: number, len: number) => '7' + String(n).padStart(len - 1, '0');
const str = (n: number) => String(n);

export interface Author { n: number; id: string; uniqueId: string; nickname: string; secUid: string }
export const AUTHORS: Author[] = [1, 2, 3, 4, 5].map((n) => ({
  n,
  id: pad(100 + n, 19),
  uniqueId: `author_${String(n).padStart(3, '0')}`,
  nickname: `Nickname ${n}`,
  secUid: `SECUID_${n}`,
}));

/** Build hashtag textExtra + caption with consistent offsets. */
export function caption(base: string, tags: string[], mention?: string) {
  let text = base;
  const extra: Array<Record<string, unknown>> = [];
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

export interface ItemOptions {
  author?: number;
  desc?: string;
  tags?: string[];
  mention?: string;
  kind?: 'video' | 'photo';
  isAd?: boolean;
  lang?: string;
  createTime?: number;
  duration?: number;
  imageTitle?: string;
  omitChallenges?: boolean;
  omitTextExtra?: boolean;
  omitContents?: boolean;
  omitDuet?: boolean;
}

/** One item as returned by both /api/user/collect/item_list/ and /api/collection/item_list/. Optional keys are omitted the way TikTok omits them. */
export function item(n: number, o: ItemOptions = {}): Record<string, any> {
  const author = AUTHORS[o.author ?? ((n % AUTHORS.length) + AUTHORS.length) % AUTHORS.length]!; // (non-positive numbers are used by tests for "newer than everything")
  const id = pad(1000 + n, 19);
  const tags = o.tags ?? [`tag${n}`, 'fyp'];
  const cap = caption(o.desc === undefined ? `Sample caption ${n}` : o.desc, tags, o.mention);
  cap.extra.forEach((e) => { if (e.type === 1) e.awemeId = id; });
  const m = Math.abs(n);
  const stats = { collectCount: 100 * m, commentCount: 10 * m, diggCount: 1000 * m, playCount: 10000 * m, shareCount: 50 * m };
  const s2 = Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, str(v)]));
  const photo = o.kind === 'photo';
  const it: Record<string, any> = {
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
      encodedType: 'normal', format: 'mp4', height: 576, id, originCover: url('originCover', n), playAddr: url('play', n), ratio: '540p',
      size: 561625, videoQuality: 'normal', volumeInfo: {}, width: 576, zoomCover: {}, PlayAddrStruct: {},
    },
  };
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

export const itemId = (n: number): string => pad(1000 + n, 19);
export const collectionId = (i: number): string => pad(500 + i, 19);

export const extra = (now = NOW_MS) => ({ fatal_item_ids: [], logid: 'FAKELOGID0000', now });
export const envelope = { log_pb: { impr_id: 'FAKELOGID0000' }, statusCode: 0, status_code: 0, status_msg: '' };

export function page(cursor: string, hasMore: boolean, items: unknown[], more: Record<string, unknown> = {}) {
  return { cursor, extra: extra(), hasMore, itemList: items, ...envelope, ...more };
}

export function coll(i: number, name: string, total: number, status = 1, userName = 'testuser') {
  return { collectionId: collectionId(i), cover: { urlList: [url('collCover', i), url('collCover2', i), url('collCover3', i)] }, name, status, total: str(total), userId: pad(99, 19), userName };
}

export function collectionList(list: ReturnType<typeof coll>[], cursor = String(list.length + 1), total = list.length + 1) {
  return { collectionList: list, cursor, extra: extra(), hasMore: false, ...envelope, total };
}

export function collectionDetail(c: ReturnType<typeof coll>) {
  return { collectionInfo: { collectionId: c.collectionId, cover: { urlList: [url('collCover', 1)] }, name: c.name, status: c.status, total: c.total, userId: c.userId, userName: c.userName }, extra: { logid: 'FAKELOGID0000', now: NOW_MS }, ...envelope };
}
