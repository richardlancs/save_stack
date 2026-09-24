// The platform contract, run over every registered adapter AND a small fake `example` adapter. If a new adapter passes this, the pipeline,
// storage, search and sync accept it; the fake one proves the core does not depend on TikTok.
import { describe, expect, it } from 'vitest';
import type { ParsedBatch, SavedItem } from '../../src/core/model';
import type { PageSnapshot } from '../../src/core/sync/types';
import { SearchService } from '../../src/core/search/service';
import { createCapturePipeline, type StatusStore } from '../../src/extension/capture/pipeline';
import { CAPTURE_CHANNEL, type CaptureStatus } from '../../src/platforms/capture-protocol';
import { originMatchesPattern } from '../../src/platforms/match-origin';
import { createRegistry, registry } from '../../src/platforms/registry';
import type { ParsedCapture, PlatformAdapter, RawCapture } from '../../src/platforms/types';
import { memoryAdapter } from '../storage/helpers';

// ---------------------------------------------------------------------------------------------- a fake platform
const EXAMPLE_ORIGIN = 'https://example.test';
const exampleAdapter: PlatformAdapter = {
  id: 'example',
  displayName: 'Example',
  parserVersion: 1,
  hostMatches: [`${EXAMPLE_ORIGIN}/*`],
  captureRules: [{ kind: 'saved', path: '/api/saved' }, { kind: 'folders', path: '/api/folders' }],
  parse(c: RawCapture): ParsedCapture {
    const body = typeof c?.body === 'object' && c.body !== null ? (c.body as Record<string, unknown>) : {};
    const list = Array.isArray(body.items) ? body.items.slice(0, 100) : undefined;
    const batch: ParsedBatch = { items: [], syncedAt: c?.capturedAt };
    const problems: ParsedCapture['problems'] = [];
    if (!list) problems.push({ code: 'bad_envelope', message: 'no items' });
    for (const raw of list ?? []) {
      const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
      if (typeof r.id !== 'string' || !/^[a-z0-9]{1,20}$/.test(r.id)) { problems.push({ code: 'bad_record', message: 'no id' }); continue; }
      const it: SavedItem = { platform: 'example', externalId: r.id, authorHandle: typeof r.by === 'string' ? r.by.slice(0, 40) : '', caption: typeof r.title === 'string' ? r.title.slice(0, 500) : undefined, hashtags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string').slice(0, 20) : undefined };
      batch.items.push(it);
    }
    return { batch, page: { kind: String(c?.kind), hasMore: typeof body.more === 'boolean' ? body.more : null, itemsDelivered: batch.items.length }, problems, shape: { items: batch.items.length, unknownItemKeys: [], missing: {} } };
  },
  sync: {
    platform: 'example',
    homeUrl: `${EXAMPLE_ORIGIN}/`,
    savedUrl: (h) => `${EXAMPLE_ORIGIN}/u/${encodeURIComponent(h)}/saved`,
    collectionUrl: (h, c) => `${EXAMPLE_ORIGIN}/u/${encodeURIComponent(h)}/f/${encodeURIComponent(c.id)}`,
    roles: { saved: 'saved', folders: 'collections' },
    detectPageState: () => 'ok',
    classifyPage: (s) => (s.pathname === '/' ? { kind: 'home' } : { kind: 'other' }),
    probes: {},
    revealSavedSelectors: [],
  },
  canonicalUrl: (i) => `${EXAMPLE_ORIGIN}/v/${i.externalId}`,
};

const adapters: PlatformAdapter[] = [...registry.all(), exampleAdapter];

// ---------------------------------------------------------------------------------------------- hostile inputs
const garbage: unknown[] = [
  null, undefined, 0, 1, -1, NaN, Infinity, true, false, '', 'x', 'x'.repeat(100_000), [], [null], [[]], {}, { items: null }, { items: 5 }, { items: 'x' },
  { items: [null, 5, 'x', [], {}, { id: null }, { id: {} }, { id: '../x' }] }, { itemList: [{}], collectionList: [{}], collectionInfo: 5 },
  { hasMore: 'yes', cursor: {}, total: [] }, JSON.parse('{"__proto__":{"polluted":1},"items":[{"id":"a1"}]}'),
  (() => { let o: unknown = { id: 'a1' }; for (let i = 0; i < 300; i++) o = { a: o, items: [{ id: 'x' + i }] }; return o; })(), // a deep chain (NOT a shared-reference graph: serialising that would be exponential)
];

const SNAPSHOTS: PageSnapshot[] = [
  { pathname: '/', search: '', title: '', hasBootstrap: false, present: {} },
  { pathname: '/@me', search: '?tab=x', title: 'Please wait...', hasBootstrap: true, present: { captcha: true, loginModal: true } },
  { pathname: '/a/b/c/d', search: '', title: 'x'.repeat(10_000), viewer: 'me', hasBootstrap: true, present: {} },
  { pathname: '', search: '', title: '', hasBootstrap: false, present: {} },
];

describe.each(adapters.map((a) => [a.id, a] as const))('platform contract: %s', (_id, a) => {
  it('has a well-formed identity', () => {
    expect(a.id).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
    expect(a.displayName.length).toBeGreaterThan(0);
    expect(Number.isInteger(a.parserVersion) && a.parserVersion > 0).toBe(true);
    expect(a.hostMatches.length).toBeGreaterThan(0);
    for (const m of a.hostMatches) expect(m, m).toMatch(/^https:\/\/[a-z0-9.*-]+\/\*$/); // https only, no <all_urls>, no wildcard host alone
  });

  it('lists its capture rules by exact path, with unique kinds', () => {
    expect(a.captureRules.length).toBeGreaterThan(0);
    const kinds = a.captureRules.map((r) => r.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const r of a.captureRules) {
      expect(r.path, r.kind).toMatch(/^\/[A-Za-z0-9_\-./]*$/); // a path: no query, no host, no wildcard
      expect(r.kind).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
    }
    expect(new Set(a.captureRules.map((r) => r.path)).size).toBe(a.captureRules.length);
  });

  it('gives every capture kind a sync role, and nothing else', () => {
    const kinds = a.captureRules.map((r) => r.kind).sort();
    expect(Object.keys(a.sync.roles).sort()).toEqual(kinds);
    for (const role of Object.values(a.sync.roles)) expect(['saved', 'collections', 'collection', 'collection_info']).toContain(role);
    expect(Object.values(a.sync.roles)).toContain('saved');
    expect(a.sync.platform).toBe(a.id);
  });

  it('parse never throws, whatever the input, for every capture kind', () => {
    for (const rule of a.captureRules) {
      for (const body of garbage) {
        let out: ParsedCapture | undefined;
        expect(() => { out = a.parse({ platform: a.id, kind: rule.kind, body, capturedAt: 1_787_000_000_000, collectionId: '7000000000000000501', requestCursor: '30' }); }, `${rule.kind} <- ${JSON.stringify(body)?.slice(0, 50)}`).not.toThrow();
        expect(out).toBeDefined();
      }
      expect(() => a.parse({ platform: a.id, kind: rule.kind, body: {}, capturedAt: NaN })).not.toThrow();
      expect(() => a.parse(null as unknown as RawCapture)).not.toThrow();
      expect(() => a.parse({ platform: a.id, kind: 'not-a-kind', body: {}, capturedAt: 1 })).not.toThrow();
    }
  });

  it('parse output is bounded, typed and serialisable, and never claims more than it returns', () => {
    for (const rule of a.captureRules) {
      for (const body of garbage) {
        const out = a.parse({ platform: a.id, kind: rule.kind, body, capturedAt: 1_787_000_000_000, collectionId: '7000000000000000501', requestCursor: '0' });
        expect(Array.isArray(out.batch.items)).toBe(true);
        expect(out.batch.items.length).toBeLessThanOrEqual(500);
        expect(Array.isArray(out.problems)).toBe(true);
        expect(out.page && typeof out.page.itemsDelivered === 'number').toBe(true);
        for (const it of out.batch.items) {
          expect(it.platform).toBe(a.id);
          expect(typeof it.externalId).toBe('string');
          expect(it.externalId.length).toBeGreaterThan(0);
        }
        expect(() => JSON.parse(JSON.stringify(out))).not.toThrow();
      }
    }
  });

  it('parse does not pollute prototypes', () => {
    for (const rule of a.captureRules) a.parse({ platform: a.id, kind: rule.kind, body: JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}'), capturedAt: 1 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('canonicalUrl stays on the platform\'s own host', () => {
    const url = a.canonicalUrl({ authorHandle: 'someone', externalId: '7000000000000000123', mediaType: 'video' });
    const origin = new URL(url).origin;
    expect(a.hostMatches.some((m) => originMatchesPattern(m, origin)), url).toBe(true);
    const hostile = a.canonicalUrl({ authorHandle: 'a/../../evil?x=1#y', externalId: '../../../etc', mediaType: 'photo' });
    expect(a.hostMatches.some((m) => originMatchesPattern(m, new URL(hostile).origin)), hostile).toBe(true);
  });

  it('sync urls cannot be steered off the platform by a hostile handle, name or id', () => {
    const home = new URL(a.sync.homeUrl).origin;
    expect(a.hostMatches.some((m) => originMatchesPattern(m, home))).toBe(true);
    for (const handle of ['me', 'me/../../evil', 'me?x=1#y', 'a b', '../x', 'me@evil.example', '\u0000', '%2e%2e']) {
      for (const url of [a.sync.savedUrl(handle), a.sync.collectionUrl(handle, { id: '1/../../x?y', name: '../../etc/passwd' })]) {
        expect(new URL(url).origin, url).toBe(home);
      }
    }
  });

  it('page classification and page state are total', () => {
    for (const snap of SNAPSHOTS) {
      const v = a.sync.classifyPage(snap);
      expect(['home', 'profile', 'collection', 'other']).toContain(v.kind);
      expect(['ok', 'login', 'captcha', 'interstitial', 'unknown']).toContain(a.sync.detectPageState(snap));
    }
    for (const sel of Object.values(a.sync.probes)) expect(typeof sel).toBe('string');
  });
});

describe('the registry', () => {
  it('rejects two adapters with the same id', () => {
    expect(() => createRegistry([exampleAdapter, exampleAdapter])).toThrow(/duplicate/);
  });
});

// ---------------------------------------------------------------------------------------------- the core does not need TikTok
describe('a platform other than TikTok works end to end through the shared pipeline, storage and search', () => {
  const memStore = (): StatusStore => { let s: CaptureStatus | undefined; return { load: async () => s, save: async (v) => { s = structuredClone(v); } }; };

  it('captures, stores and finds a video from the fake platform, using only generic code', async () => {
    const mem = await memoryAdapter(() => 1_787_000_000_000);
    const pipeline = createCapturePipeline({ registry: createRegistry([exampleAdapter]), ownExtensionId: 'ext', store: memStore(), now: () => 1_787_000_000_000, ingest: (b) => mem.adapter.upsertBatch(b) });
    const message = {
      channel: CAPTURE_CHANNEL, v: 1, platform: 'example', kind: 'saved', capturedAt: 1_787_000_000_000, pageHandle: 'me', viewerHandle: 'me',
      body: JSON.stringify({ items: [{ id: 'abc1', title: 'Sourdough starter guide', by: 'baker', tags: ['bread'] }, { id: 'abc2', title: 'Hiking boots review', by: 'walker', tags: ['outdoors'] }], more: false }),
    };
    const out = await pipeline.handle(message, { id: 'ext', origin: EXAMPLE_ORIGIN, frameId: 0 });
    expect(out).toMatchObject({ accepted: true, inserted: 2 });
    expect(await mem.adapter.getAccount('example')).toEqual({ platform: 'example', handle: 'me' });
    const found = await new SearchService(mem.adapter).search({ requestId: 'r1', chips: [{ id: 'a', text: 'bread' }] });
    expect(found.results.map((r) => r.item.externalId)).toEqual(['abc1']);
    expect(found.results[0]!.item.platform).toBe('example');
  });

  it('a message for a platform that is not registered is refused', async () => {
    const mem = await memoryAdapter();
    const pipeline = createCapturePipeline({ registry: createRegistry([]), ownExtensionId: 'ext', store: memStore(), ingest: (b) => mem.adapter.upsertBatch(b) });
    const out = await pipeline.handle({ channel: CAPTURE_CHANNEL, v: 1, platform: 'example', kind: 'saved', capturedAt: Date.now(), body: '{}' }, { id: 'ext', origin: EXAMPLE_ORIGIN, frameId: 0 });
    expect(out).toMatchObject({ accepted: false, reason: 'wrong_platform' });
  });
});
