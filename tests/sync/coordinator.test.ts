// The sync coordinator with a fake browser and fake database: what it opens, what it tells the driver, what it reconciles, and that a
// killed-and-restarted service worker continues from the persisted state.
import { describe, expect, it } from 'vitest';
import type { ReconcileInput } from '../../src/core/model';
import type { PageView, SyncPlatformSpec, SyncState } from '../../src/core/sync/types';
import { createSyncCoordinator, SyncBusyError, type CapturedPage, type LastPass, type SyncEnv, type SyncStore, type SyncWindowRecord } from '../../src/extension/sync/coordinator';
import type { DriverCommand } from '../../src/extension/sync/driver';

const spec: SyncPlatformSpec = {
  platform: 'p',
  homeUrl: 'https://p.test/',
  savedUrl: (h) => `https://p.test/@${h}?tab=saved`,
  collectionUrl: (h, c) => `https://p.test/@${h}/c/${c.name}-${c.id}`,
  roles: { saved: 'saved', collection_items: 'collection', collection_list: 'collections', collection_detail: 'collection_info' },
};

class World {
  kv = new Map<string, string>(); // "persistent storage": JSON strings, so nothing is shared by reference
  tabs = new Map<number, { url: string; windowId: number }>();
  nextTab = 1;
  opened: string[] = [];
  navigations: Array<{ tabId: number; url: string }> = [];
  closed: number[] = [];
  commands: Array<{ tabId: number; cmd: DriverCommand }> = [];
  driverReachable = true;
  reconciles: ReconcileInput[] = [];
  available = 0;
  sizes = new Map<string, number>(); // videos stored per collection
  bound: { handle: string; id?: string } | undefined;
  broadcasts: SyncState[] = [];
  alarmArmed = false;
  failOpen = false;
  failReconcile = false;
  clock = 1_000_000;

  store: SyncStore = {
    loadState: async () => this.get<SyncState>('state'),
    saveState: async (s) => { this.put('state', s); },
    loadWindow: async () => this.get<SyncWindowRecord>('window'),
    saveWindow: async (w) => { if (w) this.put('window', w); else this.kv.delete('window'); },
    loadLast: async (p) => this.get<LastPass>(`last.${p}`),
    saveLast: async (p, l) => { this.put(`last.${p}`, l); },
    clearLast: async (p) => { this.kv.delete(`last.${p}`); },
    seenAppend: async (run, bucket, ids) => { const k = `seen.${run}.${bucket}`; this.put(k, [...(this.get<string[]>(k) ?? []), ...ids]); },
    seenRead: async (run, bucket) => this.get<string[]>(`seen.${run}.${bucket}`) ?? [],
    seenClear: async (run) => { for (const k of [...this.kv.keys()]) if (k.startsWith(`seen.${run}.`)) this.kv.delete(k); },
  };
  get<T>(k: string): T | undefined { const v = this.kv.get(k); return v === undefined ? undefined : (JSON.parse(v) as T); }
  put(k: string, v: unknown): void { this.kv.set(k, JSON.stringify(v)); }
  seenKeys(): string[] { return [...this.kv.keys()].filter((k) => k.startsWith('seen.')); }

  make(over: Partial<SyncEnv> = {}) {
    let n = 0;
    const env: SyncEnv = {
      now: () => (this.clock += 1000),
      newRunId: () => `run-${++n}-${this.clock}`,
      spec,
      store: this.store,
      windows: {
        open: async (url) => {
          if (this.failOpen) throw new Error('no window available');
          const rec = { tabId: this.nextTab++, windowId: 100 + this.nextTab };
          this.tabs.set(rec.tabId, { url, windowId: rec.windowId });
          this.opened.push(url);
          return rec;
        },
        exists: async (tabId) => this.tabs.has(tabId),
        navigate: async (rec, url) => { this.tabs.get(rec.tabId)!.url = url; this.navigations.push({ tabId: rec.tabId, url }); },
        close: async (rec) => { this.tabs.delete(rec.tabId); this.closed.push(rec.tabId); },
      },
      sendToDriver: async (tabId, cmd) => { if (!this.driverReachable) return false; this.commands.push({ tabId, cmd }); return true; },
      data: {
        reconcile: async (input) => { if (this.failReconcile) throw new Error('db down'); this.reconciles.push(input); return { markedUnavailable: 0, revived: 0, membershipsRemoved: 0 }; },
        availableItems: async () => this.available,
        collectionSize: async (_p, id) => this.sizes.get(id) ?? 0,
        boundAccount: async () => this.bound,
      },
      broadcast: (s) => { this.broadcasts.push(s); },
      alarm: { arm: () => { this.alarmArmed = true; }, disarm: () => { this.alarmArmed = false; } },
      ...over,
    };
    return createSyncCoordinator(env);
  }
  cmds(kind?: DriverCommand['cmd']): DriverCommand[] { return this.commands.map((c) => c.cmd).filter((c) => !kind || c.cmd === kind); }
}

const HOME: PageView = { kind: 'home' };
const PROFILE: PageView = { kind: 'profile', pageHandle: 'me' };
const COLL = (id: string): PageView => ({ kind: 'collection', pageHandle: 'me', collectionId: id });
const cap = (kind: string, o: Partial<CapturedPage> = {}): CapturedPage => ({ kind, hasMore: true, itemsDelivered: 2, inserted: 2, reindexed: 0, duplicate: false, externalIds: [], ...o });
const savedPage = (req: string, res: string, hasMore: boolean, ids: string[], o: Partial<CapturedPage> = {}) => cap('saved', { requestCursor: req, responseCursor: res, hasMore, externalIds: ids, itemsDelivered: ids.length, inserted: ids.length, ...o });
const collPage = (id: string, req: string, res: string, hasMore: boolean, ids: string[]) => cap('collection_items', { collectionId: id, requestCursor: req, responseCursor: res, hasMore, externalIds: ids, itemsDelivered: ids.length, inserted: 0 });
const listPage = (...cs: Array<[string, string]>) => cap('collection_list', { hasMore: false, itemsDelivered: cs.length, collections: cs.map(([id, name]) => ({ id, name })) });

/** Drive a whole run through the coordinator as the real browser would. */
async function fullRun(w: World, c = w.make(), opts: { tab?: number } = {}) {
  const tab = opts.tab ?? 1;
  await c.start('full');
  await c.onDriverEvent({ type: 'ready', handle: 'me', pageState: 'ok', view: HOME }, { tabId: tab });
  await c.onDriverEvent({ type: 'ready', handle: 'me', pageState: 'ok', view: PROFILE }, { tabId: tab });
  return c;
}

describe('sync coordinator: a full run', () => {
  it('opens the platform, navigates to the saved list once it knows who is signed in, and starts the driver', async () => {
    const w = new World();
    const c = await fullRun(w);
    expect(w.opened).toEqual(['https://p.test/']);
    expect(w.navigations).toEqual([{ tabId: 1, url: 'https://p.test/@me?tab=saved' }]);
    expect(w.cmds('start')).toHaveLength(1);
    expect((await c.status()).status).toBe('running');
    expect(w.alarmArmed).toBe(true);
  });

  it('reads the saved list and each collection, reconciles exactly what it saw, marks the pass complete, and closes the window', async () => {
    const w = new World();
    w.available = 6;
    const c = await fullRun(w);
    await c.onCaptured(listPage(['c1', 'Recipes'], ['c2', 'Trips']));
    await c.onCaptured(savedPage('0', '30', true, ['v1', 'v2', 'v3']));
    await c.onCaptured(savedPage('30', '0', false, ['v4', 'v5', 'v6']));
    expect(w.reconciles).toEqual([{ platform: 'p', seenExternalIds: ['v1', 'v2', 'v3', 'v4', 'v5', 'v6'] }]);
    expect(w.get<LastPass>('last.p')).toBeDefined();
    expect(w.navigations.at(-1)).toEqual({ tabId: 1, url: 'https://p.test/@me/c/Recipes-c1' });

    await c.onDriverEvent({ type: 'ready', handle: 'me', pageState: 'ok', view: COLL('c1') }, { tabId: 1 });
    await c.onCaptured(collPage('c1', '0', '0', false, ['v1', 'v4']));
    expect(w.reconciles.at(-1)).toEqual({ platform: 'p', collectionExternalId: 'c1', seenExternalIds: ['v1', 'v4'], allowEmpty: true });
    await c.onDriverEvent({ type: 'ready', handle: 'me', pageState: 'ok', view: COLL('c2') }, { tabId: 1 });
    await c.onCaptured(collPage('c2', '0', '0', false, []));
    const s = await c.status();
    expect(s.status).toBe('completed');
    expect(w.closed).toEqual([1]);
    expect(w.seenKeys()).toEqual([]); // the remembered ids are discarded with the run
    expect(w.alarmArmed).toBe(false);
    expect(w.get('window')).toBeUndefined();
  });

  it('duplicate pages still contribute their ids to the reconciliation', async () => {
    const w = new World();
    const c = await fullRun(w);
    await c.onCaptured(listPage());
    await c.onCaptured(savedPage('0', '30', true, ['v1', 'v2'], { duplicate: true, inserted: 0 }));
    await c.onCaptured(savedPage('30', '0', false, ['v3']));
    expect(w.reconciles[0]!.seenExternalIds).toEqual(['v1', 'v2', 'v3']);
  });

  it('does not reconcile in an incremental pass that has a complete pass behind it', async () => {
    const w = new World();
    w.put('last.p', { completedAt: 5 });
    const c = w.make();
    await c.start('incremental');
    await c.onDriverEvent({ type: 'ready', handle: 'me', pageState: 'ok', view: HOME }, { tabId: 1 });
    await c.onDriverEvent({ type: 'ready', handle: 'me', pageState: 'ok', view: PROFILE }, { tabId: 1 });
    await c.onCaptured(listPage());
    await c.onCaptured(savedPage('0', '30', true, ['v1'], { inserted: 0 }));
    await c.onCaptured(savedPage('30', '20', true, ['v2'], { inserted: 0 }));
    expect((await c.status()).status).toBe('completed');
    expect(w.reconciles).toEqual([]);
    expect(w.seenKeys()).toEqual([]);
  });

  it('refuses a second start while a run is active, and allows one afterwards', async () => {
    const w = new World();
    const c = await fullRun(w);
    await expect(c.start('full')).rejects.toBeInstanceOf(SyncBusyError);
    await c.cancel();
    await expect(c.start('full')).resolves.toMatchObject({ status: 'running' });
  });
});

describe('sync coordinator: reconcile safety', () => {
  it('will not mark videos unavailable after seeing implausibly few of them', async () => {
    const w = new World();
    w.available = 100;
    const c = await fullRun(w);
    await c.onCaptured(listPage());
    await c.onCaptured(savedPage('0', '0', false, ['v1', 'v2', 'v3']));
    expect(w.reconciles).toEqual([]);
    expect((await c.status()).warnings.join(' ')).toMatch(/implausibly few/);
    expect((await c.status()).status).toBe('completed');
  });

  it('a small library is reconciled regardless (the plausibility check needs something to compare with)', async () => {
    const w = new World();
    w.available = 10;
    const c = await fullRun(w);
    await c.onCaptured(listPage());
    await c.onCaptured(savedPage('0', '0', false, ['v1']));
    expect(w.reconciles).toHaveLength(1);
  });

  it('never reconciles a saved list in which nothing was read', async () => {
    const w = new World();
    const c = await fullRun(w);
    await c.onCaptured(listPage());
    await c.onCaptured(savedPage('0', '0', false, []));
    expect(w.reconciles).toEqual([]);
    expect((await c.status()).warnings.join(' ')).toMatch(/Nothing was read/);
  });

  it('leaves a collection alone when it came back empty although the platform says it has videos', async () => {
    const w = new World();
    const c = await fullRun(w);
    await c.onCaptured({ ...listPage(['c1', 'Recipes']), collections: [{ id: 'c1', name: 'Recipes', declaredTotal: 12 }] });
    await c.onCaptured(savedPage('0', '0', false, ['v1']));
    await c.onDriverEvent({ type: 'ready', handle: 'me', pageState: 'ok', view: COLL('c1') }, { tabId: 1 });
    await c.onCaptured(collPage('c1', '0', '0', false, []));
    expect(w.reconciles.filter((r) => r.collectionExternalId !== undefined)).toEqual([]);
    expect((await c.status()).warnings.join(' ')).toMatch(/came back empty/);
  });

  it('a genuinely empty collection (declared 0) is reconciled to empty', async () => {
    const w = new World();
    const c = await fullRun(w);
    await c.onCaptured({ ...listPage(['c1', 'Empty']), collections: [{ id: 'c1', name: 'Empty', declaredTotal: 0 }] });
    await c.onCaptured(savedPage('0', '0', false, ['v1']));
    await c.onDriverEvent({ type: 'ready', handle: 'me', pageState: 'ok', view: COLL('c1') }, { tabId: 1 });
    await c.onCaptured(collPage('c1', '0', '0', false, []));
    expect(w.reconciles.at(-1)).toEqual({ platform: 'p', collectionExternalId: 'c1', seenExternalIds: [], allowEmpty: true });
  });

  it('counts each video once: a replayed first page cannot make a truncated pass look complete', async () => {
    const w = new World();
    w.available = 100;
    const c = await fullRun(w);
    await c.onCaptured(listPage());
    const page1 = Array.from({ length: 30 }, (_, i) => `v${i}`);
    const page2 = Array.from({ length: 15 }, (_, i) => `w${i}`);
    await c.onCaptured(savedPage('0', '30', true, page1));
    await c.onCaptured(savedPage('0', '30', true, page1, { duplicate: true, inserted: 0 })); // the platform replays page 1: 75 ids stored, 45 distinct
    await c.onCaptured(savedPage('30', '0', true, page2));
    await c.onCaptured(savedPage('0', '0', false, []));
    expect(w.reconciles).toEqual([]);
    expect((await c.status()).warnings.join(' ')).toMatch(/Only 45 of 100/);
  });

  it('will not drop the memberships of a big collection after seeing only a sliver of it (a forged or truncated final page)', async () => {
    const w = new World();
    w.sizes.set('c1', 300);
    const c = await fullRun(w);
    await c.onCaptured(listPage(['c1', 'Recipes']));
    await c.onCaptured(savedPage('0', '0', false, ['v1']));
    await c.onDriverEvent({ type: 'ready', handle: 'me', pageState: 'ok', view: COLL('c1') }, { tabId: 1 });
    await c.onCaptured(collPage('c1', '0', '30', true, ['a1', 'a2']));
    await c.onCaptured(collPage('c1', '30', '0', false, ['zz']));
    expect(w.reconciles.filter((r) => r.collectionExternalId !== undefined)).toEqual([]);
    expect((await c.status()).warnings.join(' ')).toMatch(/Only 3 of about 300 videos in "Recipes"/);
  });

  it('a collection is reconciled when the pass saw a plausible share of what it holds', async () => {
    const w = new World();
    w.sizes.set('c1', 40);
    const c = await fullRun(w);
    await c.onCaptured(listPage(['c1', 'Recipes']));
    await c.onCaptured(savedPage('0', '0', false, ['v1']));
    await c.onDriverEvent({ type: 'ready', handle: 'me', pageState: 'ok', view: COLL('c1') }, { tabId: 1 });
    await c.onCaptured(collPage('c1', '0', '0', false, Array.from({ length: 35 }, (_, i) => `a${i}`)));
    expect(w.reconciles.at(-1)).toMatchObject({ collectionExternalId: 'c1' });
  });

  it('a failing reconcile fails the run visibly instead of pretending it worked', async () => {
    const w = new World();
    w.failReconcile = true;
    const c = await fullRun(w);
    await c.onCaptured(listPage());
    await c.onCaptured(savedPage('0', '0', false, ['v1']));
    const s = await c.status();
    expect(s.status).toBe('failed');
    expect(s.error).toMatch(/reconcile/);
    expect(w.closed).toEqual([1]);
  });
});

describe('sync coordinator: the browser', () => {
  it('ignores driver events that do not come from the sync window', async () => {
    const w = new World();
    const c = w.make();
    await c.start('full');
    await c.onDriverEvent({ type: 'ready', handle: 'me', pageState: 'ok', view: HOME }, { tabId: 99 }); // some other tab
    await c.onDriverEvent({ type: 'ready', handle: 'me', pageState: 'ok', view: HOME }, {}); // no tab at all
    expect((await c.status()).phase).toBe('start');
    expect(w.navigations).toEqual([]);
  });

  it('closing the sync window asks for attention, and resume opens a fresh one at the same place', async () => {
    const w = new World();
    const c = await fullRun(w);
    await c.onCaptured(listPage());
    await c.onCaptured(savedPage('0', '30', true, ['v1']));
    w.tabs.delete(1);
    await c.onTabRemoved(1);
    expect((await c.status()).attention?.reason).toBe('tab_closed');
    expect(w.alarmArmed).toBe(false);
    await c.resume();
    expect(w.opened.at(-1)).toBe('https://p.test/@me?tab=saved'); // a new window on the saved list
    expect((await c.status()).status).toBe('running');
    expect(w.alarmArmed).toBe(true);
  });

  it('a tab that is not the sync window closing changes nothing', async () => {
    const w = new World();
    const c = await fullRun(w);
    const before = await c.status();
    await c.onTabRemoved(42);
    expect(await c.status()).toEqual(before);
  });

  it('pause stops the driver and resume continues on the same page when the driver answers', async () => {
    const w = new World();
    const c = await fullRun(w);
    await c.pause();
    expect(w.cmds().at(-1)).toEqual({ cmd: 'stop' });
    const opened = w.opened.length;
    await c.resume();
    expect(w.cmds().at(-1)).toEqual({ cmd: 'probe' });
    expect(w.opened.length).toBe(opened); // no new window
    expect(w.navigations).toHaveLength(1); // no reload: only the initial navigation to the saved list
  });

  it('resume reloads the target when the driver cannot be reached', async () => {
    const w = new World();
    const c = await fullRun(w);
    await c.pause();
    w.driverReachable = false;
    await c.resume();
    expect(w.navigations.at(-1)).toEqual({ tabId: 1, url: 'https://p.test/@me?tab=saved' });
  });

  it('cancel stops the driver, closes the window and clears everything the run remembered', async () => {
    const w = new World();
    const c = await fullRun(w);
    await c.onCaptured(listPage());
    await c.onCaptured(savedPage('0', '30', true, ['v1']));
    expect(w.seenKeys().length).toBeGreaterThan(0);
    await c.cancel();
    expect((await c.status()).status).toBe('cancelled');
    expect(w.cmds().at(-1)).toEqual({ cmd: 'stop' });
    expect(w.closed).toEqual([1]);
    expect(w.seenKeys()).toEqual([]);
    expect(w.alarmArmed).toBe(false);
  });

  it('a wipe or import cancels a run in progress, and does nothing when idle', async () => {
    const w = new World();
    const idle = w.make();
    await idle.onLibraryReplaced();
    expect((await idle.status()).status).toBe('idle');
    const c = await fullRun(new World());
    await c.onLibraryReplaced();
    expect((await c.status()).status).toBe('cancelled');
  });

  it('failing to open the sync window fails the run with a readable message', async () => {
    const w = new World();
    w.failOpen = true;
    const c = w.make();
    const s = await c.start('full');
    expect(s.status).toBe('failed');
    expect(s.error).toMatch(/no window available/);
  });

  it('the heartbeat reloads a stalled list', async () => {
    const w = new World();
    const c = await fullRun(w);
    w.clock += 200_000;
    await c.onAlarm();
    expect((await c.status()).stallRetries).toBe(1);
    expect(w.navigations.length).toBeGreaterThanOrEqual(2);
  });

  it('a hidden sync window pauses by itself and continues by itself', async () => {
    const w = new World();
    const c = await fullRun(w);
    await c.onDriverEvent({ type: 'hidden' }, { tabId: 1 });
    expect((await c.status()).attention?.reason).toBe('tab_hidden');
    await c.onDriverEvent({ type: 'visible' }, { tabId: 1 });
    expect((await c.status()).status).toBe('running');
    expect(w.cmds().at(-1)).toEqual({ cmd: 'probe' });
  });
});

describe('sync coordinator: whose pages count', () => {
  it('a page or a refusal from an ordinary tab does not move the run (the library still keeps the page)', async () => {
    const w = new World();
    const c = await fullRun(w);
    await c.onCaptured(listPage());
    await c.onCaptured(savedPage('0', '30', true, ['x1', 'x2']), { tabId: 77 });
    await c.onCaptureRejected('not_own_profile', { tabId: 77 });
    await c.onCaptureRejected('identity_unknown', { tabId: 77 });
    const s = await c.status();
    expect(s.status).toBe('running');
    expect(s.saved.pages).toBe(0);
    expect(w.seenKeys()).toEqual([]);
    await c.onCaptured(savedPage('0', '30', true, ['v1', 'v2']), { tabId: 1 }); // the sync window's own tab counts
    expect((await c.status()).saved.pages).toBe(1);
    await c.onCaptureRejected('not_own_profile', { tabId: 1 });
    expect((await c.status()).attention?.reason).toBe('not_own_profile');
  });

  it('nothing of a run counts pages while the sync window record is missing', async () => {
    const w = new World();
    const c = await fullRun(w);
    w.kv.delete('window');
    await c.onCaptured(savedPage('0', '30', true, ['v1']), { tabId: 1 });
    expect((await c.status()).saved.pages).toBe(0);
  });

  it('the first page after the user opens a list by hand is remembered for reconciliation, like every later page', async () => {
    const w = new World();
    w.available = 6;
    const c = await fullRun(w, w.make({ syncConfig: { maxStallRetries: 0 } }));
    await c.onCaptured(listPage());
    await c.onDriverEvent({ type: 'stalled' }, { tabId: 1 });
    expect((await c.status()).attention?.reason).toBe('stalled');
    await c.onCaptured(savedPage('0', '30', true, ['v1', 'v2', 'v3'])); // the user opened Favorites: guided mode resumes
    expect((await c.status()).status).toBe('running');
    await c.onCaptured(savedPage('30', '0', false, ['v4', 'v5', 'v6']));
    expect(w.reconciles).toEqual([{ platform: 'p', seenExternalIds: ['v1', 'v2', 'v3', 'v4', 'v5', 'v6'] }]);
  });
});

describe('sync coordinator: state, broadcasts and restarts', () => {
  it('a run that says "running" but has no window of this browser session waits for the user instead of opening anything', async () => {
    const w = new World();
    await fullRun(w);
    w.kv.delete('window'); // the store drops a window record from an earlier browser session
    const opened = w.opened.length;
    const navigated = w.navigations.length;
    const b = w.make();
    const s = await b.init();
    expect(s).toMatchObject({ status: 'needs_attention', attention: { reason: 'tab_closed' } });
    expect(w.opened.length).toBe(opened);
    expect(w.navigations.length).toBe(navigated);
    expect(w.alarmArmed).toBe(false);
    await b.onAlarm();
    expect(w.opened.length).toBe(opened); // the heartbeat does not resurrect it either
    await b.resume();
    expect(w.opened.length).toBe(opened + 1); // only the user's Resume opens a window
  });

  it('a wipe or import forgets that a complete pass ever ran, so the next incremental sync reads everything', async () => {
    const w = new World();
    const c = await fullRun(w);
    await c.onCaptured(listPage());
    await c.onCaptured(savedPage('0', '0', false, ['v1']));
    expect(w.get<LastPass>('last.p')).toBeDefined();
    await c.onLibraryReplaced();
    expect(w.get<LastPass>('last.p')).toBeUndefined();
    await c.start('incremental');
    expect(await c.status()).toMatchObject({ mode: 'full', requestedMode: 'incremental' });
  });

  it('persists after every change and broadcasts a strictly increasing sequence', async () => {
    const w = new World();
    const c = await fullRun(w);
    await c.onCaptured(listPage(['c1', 'A']));
    await c.onCaptured(savedPage('0', '30', true, ['v1']));
    const seqs = w.broadcasts.map((b) => b.seq);
    expect(seqs.length).toBeGreaterThan(3);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(w.get<SyncState>('state')!.seq).toBe(seqs.at(-1));
  });

  it('a killed and restarted service worker continues the same run from the persisted state', async () => {
    const w = new World();
    const a = await fullRun(w);
    await a.onCaptured(listPage(['c1', 'A']));
    await a.onCaptured(savedPage('0', '30', true, ['v1', 'v2']));
    // the worker dies here: a brand-new coordinator over the same persistent storage
    const b = w.make();
    expect((await b.init()).status).toBe('running');
    expect(w.alarmArmed).toBe(true);
    await b.onCaptured(savedPage('30', '0', false, ['v3']));
    expect(w.reconciles[0]!.seenExternalIds).toEqual(['v1', 'v2', 'v3']); // ids from before the restart survived
    await b.onDriverEvent({ type: 'ready', handle: 'me', pageState: 'ok', view: COLL('c1') }, { tabId: 1 });
    await b.onCaptured(collPage('c1', '0', '0', false, ['v1']));
    expect((await b.status()).status).toBe('completed');
  });

  it('a corrupt or foreign saved state is replaced by a clean one', async () => {
    const w = new World();
    w.put('state', { v: 99, status: 'running' });
    const c = w.make();
    expect((await c.init()).status).toBe('idle');
  });

  it('events are processed strictly in order even when they arrive together', async () => {
    const w = new World();
    const c = await fullRun(w);
    await c.onCaptured(listPage());
    const pages = Array.from({ length: 15 }, (_, i) => savedPage(String(i === 0 ? 0 : 100 - (i - 1)), String(100 - i), i < 14, [`v${i}`]));
    pages[14] = savedPage('87', '0', false, ['v14']);
    await Promise.all(pages.map((p) => c.onCaptured(p)));
    expect((await c.status()).saved).toMatchObject({ pages: 15, done: 'complete' });
    expect(w.reconciles[0]!.seenExternalIds).toEqual(pages.map((p) => p.externalIds[0]));
  });

  it('captures of kinds the sync does not know are ignored', async () => {
    const w = new World();
    const c = await fullRun(w);
    const before = await c.status();
    await c.onCaptured(cap('something_else', { externalIds: ['x'] }));
    expect(await c.status()).toEqual(before);
  });

  it('capture rejections are forwarded (a captcha-like run of errors asks for attention)', async () => {
    const w = new World();
    const c = await fullRun(w);
    await c.onCaptured(listPage());
    await c.onCaptureRejected('bad_envelope');
    await c.onCaptureRejected('bad_envelope');
    expect((await c.status()).attention?.reason).toBe('blocked');
  });
});
