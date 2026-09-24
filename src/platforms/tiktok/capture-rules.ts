// What may be read from TikTok's web app, and nothing else.
//
// The page also makes calls for the user's own uploads, reposts, stories, playlists and other tabs (seen in M0:
// /api/post/item_list/, /api/repost/item_list/, /api/story/item_list/, /api/user/playlist/ ...). Those are out of scope and
// more private than what was asked for, so they are NEVER forwarded: an unlisted path is dropped inside the page's own hook,
// before anything crosses into the extension.

import type { CaptureRule } from '../types';

export const TIKTOK_ORIGIN = 'https://www.tiktok.com';

export type TikTokKind = 'favorites' | 'collection_items' | 'collection_list' | 'collection_detail';

export const TIKTOK_CAPTURE_RULES: readonly (CaptureRule & { kind: TikTokKind })[] = [
  { kind: 'favorites', path: '/api/user/collect/item_list/' },
  { kind: 'collection_items', path: '/api/collection/item_list/' },
  { kind: 'collection_list', path: '/api/user/collection_list/' },
  { kind: 'collection_detail', path: '/api/collection/detail/' },
];

export interface ClassifiedRequest {
  kind: TikTokKind;
  /** Digits only, at most 16. Anything else is dropped rather than forwarded. */
  requestCursor?: string;
  /** Digits only, at most 24. */
  collectionId?: string;
}

const DIGITS_16 = /^\d{1,16}$/;
const DIGITS_24 = /^\d{1,24}$/;

/**
 * Decide whether a request is one we may read, and extract the ONLY request values we ever forward (the cursor and the
 * collection id, both digits-only). Every other parameter (device ids, tokens, signatures, ...) is ignored here and never
 * leaves this function. `input` may be a string, URL or Request-like object; anything unparseable is simply "not ours".
 * Pure: safe to call from the page's fetch/XHR wrappers, which must never throw.
 */
export function classifyRequest(input: unknown, baseOrigin: string = TIKTOK_ORIGIN): ClassifiedRequest | null {
  let raw: string;
  if (typeof input === 'string') raw = input;
  else if (input instanceof URL) raw = input.href;
  else if (input !== null && typeof input === 'object' && typeof (input as { url?: unknown }).url === 'string') raw = (input as { url: string }).url;
  else return null;
  let u: URL;
  try { u = new URL(raw, baseOrigin); } catch { return null; }
  if (u.origin !== TIKTOK_ORIGIN) return null;
  const rule = TIKTOK_CAPTURE_RULES.find((r) => r.path === u.pathname);
  if (!rule) return null;
  const cursor = u.searchParams.get('cursor');
  const collectionId = u.searchParams.get('collectionId');
  const out: ClassifiedRequest = { kind: rule.kind };
  if (cursor !== null && DIGITS_16.test(cursor)) out.requestCursor = cursor;
  if (collectionId !== null && DIGITS_24.test(collectionId)) out.collectionId = collectionId;
  return out;
}
