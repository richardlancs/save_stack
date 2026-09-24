// The thin Chrome-backed parts of the sync environment, against a fake `chrome`: which window record is trusted, how the heartbeat is
// armed, and what closing the sync window closes. (The logic that uses them is tested against fakes of these interfaces elsewhere.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootId, chromeAlarm, chromeSyncStore, chromeSyncWindows, resetBootIdForTests, SYNC_ALARM } from '../../src/extension/sync/chrome-env';

function area() {
  const m = new Map<string, unknown>();
  return {
    m,
    get: async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => m.has(k)).map((k) => [k, m.get(k)])),
    set: async (o: Record<string, unknown>) => { for (const [k, v] of Object.entries(o)) m.set(k, structuredClone(v)); },
    remove: async (keys: string | string[]) => { for (const k of Array.isArray(keys) ? keys : [keys]) m.delete(k); },
  };
}

interface Fake {
  local: ReturnType<typeof area>;
  session: ReturnType<typeof area>;
  alarms: Set<string>;
  created: number;
  tabsRemoved: number[];
  windowsRemoved: number[];
}

let fake: Fake;
const install = (over: { session?: unknown } = {}): void => {
  fake = { local: fake?.local ?? area(), session: area(), alarms: new Set(), created: 0, tabsRemoved: [], windowsRemoved: [] };
  (globalThis as Record<string, unknown>).chrome = {
    storage: { local: fake.local, session: 'session' in over ? over.session : fake.session },
    alarms: {
      get: async (name: string) => (fake.alarms.has(name) ? { name } : undefined),
      create: async (name: string) => { fake.alarms.add(name); fake.created += 1; },
      clear: async (name: string) => fake.alarms.delete(name),
    },
    tabs: { remove: async (id: number) => { fake.tabsRemoved.push(id); } },
    windows: { remove: async (id: number) => { fake.windowsRemoved.push(id); } },
  };
  resetBootIdForTests();
};

beforeEach(() => { (fake as unknown) = undefined; install(); });
afterEach(() => { delete (globalThis as Record<string, unknown>).chrome; resetBootIdForTests(); });

describe('the sync window record', () => {
  it('is trusted within the browser session that wrote it (a service worker restart keeps it)', async () => {
    await chromeSyncStore.saveWindow({ tabId: 5, windowId: 9 });
    resetBootIdForTests(); // a stopped and restarted service worker: the session storage is still there
    expect(await chromeSyncStore.loadWindow()).toEqual({ tabId: 5, windowId: 9 });
  });

  it('is NOT trusted after the browser was restarted: tab ids start over, so the old id could be one of the user\'s own tabs', async () => {
    await chromeSyncStore.saveWindow({ tabId: 5, windowId: 9 });
    install(); // a new browser session: local storage persists, session storage is empty
    expect(fake.local.m.has('scroganize.sync.window')).toBe(true);
    expect(await chromeSyncStore.loadWindow()).toBeUndefined();
  });

  it('a new session gets a new id, and the same session keeps its id', async () => {
    const a = await bootId();
    expect(await bootId()).toBe(a);
    resetBootIdForTests();
    expect(await bootId()).toBe(a); // read back from the session storage
    install();
    expect(await bootId()).not.toBe(a);
  });

  it('when session storage is unavailable the record is trusted as before (never blocks a sync)', async () => {
    install({ session: undefined });
    await chromeSyncStore.saveWindow({ tabId: 2, windowId: 3 });
    expect(await chromeSyncStore.loadWindow()).toEqual({ tabId: 2, windowId: 3 });
  });

  it('can be removed', async () => {
    await chromeSyncStore.saveWindow({ tabId: 5, windowId: 9 });
    await chromeSyncStore.saveWindow(undefined);
    expect(await chromeSyncStore.loadWindow()).toBeUndefined();
  });
});

describe('the last complete pass', () => {
  it('is remembered per platform and can be forgotten', async () => {
    await chromeSyncStore.saveLast('p', { completedAt: 7 });
    expect(await chromeSyncStore.loadLast('p')).toEqual({ completedAt: 7 });
    await chromeSyncStore.clearLast('p');
    expect(await chromeSyncStore.loadLast('p')).toBeUndefined();
  });
});

describe('the heartbeat alarm', () => {
  it('is created once, not restarted by every event of a run', async () => {
    for (let i = 0; i < 5; i++) { chromeAlarm.arm(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }
    await vi.waitFor(() => expect(fake.created).toBe(1));
    expect(fake.alarms.has(SYNC_ALARM)).toBe(true);
  });

  it('can be cleared', async () => {
    chromeAlarm.arm();
    await vi.waitFor(() => expect(fake.alarms.has(SYNC_ALARM)).toBe(true));
    chromeAlarm.disarm();
    await vi.waitFor(() => expect(fake.alarms.has(SYNC_ALARM)).toBe(false));
  });
});

describe('closing the sync window', () => {
  it('closes the sync TAB, never the whole window (the user may have put tabs of their own in it)', async () => {
    await chromeSyncWindows.close({ tabId: 5, windowId: 9 });
    expect(fake.tabsRemoved).toEqual([5]);
    expect(fake.windowsRemoved).toEqual([]);
  });
});
