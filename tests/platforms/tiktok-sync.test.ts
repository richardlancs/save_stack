import { describe, expect, it } from 'vitest';
import type { PageSnapshot } from '../../src/core/sync/types';
import { TIKTOK_SYNC, tiktokClassifyPage, tiktokPageState } from '../../src/platforms/tiktok/sync';
import { TIKTOK_CAPTURE_RULES } from '../../src/platforms/tiktok/capture-rules';

const snap = (o: Partial<PageSnapshot> = {}): PageSnapshot => ({ pathname: '/@me', search: '', title: 'me | TikTok', hasBootstrap: true, present: {}, ...o });

describe('tiktok sync: urls', () => {
  it('builds the saved-list and collection urls on tiktok.com only', () => {
    expect(TIKTOK_SYNC.homeUrl).toBe('https://www.tiktok.com/');
    expect(TIKTOK_SYNC.savedUrl('test.user_1')).toBe('https://www.tiktok.com/@test.user_1?tab=favorites');
    expect(TIKTOK_SYNC.collectionUrl('me', { id: '7000000000000000501', name: 'Recipes & Ideas!' })).toBe('https://www.tiktok.com/@me/collection/recipes-ideas-7000000000000000501');
  });

  it('collection names that slugify to nothing still produce a usable url', () => {
    expect(TIKTOK_SYNC.collectionUrl('me', { id: '7000000000000000501', name: 'レシピ' })).toBe('https://www.tiktok.com/@me/collection/collection-7000000000000000501');
    expect(TIKTOK_SYNC.collectionUrl('me', { id: '7000000000000000501', name: '   ' })).toBe('https://www.tiktok.com/@me/collection/collection-7000000000000000501');
  });

  it('cannot be steered to another origin or path by a hostile handle, name or id', () => {
    for (const handle of ['me/../../evil', 'me?x=1#y', 'a b', '../x', 'me@evil.example']) {
      const u = new URL(TIKTOK_SYNC.savedUrl(handle));
      expect(u.origin).toBe('https://www.tiktok.com');
      expect(u.pathname.split('/').length).toBe(2); // exactly /@handle
    }
    const u = new URL(TIKTOK_SYNC.collectionUrl('me', { id: '1/../../x?y', name: '../../etc/passwd' }));
    expect(u.origin).toBe('https://www.tiktok.com');
    expect(u.pathname.startsWith('/@me/collection/')).toBe(true);
    expect(u.pathname.split('/').length).toBe(4);
  });
});

describe('tiktok sync: capture kinds', () => {
  it('assigns a sync role to every capture rule and to nothing else', () => {
    expect(Object.keys(TIKTOK_SYNC.roles).sort()).toEqual(TIKTOK_CAPTURE_RULES.map((r) => r.kind).sort());
    expect(TIKTOK_SYNC.roles).toEqual({ favorites: 'saved', collection_items: 'collection', collection_list: 'collections', collection_detail: 'collection_info' });
  });
});

describe('tiktok sync: page classification', () => {
  it('recognizes profile, collection, home and other pages', () => {
    expect(tiktokClassifyPage(snap({ pathname: '/@me' }))).toEqual({ kind: 'profile', pageHandle: 'me' });
    expect(tiktokClassifyPage(snap({ pathname: '/@me/' }))).toEqual({ kind: 'profile', pageHandle: 'me' });
    expect(tiktokClassifyPage(snap({ pathname: '/@me/collection/recipes-7000000000000000501' }))).toEqual({ kind: 'collection', pageHandle: 'me', collectionId: '7000000000000000501' });
    expect(tiktokClassifyPage(snap({ pathname: '/@me/collection/7000000000000000501' }))).toEqual({ kind: 'collection', pageHandle: 'me', collectionId: '7000000000000000501' });
    for (const p of ['/', '/foryou', '/following', '/explore']) expect(tiktokClassifyPage(snap({ pathname: p })), p).toEqual({ kind: 'home' });
    for (const p of ['/@me/video/123', '/tag/food', '/search', '/login', '/@me/collection/short-12']) expect(tiktokClassifyPage(snap({ pathname: p })).kind, p).toBe('other');
  });

  it('a handle outside the allowed alphabet is not reported', () => {
    expect(tiktokClassifyPage(snap({ pathname: '/@a b' })).pageHandle).toBeUndefined();
  });
});

describe('tiktok sync: page state', () => {
  it('a page with its bootstrap data and no walls is the real one', () => { expect(tiktokPageState(snap())).toBe('ok'); });
  it('detects a verification challenge first, even on an otherwise normal page', () => {
    expect(tiktokPageState(snap({ present: { captcha: true } }))).toBe('captcha');
    expect(tiktokPageState(snap({ present: { captcha: true, loginModal: true } }))).toBe('captcha');
  });
  it('detects a login wall', () => { expect(tiktokPageState(snap({ present: { loginModal: true } }))).toBe('login'); });
  it('detects the interstitial by its title, and a page without bootstrap data as unknown', () => {
    expect(tiktokPageState(snap({ title: 'Please wait...', hasBootstrap: false }))).toBe('interstitial');
    expect(tiktokPageState(snap({ title: 'Please Wait' }))).toBe('interstitial');
    expect(tiktokPageState(snap({ title: 'Oops', hasBootstrap: false }))).toBe('unknown');
  });
});
