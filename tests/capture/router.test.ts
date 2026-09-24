// Who may talk to the service worker, and about what.
import { describe, expect, it, vi } from 'vitest';
import type { CapturePipeline } from '../../src/extension/capture/pipeline';
import { createMessageRouter } from '../../src/extension/message-router';
import { RPC_VERSION, type RpcRequest, type RpcResponse } from '../../src/extension/rpc/protocol';

const EXT = 'ext-id';
const ORIGIN = `chrome-extension://${EXT}`;

function setup() {
  const handled: unknown[] = [];
  const pipeline: CapturePipeline = {
    handle: vi.fn(async (m) => { handled.push(m); return { accepted: true }; }),
    getStatus: vi.fn(),
    reset: vi.fn(),
    subscribe: vi.fn(() => () => undefined),
  };
  const handleDb = vi.fn(async (r: RpcRequest): Promise<RpcResponse> => ({ v: RPC_VERSION, id: r.id, ok: true, result: null as never }));
  const driverEvents: Array<{ event: unknown; sender: { tabId?: number } }> = [];
  const route = createMessageRouter({
    ownExtensionId: EXT, extensionOrigin: ORIGIN, pipeline, handleDb,
    sync: { onDriverEvent: async (event, sender) => { driverEvents.push({ event, sender }); } },
    platformMatches: ['https://www.tiktok.com/*'],
  });
  return { route, pipeline, handleDb, handled, driverEvents };
}
const db = (method: string, id = 'r1') => ({ target: 'db', request: { v: RPC_VERSION, id, method, params: undefined } });

describe('service worker message router: sync driver events', () => {
  const READY = { type: 'ready', handle: 'me', pageState: 'ok', view: { kind: 'profile', pageHandle: 'me' }, extra: 'x' };
  const PAGE_SENDER = { id: EXT, origin: 'https://www.tiktok.com', frameId: 0, tabId: 7 };

  it('routes a valid event from our content script on the platform page, with the tab it came from, rebuilt without extras', async () => {
    const { route, driverEvents } = setup();
    expect(await route({ target: 'sync-driver', event: READY }, PAGE_SENDER)).toEqual({ accepted: true });
    expect(driverEvents).toEqual([{ event: { type: 'ready', handle: 'me', pageState: 'ok', view: { kind: 'profile', pageHandle: 'me' } }, sender: { tabId: 7 } }]);
  });

  it.each([
    ['another extension', { ...PAGE_SENDER, id: 'other' }],
    ['no id', { origin: 'https://www.tiktok.com', tabId: 7 }],
    ['a different site', { ...PAGE_SENDER, origin: 'https://evil.example' }],
    ['our own extension page', { id: EXT, origin: ORIGIN, frameId: 0 }],
    ['a sub-frame', { ...PAGE_SENDER, frameId: 2 }],
    ['no origin', { id: EXT, tabId: 7 }],
  ])('refuses driver events from %s', async (_n, sender) => {
    const { route, driverEvents } = setup();
    expect(await route({ target: 'sync-driver', event: READY }, sender)).toMatchObject({ accepted: false, reason: 'sender' });
    expect(driverEvents).toEqual([]);
  });

  it('refuses malformed events, and everything when sync is not wired', async () => {
    const { route, driverEvents } = setup();
    for (const event of [null, 5, {}, { type: 'ready' }, { type: 'blocked', pageState: 'ok' }, { type: 'wipe' }]) expect(await route({ target: 'sync-driver', event }, PAGE_SENDER)).toMatchObject({ accepted: false });
    expect(driverEvents).toEqual([]);
    const bare = createMessageRouter({ ownExtensionId: EXT, extensionOrigin: ORIGIN, pipeline: setup().pipeline, handleDb: vi.fn() });
    expect(await bare({ target: 'sync-driver', event: READY }, PAGE_SENDER)).toMatchObject({ accepted: false });
  });

  it('a driver event can never reach the database handler', async () => {
    const { route, handleDb } = setup();
    await route({ target: 'sync-driver', event: { type: 'stalled' }, request: db('wipeData').request }, PAGE_SENDER);
    expect(handleDb).not.toHaveBeenCalled();
  });
});

describe('service worker message router', () => {
  it('answers database RPC from our own extension pages', async () => {
    const { route, handleDb } = setup();
    const res = await route(db('getStats'), { id: EXT, origin: ORIGIN });
    expect(res).toMatchObject({ ok: true, id: 'r1' });
    expect(handleDb).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a content script on a web page', { id: EXT, origin: 'https://www.tiktok.com', frameId: 0 }],
    ['a look-alike origin', { id: EXT, origin: `${ORIGIN}.evil.example` }],
    ['another extension', { id: 'other', origin: 'chrome-extension://other' }],
    ['a sender with no origin', { id: EXT }],
    ['a sender with nothing', {}],
  ])('refuses database RPC from %s (export/wipe/import must be unreachable from a web page)', async (_n, sender) => {
    const { route, handleDb } = setup();
    for (const method of ['wipeData', 'exportData', 'importData', 'upsertBatch', 'getStats']) {
      const res = (await route(db(method, `id-${method}`), sender)) as RpcResponse;
      expect(res).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' }, id: `id-${method}` });
    }
    expect(handleDb).not.toHaveBeenCalled();
  });

  it('routes capture messages to the pipeline with the sender (the pipeline decides)', async () => {
    const { route, pipeline, handled } = setup();
    const sender = { id: EXT, origin: 'https://www.tiktok.com', frameId: 0 };
    expect(await route({ target: 'capture', message: { any: 'thing' } }, sender)).toEqual({ accepted: true });
    expect(pipeline.handle).toHaveBeenCalledWith({ any: 'thing' }, sender);
    expect(handled).toEqual([{ any: 'thing' }]);
  });

  it('a capture message can never reach the database handler', async () => {
    const { route, handleDb } = setup();
    await route({ target: 'capture', message: db('wipeData') }, { id: EXT, origin: 'https://www.tiktok.com' });
    expect(handleDb).not.toHaveBeenCalled();
  });

  it.each([null, undefined, 5, 'x', [], {}, { target: 'offscreen', request: {} }, { target: 'other' }])('ignores %j (not addressed to the service worker)', (m) => {
    const { route } = setup();
    expect(route(m, { id: EXT, origin: ORIGIN })).toBeUndefined();
  });

  it('a malformed db request from a web page still gets a refusal, with no crash', async () => {
    const { route } = setup();
    for (const m of [{ target: 'db' }, { target: 'db', request: null }, { target: 'db', request: 5 }]) {
      expect(await route(m, { id: EXT, origin: 'https://www.tiktok.com' })).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    }
  });
});
