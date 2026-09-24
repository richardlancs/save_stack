/// <reference types="node" />
// A fake tiktok.com for end-to-end tests. Playwright intercepts https://www.tiktok.com/** and answers from here, so the REAL
// extension runs against pages that behave like TikTok's web app: a hydration blob naming the signed-in user, a page script that
// fetches the four endpoints with scroll-triggered pagination (and noisy secret-looking query parameters and headers, to prove
// they never leave the page), plus endpoints the extension must never read.
//
// Payload shapes come from tests/support/tiktok-payloads.ts (the same builders the parser tests use), which reconstruct the
// structure observed in M0 with synthetic values. The user's real account is never touched.
//
// Quirks modelled from docs/TIKTOK_FINDINGS.md: the favorites cursor is a save-time boundary (epoch seconds, strictly
// decreasing, "0" at the end); collection pages use an offset cursor; declared totals overcount (unavailable videos are not
// delivered); collections are subsets of favorites; photo carousels; a "Please wait" interstitial before the real page; and a
// page that re-requests its first pages whenever it is opened.
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import selfsigned from 'selfsigned';
import { coll, collectionDetail, collectionId, collectionList, item, itemId, page as pageEnvelope, type ItemOptions } from '../tests/support/tiktok-payloads';

export const THEMES = [
  { name: 'cooking', desc: 'Easy pasta dinner recipe', tags: ['food', 'recipe', 'pasta'] },
  { name: 'makeup', desc: 'Everyday makeup tutorial', tags: ['makeup', 'grwm'] },
  { name: 'travel', desc: 'Weekend trip to the coast', tags: ['travel', 'beach'] },
  { name: 'pets', desc: 'My dog learns a new trick', tags: ['dog', 'pets'] },
  { name: 'fitness', desc: 'Quick home workout', tags: ['fitness', 'workout'] },
] as const;

export const VIEWER = 'testuser';
/** A stable numeric user id for a handle (the real site has one that survives a username change). */
export const uidFor = (handle: string): string => { let h = 7; for (const ch of handle) h = (h * 31 + ch.charCodeAt(0)) % 1_000_000_007; return '7' + String(h).padStart(18, '0'); };
export const STRANGER = 'someoneelse';
const PAGE_SIZE = 30;
const SAVE_STEP_S = 1800; // consecutive favorites were saved 30 minutes apart

export interface MockCollection { i: number; name: string; declaredTotal: number; members: number[]; owner: string }

export interface MockAccount {
  /** Item numbers (1 = newest saved), the ones TikTok will actually deliver. */
  delivered: number[];
  /** Saved but unavailable: never delivered, yet still counted in declared totals. */
  dropped: number[];
  collections: MockCollection[];
  savedAtS: (n: number) => number;
  itemOpts: (n: number) => ItemOptions;
}

export function buildAccount(favorites = 95, nowS = Math.floor(Date.now() / 1000) - 86_400): MockAccount {
  const dropped = [7, 33];
  const all = Array.from({ length: favorites }, (_, i) => i + 1);
  const delivered = all.filter((n) => !dropped.includes(n));
  const itemOpts = (n: number): ItemOptions => {
    const th = THEMES[((n % THEMES.length) + THEMES.length) % THEMES.length]!;
    return { desc: `${th.desc} ${n}`, tags: [...th.tags], kind: n % 7 === 0 ? 'photo' : 'video', duration: 10 + (n % 50) };
  };
  const inFav = (pred: (n: number) => boolean) => all.filter(pred);
  const deliveredOf = (ns: number[]) => ns.filter((n) => delivered.includes(n));
  const cooking = inFav((n) => n % 5 === 0);
  const travel = inFav((n) => n % 5 === 2);
  const odd = inFav((n) => n % 2 === 1);
  const collections: MockCollection[] = [
    { i: 1, name: 'Recipes', declaredTotal: cooking.length + 2, members: deliveredOf(cooking), owner: VIEWER },
    { i: 2, name: 'Trip ideas', declaredTotal: travel.length, members: deliveredOf(travel), owner: VIEWER },
    { i: 3, name: 'Empty shelf', declaredTotal: 0, members: [], owner: VIEWER },
    { i: 4, name: 'Everything odd', declaredTotal: odd.length, members: deliveredOf(odd), owner: VIEWER },
  ];
  return { delivered, dropped, collections, savedAtS: (n) => nowS - SAVE_STEP_S * n, itemOpts };
}

/** What the capture pipeline should end up holding once every page has been read. */
export function expectedLibrary(a: MockAccount) {
  return {
    items: a.delivered.length,
    collections: a.collections.length,
    memberships: a.collections.reduce((s, c) => s + c.members.length, 0),
    externalIdsNewestFirst: a.delivered.map((n) => itemId(n)),
    byTheme: (name: string) => a.delivered.filter((n) => THEMES[((n % THEMES.length) + THEMES.length) % THEMES.length]!.name === name).map((n) => itemId(n)),
  };
}

export interface MockOptions {
  /** The signed-in user the hydration blob names; null = signed out (no `user` in the blob). */
  viewer?: string | null;
  interstitial?: boolean;
  latencyMs?: number;
  /** The profile page does not load the list by itself: only clicking the Favorites tab does (tests the driver's reveal click and the guided fallback). */
  requireFavoritesClick?: boolean;
  account?: MockAccount;
}

export interface Fulfill { status: number; contentType?: string; body?: string }

export interface Served { favorites: number; collection_items: number; collection_list: number; collection_detail: number; blocked: number; pages: number }

/** The page script: what TikTok's web app does, reduced to what matters. Serialized into every real page. */
const PAGE_SCRIPT = String.raw`
(() => {
  const cfg = window.__MOCK_CFG__;
  window.__captured = [];
  window.addEventListener('message', (e) => { if (e.data && e.data.channel === 'scroganize:capture') { try { window.__captured.push(JSON.stringify(e.data)); } catch (_) {} } });
  const S = { ready: false, done: false, loading: false, pages: 0, cursor: '0', errors: [] };
  window.__mock = { state: S, loadNext: () => loadNext() };
  const noisy = (extra) => new URLSearchParams(Object.assign({ aid: '1988', app_language: 'en', device_id: 'SECRET_DEVICE_ID', msToken: 'SECRET_MSTOKEN', 'X-Bogus': 'SECRET_XBOGUS', verifyFp: 'SECRET_VERIFYFP' }, extra)).toString();
  const get = async (path, extra) => {
    const res = await fetch(path + '?' + noisy(extra), { credentials: 'include', headers: { 'x-secret-header': 'SECRET_HEADER' } });
    return res.json();
  };
  const showCaptcha = () => { if (!document.getElementById('captcha_container')) { const c = document.createElement('div'); c.id = 'captcha_container'; c.textContent = 'Drag the slider'; document.body.prepend(c); } };
  // some of the platform's calls go through XMLHttpRequest rather than fetch
  const getXhr = (path, extra) => new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('GET', path + '?' + noisy(extra));
    x.setRequestHeader('x-secret-header', 'SECRET_HEADER');
    x.onload = () => { try { resolve(JSON.parse(x.responseText)); } catch (e) { reject(e); } };
    x.onerror = () => reject(new Error('xhr failed'));
    x.send();
  });
  const list = document.createElement('div');
  const tile = (it) => { const d = document.createElement('div'); d.className = 'tile'; d.style.cssText = 'height:50px;border-bottom:1px solid #ccc'; d.textContent = it.desc; list.appendChild(d); };
  const near = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 300;
  async function loadNext() {
    if (S.done || S.loading || !S.ready) return false;
    S.loading = true;
    try {
      const j = cfg.mode === 'collection'
        ? await get('/api/collection/item_list/', { collectionId: cfg.collectionId, cursor: S.cursor, count: '30' })
        : await get('/api/user/collect/item_list/', { cursor: S.cursor, count: '30' });
      if (j.statusCode && j.statusCode !== 0) { showCaptcha(); throw new Error('challenge'); }
      (j.itemList || []).forEach(tile);
      S.cursor = String(j.cursor);
      S.pages++;
      if (!j.hasMore) S.done = true;
    } catch (e) { S.errors.push(String(e)); }
    S.loading = false;
    return true;
  }
  window.addEventListener('scroll', () => { if (near()) loadNext(); }, { passive: true });
  window.addEventListener('wheel', () => { setTimeout(() => { if (near()) loadNext(); }, 30); }, { passive: true });
  async function init() {
    document.body.appendChild(list);
    try {
      // requests the extension must never read
      get('/api/post/item_list/', { cursor: '0', count: '30' }).catch(() => {});
      get('/api/user/playlist/', { cursor: '0' }).catch(() => {});
      if (cfg.mode === 'collection') {
        const d = await get('/api/collection/detail/', { collectionId: cfg.collectionId });
        if (d.statusCode && d.statusCode !== 0) { showCaptcha(); throw new Error('challenge'); }
      } else {
        const l = await getXhr('/api/user/collection_list/', { cursor: '0', count: '20' });
        if (l.statusCode && l.statusCode !== 0) { showCaptcha(); throw new Error('challenge'); }
      }
      S.ready = true;
      await loadNext();
    } catch (e) { S.errors.push(String(e)); S.ready = true; }
  }
  const start = () => {
    if (cfg.mode === 'home') { S.ready = true; return; }
    if (cfg.mode === 'favorites' && !cfg.autoLoad) {
      // the list opens only when the Favorites tab is clicked, like a profile page with several tabs
      document.addEventListener('click', (e) => { if (e.target && e.target.id === 'favtab' && !S.ready) init(); });
      return;
    }
    init();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
`;

export function createMockTikTok(options: MockOptions = {}) {
  const account = options.account ?? buildAccount();
  const state = {
    viewer: options.viewer === undefined ? VIEWER : options.viewer,
    /** Override the signed-in user's stable id (default: derived from the handle). Set it to the old id to simulate a username change. */
    viewerUid: null as string | null,
    interstitial: options.interstitial ?? false,
    latencyMs: options.latencyMs ?? 0,
    requireFavoritesClick: options.requireFavoritesClick ?? false,
    /** The Favorites tab element does not match the selectors the driver knows (so the driver cannot open the list itself). */
    tabSelectorBroken: false,
    /** Every item carries a field the parser has never seen ("TikTok changed something"). */
    extraItemKey: false,
    /** Show a login modal on every real page. */
    loginWall: false,
    /** After this many allowed API responses, answer with a challenge (error bodies) and show a captcha on the page; null = never. */
    captchaAfter: null as number | null,
    /** After this many favorites responses, answer favorites requests with a server error; null = never. */
    failFavoritesAfter: null as number | null,
    /** When each allowed API request arrived, for pacing assertions. */
    requests: [] as Array<{ kind: string; at: number; cursor: string | null; collectionId: string | null }>,
    served: { favorites: 0, collection_items: 0, collection_list: 0, collection_detail: 0, blocked: 0, pages: 0 } as Served,
    interstitialShown: new Set<string>(),
    /** Every URL the mock saw, with query values stripped (so nothing sensitive is ever printed). */
    log: [] as string[],
  };

  const fulfill = (r: Fulfill): Fulfill => r;
  const json = (body: unknown): Fulfill => ({ status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(body) });
  const collOf = (c: MockCollection) => coll(c.i, c.name, c.declaredTotal, 1, c.owner === VIEWER ? (state.viewer ?? VIEWER) : c.owner); // the owner is whoever is signed in now (a renamed user's collections carry the new name)
  const sortedDelivered = () => account.delivered.slice().sort((a, b) => a - b);

  const withDrift = (it: Record<string, any>): Record<string, any> => { if (state.extraItemKey) it.brandNewPlatformField = { added: 'by the platform' }; return it; };

  function favoritesPage(cursorParam: string | null) {
    const boundary = cursorParam && /^\d+$/.test(cursorParam) && cursorParam !== '0' ? Number(cursorParam) : Infinity;
    const eligible = sortedDelivered().filter((n) => account.savedAtS(n) < boundary);
    const slice = eligible.slice(0, PAGE_SIZE);
    const hasMore = eligible.length > slice.length;
    const cursor = hasMore ? String(account.savedAtS(slice[slice.length - 1]!)) : '0';
    return pageEnvelope(cursor, hasMore, slice.map((n) => withDrift(item(n, account.itemOpts(n)))));
  }

  function collectionItemsPage(collectionIdParam: string | null, cursorParam: string | null) {
    const c = account.collections.find((x) => collectionId(x.i) === collectionIdParam) ?? STRANGER_COLLECTIONS.find((x) => collectionId(x.i) === collectionIdParam);
    if (!c) return pageEnvelope('0', false, []);
    const offset = cursorParam && /^\d+$/.test(cursorParam) ? Number(cursorParam) : 0;
    const slice = c.members.slice(offset, offset + PAGE_SIZE);
    const hasMore = offset + slice.length < c.members.length;
    return pageEnvelope(String(offset + slice.length), hasMore, slice.map((n) => withDrift(item(n, c.owner === VIEWER ? account.itemOpts(n) : { desc: `Stranger post ${n}`, tags: ['stranger'] }))));
  }

  const STRANGER_COLLECTIONS: MockCollection[] = [{ i: 90, name: 'Their public list', declaredTotal: 3, members: [901, 902, 903], owner: STRANGER }];

  function realPage(pathname: string, cfg: Record<string, unknown>): string {
    const user = state.viewer ? { user: { uniqueId: state.viewer, uid: state.viewerUid ?? uidFor(state.viewer), secUid: 'SECUID_VIEWER' } } : {};
    const blob = { __DEFAULT_SCOPE__: { 'webapp.app-context': { ...user, language: 'en' }, 'webapp.user-detail': { userInfo: { user: { uniqueId: (cfg.handle as string) ?? '' } } } } };
    return `<!doctype html><html><head><meta charset="utf-8"><title>Mock TikTok ${pathname}</title>
<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(blob)}</script>
<script>window.__MOCK_CFG__ = ${JSON.stringify(cfg)};</script></head><body style="margin:0">${state.loginWall ? '<div data-e2e="login-modal">Log in to TikTok</div>' : ''}${cfg.mode === 'favorites' ? `<p ${state.tabSelectorBroken ? 'data-e2e="tab-x"' : 'data-e2e="favorites-tab"'} id="favtab" style="margin:0">Favorites</p>` : ''}<script>${PAGE_SCRIPT}</script></body></html>`;
  }

  const allowedKind = (p: string): string | null =>
    p === '/api/user/collect/item_list/' ? 'favorites' : p === '/api/collection/item_list/' ? 'collection_items' : p === '/api/user/collection_list/' ? 'collection_list' : p === '/api/collection/detail/' ? 'collection_detail' : null;

  async function respond(method: string, url: URL): Promise<Fulfill> {
    state.log.push(`${method} ${url.pathname}`);
    if (state.latencyMs) await new Promise((r) => setTimeout(r, state.latencyMs));
    const p = url.pathname;
    const q = url.searchParams;

    if (p === '/favicon.ico') return fulfill({ status: 204 });

    const kind = allowedKind(p);
    if (kind) {
      state.requests.push({ kind, at: Date.now(), cursor: q.get('cursor'), collectionId: q.get('collectionId') });
      if (state.captchaAfter !== null && state.requests.length > state.captchaAfter) return fulfill(json({ statusCode: 10000, status_msg: 'verification required' }));
      if (kind === 'favorites' && state.failFavoritesAfter !== null && state.served.favorites >= state.failFavoritesAfter) return fulfill({ status: 503, contentType: 'text/plain', body: 'unavailable' });
    }
    if (p === '/api/user/collect/item_list/') { state.served.favorites++; return fulfill(json(favoritesPage(q.get('cursor')))); }
    if (p === '/api/collection/item_list/') { state.served.collection_items++; return fulfill(json(collectionItemsPage(q.get('collectionId'), q.get('cursor')))); }
    if (p === '/api/user/collection_list/') { state.served.collection_list++; return fulfill(json(collectionList(account.collections.map(collOf)))); }
    if (p === '/api/collection/detail/') {
      state.served.collection_detail++;
      const c = [...account.collections, ...STRANGER_COLLECTIONS].find((x) => collectionId(x.i) === q.get('collectionId'));
      return fulfill(json(c ? collectionDetail(collOf(c)) : { statusCode: 10000 }));
    }
    if (p === '/api/post/item_list/' || p === '/api/user/playlist/' || p === '/api/repost/item_list/') {
      state.served.blocked++;
      return fulfill(json(pageEnvelope('0', false, [item(999, { desc: 'PRIVATE upload that must never be captured' })])));
    }

    if (p === '/' || p === '/foryou') {
      state.served.pages++;
      return fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: realPage(p, { mode: 'home' }) });
    }

    const m = /^\/@([^/]+)(?:\/collection\/([^/]+))?\/?$/.exec(p);
    if (m) {
      const handle = decodeURIComponent(m[1]!);
      if (state.interstitial && !state.interstitialShown.has(url.href)) {
        state.interstitialShown.add(url.href);
        return fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Please wait...</title><script>setTimeout(() => location.reload(), 120)</script>' });
      }
      state.served.pages++;
      const cfg: Record<string, unknown> = { handle };
      if (m[2]) { cfg.mode = 'collection'; cfg.collectionId = /(\d{6,})$/.exec(m[2])?.[1] ?? ''; }
      else { cfg.mode = 'favorites'; cfg.autoLoad = q.get('tab') === 'favorites' && !state.requireFavoritesClick; }
      return fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: realPage(p, cfg) });
    }
    return fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
  }

  return {
    account,
    state,
    expected: expectedLibrary(account),
    /**
     * Start the mock as a local HTTPS server for www.tiktok.com. The browser is pointed at it with DNS rules that send www.tiktok.com to
     * the mock and make EVERY other host unresolvable, so a test can never reach the real internet (found the hard way: a window opened
     * by the extension itself bypasses Playwright's request interception and would otherwise load the real site).
     */
    async start(): Promise<{ port: number; args: string[]; stop(): Promise<void> }> {
      const pems = await selfsigned.generate([{ name: 'commonName', value: 'www.tiktok.com' }], {
        algorithm: 'sha256',
        extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'www.tiktok.com' }] }],
      });
      const server = https.createServer({ key: pems.private, cert: pems.cert }, (req, res) => {
        const url = new URL(req.url ?? '/', 'https://www.tiktok.com');
        respond(req.method ?? 'GET', url).then(
          (r) => { res.writeHead(r.status, r.contentType ? { 'content-type': r.contentType } : {}); res.end(r.body ?? ''); },
          () => { res.writeHead(500); res.end(); },
        );
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as AddressInfo).port;
      return {
        port,
        args: [`--host-resolver-rules=MAP www.tiktok.com 127.0.0.1:${port}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`, '--ignore-certificate-errors'],
        stop: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
      };
    },
    urls: {
      favorites: (handle = VIEWER) => `https://www.tiktok.com/@${handle}?tab=favorites`,
      collection: (c: MockCollection, handle = c.owner) => `https://www.tiktok.com/@${handle}/collection/${c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${collectionId(c.i)}`,
      strangerCollection: () => `https://www.tiktok.com/@${STRANGER}/collection/their-public-list-${collectionId(STRANGER_COLLECTIONS[0]!.i)}`,
    },
    strangerCollection: STRANGER_COLLECTIONS[0]!,
    /** Change the account between syncs. New saves get ids that are newer than everything (item numbers 0, -1, -2, ...). */
    addSaved(count: number): number[] {
      const base = Math.min(0, ...account.delivered);
      const added = Array.from({ length: count }, (_, i) => base - 1 - i);
      account.delivered.push(...added);
      return added;
    },
    removeSaved(n: number): void {
      account.delivered = account.delivered.filter((x) => x !== n);
      for (const c of account.collections) c.members = c.members.filter((x) => x !== n);
    },
    removeFromCollection(collectionIndex: number, n: number): void {
      const c = account.collections[collectionIndex]!;
      c.members = c.members.filter((x) => x !== n);
    },
    deleteCollection(collectionIndex: number): void { account.collections.splice(collectionIndex, 1); },
    /** Requests the extension is allowed to read, served so far. */
    allowedServed: () => state.served.favorites + state.served.collection_items + state.served.collection_list + state.served.collection_detail,
  };
}

export type MockTikTok = ReturnType<typeof createMockTikTok>;
