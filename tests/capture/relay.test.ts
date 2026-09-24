// The isolated-world relay: only this page's own, well-formed capture messages get forwarded, and nothing can break the page.
import { describe, expect, it } from 'vitest';
import { installCaptureRelay, type RelayWindow } from '../../src/extension/capture/relay';
import type { CaptureRuntimeMessage } from '../../src/extension/capture/protocol';
import { CAPTURE_CHANNEL } from '../../src/platforms/capture-protocol';
import { registry } from '../../src/platforms/registry';

const ORIGIN = 'https://www.tiktok.com';
const msg = (o: Record<string, unknown> = {}) => ({
  channel: CAPTURE_CHANNEL, v: 1, platform: 'tiktok', kind: 'favorites', capturedAt: Date.now(), body: '{"itemList":[]}', pageHandle: 'testuser', viewerHandle: 'testuser', ...o,
});

function setup(send?: (m: CaptureRuntimeMessage) => Promise<unknown>) {
  const self = { name: 'this window' };
  const sent: CaptureRuntimeMessage[] = [];
  let listener!: (ev: { source: unknown; origin: string; data: unknown }) => void;
  const win: RelayWindow = { location: { origin: ORIGIN }, addEventListener: (_t, l) => { listener = l; } };
  installCaptureRelay(win, self, registry, send ?? (async (m) => { sent.push(m); return { accepted: true }; }));
  return { self, sent, deliver: (data: unknown, source: unknown = self, origin: string = ORIGIN) => listener({ source, origin, data }) };
}

describe('capture relay', () => {
  it('forwards a valid message from this window, rebuilt without extras', () => {
    const { sent, deliver } = setup();
    deliver(msg({ cookie: 'sessionid=SECRET', extra: { a: 1 } }));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.target).toBe('capture');
    expect(JSON.stringify(sent[0])).not.toMatch(/SECRET|cookie|extra/);
  });

  it('ignores messages from another window or origin', () => {
    const { sent, deliver } = setup();
    deliver(msg(), { name: 'an iframe' });
    deliver(msg(), null);
    deliver(msg(), 'window');
    const s2 = setup();
    s2.deliver(msg(), s2.self, 'https://evil.example');
    s2.deliver(msg(), s2.self, 'null');
    s2.deliver(msg(), s2.self, 'https://www.tiktok.com.evil.example');
    expect(sent).toHaveLength(0);
    expect(s2.sent).toHaveLength(0);
  });

  it('ignores the page\'s other traffic, and invalid capture messages', () => {
    const { sent, deliver } = setup();
    for (const data of [null, undefined, 1, 'x', [], {}, { channel: 'other' }, { type: 'webpackHotUpdate' }, msg({ kind: 'post_item_list' }), msg({ platform: 'instagram' }), msg({ requestCursor: 'abc' }), msg({ body: 5 }), msg({ capturedAt: 1 })])
      deliver(data);
    expect(sent).toHaveLength(0);
  });

  it('does not throw when the extension is unreachable (rejected or synchronously throwing send)', async () => {
    const a = setup(() => Promise.reject(new Error('Extension context invalidated.')));
    expect(() => a.deliver(msg())).not.toThrow();
    const b = setup(() => { throw new Error('Extension context invalidated.'); });
    expect(() => b.deliver(msg())).not.toThrow();
    await new Promise((r) => setTimeout(r, 5)); // any stray rejection would surface as an unhandled error here
  });

  it('survives hostile event objects', () => {
    const { deliver } = setup();
    const trap = new Proxy({}, { get() { throw new Error('trap'); } });
    expect(() => deliver(trap)).not.toThrow();
    expect(() => deliver({ get channel(): string { throw new Error('x'); } })).not.toThrow();
  });
});
