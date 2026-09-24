// The sync state machine: scripted runs, every attention path, the completeness rules, and a seeded random-event check of the invariants.
import { describe, expect, it } from 'vitest';
import { initialSyncState, isActive, reduce } from '../../src/core/sync/machine';
import {
  DEFAULT_SYNC_CONFIG,
  type PageView,
  type SyncEffect,
  type SyncEvent,
  type SyncMode,
  type SyncPage,
  type SyncState,
} from '../../src/core/sync/types';

let clock = 1_000_000;
const t = () => (clock += 1000);

const HOME: PageView = { kind: 'home' };
const PROFILE: PageView = { kind: 'profile', pageHandle: 'me' };
const COLL = (id: string): PageView => ({ kind: 'collection', pageHandle: 'me', collectionId: id });

class Run {
  state = initialSyncState('p');
  effects: SyncEffect[] = [];
  all: SyncEffect[] = [];
  send(e: SyncEvent): this {
    const before = JSON.stringify(this.state);
    const step = reduce(this.state, e);
    expect(JSON.stringify(this.state), 'reduce must not mutate its input').toBe(before);
    this.state = step.state;
    this.effects = step.effects;
    this.all.push(...step.effects);
    return this;
  }
  start(mode: SyncMode = 'full', o: { hasCompletedBefore?: boolean; boundHandle?: string; boundId?: string; config?: Partial<typeof DEFAULT_SYNC_CONFIG> } = {}) {
    return this.send({ type: 'start', now: t(), runId: 'run1', platform: 'p', mode, hasCompletedBefore: o.hasCompletedBefore ?? true, ...(o.boundHandle !== undefined ? { boundHandle: o.boundHandle } : {}), ...(o.boundId !== undefined ? { boundId: o.boundId } : {}), ...(o.config ? { config: o.config } : {}) });
  }
  ready(view: PageView = HOME, handle: string | null = 'me', pageState: 'ok' | 'login' | 'captcha' | 'interstitial' | 'unknown' = 'ok', id?: string) {
    return this.send({ type: 'driver_ready', now: t(), ...(handle !== null ? { handle } : {}), ...(id !== undefined ? { id } : {}), pageState, view });
  }
  page(p: Partial<SyncPage> & { role: SyncPage['role'] }) {
    return this.send({ type: 'page', now: t(), page: { hasMore: true, items: 10, inserted: 10, reindexed: 0, duplicate: false, ...p } });
  }
  types(): string[] { return this.effects.map((e) => e.type); }
  has(type: SyncEffect['type']): boolean { return this.all.some((e) => e.type === type); }
}

/** A saved-list page in a chain: request cursor -> response cursor. */
const saved = (req: string, res: string, hasMore: boolean, o: Partial<SyncPage> = {}) => ({ role: 'saved' as const, requestCursor: req, responseCursor: res, hasMore, ...o });
const coll = (id: string, req: string, res: string, hasMore: boolean, o: Partial<SyncPage> = {}) => ({ role: 'collection' as const, collectionId: id, requestCursor: req, responseCursor: res, hasMore, ...o });
const list = (...cs: Array<[string, string]>) => ({ role: 'collections' as const, hasMore: false, collections: cs.map(([id, name]) => ({ id, name })) });

/** Run to the point where the saved list is being scrolled. */
function toSavedList(mode: SyncMode = 'full', o: Parameters<Run['start']>[1] = {}) {
  const r = new Run().start(mode, o);
  r.ready(HOME);
  r.ready(PROFILE);
  return r;
}

describe('sync machine: the happy path', () => {
  it('start opens the platform and refuses a second start while active', () => {
    const r = new Run().start('full');
    expect(r.state).toMatchObject({ status: 'running', phase: 'start', mode: 'full', runId: 'run1' });
    expect(r.types()).toEqual(['open']);
    const again = reduce(r.state, { type: 'start', now: t(), runId: 'run2', platform: 'p', mode: 'full', hasCompletedBefore: true });
    expect(again.state).toBe(r.state);
    expect(again.effects).toEqual([]);
  });

  it('runs identity -> saved list -> every collection -> completed, reconciling each complete list (full mode)', () => {
    const r = new Run().start('full');
    r.ready(HOME); // identity read
    expect(r.state).toMatchObject({ phase: 'saved', handle: 'me' });
    expect(r.effects).toEqual([{ type: 'open', target: { kind: 'saved' } }]);
    r.ready(PROFILE);
    expect(r.effects).toEqual([{ type: 'driver_start', target: { kind: 'saved' } }]);

    r.page(list(['c1', 'Recipes'], ['c2', 'Trips'])); // arrives while the saved page loads
    expect(r.state.collections.map((c) => [c.id, c.status])).toEqual([['c1', 'pending'], ['c2', 'pending']]);

    r.page(saved('0', '300', true));
    expect(r.effects).toEqual([]);
    r.page(saved('300', '200', true));
    r.page(saved('200', '0', false));
    expect(r.state.saved).toMatchObject({ done: 'complete', pages: 3 });
    expect(r.effects.map((e) => e.type)).toEqual(['driver_stop', 'mark_complete_pass', 'reconcile', 'open']);
    expect(r.effects[2]).toEqual({ type: 'reconcile', scope: 'saved' });
    expect(r.effects[3]).toEqual({ type: 'open', target: { kind: 'collection', id: 'c1', name: 'Recipes' } });
    expect(r.state).toMatchObject({ phase: 'collections', status: 'running' });
    expect(r.state.collections.map((c) => c.status)).toEqual(['active', 'pending']);

    r.ready(COLL('c1'));
    expect(r.effects).toEqual([{ type: 'driver_start', target: { kind: 'collection', id: 'c1', name: 'Recipes' } }]);
    r.page(coll('c1', '0', '30', true));
    r.page(coll('c1', '30', '45', false, { items: 15 }));
    expect(r.effects.map((e) => e.type)).toEqual(['driver_stop', 'reconcile', 'open']);
    expect(r.effects[1]).toEqual({ type: 'reconcile', scope: 'collection', collectionId: 'c1' });
    expect(r.state.collections[0]).toMatchObject({ status: 'done', pages: 2, items: 25 });

    r.ready(COLL('c2'));
    r.page(coll('c2', '0', '5', false, { items: 5 }));
    expect(r.state).toMatchObject({ status: 'completed', phase: 'done' });
    expect(r.state.finishedAt).toBeGreaterThan(0);
    expect(r.effects.map((e) => e.type)).toEqual(['driver_stop', 'reconcile', 'clear_seen', 'close_window']);
    expect(r.state.totals).toMatchObject({ pages: 3 + 2 + 1, items: 30 + 25 + 5 });
    expect(r.state.warnings).toEqual([]);
  });

  it('a run with no collections completes right after the saved list (an empty collection list is still a list)', () => {
    const r = toSavedList('full');
    r.page(list());
    r.page(saved('0', '0', false));
    expect(r.state.status).toBe('completed');
  });

  it('an incremental request with no earlier complete pass runs as a full pass and says so', () => {
    const r = new Run().start('incremental', { hasCompletedBefore: false });
    expect(r.state).toMatchObject({ requestedMode: 'incremental', mode: 'full' });
    expect(r.state.warnings[0]).toMatch(/reads everything/);
  });

  it('empty collections and declared totals are tracked without inventing items', () => {
    const r = toSavedList('full');
    r.page(list(['c1', 'Empty']));
    r.page({ role: 'collection_info', collectionId: 'c1', hasMore: null, items: 0, inserted: 0, reindexed: 0, duplicate: false, declaredTotal: 12 });
    expect(r.state.collections[0]!.declaredTotal).toBe(12);
    r.page(saved('0', '0', false));
    r.ready(COLL('c1'));
    r.page(coll('c1', '0', '0', false, { items: 0, inserted: 0 }));
    expect(r.state.status).toBe('completed');
    expect(r.state.collections[0]).toMatchObject({ status: 'done', items: 0, declaredTotal: 12 });
  });
});

describe('sync machine: incremental passes', () => {
  it('stops the saved list after two consecutive pages with nothing new, without reconciling', () => {
    const r = toSavedList('incremental');
    expect(r.state.mode).toBe('incremental');
    r.page(list(['c1', 'Recipes']));
    r.page(saved('0', '300', true, { inserted: 3 })); // something new: streak 0
    r.page(saved('300', '200', true, { inserted: 0 })); // streak 1
    expect(r.state.saved.done).toBe(false);
    r.page(saved('200', '100', true, { inserted: 0 })); // streak 2: stop
    expect(r.state.saved.done).toBe('early');
    expect(r.has('reconcile')).toBe(false);
    expect(r.has('mark_complete_pass')).toBe(false);
    expect(r.effects.map((e) => e.type)).toEqual(['driver_stop', 'open']); // straight on to the collections
    expect(r.state.phase).toBe('collections');
  });

  it('a page with something new resets the streak', () => {
    const r = toSavedList('incremental');
    r.page(list());
    r.page(saved('0', '300', true, { inserted: 0 }));
    r.page(saved('300', '200', true, { inserted: 1 }));
    r.page(saved('200', '100', true, { inserted: 0 }));
    expect(r.state.saved.knownStreak).toBe(1);
    expect(r.state.saved.done).toBe(false);
  });

  it('reads collections completely in incremental mode too, but never reconciles them', () => {
    const r = toSavedList('incremental');
    r.page(list(['c1', 'A']));
    r.page(saved('0', '0', false, { inserted: 0 })); // list ended on its own
    expect(r.state.saved.done).toBe('complete');
    r.ready(COLL('c1'));
    r.page(coll('c1', '0', '0', false));
    expect(r.state.status).toBe('completed');
    expect(r.all.filter((e) => e.type === 'reconcile')).toEqual([]);
  });

  it('duplicate pages count as "nothing new" and still chain', () => {
    const r = toSavedList('incremental');
    r.page(list());
    r.page(saved('0', '300', true, { inserted: 0, duplicate: true }));
    r.page(saved('300', '200', true, { inserted: 0, duplicate: true }));
    expect(r.state.saved.done).toBe('early');
    expect(r.state.chain.gap).toBe(false);
  });
});

describe('sync machine: completeness is only claimed for a list whose pages chained', () => {
  it('a missing page at the end re-reads the list, and a persistent gap finishes it as partial with no reconcile', () => {
    const r = toSavedList('full', { config: { maxStallRetries: 2 } });
    r.page(list());
    r.page(saved('0', '300', true));
    r.page(saved('200', '0', false)); // request 200 does not follow response 300: a page was missed
    expect(r.state.saved.done).toBe(false);
    expect(r.effects).toEqual([{ type: 'open', target: { kind: 'saved' } }]); // reload from the top
    expect(r.state.chainRetries).toBe(1);
    r.page(saved('0', '300', true));
    r.page(saved('200', '0', false)); // again
    expect(r.state.chainRetries).toBe(2);
    r.page(saved('0', '300', true));
    r.page(saved('200', '0', false)); // retries exhausted
    expect(r.state.saved.done).toBe('partial');
    expect(r.has('reconcile')).toBe(false);
    expect(r.has('mark_complete_pass')).toBe(false);
    expect(r.state.warnings.join(' ')).toMatch(/missed/);
    expect(r.state.status).toBe('completed'); // the run still ends; the user is told
  });

  it('a reload that then reads cleanly IS complete', () => {
    const r = toSavedList('full');
    r.page(list());
    r.page(saved('0', '300', true));
    r.page(saved('200', '0', false)); // gap -> reload
    r.page(saved('0', '300', true));
    r.page(saved('300', '0', false)); // clean chain this time
    expect(r.state.saved.done).toBe('complete');
    expect(r.has('reconcile')).toBe(true);
  });

  it('joining a list mid-way (first captured page is not the first) is a gap', () => {
    const r = toSavedList('full');
    r.page(list());
    r.page(saved('300', '0', false));
    expect(r.state.saved.done).toBe(false);
    expect(r.effects.map((e) => e.type)).toEqual(['open']);
  });

  it('a collection with a gap is re-read, then marked incomplete rather than reconciled', () => {
    const r = toSavedList('full', { config: { maxStallRetries: 0 } });
    r.page(list(['c1', 'A'], ['c2', 'B']));
    r.page(saved('0', '0', false));
    r.ready(COLL('c1'));
    r.page(coll('c1', '30', '0', false)); // missed the first page; no retries allowed
    expect(r.state.collections[0]).toMatchObject({ status: 'done', note: 'incomplete' });
    expect(r.all.filter((e) => e.type === 'reconcile').map((e) => JSON.stringify(e))).toEqual([JSON.stringify({ type: 'reconcile', scope: 'saved' })]); // no collection reconcile
    expect(r.state.target).toMatchObject({ kind: 'collection', id: 'c2' }); // moved on
    expect(r.state.warnings.join(' ')).toMatch(/collection "A"/);
  });

  it('a first page (cursor 0) after a reload clears an earlier gap', () => {
    const r = toSavedList('full');
    r.page(list());
    r.page(saved('300', '200', true)); // gap
    expect(r.state.chain.gap).toBe(true);
    r.page(saved('0', '300', true));
    expect(r.state.chain.gap).toBe(false);
  });
});

describe('sync machine: things that need the user', () => {
  it('the collection list never arriving asks the user to open it, and continues by itself when it arrives', () => {
    const r = toSavedList('full');
    r.page(saved('0', '0', false));
    expect(r.state).toMatchObject({ status: 'needs_attention', attention: { reason: 'open_collections' } });
    r.page(list(['c1', 'A']));
    expect(r.state.status).toBe('running');
    expect(r.state.attention).toBeUndefined();
    expect(r.effects).toEqual([{ type: 'open', target: { kind: 'collection', id: 'c1', name: 'A' } }]);
  });

  it.each([
    ['not signed in (page says login)', (r: Run) => r.ready(HOME, null, 'login'), 'login_required'],
    ['not signed in (no handle on a real page)', (r: Run) => r.ready(HOME, null, 'ok'), 'login_required'],
    ['a captcha', (r: Run) => r.ready(HOME, 'me', 'captcha'), 'captcha'],
  ])('%s at the start', (_n, act, reason) => {
    const r = new Run().start('full');
    act(r);
    expect(r.state).toMatchObject({ status: 'needs_attention', attention: { reason } });
    expect(r.effects).toEqual([{ type: 'driver_stop' }]);
  });

  it('ignores the interstitial and unknown pages (waits for the real one)', () => {
    const r = new Run().start('full');
    const before = r.state;
    r.ready(HOME, 'me', 'interstitial');
    r.ready(HOME, 'me', 'unknown');
    expect(r.state).toBe(before);
    expect(r.effects).toEqual([]);
  });

  it('refuses a signed-in account that differs from the library\'s, case-insensitively', () => {
    const r = new Run().start('full', { boundHandle: 'Original' });
    r.ready(HOME, 'someone_else');
    expect(r.state.attention?.reason).toBe('wrong_account');
    const ok = new Run().start('full', { boundHandle: 'ME' });
    ok.ready(HOME, 'me');
    expect(ok.state.status).toBe('running');
  });

  it('compares accounts by stable id when both sides have one: a username change is the same person, a reused name is not', () => {
    const renamed = new Run().start('full', { boundHandle: 'oldname', boundId: '111' });
    renamed.ready(HOME, 'newname', 'ok', '111');
    expect(renamed.state.status).toBe('running');
    expect(renamed.state).toMatchObject({ handle: 'newname', accountId: '111' });
    const squatter = new Run().start('full', { boundHandle: 'oldname', boundId: '111' });
    squatter.ready(HOME, 'oldname', 'ok', '999');
    expect(squatter.state.attention?.reason).toBe('wrong_account');
    const noIdOnPage = new Run().start('full', { boundHandle: 'oldname', boundId: '111' });
    noIdOnPage.ready(HOME, 'oldname', 'ok'); // the page did not offer an id: handles decide
    expect(noIdOnPage.state.status).toBe('running');
  });

  it('notices an account switch in the middle of a run, by id too', () => {
    const r = new Run().start('full');
    r.ready(HOME, 'me', 'ok', '111');
    r.ready(PROFILE, 'me', 'ok', '222'); // same handle, different person
    expect(r.state.attention?.reason).toBe('wrong_account');
  });

  it('notices an account switch in the middle of a run', () => {
    const r = toSavedList('full');
    r.ready(PROFILE, 'another');
    expect(r.state.attention?.reason).toBe('wrong_account');
  });

  it('refuses to read a page that is someone else\'s profile', () => {
    const r = new Run().start('full');
    r.ready({ kind: 'profile', pageHandle: 'stranger' }, 'me');
    expect(r.state.attention?.reason).toBe('not_own_profile');
  });

  it('maps capture rejections to what the user must do', () => {
    const run = (reason: string) => { const r = toSavedList('full'); r.send({ type: 'rejected', now: t(), reason }); return r; };
    expect(run('identity_unknown').state.attention?.reason).toBe('login_required');
    expect(run('account_mismatch').state.attention?.reason).toBe('wrong_account');
    expect(run('not_own_profile').state.attention?.reason).toBe('not_own_profile');
    expect(run('owner_mismatch').state.attention?.reason).toBe('not_own_profile');
    for (const harmless of ['sender', 'malformed', 'too_large', 'stale', 'unknown_kind', 'bad_json']) expect(run(harmless).state.status, harmless).toBe('running');
  });

  it('unreadable responses in a row mean the platform is blocking us; one good page resets the count', () => {
    const r = toSavedList('full');
    r.page(list());
    r.send({ type: 'rejected', now: t(), reason: 'bad_envelope' });
    expect(r.state.status).toBe('running');
    r.page(saved('0', '300', true));
    r.send({ type: 'rejected', now: t(), reason: 'bad_envelope' });
    expect(r.state.status).toBe('running');
    r.send({ type: 'rejected', now: t(), reason: 'bad_envelope' });
    expect(r.state).toMatchObject({ status: 'needs_attention', attention: { reason: 'blocked' } });
  });

  it('gives up when the local database keeps failing', () => {
    const r = toSavedList('full');
    for (let i = 0; i < 3; i++) r.send({ type: 'rejected', now: t(), reason: 'ingest_failed' });
    expect(r.state.status).toBe('failed');
    expect(r.state.error).toMatch(/database/);
    expect(r.effects.map((e) => e.type)).toEqual(['driver_stop', 'clear_seen', 'close_window']);
  });

  it('a failure or warning reported right after the last list finished still applies to the run', () => {
    const r = toSavedList('full');
    r.page(list());
    r.page(saved('0', '0', false));
    expect(r.state.status).toBe('completed');
    r.send({ type: 'warn', now: t(), message: 'careful' });
    expect(r.state.warnings).toContain('careful');
    r.send({ type: 'fatal', now: t(), message: 'reconcile blew up' });
    expect(r.state).toMatchObject({ status: 'failed', error: 'reconcile blew up' });
    const s = r.state;
    r.send({ type: 'fatal', now: t(), message: 'again' }); // already failed: ignored
    r.send({ type: 'warn', now: t(), message: 'late' });
    expect(r.state).toBe(s);
  });

  it('a list that never loaded continues by itself once the user opens it and pages arrive', () => {
    const r = toSavedList('full', { config: { maxStallRetries: 0 } });
    r.page(list());
    r.send({ type: 'driver_stalled', now: t() });
    expect(r.state).toMatchObject({ status: 'needs_attention', attention: { reason: 'stalled' } });
    expect(r.state.attention?.message).toMatch(/Favorites/);
    r.page(saved('0', '300', true));
    expect(r.state.status).toBe('running');
    expect(r.state.attention).toBeUndefined();
    expect(r.effects).toEqual([{ type: 'resume_target', target: { kind: 'saved' } }]);
    expect(r.state.saved.pages).toBe(1);
  });

  it('the collection list is kept even when it arrives while the run waits for the user (guided mode)', () => {
    const r = toSavedList('full', { config: { maxStallRetries: 0 } });
    r.send({ type: 'driver_stalled', now: t() });
    expect(r.state.attention?.reason).toBe('stalled');
    r.page(list(['c1', 'A'], ['c2', 'B'])); // arrives before the saved list the user is about to open
    expect(r.state.status).toBe('needs_attention'); // it does not resume by itself: it is only information
    expect(r.state.collections.map((c) => c.id)).toEqual(['c1', 'c2']);
    r.page(saved('0', '0', false)); // the user opened the saved list; it is one page long
    expect(r.state.saved.done).toBe('complete');
    expect(r.state.target).toMatchObject({ kind: 'collection', id: 'c1' }); // straight on to the collections: no "open the collections" prompt
  });

  it('a paused run also keeps the collection list and declared sizes it is told about', () => {
    const r = toSavedList('full');
    r.send({ type: 'pause', now: t() });
    r.page(list(['c1', 'A']));
    r.page({ role: 'collection_info', collectionId: 'c1', hasMore: null, items: 0, inserted: 0, reindexed: 0, duplicate: false, declaredTotal: 9 });
    expect(r.state.status).toBe('paused');
    expect(r.state.collections[0]).toMatchObject({ id: 'c1', declaredTotal: 9 });
  });

  it('a stalled sync does not resume for pages that are not its list', () => {
    const r = toSavedList('full', { config: { maxStallRetries: 0 } });
    r.page(list(['c1', 'A']));
    r.send({ type: 'driver_stalled', now: t() });
    const s = r.state;
    r.page(coll('c1', '0', '5', true)); // a collection page while the target is the saved list
    r.page(saved('0', '0', true, { items: 0 })); // an empty page proves nothing
    expect(r.state).toBe(s);
  });

  it('a hidden window pauses by itself and continues by itself when it becomes visible', () => {
    const r = toSavedList('full');
    r.send({ type: 'driver_hidden', now: t() });
    expect(r.state).toMatchObject({ status: 'needs_attention', attention: { reason: 'tab_hidden' } });
    expect(r.effects).toEqual([{ type: 'driver_stop' }]);
    r.send({ type: 'driver_visible', now: t() });
    expect(r.state.status).toBe('running');
    expect(r.effects).toEqual([{ type: 'resume_target', target: { kind: 'saved' } }]);
  });

  it('becoming visible does NOT clear an attention that is about something else', () => {
    const r = toSavedList('full');
    r.ready(HOME, null, 'captcha');
    const s = r.state;
    r.send({ type: 'driver_visible', now: t() });
    expect(r.state).toBe(s);
  });

  it('a mid-run login wall or captcha reported by the driver asks for the user', () => {
    let r = toSavedList('full');
    r.send({ type: 'driver_blocked', now: t(), pageState: 'captcha' });
    expect(r.state.attention?.reason).toBe('captcha');
    r = toSavedList('full');
    r.send({ type: 'driver_blocked', now: t(), pageState: 'login' });
    expect(r.state.attention?.reason).toBe('login_required');
  });

  it('closing the window mid-run is noticed, and resume reopens where it left off', () => {
    const r = toSavedList('full');
    r.page(list(['c1', 'A']));
    r.page(saved('0', '0', false));
    r.ready(COLL('c1'));
    r.send({ type: 'tab_closed', now: t() });
    expect(r.state.attention?.reason).toBe('tab_closed');
    r.send({ type: 'resume', now: t() });
    expect(r.state.status).toBe('running');
    expect(r.effects).toEqual([{ type: 'resume_target', target: { kind: 'collection', id: 'c1', name: 'A' } }]);
  });
});

describe('sync machine: a hidden window that is then closed', () => {
  it('can never become visible again, so it asks for the window to be reopened', () => {
    const r = toSavedList();
    r.send({ type: 'driver_hidden', now: t() });
    expect(r.state.attention?.reason).toBe('tab_hidden');
    r.send({ type: 'tab_closed', now: t() });
    expect(r.state).toMatchObject({ status: 'needs_attention', attention: { reason: 'tab_closed' } });
  });

  it('a closed tab does nothing to a run that is waiting for something else', () => {
    const r = toSavedList();
    r.send({ type: 'driver_blocked', pageState: 'login', now: t() });
    r.send({ type: 'tab_closed', now: t() });
    expect(r.state.attention?.reason).toBe('login_required');
  });
});

describe('sync machine: a collection list with more entries than one page', () => {
  it('warns instead of claiming every collection was read', () => {
    const r = toSavedList();
    r.page({ ...list(['c1', 'A']), hasMore: true });
    expect(r.state.warnings.join(' ')).toMatch(/more collections than it sent at once/);
    r.page({ ...list(['c2', 'B']), hasMore: true });
    expect(r.state.warnings.filter((w) => /more collections/.test(w))).toHaveLength(1); // once
  });

  it('a list that says it is complete adds no warning', () => {
    const r = toSavedList();
    r.page(list(['c1', 'A']));
    expect(r.state.warnings).toEqual([]);
  });
});

describe('sync machine: stalls', () => {
  it('reloads a stalled list up to the retry limit, then asks the user', () => {
    const r = toSavedList('full', { config: { maxStallRetries: 2 } });
    r.send({ type: 'driver_stalled', now: t() });
    expect(r.effects).toEqual([{ type: 'open', target: { kind: 'saved' } }]);
    r.send({ type: 'driver_stalled', now: t() });
    expect(r.state.stallRetries).toBe(2);
    r.send({ type: 'driver_stalled', now: t() });
    expect(r.state).toMatchObject({ status: 'needs_attention', attention: { reason: 'stalled' } });
  });

  it('progress resets the retry count', () => {
    const r = toSavedList('full');
    r.page(list());
    r.send({ type: 'driver_stalled', now: t() });
    expect(r.state.stallRetries).toBe(1);
    r.page(saved('0', '300', true));
    expect(r.state.stallRetries).toBe(0);
  });

  it('the heartbeat tick declares a stall only after stallMs without progress', () => {
    const r = toSavedList('full');
    const last = r.state.lastProgressAt;
    r.send({ type: 'tick', now: last + DEFAULT_SYNC_CONFIG.stallMs - 1 });
    expect(r.state.stallRetries).toBe(0);
    r.send({ type: 'tick', now: last + DEFAULT_SYNC_CONFIG.stallMs + 1 });
    expect(r.state.stallRetries).toBe(1);
    expect(r.effects[0]!.type).toBe('open');
  });

  it('a redirect to the wrong page is retried, not read', () => {
    const r = toSavedList('full');
    r.ready(HOME, 'me'); // the saved list target, but the window landed on the home page
    expect(r.effects).toEqual([{ type: 'open', target: { kind: 'saved' } }]);
    expect(r.state.stallRetries).toBe(1);
  });
});

describe('sync machine: pause, resume, cancel', () => {
  it('pause stops the driver and keeps the position; pages arriving while paused are ignored; resume continues the same target', () => {
    const r = toSavedList('full');
    r.page(list());
    r.page(saved('0', '300', true));
    r.send({ type: 'pause', now: t() });
    expect(r.state.status).toBe('paused');
    expect(r.effects).toEqual([{ type: 'driver_stop' }]);
    const paused = r.state;
    r.page(saved('300', '200', true));
    expect(r.state).toBe(paused);
    r.send({ type: 'resume', now: t() });
    expect(r.state.status).toBe('running');
    expect(r.effects).toEqual([{ type: 'resume_target', target: { kind: 'saved' } }]);
    expect(r.state.saved.pages).toBe(1);
  });

  it('pause/resume are no-ops when they do not apply', () => {
    const r = new Run();
    const idle = r.state;
    r.send({ type: 'pause', now: t() }).send({ type: 'resume', now: t() }).send({ type: 'cancel', now: t() });
    expect(r.state).toBe(idle);
    const running = toSavedList('full');
    const s = running.state;
    running.send({ type: 'resume', now: t() });
    expect(running.state).toBe(s);
  });

  it('cancel works from running, paused and needs_attention, and cleans up', () => {
    const cases: Array<(r: Run) => void> = [
      () => undefined,
      (r) => r.send({ type: 'pause', now: t() }),
      (r) => r.send({ type: 'driver_stalled', now: t() }).send({ type: 'driver_stalled', now: t() }).send({ type: 'driver_stalled', now: t() }).send({ type: 'driver_stalled', now: t() }),
    ];
    for (const prep of cases) {
      const r = toSavedList('full');
      prep(r);
      r.send({ type: 'cancel', now: t() });
      expect(r.state.status).toBe('cancelled');
      expect(r.state.finishedAt).toBeGreaterThan(0);
      expect(r.effects.map((e) => e.type)).toEqual(['driver_stop', 'clear_seen', 'close_window']);
    }
  });

  it('a finished run can be followed by a new one, keeping the sequence counter monotonic', () => {
    const r = toSavedList('full');
    const seq = r.state.seq;
    r.send({ type: 'cancel', now: t() });
    r.start('full');
    expect(r.state.status).toBe('running');
    expect(r.state.seq).toBeGreaterThan(seq);
    expect(r.state.saved.pages).toBe(0);
    expect(r.state.warnings).toEqual([]);
  });

  it('the per-run page cap fails the run and says how to continue', () => {
    const r = toSavedList('full', { config: { maxPages: 3 } });
    r.page(list());
    r.page(saved('0', '3', true));
    r.page(saved('3', '2', true));
    r.page(saved('2', '1', true));
    expect(r.state.status).toBe('failed');
    expect(r.state.error).toMatch(/per-run limit/);
    expect(r.effects.map((e) => e.type)).toEqual(['driver_stop', 'clear_seen', 'close_window']);
  });
});

describe('sync machine: ignored events', () => {
  it('pages for the wrong list, and events in a state where they mean nothing, change nothing', () => {
    const r = toSavedList('full');
    r.page(list(['c1', 'A']));
    const s = r.state;
    r.page(coll('c1', '0', '5', false)); // a collection page while we are on the saved list
    expect(r.state).toBe(s);
    const idle = new Run();
    idle.page(saved('0', '0', false));
    idle.ready(HOME);
    idle.send({ type: 'tick', now: t() });
    idle.send({ type: 'driver_hidden', now: t() });
    idle.send({ type: 'tab_closed', now: t() });
    idle.send({ type: 'rejected', now: t(), reason: 'bad_envelope' });
    expect(idle.state.status).toBe('idle');
    expect(idle.state.seq).toBe(0);
  });

  it('a page for another collection while reading one is ignored', () => {
    const r = toSavedList('full');
    r.page(list(['c1', 'A'], ['c2', 'B']));
    r.page(saved('0', '0', false));
    const s = r.state;
    r.page(coll('c2', '0', '5', false));
    expect(r.state).toBe(s);
  });
});

describe('sync machine: resuming after the service worker was killed', () => {
  it('the persisted state (JSON) is enough to continue a run to completion', () => {
    const r = toSavedList('full');
    r.page(list(['c1', 'A']));
    r.page(saved('0', '300', true));
    // the worker dies here: only JSON survives
    const revived = new Run();
    revived.state = JSON.parse(JSON.stringify(r.state)) as SyncState;
    revived.send({ type: 'resume', now: t() }); // (the worker re-arms with a resume-like event; here it is a pause first)
    expect(revived.state.status).toBe('running'); // resume on a running state is ignored: still running
    revived.page(saved('300', '0', false));
    expect(revived.state.saved.done).toBe('complete');
    revived.ready(COLL('c1'));
    revived.page(coll('c1', '0', '0', false));
    expect(revived.state.status).toBe('completed');
  });

  it('the state is always plain JSON (no undefined fields, functions or class instances)', () => {
    const r = toSavedList('full');
    r.page(list(['c1', 'A']));
    r.page(saved('0', '300', true));
    expect(JSON.parse(JSON.stringify(r.state))).toEqual(r.state);
  });
});

// -------------------------------------------------------------------------------------------- random events

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let x = a; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
}

describe('sync machine: invariants under random events', () => {
  it('never throws, stays serializable, and keeps its invariants over 300 random runs of 60 events', () => {
    const roles = ['saved', 'collections', 'collection', 'collection_info'] as const;
    const views: PageView[] = [HOME, PROFILE, COLL('c1'), COLL('c2'), { kind: 'other' }, { kind: 'profile', pageHandle: 'stranger' }];
    const reasons = ['identity_unknown', 'account_mismatch', 'not_own_profile', 'bad_envelope', 'ingest_failed', 'sender', 'malformed'];
    for (let seed = 1; seed <= 300; seed++) {
      const rnd = mulberry32(seed);
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
      let state = initialSyncState('p');
      let now = 5_000;
      let prevTotals = 0;
      let prevSeq = 0;
      for (let i = 0; i < 60; i++) {
        now += Math.floor(rnd() * 60_000);
        const roll = rnd();
        let e: SyncEvent;
        if (roll < 0.08) e = { type: 'start', now, runId: `r${seed}-${i}`, platform: 'p', mode: pick(['full', 'incremental'] as const), hasCompletedBefore: rnd() < 0.5, ...(rnd() < 0.3 ? { boundHandle: pick(['me', 'x']) } : {}) };
        else if (roll < 0.14) e = { type: pick(['pause', 'resume', 'cancel', 'tick', 'driver_hidden', 'driver_visible', 'driver_stalled', 'tab_closed'] as const), now };
        else if (roll < 0.16) e = rnd() < 0.5 ? { type: 'fatal', now, message: 'boom' } : { type: 'warn', now, message: 'careful' };
        else if (roll < 0.3) e = { type: 'driver_ready', now, ...(rnd() < 0.85 ? { handle: pick(['me', 'x']) } : {}), pageState: pick(['ok', 'ok', 'ok', 'login', 'captcha', 'interstitial', 'unknown'] as const), view: pick(views) };
        else if (roll < 0.35) e = { type: 'driver_blocked', now, pageState: pick(['login', 'captcha'] as const) };
        else if (roll < 0.42) e = { type: 'rejected', now, reason: pick(reasons) };
        else {
          const role = pick(roles);
          const cs = role === 'collections' ? [{ id: 'c1', name: 'A' }, { id: 'c2', name: 'B' }].slice(0, Math.floor(rnd() * 3)) : undefined;
          e = { type: 'page', now, page: { role, hasMore: pick([true, true, false, null]), items: Math.floor(rnd() * 30), inserted: Math.floor(rnd() * 5), reindexed: 0, duplicate: rnd() < 0.2, ...(role === 'collection' || role === 'collection_info' ? { collectionId: pick(['c1', 'c2', 'zz']) } : {}), requestCursor: pick(['0', '10', '20', undefined]), responseCursor: pick(['10', '20', '0']), ...(cs ? { collections: cs } : {}) } };
        }
        const frozen = JSON.stringify(state);
        let step;
        try { step = reduce(state, e); } catch (err) { throw new Error(`reduce threw at seed ${seed}, step ${i}: ${(err as Error).message}\n${JSON.stringify(e)}`); }
        expect(JSON.stringify(state), `input mutated (seed ${seed}, step ${i})`).toBe(frozen);
        state = step.state;
        const ctx = `seed ${seed}, step ${i}, event ${JSON.stringify(e)}`;
        // serializable
        expect(JSON.parse(JSON.stringify(state)), ctx).toEqual(state);
        // status/phase/attention consistency
        expect(['idle', 'running', 'paused', 'needs_attention', 'completed', 'failed', 'cancelled'], ctx).toContain(state.status);
        expect(state.status === 'needs_attention', ctx).toBe(state.attention !== undefined);
        if (state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled') expect(state.finishedAt, ctx).toBeGreaterThan(0);
        if (isActive(state)) expect(state.finishedAt, ctx).toBeUndefined();
        // counters
        expect(state.seq, ctx).toBeGreaterThanOrEqual(prevSeq);
        prevSeq = state.seq;
        if (e.type !== 'start') expect(state.totals.pages, ctx).toBeGreaterThanOrEqual(prevTotals);
        prevTotals = state.totals.pages;
        // at most one active collection, and only while reading collections
        const active = state.collections.filter((c) => c.status === 'active');
        expect(active.length, ctx).toBeLessThanOrEqual(1);
        if (state.target.kind === 'collection' && isActive(state)) expect(state.collections.some((c) => c.id === (state.target as { id: string }).id), ctx).toBe(true);
        // effects only ever come with a state change
        if (step.state === (state as unknown)) { /* same object: handled below */ }
        // a finished run never asks for more scrolling
        if (isActive(state) === false && (state.status === 'completed' || state.status === 'cancelled' || state.status === 'failed')) expect(step.effects.some((f) => f.type === 'driver_start' || f.type === 'open'), ctx).toBe(false);
        // an unchanged step has no effects
        if (JSON.stringify(step.state) === frozen) expect(step.effects, ctx).toEqual([]);
      }
    }
  });
});
