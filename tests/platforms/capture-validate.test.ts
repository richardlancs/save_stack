// The capture message validator (used at the relay AND again in the service worker), origin matching, and page identity.
import { describe, expect, it } from 'vitest';
import { CAPTURE_CHANNEL, CAPTURE_VERSION, MAX_BODY_CHARS, MAX_CLOCK_SKEW_MS } from '../../src/platforms/capture-protocol';
import { originMatchesAny, originMatchesPattern } from '../../src/platforms/match-origin';
import { createRegistry, registry } from '../../src/platforms/registry';
import { HYDRATION_SCRIPT_ID, pageHandleFromPath, viewerFromHydration, viewerHandleFromHydration } from '../../src/platforms/tiktok/page-identity';
import { validateCaptureMessage } from '../../src/platforms/validate-capture';

const NOW = 1_787_000_000_000;
const good = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  channel: CAPTURE_CHANNEL, v: CAPTURE_VERSION, platform: 'tiktok', kind: 'favorites', capturedAt: NOW, body: '{"itemList":[]}',
  requestCursor: '0', pageHandle: 'testuser', viewerHandle: 'testuser', ...o,
});
const check = (data: unknown, now = NOW) => validateCaptureMessage(data, registry, now);
const reason = (data: unknown, now = NOW): string | undefined => { const r = check(data, now); return r.ok ? undefined : r.reason; };

describe('validateCaptureMessage', () => {
  it('accepts a well-formed message and returns a rebuilt copy', () => {
    const r = check(good({ collectionId: '7000000000000000501', requestCursor: '1786000000' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message).toMatchObject({ platform: 'tiktok', kind: 'favorites', collectionId: '7000000000000000501', requestCursor: '1786000000', pageHandle: 'testuser' });
  });

  it('carries forward ONLY the known fields (a sender cannot smuggle extras through)', () => {
    const r = check(good({ cookie: 'sessionid=abc', headers: { a: 1 }, __proto__: { x: 1 }, extra: 'x' }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.message).sort()).toEqual(['body', 'capturedAt', 'channel', 'collectionId', 'kind', 'pageHandle', 'platform', 'requestCursor', 'v', 'viewerHandle', 'viewerId'].sort());
    if (r.ok) expect(JSON.stringify(r.message)).not.toMatch(/sessionid|cookie|headers/);
  });

  it.each([null, undefined, 5, 'str', true, [], [good()], () => 1, Symbol('s')])('rejects a non-object: %s', (v) => {
    expect(reason(v)).toBe('malformed');
  });

  it('rejects a wrong channel or version', () => {
    expect(reason(good({ channel: 'other' }))).toBe('malformed');
    expect(reason(good({ v: 2 }))).toBe('malformed');
    expect(reason(good({ v: '1' }))).toBe('malformed');
    const { channel: _c, ...noChannel } = good();
    expect(reason(noChannel)).toBe('malformed');
  });

  it('separates an unknown platform from a malformed one', () => {
    expect(reason(good({ platform: 'instagram' }))).toBe('wrong_platform');
    expect(reason(good({ platform: 'TikTok' }))).toBe('malformed'); // not a valid platform id shape
    expect(reason(good({ platform: '../etc' }))).toBe('malformed');
    expect(reason(good({ platform: 7 }))).toBe('malformed');
  });

  it('allows only the platform\'s own capture kinds (the allowlist holds at both ends)', () => {
    for (const kind of ['favorites', 'collection_items', 'collection_list', 'collection_detail']) expect(reason(good({ kind }))).toBeUndefined();
    for (const kind of ['post_item_list', 'repost', 'user_detail', '', 'FAVORITES', 'favorites ', 7, null]) expect(reason(good({ kind }))).toBe('unknown_kind');
  });

  it('cursors and collection ids are digits only', () => {
    for (const requestCursor of ['abc', '12a', '-1', '1.5', '', ' 1', '1'.repeat(17), 'undefined', 12]) expect(reason(good({ requestCursor })), String(requestCursor)).toBe('malformed');
    for (const collectionId of ['abc', '', '7'.repeat(25), '7000000000000000501; DROP', 7]) expect(reason(good({ collectionId })), String(collectionId)).toBe('malformed');
    expect(reason(good({ requestCursor: '9999999999999999' }))).toBeUndefined(); // 16 digits
  });

  it('handles match the platform handle alphabet', () => {
    for (const h of ['a', 'test.user_1', 'A'.repeat(64)]) expect(reason(good({ pageHandle: h, viewerHandle: h }))).toBeUndefined();
    for (const h of ['', 'a b', 'a/b', '<script>', 'x'.repeat(65), 'név', 5]) expect(reason(good({ pageHandle: h })), String(h)).toBe('malformed');
    expect(reason(good({ viewerHandle: 'a;b' }))).toBe('malformed');
  });

  it('the stable user id is digits only', () => {
    expect(reason(good({ viewerId: '7000000000000000099' }))).toBeUndefined();
    for (const viewerId of ['', 'abc', '12a', '1'.repeat(25), '-1', 5, ' 1']) expect(reason(good({ viewerId })), String(viewerId)).toBe('malformed');
  });

  it('handles may be absent (the pipeline decides what absence means)', () => {
    const { pageHandle: _p, viewerHandle: _v, ...bare } = good();
    expect(reason(bare)).toBeUndefined();
  });

  it('rejects stale and future timestamps, and non-finite ones', () => {
    expect(reason(good({ capturedAt: NOW - MAX_CLOCK_SKEW_MS + 1000 }))).toBeUndefined();
    expect(reason(good({ capturedAt: NOW - MAX_CLOCK_SKEW_MS - 1000 }))).toBe('stale');
    expect(reason(good({ capturedAt: NOW + MAX_CLOCK_SKEW_MS + 1000 }))).toBe('stale');
    for (const capturedAt of [NaN, Infinity, -Infinity, '1787000000000', null, undefined]) expect(reason(good({ capturedAt })), String(capturedAt)).toBe('malformed');
  });

  it('bounds the body', () => {
    expect(reason(good({ body: '' }))).toBe('malformed');
    expect(reason(good({ body: {} }))).toBe('malformed');
    expect(reason(good({ body: 'x'.repeat(MAX_BODY_CHARS) }))).toBeUndefined();
    expect(reason(good({ body: 'x'.repeat(MAX_BODY_CHARS + 1) }))).toBe('too_large');
  });

  it('never throws, even for hostile objects (throwing getters, proxies)', () => {
    const throwing = { get channel(): string { throw new Error('boom'); } };
    expect(reason(throwing)).toBe('malformed');
    const proxy = new Proxy({}, { get() { throw new Error('trap'); }, has() { throw new Error('trap'); } });
    expect(reason(proxy)).toBe('malformed');
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    expect(reason(revocable.proxy)).toBe('malformed');
  });

  it('a registry without the platform treats everything as wrong_platform', () => {
    const empty = createRegistry([]);
    const r = validateCaptureMessage(good(), empty, NOW);
    expect(r).toEqual({ ok: false, reason: 'wrong_platform' });
  });

  it('prototype pollution attempts are inert', () => {
    const evil = JSON.parse('{"__proto__":{"polluted":true},"channel":"scroganize:capture","v":1,"platform":"tiktok","kind":"favorites","capturedAt":1787000000000,"body":"{}"}') as unknown;
    expect(check(evil).ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('originMatchesPattern', () => {
  const P = 'https://www.tiktok.com/*';
  it('matches the exact origin only', () => {
    expect(originMatchesPattern(P, 'https://www.tiktok.com')).toBe(true);
    for (const o of ['http://www.tiktok.com', 'https://tiktok.com', 'https://www.tiktok.com.evil.example', 'https://evil.example', 'https://www.tiktok.com:8443', 'https://xwww.tiktok.com', 'chrome-extension://abc', 'null', '', undefined])
      expect(originMatchesPattern(P, o as string | undefined), String(o)).toBe(false);
  });
  it('is case-insensitive for the host', () => { expect(originMatchesPattern(P, 'https://WWW.TikTok.com')).toBe(true); });
  it('supports wildcard subdomains without matching look-alikes', () => {
    const W = 'https://*.example.com/*';
    expect(originMatchesPattern(W, 'https://a.example.com')).toBe(true);
    expect(originMatchesPattern(W, 'https://a.b.example.com')).toBe(true);
    expect(originMatchesPattern(W, 'https://example.com')).toBe(true);
    expect(originMatchesPattern(W, 'https://badexample.com')).toBe(false);
    expect(originMatchesPattern(W, 'https://example.com.evil.example')).toBe(false);
  });
  it('rejects malformed patterns and origins instead of throwing', () => {
    for (const p of ['', 'tiktok.com', '<all_urls>', 'https://', 'ftp://x/*']) expect(originMatchesPattern(p, 'https://www.tiktok.com'), p).toBe(false);
    expect(originMatchesAny(['x', P], 'https://www.tiktok.com')).toBe(true);
    expect(originMatchesAny([], 'https://www.tiktok.com')).toBe(false);
  });
});

describe('tiktok page identity', () => {
  it('reads the profile handle from the path', () => {
    expect(pageHandleFromPath('/@testuser')).toBe('testuser');
    expect(pageHandleFromPath('/@testuser/')).toBe('testuser');
    expect(pageHandleFromPath('/@test.user_1/collection/recipes-7000000000000000501')).toBe('test.user_1');
    expect(pageHandleFromPath('/@test%2Euser')).toBe('test.user');
    for (const p of ['/', '/foryou', '/explore', '/@', '/@a b', '/@%E0%A4%A', '/@' + 'x'.repeat(65), '/video/123', '/@a<b>/x']) expect(pageHandleFromPath(p), p).toBeUndefined();
  });

  const blob = (uniqueId: unknown, scoped = true) => {
    const ctx = { 'webapp.app-context': { user: { uniqueId, uid: '1' } } };
    return JSON.stringify(scoped ? { __DEFAULT_SCOPE__: ctx } : ctx);
  };
  it('reads the signed-in user from the hydration blob (scoped or top-level)', () => {
    expect(viewerHandleFromHydration(blob('testuser'))).toBe('testuser');
    expect(viewerHandleFromHydration(blob('testuser', false))).toBe('testuser');
  });
  it('returns undefined for signed-out, malformed or hostile blobs', () => {
    for (const t of [undefined, null, '', 'not json', '[]', '{}', '{"__DEFAULT_SCOPE__":{}}', '{"__DEFAULT_SCOPE__":{"webapp.app-context":{}}}', blob(''), blob('a b'), blob(5), blob(null), blob('x'.repeat(65))])
      expect(viewerHandleFromHydration(t as string | null | undefined), String(t)).toBeUndefined();
    expect(viewerHandleFromHydration('x'.repeat(5_000_001))).toBeUndefined();
  });
  it('reads the stable numeric id too (string or number), and ignores one that is not digits', () => {
    const withUid = (uid: unknown) => JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.app-context': { user: { uniqueId: 'me', uid } } } });
    expect(viewerFromHydration(withUid('7000000000000000099'))).toEqual({ handle: 'me', id: '7000000000000000099' });
    expect(viewerFromHydration(withUid(12345))).toEqual({ handle: 'me', id: '12345' });
    for (const bad of ['abc', '', null, undefined, {}, 1.5, 2 ** 60, '1'.repeat(30)]) expect(viewerFromHydration(withUid(bad)), String(bad)).toEqual({ handle: 'me' });
  });

  it('exposes the script id the page hook reads', () => { expect(HYDRATION_SCRIPT_ID).toBe('__UNIVERSAL_DATA_FOR_REHYDRATION__'); });
});

