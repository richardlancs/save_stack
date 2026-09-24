// The in-page hook, driven with a fake window: what it captures, what it must never touch, and that the page cannot tell it is there.
import { describe, expect, it } from 'vitest';
import { installCaptureHook, type HookPlatform, type HookWindow } from '../../src/extension/capture/hook';
import { CAPTURE_CHANNEL, MAX_BODY_CHARS } from '../../src/platforms/capture-protocol';
import { classifyRequest } from '../../src/platforms/tiktok/capture-rules';

const ORIGIN = 'https://www.tiktok.com';
const FAV = `${ORIGIN}/api/user/collect/item_list/?aid=1988&device_id=DEVICE123&msToken=SECRETTOKEN&X-Bogus=SECRETSIG&cursor=1786000000&count=30`;

interface Posted { message: Record<string, unknown>; targetOrigin: string }

function fakeResponse(body: string, ok = true) {
  const state = { cloned: 0, read: 0 };
  return { ok, state, clone() { state.cloned++; return { text: async () => { state.read++; return body; } }; } };
}

class FakeXhr {
  responseType = '';
  responseText = '';
  response: unknown = null;
  status = 200;
  method = '';
  url = '';
  private listeners: Array<() => void> = [];
  open(method: string, url: string | URL) { this.method = method; this.url = String(url); }
  send() { /* the test triggers load */ }
  addEventListener(_t: 'load', l: () => void) { this.listeners.push(l); }
  finish() { for (const l of this.listeners) l(); }
}

function setup(opts: { platform?: Partial<HookPlatform>; fetchImpl?: HookWindow['fetch'] } = {}) {
  const posted: Posted[] = [];
  const win: HookWindow = {
    fetch: opts.fetchImpl ?? (async () => fakeResponse('{"itemList":[]}')),
    XMLHttpRequest: FakeXhr as unknown as HookWindow['XMLHttpRequest'],
    location: { origin: ORIGIN },
    postMessage: (message, targetOrigin) => { posted.push({ message: message as Record<string, unknown>, targetOrigin }); },
  };
  const originals = { fetch: win.fetch, open: FakeXhr.prototype.open, send: FakeXhr.prototype.send };
  const platform: HookPlatform = {
    id: 'tiktok',
    classify: classifyRequest,
    identity: () => ({ pageHandle: 'testuser', viewerHandle: 'testuser' }),
    ...opts.platform,
  };
  const hook = installCaptureHook(win, platform, () => 1_787_000_000_000);
  return { win, posted, hook, originals, platform };
}
const settle = () => new Promise((r) => setTimeout(r, 5));

describe('capture hook: fetch', () => {
  it('captures an allowed response and forwards ONLY the cursor, the collection id and the identity', async () => {
    const res = fakeResponse('{"itemList":[1]}');
    const { win, posted } = setup({ fetchImpl: async () => res });
    await win.fetch!(FAV, { headers: { cookie: 'sessionid=SECRETCOOKIE' }, body: 'SECRETBODY' });
    await settle();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.message).toEqual({
      channel: CAPTURE_CHANNEL, v: 1, platform: 'tiktok', kind: 'favorites', capturedAt: 1_787_000_000_000,
      body: '{"itemList":[1]}', requestCursor: '1786000000', pageHandle: 'testuser', viewerHandle: 'testuser',
    });
    const wire = JSON.stringify(posted);
    for (const secret of ['SECRETTOKEN', 'SECRETSIG', 'DEVICE123', 'SECRETCOOKIE', 'SECRETBODY', 'sessionid', 'msToken']) expect(wire).not.toContain(secret);
  });

  it('posts to the page\'s own origin, never a wildcard', async () => {
    const { win, posted } = setup();
    await win.fetch!(FAV);
    await settle();
    expect(posted[0]!.targetOrigin).toBe(ORIGIN);
  });

  it('the page gets the SAME response object, and its body is still readable after the hook cloned it', async () => {
    const res = fakeResponse('{"itemList":[1]}');
    const { win, posted } = setup({ fetchImpl: async () => res });
    const got = await win.fetch!(FAV);
    expect(got).toBe(res);
    await settle();
    expect(posted).toHaveLength(1);
  });

  it('is transparent to inspection: same name, length and prototype as the function it wraps, and no hook source in toString', () => {
    async function fetch(_input: unknown, _init?: unknown) { return fakeResponse('{}'); }
    const { win } = setup({ fetchImpl: fetch as never });
    expect(win.fetch).not.toBe(fetch);
    expect((win.fetch as { name: string }).name).toBe('fetch');
    expect((win.fetch as { length: number }).length).toBe(fetch.length);
    expect(Object.getPrototypeOf(win.fetch)).toBe(Object.getPrototypeOf(fetch));
    expect(Function.prototype.toString.call(win.fetch)).not.toMatch(/classify|report|postMessage|identity/);
  });

  it('a rejection the page ignores is still an unhandled rejection exactly once, like without the hook', async () => {
    const seen: unknown[] = [];
    const on = (e: unknown) => seen.push(e);
    process.on('unhandledRejection', on);
    try {
      const boom = new Error('network down');
      const { win } = setup({ fetchImpl: () => Promise.reject(boom) });
      void win.fetch!(FAV); // the page does not handle it
      await settle(); await settle();
      expect(seen).toEqual([boom]);
    } finally { process.off('unhandledRejection', on); }
  });

  it('passes arguments and `this` through unchanged', async () => {
    let seen: { self: unknown; args: unknown[] } | undefined;
    const fetchImpl = function (this: unknown, ...args: unknown[]) { seen = { self: this, args }; return Promise.resolve(fakeResponse('{}')); };
    const { win } = setup({ fetchImpl: fetchImpl as HookWindow['fetch'] });
    const init = { method: 'GET' };
    await win.fetch!.call(win, FAV, init);
    expect(seen!.self).toBe(win);
    expect(seen!.args[0]).toBe(FAV);
    expect(seen!.args[1]).toBe(init);
  });

  it('never reads, clones or posts anything for a request outside the allowlist', async () => {
    const res = fakeResponse('{"itemList":[]}');
    const { win, posted } = setup({ fetchImpl: async () => res });
    for (const url of [
      `${ORIGIN}/api/post/item_list/?cursor=0`,
      `${ORIGIN}/api/repost/item_list/`,
      `${ORIGIN}/api/story/item_list/`,
      `${ORIGIN}/api/user/playlist/`,
      `${ORIGIN}/api/user/collect/item_list`, // no trailing slash: exact path only
      `${ORIGIN}/x/api/user/collect/item_list/`,
      'https://evil.example/api/user/collect/item_list/',
      'https://www.tiktok.com.evil.example/api/user/collect/item_list/',
      'http://www.tiktok.com/api/user/collect/item_list/',
    ]) await win.fetch!(url);
    await settle();
    expect(posted).toHaveLength(0);
    expect(res.state).toEqual({ cloned: 0, read: 0 });
  });

  it('accepts a Request-like input and a relative URL', async () => {
    const { win, posted } = setup();
    await win.fetch!({ url: `${ORIGIN}/api/collection/item_list/?collectionId=7000000000000000501&cursor=30` });
    await win.fetch!('/api/user/collection_list/?cursor=0');
    await settle();
    expect(posted.map((p) => [p.message.kind, p.message.collectionId, p.message.requestCursor])).toEqual([
      ['collection_items', '7000000000000000501', '30'],
      ['collection_list', undefined, '0'],
    ]);
  });

  it('drops a non-digit cursor instead of forwarding it', async () => {
    const { win, posted } = setup();
    await win.fetch!(`${ORIGIN}/api/user/collect/item_list/?cursor=abc%3Bdrop&collectionId=x`);
    await settle();
    expect(posted[0]!.message.requestCursor).toBeUndefined();
    expect(posted[0]!.message.collectionId).toBeUndefined();
  });

  it('does not capture an unsuccessful response', async () => {
    const { win, posted } = setup({ fetchImpl: async () => fakeResponse('{"error":1}', false) });
    await win.fetch!(FAV);
    await settle();
    expect(posted).toHaveLength(0);
  });

  it('does not post an empty or oversized body', async () => {
    let body = '';
    const { win, posted } = setup({ fetchImpl: async () => fakeResponse(body) });
    await win.fetch!(FAV); await settle();
    body = 'x'.repeat(MAX_BODY_CHARS + 1);
    await win.fetch!(FAV); await settle();
    expect(posted).toHaveLength(0);
  });

  it('a rejecting fetch still rejects for the page, and the hook adds no unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { win, posted } = setup({ fetchImpl: () => Promise.reject(new Error('network down')) });
      await expect(win.fetch!(FAV)).rejects.toThrow('network down');
      await settle();
      expect(posted).toHaveLength(0);
      expect(unhandled).toHaveLength(0);
    } finally { process.off('unhandledRejection', onUnhandled); }
  });

  it('the page is unaffected when clone/text/postMessage/classify/identity all throw', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const boom = () => { throw new Error('boom'); };
      const cases: Array<() => ReturnType<typeof setup>> = [
        () => setup({ fetchImpl: async () => ({ ok: true, clone: boom }) as never }),
        () => setup({ fetchImpl: async () => ({ ok: true, clone: () => ({ text: () => Promise.reject(new Error('x')) }) }) as never }),
        () => { const s = setup(); (s.win as { postMessage: unknown }).postMessage = boom; return s; },
        () => setup({ platform: { classify: boom } }),
        () => setup({ platform: { identity: boom } }),
      ];
      for (const make of cases) {
        const s = make();
        const res = await s.win.fetch!(FAV);
        expect(res).toBeTruthy(); // the page still got its response
        await settle();
      }
      expect(unhandled).toHaveLength(0);
    } finally { process.off('unhandledRejection', onUnhandled); }
  });

  it('reads identity when the request is MADE (single-page navigation changes it mid-session)', async () => {
    let who = 'first';
    const { win, posted } = setup({ platform: { identity: () => ({ pageHandle: who, viewerHandle: 'testuser' }) } });
    const p1 = win.fetch!(FAV);
    who = 'second'; // navigated away before the response arrived
    await p1; await settle();
    expect(posted[0]!.message.pageHandle).toBe('first');
  });

  it('a non-function fetch is left alone', () => {
    const win: HookWindow = { location: { origin: ORIGIN }, postMessage: () => undefined };
    expect(() => installCaptureHook(win, { id: 'tiktok', classify: classifyRequest, identity: () => ({}) })).not.toThrow();
    expect(win.fetch).toBeUndefined();
  });
});

describe('capture hook: XMLHttpRequest', () => {
  it('captures an allowed load (text and json response types)', async () => {
    const { posted } = setup();
    const a = new FakeXhr();
    a.open('GET', FAV); a.send(); a.responseText = '{"itemList":[2]}'; a.finish();
    const b = new FakeXhr();
    b.open('GET', `${ORIGIN}/api/collection/detail/?collectionId=7000000000000000501`); b.send();
    b.responseType = 'json'; b.response = { collectionInfo: {} }; b.finish();
    expect(posted.map((p) => [p.message.kind, p.message.body])).toEqual([
      ['favorites', '{"itemList":[2]}'],
      ['collection_detail', '{"collectionInfo":{}}'],
    ]);
    expect(JSON.stringify(posted)).not.toMatch(/SECRET|DEVICE123/);
  });

  it('ignores other URLs, failed statuses and unreadable response types', () => {
    const { posted } = setup();
    const other = new FakeXhr(); other.open('GET', `${ORIGIN}/api/post/item_list/`); other.send(); other.responseText = '{}'; other.finish();
    const failed = new FakeXhr(); failed.open('GET', FAV); failed.send(); failed.status = 500; failed.responseText = '{}'; failed.finish();
    const blob = new FakeXhr(); blob.open('GET', FAV); blob.send(); blob.responseType = 'arraybuffer'; blob.finish();
    expect(posted).toHaveLength(0);
  });

  it('re-opening an instance for a different URL stops tracking it', () => {
    const { posted } = setup();
    const x = new FakeXhr();
    x.open('GET', FAV);
    x.open('GET', `${ORIGIN}/api/post/item_list/`);
    x.send(); x.responseText = '{}'; x.finish();
    expect(posted).toHaveLength(0);
  });

  it('leaves no trace on the page\'s XHR objects and still calls the originals', () => {
    const { originals } = setup();
    const x = new FakeXhr();
    const before = Object.keys(x).sort();
    x.open('GET', FAV); x.send();
    expect(Object.keys(x).sort()).toEqual([...before, 'method', 'url'].filter((k, i, a) => a.indexOf(k) === i).sort());
    expect(x.method).toBe('GET'); // the original open ran
    expect(x.url).toBe(FAV);
    expect(FakeXhr.prototype.open).not.toBe(originals.open);
  });

  it('survives hostile XHR state', () => {
    const { posted } = setup({ platform: { classify: () => { throw new Error('boom'); } } });
    const x = new FakeXhr();
    expect(() => { x.open('GET', FAV); x.send(); x.responseText = '{}'; x.finish(); }).not.toThrow();
    expect(posted).toHaveLength(0);
  });
});

describe('capture hook: XMLHttpRequest reuse and transparency', () => {
  it('a reused XHR object never reports a later request under the earlier one\'s kind, and repeated send() does not stack listeners', () => {
    const { posted } = setup();
    const x = new FakeXhr();
    x.open('GET', FAV); x.send(); x.send(); // an allowed request, sent twice
    x.open('GET', ORIGIN + '/api/post/item_list/'); x.send(); // the same object reused for a request we must never read
    x.responseText = '{"private":"uploads"}'; x.finish();
    expect(posted).toHaveLength(0);
    const y = new FakeXhr();
    y.open('GET', FAV); y.send(); y.send(); y.responseText = '{"itemList":[]}'; y.finish();
    expect(posted).toHaveLength(1); // one response, one message
  });

  it('XHR methods are transparent too (same name; no hook source in toString)', () => {
    const openName = FakeXhr.prototype.open.name;
    setup();
    expect(FakeXhr.prototype.open.name).toBe(openName);
    expect(Function.prototype.toString.call(FakeXhr.prototype.send)).not.toMatch(/tracked|classify|report/);
  });
});

describe('capture hook: uninstall', () => {
  it('restores the page\'s original fetch and XHR methods', () => {
    const { win, hook, originals } = setup();
    expect(win.fetch).not.toBe(originals.fetch);
    hook.uninstall();
    expect(win.fetch).toBe(originals.fetch);
    expect(FakeXhr.prototype.open).toBe(originals.open);
    expect(FakeXhr.prototype.send).toBe(originals.send);
  });
});
