// What sync needs to know about TikTok: where its lists live, what kind of page the sync window is on, and whether that page is the
// real one, a challenge, or a login wall. Pure, so it is unit-tested; the in-page driver only gathers the facts (PageSnapshot).
//
// UNVERIFIED against the live site (docs/LIVE_CHECKLIST.md, section "sync"): the exact URL that opens the Favorites list, the
// selectors below, and how the collections list is reached. Every one of them has a fallback that hands control to the user
// instead of failing silently: an unloaded list stalls, the sync asks for attention, and it continues by itself as soon as the
// user opens the list and pages start arriving.

import type { CaptureRole, PageSnapshot, PageState, PageView, SyncPageSpec, SyncPlatformSpec } from '../../core/sync/types';
import { TIKTOK_ORIGIN } from './capture-rules';
import { pageHandleFromPath } from './page-identity';

const slug = (name: string): string => {
  const s = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return s.length > 0 ? s : 'collection';
};

const roles: Record<string, CaptureRole> = {
  favorites: 'saved',
  collection_items: 'collection',
  collection_list: 'collections',
  collection_detail: 'collection_info',
};

/** CSS selectors the driver tests to build a PageSnapshot. Names are the keys of `PageSnapshot.present`. */
export const TIKTOK_PROBES: Record<string, string> = {
  captcha: '#captcha_container, .captcha_verify_container, [class*="captcha-verify"], [id*="captcha"] iframe, iframe[src*="captcha"]',
  loginModal: '[data-e2e="login-modal"], [id*="login-modal"], [data-e2e="modal-close-inner-button"]',
};

/** Controls a person would click to reveal the list, tried once by the driver when the list does not appear by itself (best effort). */
export const TIKTOK_REVEAL_SAVED: string[] = ['[data-e2e="favorites-tab"]', '[role="tab"][data-e2e*="favorite"]', 'p[data-e2e="favorites-tab"]'];

export function tiktokPageState(s: PageSnapshot): PageState {
  if (s.present.captcha) return 'captcha';
  if (s.present.loginModal) return 'login';
  if (/please wait/i.test(s.title)) return 'interstitial';
  if (!s.hasBootstrap) return 'unknown';
  return 'ok';
}

export function tiktokClassifyPage(s: PageSnapshot): PageView {
  const path = s.pathname;
  const collection = /^\/@([^/]+)\/collection\/[^/]*?(\d{6,})\/?$/.exec(path);
  if (collection) {
    const pageHandle = pageHandleFromPath(path);
    return { kind: 'collection', ...(pageHandle ? { pageHandle } : {}), collectionId: collection[2]! };
  }
  if (/^\/@[^/]+\/?$/.test(path)) {
    const pageHandle = pageHandleFromPath(path);
    return { kind: 'profile', ...(pageHandle ? { pageHandle } : {}) };
  }
  if (path === '/' || path === '/foryou' || path === '/following' || path === '/explore') return { kind: 'home' };
  return { kind: 'other' };
}

export const TIKTOK_SYNC: SyncPlatformSpec = {
  platform: 'tiktok',
  homeUrl: `${TIKTOK_ORIGIN}/`,
  savedUrl: (handle) => `${TIKTOK_ORIGIN}/@${encodeURIComponent(handle)}?tab=favorites`,
  collectionUrl: (handle, c) => `${TIKTOK_ORIGIN}/@${encodeURIComponent(handle)}/collection/${slug(c.name)}-${encodeURIComponent(c.id)}`,
  roles,
};

export const TIKTOK_PAGE_SPEC: SyncPageSpec = {
  detectPageState: tiktokPageState,
  classifyPage: tiktokClassifyPage,
  probes: TIKTOK_PROBES,
  revealSavedSelectors: TIKTOK_REVEAL_SAVED,
};
