// TikTok response parsing. PURE and TOTAL: whatever the input, `parseTikTokCapture` returns and never throws.
//
// Design (docs/TIKTOK_FINDINGS.md §2):
//   * every field except the video id is optional (observed presence from 0.2% to 100%)
//   * numbers arrive as numbers OR numeric strings; times are epoch SECONDS; photo carousels have video.duration = 0
//   * declared totals are unreliable, so completion is `hasMore === false`, never a count comparison
//   * bad records are dropped and reported, never allowed to sink a page; unknown fields are reported so a platform
//     change shows up as a warning instead of silently degrading results
// Hand-written readers instead of a schema library: the requirement is "never throw, drop and count", which is exactly
// what these small coercions do, and it adds nothing to the service-worker bundle.

import type { Collection, Membership, ParsedBatch, SavedItem } from '../../core/model';
import type { PageInfo, ParseProblem, ParsedCapture, RawCapture, ShapeReport } from '../types';
import { estimateSavedAt } from './saved-at';

/** Parser version: bump when the understanding of TikTok's payloads changes. Recorded with drift reports. */
export const TIKTOK_PARSER_VERSION = 1;

const MAX_PROBLEMS = 50;
const MAX_CAPTION = 10_000;
const MAX_TAGS = 64;
const MAX_TAG_LENGTH = 100;
const MAX_COLLECTION_NAME = 200;
const MAX_UNKNOWN_KEYS = 30;
const MAX_UNKNOWN_KEY_LENGTH = 64;
/** Real pages carry 15 to 30 items (a collection list is a handful). Anything past these caps is dropped, so one message can never flood the library. */
const MAX_ITEMS_PER_PAGE = 300;
const MAX_COLLECTIONS_PER_PAGE = 500;

/** Item keys seen in the real payloads (M0). Anything else is reported as `unknownItemKeys`. */
export const KNOWN_ITEM_KEYS: ReadonlySet<string> = new Set([
  'AIGCDescription', 'CategoryType', 'IsHDBitrate', 'ShowAIGC', 'author', 'authorStats', 'authorStatsV2', 'backendSourceEventTracking',
  'collected', 'createTime', 'creatorAIComment', 'desc', 'digged', 'duetDisplay', 'forFriend', 'id', 'isAd', 'isProhibited', 'isReviewing',
  'itemCommentStatus', 'item_control', 'music', 'officalItem', 'originalItem', 'privateItem', 'secret', 'shareEnabled', 'stats', 'statsV2',
  'stitchDisplay', 'textLanguage', 'textTranslatable', 'video',
  'challenges', 'contents', 'diversificationId', 'duetEnabled', 'effectStickers', 'penaltyContext', 'stitchEnabled', 'textExtra',
  'videoSuggestWordsList', 'aigcLabelType', 'imagePost', 'titleLanguage', 'titleTranslatable', 'playlistId', 'poi', 'anchors',
  'stickersOnItem', 'adAuthorization', 'warnInfo', 'repostList', 'itemMute', 'BAInfo', 'adLabelVersion',
]);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined);
const asNum = (v: unknown): number | undefined => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? n : undefined; }
  return undefined;
};
const clean = (s: string | undefined, max: number): string | undefined => {
  if (s === undefined) return undefined;
  const t = s.trim().slice(0, max);
  return t === '' ? undefined : t;
};
const httpsUrl = (v: unknown): string | undefined => (typeof v === 'string' && v.startsWith('https://') && v.length <= 2048 ? v : undefined);

/** Hashtags from the structured fields, falling back to `#tag` in the caption when TikTok omitted them (15% of items have no `challenges`). */
function extractHashtags(raw: Record<string, unknown>, caption: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (t: string | undefined) => {
    const v = t?.trim().replace(/^#+/, '').toLowerCase().slice(0, MAX_TAG_LENGTH);
    if (v && !seen.has(v) && out.length < MAX_TAGS) { seen.add(v); out.push(v); }
  };
  for (const c of asArr(raw.challenges)) if (isObj(c)) add(asStr(c.title));
  for (const t of asArr(raw.textExtra)) if (isObj(t) && t.type !== 0) add(asStr(t.hashtagName));
  if (out.length === 0) for (const m of caption.matchAll(/#([\p{L}\p{N}_]+)/gu)) add(m[1]);
  return out;
}

interface ParsedItem {
  item: SavedItem;
  keys: string[];
  missing: string[];
}

function parseItem(raw: unknown): ParsedItem | string {
  if (!isObj(raw)) return 'item is not an object';
  const id = asStr(raw.id);
  if (id === undefined || !/^\d{5,30}$/.test(id)) return 'item has no usable id';

  const author = isObj(raw.author) ? raw.author : {};
  const music = isObj(raw.music) ? raw.music : {};
  const video = isObj(raw.video) ? raw.video : {};
  const stats = isObj(raw.stats) ? raw.stats : {};
  const stats2 = isObj(raw.statsV2) ? raw.statsV2 : {};
  const imagePost = isObj(raw.imagePost) ? raw.imagePost : undefined;
  const contents0 = asArr(raw.contents)[0];

  // `desc` present (even '') is the caption; absent means "not provided", which storage treats as "keep what is already stored".
  const descRaw = asStr(raw.desc) ?? (isObj(contents0) ? asStr(contents0.desc) : undefined);
  const caption = descRaw === undefined ? undefined : descRaw.slice(0, MAX_CAPTION);
  const photo = imagePost !== undefined;
  const duration = asNum(video.duration);
  const created = asNum(raw.createTime);
  const views = asNum(stats.playCount) ?? asNum(stats2.playCount);
  const likes = asNum(stats.diggCount) ?? asNum(stats2.diggCount);
  const comments = asNum(stats.commentCount) ?? asNum(stats2.commentCount);
  const shares = asNum(stats.shareCount) ?? asNum(stats2.shareCount);
  const saves = asNum(stats.collectCount) ?? asNum(stats2.collectCount);
  const language = clean(asStr(raw.textLanguage), 8);
  const cover = isObj(imagePost?.cover) && isObj((imagePost!.cover as Record<string, unknown>).imageURL)
    ? asArr(((imagePost!.cover as Record<string, unknown>).imageURL as Record<string, unknown>).urlList)[0]
    : undefined;

  const item: SavedItem = {
    platform: 'tiktok',
    externalId: id,
    authorHandle: clean(asStr(author.uniqueId), 64) ?? '',
    authorName: clean(asStr(author.nickname), 100),
    caption,
    // undefined only when the record offers nothing to derive tags from (no caption, no challenges, no textExtra)
    hashtags: caption === undefined && !Array.isArray(raw.challenges) && !Array.isArray(raw.textExtra) ? undefined : extractHashtags(raw, caption ?? ''),
    soundTitle: clean(asStr(music.title), 200),
    soundAuthor: clean(asStr(music.authorName), 100),
    mediaType: photo ? 'photo' : 'video',
    durationSec: !photo && duration !== undefined && duration > 0 ? Math.round(duration) : undefined,
    postedAt: created !== undefined && created > 0 ? Math.round(created > 1e11 ? created : created * 1000) : undefined,
    stats: [views, likes, comments, shares, saves].some((v) => v !== undefined) ? { views, likes, comments, shares, saves } : undefined,
    thumbnailUrl: httpsUrl(video.cover) ?? httpsUrl(video.originCover) ?? httpsUrl(cover) ?? httpsUrl(video.dynamicCover),
    language: language === 'un' ? undefined : language, // 'un' = TikTok could not tell
    isAd: raw.isAd === true,
  };

  const missing: string[] = [];
  if (typeof raw.desc !== 'string') missing.push('desc');
  if (asStr(author.uniqueId) === undefined) missing.push('author.uniqueId');
  if (created === undefined) missing.push('createTime');
  if (views === undefined && likes === undefined) missing.push('stats');
  if (!isObj(raw.video)) missing.push('video');
  if (asStr(music.title) === undefined) missing.push('music.title');
  return { item, keys: Object.keys(raw), missing };
}

/** An explicit "nothing more, no error" answer that simply leaves the list out: an empty page, not a malformed one. */
const emptyPage = (body: Record<string, unknown> | undefined): boolean =>
  body !== undefined && body.hasMore === false && (body.statusCode === undefined || body.statusCode === 0);

const emptyShape = (): ShapeReport => ({ items: 0, unknownItemKeys: [], missing: {} });

function parseItemList(capture: RawCapture, kind: 'favorites' | 'collection_items'): ParsedCapture {
  const problems: ParseProblem[] = [];
  const shape = emptyShape();
  const body = isObj(capture.body) ? capture.body : undefined;
  const list = body && Array.isArray(body.itemList) ? body.itemList : emptyPage(body) ? [] : undefined;
  const page: PageInfo = {
    kind,
    hasMore: typeof body?.hasMore === 'boolean' ? body.hasMore : null,
    requestCursor: capture.requestCursor,
    responseCursor: asStr(body?.cursor),
    itemsDelivered: 0,
    declaredTotal: asNum(body?.total),
    collectionId: capture.collectionId,
  };
  const batch: ParsedBatch = { items: [], syncedAt: capture.capturedAt };
  if (!list) {
    problems.push({ code: 'bad_envelope', message: 'response has no itemList array' });
    return { batch, page, problems, shape };
  }

  const unknown = new Set<string>();
  const seen = new Set<string>();
  const parsed: SavedItem[] = [];
  if (list.length > MAX_ITEMS_PER_PAGE) problems.push({ code: 'bad_record', message: `page has ${list.length} items; only the first ${MAX_ITEMS_PER_PAGE} were read` });
  list.slice(0, MAX_ITEMS_PER_PAGE).forEach((raw, index) => {
    const r = parseItem(raw);
    if (typeof r === 'string') { if (problems.length < MAX_PROBLEMS) problems.push({ code: 'bad_record', message: r, index }); return; }
    if (seen.has(r.item.externalId)) return; // the same video twice in one page: keep the first
    seen.add(r.item.externalId);
    parsed.push(r.item);
    shape.items++;
    for (const k of r.keys) if (!KNOWN_ITEM_KEYS.has(k) && unknown.size < MAX_UNKNOWN_KEYS) unknown.add(k.slice(0, MAX_UNKNOWN_KEY_LENGTH));
    for (const m of r.missing) shape.missing[m] = (shape.missing[m] ?? 0) + 1;
  });
  shape.unknownItemKeys = [...unknown].sort();
  page.itemsDelivered = parsed.length;

  if (kind === 'favorites') {
    // no saved time exists per video: estimate it from this page's cursors (see saved-at.ts)
    // When the page's lower bound is unknown (the last or only page) the times only preserve ORDER, so they are labelled 'unknown'.
    // The first page of the list (cursor 0) is its newest end: what is new there is a new save (see ParsedBatch.headOfList).
    if (capture.requestCursor === undefined || capture.requestCursor === '0') batch.headOfList = true;
    const est = estimateSavedAt(parsed.length, capture.requestCursor, page.responseCursor, capture.capturedAt);
    parsed.forEach((it, i) => { it.savedAt = est.times[i]; it.savedAtSource = est.bounded ? 'interpolated' : 'unknown'; });
  } else {
    // a collection page says nothing about WHEN: mark it 'unknown' so the favorites-based estimate can replace it
    parsed.forEach((it) => { it.savedAt = capture.capturedAt; it.savedAtSource = 'unknown'; });
    if (!capture.collectionId) {
      problems.push({ code: 'missing_collection_id', message: 'collection page arrived without its collection id; videos stored, memberships skipped' });
    } else {
      const offset = Number(capture.requestCursor ?? '0') || 0; // collection cursors are OFFSETS
      const memberships: Membership[] = parsed.map((it, i) => ({ platform: 'tiktok', itemExternalId: it.externalId, collectionExternalId: capture.collectionId!, position: offset + i }));
      batch.memberships = memberships;
    }
  }
  batch.items = parsed;
  return { batch, page, problems, shape };
}

function parseCollectionList(capture: RawCapture): ParsedCapture {
  const problems: ParseProblem[] = [];
  const body = isObj(capture.body) ? capture.body : undefined;
  const list = body && Array.isArray(body.collectionList) ? body.collectionList : emptyPage(body) ? [] : undefined;
  const page: PageInfo = {
    kind: 'collection_list',
    hasMore: typeof body?.hasMore === 'boolean' ? body.hasMore : null,
    requestCursor: capture.requestCursor,
    responseCursor: asStr(body?.cursor),
    itemsDelivered: 0,
    declaredTotal: asNum(body?.total),
  };
  const batch: ParsedBatch = { items: [], syncedAt: capture.capturedAt };
  if (!list) {
    problems.push({ code: 'bad_envelope', message: 'response has no collectionList array' });
    return { batch, page, problems, shape: emptyShape() };
  }
  const collections: Collection[] = [];
  let owner: string | undefined;
  if (list.length > MAX_COLLECTIONS_PER_PAGE) problems.push({ code: 'bad_record', message: `page has ${list.length} collections; only the first ${MAX_COLLECTIONS_PER_PAGE} were read` });
  list.slice(0, MAX_COLLECTIONS_PER_PAGE).forEach((raw, index) => {
    const c = isObj(raw) ? raw : undefined;
    const id = asStr(c?.collectionId);
    const name = clean(asStr(c?.name), MAX_COLLECTION_NAME);
    if (!c || id === undefined || !/^\d{1,30}$/.test(id) || name === undefined) {
      if (problems.length < MAX_PROBLEMS) problems.push({ code: 'bad_record', message: 'collection has no usable id or name', index });
      return;
    }
    owner ??= clean(asStr(c.userName), 64);
    collections.push({ platform: 'tiktok', externalId: id, name, declaredTotal: asNum(c.total) });
  });
  batch.collections = collections;
  page.itemsDelivered = collections.length;
  return { batch, page, ownerHandle: owner, problems, shape: emptyShape() };
}

function parseCollectionDetail(capture: RawCapture): ParsedCapture {
  const problems: ParseProblem[] = [];
  const body = isObj(capture.body) ? capture.body : undefined;
  const info = body && isObj(body.collectionInfo) ? body.collectionInfo : undefined;
  const page: PageInfo = { kind: 'collection_detail', hasMore: null, itemsDelivered: 0, collectionId: capture.collectionId };
  const batch: ParsedBatch = { items: [], syncedAt: capture.capturedAt };
  const id = asStr(info?.collectionId);
  const name = clean(asStr(info?.name), MAX_COLLECTION_NAME);
  if (!info || id === undefined || !/^\d{1,30}$/.test(id) || name === undefined) {
    problems.push({ code: 'bad_envelope', message: 'response has no usable collectionInfo' });
    return { batch, page, problems, shape: emptyShape() };
  }
  batch.collections = [{ platform: 'tiktok', externalId: id, name, declaredTotal: asNum(info.total) }];
  page.itemsDelivered = 1;
  page.declaredTotal = asNum(info.total);
  return { batch, page, ownerHandle: clean(asStr(info.userName), 64), problems, shape: emptyShape() };
}

/** Never throws. An unrecognised kind or a malformed body yields an empty batch and a `bad_envelope` problem. */
export function parseTikTokCapture(capture: RawCapture): ParsedCapture {
  try {
    switch (capture.kind) {
      case 'favorites': return parseItemList(capture, 'favorites');
      case 'collection_items': return parseItemList(capture, 'collection_items');
      case 'collection_list': return parseCollectionList(capture);
      case 'collection_detail': return parseCollectionDetail(capture);
      default:
        return { batch: { items: [], syncedAt: capture?.capturedAt }, page: { kind: String(capture?.kind), hasMore: null, itemsDelivered: 0 }, problems: [{ code: 'bad_envelope', message: `unknown capture kind "${String(capture?.kind)}"` }], shape: emptyShape() };
    }
  } catch (e) {
    // Defence in depth: the readers above are written not to throw, but a parser bug must never take the capture pipeline down.
    return { batch: { items: [], syncedAt: capture?.capturedAt }, page: { kind: String(capture?.kind), hasMore: null, itemsDelivered: 0 }, problems: [{ code: 'bad_envelope', message: `parser error: ${(e as Error)?.message ?? e}` }], shape: emptyShape() };
  }
}
