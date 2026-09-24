// Results state, sync wording and formatters.
import { describe, expect, it } from 'vitest';
import type { ChipInfo, ResultItem, SearchResponse } from '../../src/core/search/types';
import { DEFAULT_SYNC_CONFIG, type SyncState } from '../../src/core/sync/types';
import { initialSyncState } from '../../src/core/sync/machine';
import { formatBytes, formatCompact, formatCount, formatDuration, plural, savedLabel } from '../../src/ui/format';
import { appended, begin, chipInfoLoaded, failed, initialResults, loaded, loadingMore, narrowestChip, rowKey } from '../../src/ui/state/results';
import { syncView } from '../../src/ui/state/sync-view';

const result = (n: number): ResultItem => ({ item: { id: n, platform: 'p', externalId: `v${n}`, authorHandle: 'a', mediaType: 'video', isAd: false, hashtags: [], savedAt: 1, savedAtSource: 'exact', firstSeenAt: 1, lastSeenAt: 1, available: true, collections: [] }, snippet: [], score: 1 });
const response = (requestId: string, ns: number[], o: Partial<SearchResponse> = {}): SearchResponse => ({ requestId, results: ns.map(result), total: ns.length, totalIsCapped: false, tookMs: 1, orderedBy: 'relevance', tooBroad: false, suggestedChips: [], ...o });

describe('results: a new search does not inherit the paging of the old one', () => {
  it('drops the cursor the moment a new search begins, so "Show more" cannot pair it with the new chips', () => {
    let s = loaded(begin(initialResults(), 'a'), response('a', [1, 2, 3], { nextCursor: 'cursor-a' }));
    expect(s.nextCursor).toBe('cursor-a');
    s = begin(s, 'b');
    expect(s.nextCursor).toBeUndefined();
    expect(s.items).toHaveLength(3); // the list itself stays until the answer arrives
    expect(loadingMore(s)).toBe(s); // and there is nothing to load more of
  });

  it('a page of an older search that arrives after a newer one began is ignored', () => {
    let s = loaded(begin(initialResults(), 'a'), response('a', [1, 2, 3], { nextCursor: 'cursor-a' }));
    s = begin(loadingMore(s), 'b');
    expect(appended(s, response('a', [4, 5], { nextCursor: 'cursor-a2' }))).toBe(s);
  });

  it('a row keeps its key while more pages of the same search arrive, and gets a new one when a new answer replaces it', () => {
    const a = loaded(begin(initialResults(), 'a'), response('a', [1, 2], { nextCursor: 'c' }));
    const more = appended(a, response('a', [3]));
    expect(rowKey(more, result(1).item)).toBe(rowKey(a, result(1).item));
    expect(rowKey(a, result(1).item)).not.toBe(rowKey(a, result(2).item));
    const b = loaded(begin(a, 'b'), response('b', [1, 2]));
    expect(rowKey(b, result(1).item)).not.toBe(rowKey(a, result(1).item)); // same video, new search: a fresh row
  });

  it('remembers which search the rows on screen came from, so their per-row state is rebuilt with them', () => {
    let s = loaded(begin(initialResults(), 'a'), response('a', [1, 2]));
    expect(s.itemsFor).toBe('a');
    s = begin(s, 'b');
    expect(s.itemsFor).toBe('a'); // still the old rows
    s = loaded(s, response('b', [1, 2], { nextCursor: 'c' }));
    expect(s.itemsFor).toBe('b');
    expect(appended(s, response('b', [3])).itemsFor).toBe('b'); // more rows of the same search keep their state
  });
});

describe('results state', () => {
  it('a newer search wins: answers for any other request id are ignored', () => {
    let s = begin(initialResults(), 'r1');
    s = begin(s, 'r2');
    expect(loaded(s, response('r1', [1])).items).toEqual([]);
    expect(loaded(s, response('r2', [1, 2])).items).toHaveLength(2);
    expect(chipInfoLoaded(s, 'r1', [{ chipId: 'a', count: 1, countIsCapped: false, expandedTerms: [] }]).chipInfo).toEqual([]);
    expect(failed(s, 'r1', 'boom').status).toBe('loading');
  });

  it('keeps the previous list on screen while the next search runs', () => {
    let s = loaded(begin(initialResults(), 'r1'), response('r1', [1, 2]));
    s = begin(s, 'r2');
    expect(s.status).toBe('loading');
    expect(s.items).toHaveLength(2);
  });

  it('paging appends without duplicates and stops when there is no cursor', () => {
    let s = loaded(begin(initialResults(), 'r1'), response('r1', [1, 2], { nextCursor: 'c1' }));
    s = loadingMore(s);
    expect(s.loadingMore).toBe(true);
    expect(loadingMore(s)).toBe(s); // already loading
    s = appended(s, response('r1', [2, 3], { nextCursor: 'c2' }));
    expect(s.items.map((r) => r.item.externalId)).toEqual(['v1', 'v2', 'v3']);
    expect(s.nextCursor).toBe('c2');
    s = appended(loadingMore(s), response('r1', [4]));
    expect(s.nextCursor).toBeUndefined();
    expect(loadingMore(s)).toBe(s);
    expect(appended(s, response('other', [9])).items).toHaveLength(4);
  });

  it('carries the total, the "too broad" flag and the suggestions', () => {
    const s = loaded(begin(initialResults(), 'r1'), response('r1', [1], { total: 10001, totalIsCapped: true, tooBroad: true, suggestedChips: [{ text: 'pasta', count: 5, source: 'hashtag' }] }));
    expect(s).toMatchObject({ total: 10001, totalIsCapped: true, tooBroad: true });
    expect(s.suggested).toHaveLength(1);
  });

  it('names the chip that over-narrows an empty AND search', () => {
    const info: ChipInfo[] = [{ chipId: 'a', count: 500, countIsCapped: false, expandedTerms: [] }, { chipId: 'b', count: 2, countIsCapped: false, expandedTerms: [] }];
    const s = chipInfoLoaded(loaded(begin(initialResults(), 'r1'), response('r1', [])), 'r1', info);
    expect(narrowestChip(s)?.chipId).toBe('b');
    expect(narrowestChip(loaded(begin(initialResults(), 'r2'), response('r2', [1])))).toBeUndefined();
  });

  it('an error is recorded for the current search only', () => {
    const s = failed(begin(initialResults(), 'r1'), 'r1', 'the database is busy');
    expect(s).toMatchObject({ status: 'error', error: 'the database is busy' });
  });
});

describe('sync wording', () => {
  const base = (o: Partial<SyncState>): SyncState => ({ ...initialSyncState('p'), runId: 'r', ...o, config: DEFAULT_SYNC_CONFIG });

  it('idle and never-synced offer only Sync', () => {
    expect(syncView(undefined)).toMatchObject({ buttons: ['start'], tone: 'idle' });
    expect(syncView(initialSyncState('p')).buttons).toEqual(['start']);
  });

  it('a running sync says where it is and offers Pause and Cancel', () => {
    const v = syncView(base({ status: 'running', phase: 'collections', collections: [{ id: '1', name: 'A', status: 'done', pages: 1, items: 1 }, { id: '2', name: 'Recipes', status: 'active', pages: 0, items: 0 }, { id: '3', name: 'C', status: 'pending', pages: 0, items: 0 }], totals: { pages: 3, items: 9, inserted: 7, reindexed: 0 } }));
    expect(v.headline).toBe('Reading collection 2 of 3: Recipes');
    expect(v.detail).toBe('7 new videos so far');
    expect(v.buttons).toEqual(['pause', 'cancel']);
    expect(v.fraction).toBeGreaterThan(0.3);
    expect(v.fraction).toBeLessThan(1);
    expect(syncView(base({ status: 'running', phase: 'saved', saved: { pages: 2, items: 60, inserted: 0, knownStreak: 0, done: false } })).headline).toMatch(/60 videos seen/);
  });

  it('progress only moves forward as the run advances', () => {
    const f = (o: Partial<SyncState>) => syncView(base({ status: 'running', ...o })).fraction ?? 0;
    const cols = (done: number) => Array.from({ length: 4 }, (_, i) => ({ id: String(i), name: 'c', status: (i < done ? 'done' : i === done ? 'active' : 'pending') as 'done', pages: 0, items: 0 }));
    expect(f({ phase: 'saved', saved: { pages: 1, items: 1, inserted: 0, knownStreak: 0, done: false } })).toBeLessThan(f({ phase: 'saved', saved: { pages: 9, items: 1, inserted: 0, knownStreak: 0, done: false } }));
    expect(f({ phase: 'saved', saved: { pages: 99, items: 1, inserted: 0, knownStreak: 0, done: false } })).toBeLessThanOrEqual(f({ phase: 'collections', collections: cols(0) }));
    expect(f({ phase: 'collections', collections: cols(1) })).toBeLessThan(f({ phase: 'collections', collections: cols(3) }));
  });

  it('a paused sync offers Resume; a needs-attention sync shows its message and offers Resume (also for a hidden window, which usually fixes itself)', () => {
    expect(syncView(base({ status: 'paused' })).buttons).toEqual(['resume', 'cancel']);
    const login = syncView(base({ status: 'needs_attention', attention: { reason: 'login_required', message: 'Sign in, then press Resume.', at: 1 } }));
    expect(login).toMatchObject({ attentionMessage: 'Sign in, then press Resume.', buttons: ['resume', 'cancel'], tone: 'attention' });
    const hidden = syncView(base({ status: 'needs_attention', attention: { reason: 'tab_hidden', message: 'Bring it back.', at: 1 } }));
    expect(hidden.buttons).toEqual(['resume', 'cancel']); // never a dead end: if the window was closed instead, Resume reopens it
  });

  it('finished runs summarise, keep their warnings, and offer Sync again', () => {
    const ok = syncView(base({ status: 'completed', phase: 'done', totals: { pages: 9, items: 90, inserted: 1, reindexed: 0 }, saved: { pages: 4, items: 90, inserted: 1, knownStreak: 0, done: 'complete' }, collections: [{ id: '1', name: 'A', status: 'done', pages: 1, items: 1 }] }));
    expect(ok).toMatchObject({ headline: 'Sync finished', tone: 'good', buttons: ['start'], fraction: 1 });
    expect(ok.detail).toMatch(/1 new video,/);
    const noted = syncView(base({ status: 'completed', phase: 'done', warnings: ['Some pages were missed.'] }));
    expect(noted).toMatchObject({ headline: 'Sync finished, with notes', tone: 'attention' });
    expect(noted.warnings).toEqual(['Some pages were missed.']);
    expect(syncView(base({ status: 'failed', error: 'db down' }))).toMatchObject({ tone: 'bad', detail: 'db down', buttons: ['start'] });
    expect(syncView(base({ status: 'cancelled', totals: { pages: 1, items: 1, inserted: 2, reindexed: 0 } })).detail).toMatch(/2 new videos were saved/);
    expect(syncView(base({ status: 'cancelled' })).detail).toBe('Nothing was changed.');
  });
});

describe('formatting', () => {
  it('counts', () => {
    expect(formatCount(1234, false, 'en-US')).toBe('1,234');
    expect(formatCount(10001, true, 'en-US')).toBe('10,000+');
    expect(plural(1, 'video')).toBe('1 video');
    expect(plural(3, 'video')).toBe('3 videos');
    expect(plural(0, 'video')).toBe('0 videos');
  });

  it('sizes and durations', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(12_345_678)).toBe('11.8 MB');
    expect(formatBytes(-1)).toBe('');
    expect(formatBytes(NaN)).toBe('');
    expect(formatDuration(95)).toBe('1:35');
    expect(formatDuration(5)).toBe('0:05');
    expect(formatDuration(undefined)).toBe('');
    expect(formatCompact(999)).toBe('999');
    expect(formatCompact(1500)).toBe('1.5K');
    expect(formatCompact(12_000)).toBe('12K');
    expect(formatCompact(2_300_000)).toBe('2.3M');
    expect(formatCompact(undefined)).toBe('');
  });

  it('never shows a saved time more precisely than it deserves', () => {
    const now = Date.UTC(2026, 8, 24);
    const t = Date.UTC(2026, 2, 10, 12);
    expect(savedLabel(t, 'unknown', now, 'en-US')).toBe(''); // only the order is known: show nothing
    expect(savedLabel(t, 'interpolated', now, 'en-US')).toMatch(/^around Mar(ch)? 2026$/);
    expect(savedLabel(now - 3600_000, 'first_seen', now, 'en-US')).toBe('saved today');
    expect(savedLabel(now - 86_400_000, 'first_seen', now, 'en-US')).toBe('saved yesterday');
    expect(savedLabel(now - 5 * 86_400_000, 'first_seen', now, 'en-US')).toBe('saved 5 days ago');
    expect(savedLabel(t, 'first_seen', now, 'en-US')).toMatch(/^saved Mar 10, 2026$/);
    expect(savedLabel(t, 'exact', now, 'en-US')).toMatch(/^saved /);
    expect(savedLabel(NaN, 'exact', now)).toBe('');
  });
});
