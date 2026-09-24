// Static rendering of the panel's components (no browser): structure, accessible names, and that untrusted text stays text.
// Real interactions are covered end to end by e2e/panel.ts in a real Chromium.
import { h } from 'preact';
import { render } from 'preact-render-to-string';
import { describe, expect, it } from 'vitest';
import type { ResultItem, SearchResponse } from '../../src/core/search/types';
import { initialSyncState } from '../../src/core/sync/machine';
import { DEFAULT_SYNC_CONFIG, type SyncState } from '../../src/core/sync/types';
import { Footer } from '../../src/ui/components/Footer';
import { ResultRow } from '../../src/ui/components/ResultRow';
import { Results } from '../../src/ui/components/Results';
import { SearchBox } from '../../src/ui/components/SearchBox';
import { SyncSection } from '../../src/ui/components/SyncSection';
import { commit, initialQuery, pressEnter, removeChip, typeInput, type QueryState } from '../../src/ui/state/query';
import { begin, chipInfoLoaded, initialResults, loaded, type ResultsState } from '../../src/ui/state/results';

const noop = () => undefined;
const type = (s: QueryState, w: string) => pressEnter(typeInput(s, w)).state;
const searchBox = (query: QueryState) => render(h(SearchBox, { query, busy: false, onInput: noop, onEnter: noop, onBackspaceEmpty: noop, onPaste: () => false, onRemove: noop, onSearch: noop, onMode: noop, onSort: noop, onExpandAll: noop }));

const result = (n: number, o: Partial<ResultItem['item']> = {}, url?: string): ResultItem => ({
  item: { id: n, platform: 'p', externalId: `v${n}`, authorHandle: `author${n}`, caption: `caption ${n}`, mediaType: 'video', isAd: false, hashtags: [], savedAt: 1_780_000_000_000, savedAtSource: 'interpolated', firstSeenAt: 1, lastSeenAt: 1, available: true, collections: [], ...o },
  snippet: [{ text: 'a ', hit: false }, { text: 'match', hit: true }, { text: ' here', hit: false }],
  score: 1,
  ...(url ? { url } : {}),
});
const response = (ns: ResultItem[], o: Partial<SearchResponse> = {}): SearchResponse => ({ requestId: 'r1', results: ns, total: ns.length, totalIsCapped: false, tookMs: 1, orderedBy: 'relevance', tooBroad: false, suggestedChips: [], ...o });
const ready = (res: SearchResponse, info: ResultsState['chipInfo'] = []): ResultsState => chipInfoLoaded(loaded(begin(initialResults(), 'r1'), res), 'r1', info);
const resultsHtml = (q: QueryState, r: ResultsState, hasAny = true) => render(h(Results, { query: q, results: r, hasAnyVideos: hasAny, platformName: 'Example', onLoadMore: noop, onAddSuggested: noop, onUseSuggestion: noop, explain: async () => ({ matches: [] }) }));

describe('the search box', () => {
  it('is a search form with a labelled input and a Search button', () => {
    const html = searchBox(initialQuery());
    expect(html).toContain('role="search"');
    expect(html).toContain('aria-label="Add a category to search for"');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Search<\/button>/);
  });

  it('shows each category as a chip with an accessibly named x', () => {
    const html = searchBox(type(type(initialQuery(), 'food'), 'meal prep'));
    expect(html).toContain('aria-label="Remove the category food"');
    expect(html).toContain('aria-label="Remove the category meal prep"');
    expect(html).toContain('aria-label="Categories in this search"');
  });

  it('says "Filters changed" only when the draft differs from the last search', () => {
    const searched = commit(type(initialQuery(), 'food')).state;
    expect(searchBox(searched)).not.toContain('Filters changed');
    expect(searchBox(removeChip(searched, searched.draft[0]!.id))).toContain('Filters changed. Press Search');
    expect(searchBox(type(searched, 'makeup'))).toContain('Filters changed');
  });

  it('shows the notice for a rejected input, and the options', () => {
    const html = searchBox(type(type(initialQuery(), 'a'), 'A'));
    expect(html).toContain('already there');
    expect(html).toContain('All categories');
    expect(html).toContain('Any category');
    expect(html).toContain('Include related words');
    expect(html).toContain('Recently saved');
  });

  it('the related-words checkbox shows the saved preference even before any category exists', () => {
    const checked = (html: string) => /<input[^>]*type="checkbox"[^>]*checked/.test(html) || /<input[^>]*checked[^>]*type="checkbox"/.test(html);
    expect(checked(searchBox(initialQuery({ relatedWords: true })))).toBe(true);
    expect(checked(searchBox(initialQuery({ relatedWords: false })))).toBe(false);
    const off = type(initialQuery({ relatedWords: false }), 'food');
    expect(checked(searchBox(off))).toBe(false);
  });

  it('escapes what the user typed', () => {
    const html = searchBox(type(initialQuery(), '<script>alert(1)</script>'));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script>alert(1)&lt;/script>'); // the < is escaped, so it can never open a tag
  });
});

describe('results', () => {
  const q = commit(type(initialQuery(), 'food')).state;

  it('says how many, in words, and lists the videos', () => {
    const html = resultsHtml(q, ready(response([result(1), result(2)], { total: 2 })));
    expect(html).toContain('data-testid="count"');
    expect(html).toContain('2 videos');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('caption');
    expect(html).toContain('<mark>match</mark>');
    expect(resultsHtml(q, ready(response([result(1)], { total: 1 })))).toContain('1 video<');
  });

  it('shows "10,000+" for a capped total and the too-broad prompt', () => {
    const html = resultsHtml(q, ready(response([result(1)], { total: 10001, totalIsCapped: true, tooBroad: true })));
    expect(html).toContain('10,000+');
    expect(html).toContain('Add another category to narrow it down');
  });

  it('explains an empty result: which category is narrowest, and suggests a correction for a typo', () => {
    const two = commit(type(type(initialQuery(), 'makup'), 'easy')).state;
    const [a, b] = two.committed;
    const info = [{ chipId: a!.id, count: 0, countIsCapped: false, expandedTerms: [], didYouMean: 'makeup' }, { chipId: b!.id, count: 30, countIsCapped: false, expandedTerms: ['simple'] }];
    const html = resultsHtml(two, ready(response([], { total: 0 }), info));
    expect(html).toContain('No videos found');
    expect(html).toContain('Nothing matches &quot;makup&quot;');
    expect(html).toContain('Did you mean &quot;makeup&quot;?');
    expect(html).toContain('also matched: simple');
  });

  it('offers the suggested categories as buttons with a full accessible name', () => {
    const html = resultsHtml(q, ready(response([result(1)], { suggestedChips: [{ text: 'pasta', count: 12, source: 'hashtag' }] })));
    expect(html).toContain('Narrow it down');
    expect(html).toContain('aria-label="Add the category pasta (12 videos)"');
  });

  it('a first-time library shows the empty state that explains how to fill it', () => {
    const html = resultsHtml(initialQuery(), ready(response([], { total: 0 })), false);
    expect(html).toContain('Nothing here yet');
    expect(html).toContain('Sync');
    expect(html).toContain('on Example while signed in'); // the platform name comes from the backend, never from the UI
  });

  it('an empty library shows the empty state even when categories are set', () => {
    const html = resultsHtml(q, ready(response([], { total: 0 })), false);
    expect(html).toContain('Nothing here yet');
    expect(html).not.toContain('No videos found');
  });

  it('shows the "Show more" button only while there is a next page', () => {
    expect(resultsHtml(q, ready(response([result(1)], { nextCursor: 'c1' })))).toContain('Show more');
    expect(resultsHtml(q, ready(response([result(1)])))).not.toContain('Show more');
  });

  it('shows errors as an alert', () => {
    const failedState: ResultsState = { ...initialResults(), status: 'error', error: 'db down' };
    expect(resultsHtml(q, failedState)).toContain('role="alert"');
    expect(resultsHtml(q, failedState)).toContain('db down');
  });
});

describe('a result row', () => {
  const row = (r: ResultItem, chips = commit(type(initialQuery(), 'food')).state.committed) => render(h(ResultRow, { result: r, chips, ...(r.url ? { url: r.url } : {}), explain: async () => ({ matches: [] }) }));

  it('renders captions and names as TEXT, never as markup', () => {
    const evil = result(1, { caption: '<img src=x onerror=alert(1)>', authorHandle: '<b>x</b>' });
    evil.snippet = [{ text: '<img src=x onerror=alert(1)>', hit: false }];
    const html = row(evil);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)>');
  });

  it('links out safely, only when the platform provided a link', () => {
    const html = row(result(1, {}, 'https://example.test/v/1'));
    expect(html).toContain('href="https://example.test/v/1"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
    expect(row(result(2))).not.toContain('>Open<');
  });

  it('shows collections, duration, and never a date it cannot stand behind', () => {
    const html = row(result(1, { collections: [{ externalId: 'c', name: 'Recipes', position: 0 }], durationSec: 95, savedAtSource: 'unknown' }));
    expect(html).toContain('Recipes');
    expect(html).toContain('1:35');
    expect(html).not.toContain('around');
    expect(html).not.toMatch(/saved (today|yesterday|\d+ days)/);
  });

  it('marks a video that is no longer saved, and dims it', () => {
    const html = row(result(1, { available: false }));
    expect(html).toContain('No longer saved');
    expect(html).toContain('result gone');
  });

  it('offers "Why this matched" only when there are categories to explain', () => {
    expect(row(result(1))).toContain('Why this matched');
    expect(row(result(1), [])).not.toContain('Why this matched');
  });

  it('a photo without a thumbnail gets a labelled placeholder, not a broken image', () => {
    const html = row(result(1, { mediaType: 'photo' }));
    expect(html).toContain('thumb placeholder');
    expect(html).toContain('Photo by author1');
    expect(html).not.toContain('<img');
  });
});

describe('the sync section', () => {
  const base = (o: Partial<SyncState>): SyncState => ({ ...initialSyncState('p'), runId: 'r', ...o, config: DEFAULT_SYNC_CONFIG });
  const html = (state: SyncState | undefined, error?: string) => render(h(SyncSection, { state, busy: false, ...(error ? { error } : {}), onStart: noop, onPause: noop, onResume: noop, onCancel: noop }));

  it('offers Sync and the full re-sync option when idle', () => {
    const out = html(undefined);
    expect(out).toContain('>Sync<');
    expect(out).toContain('Full re-sync');
    expect(out).toContain('Not synced yet');
  });

  it('while running: Pause and Cancel, a progress bar, and the reminder to keep the window visible', () => {
    const out = html(base({ status: 'running', phase: 'saved' }));
    expect(out).toContain('>Pause<');
    expect(out).toContain('>Cancel<');
    expect(out).toContain('role="progressbar"');
    expect(out).toContain('Keep the sync window visible');
    expect(out).not.toContain('Full re-sync');
  });

  it('when it needs the user: an alert with the message and a Resume button', () => {
    const out = html(base({ status: 'needs_attention', attention: { reason: 'captcha', message: 'Solve the puzzle, then press Resume.', at: 1 } }));
    expect(out).toContain('role="alert"');
    expect(out).toContain('Solve the puzzle, then press Resume.');
    expect(out).toContain('>Resume<');
  });

  it('shows warnings and errors', () => {
    expect(html(base({ status: 'completed', phase: 'done', warnings: ['Some pages were missed.'] }))).toContain('Some pages were missed.');
    expect(html(undefined, 'A sync is already running.')).toContain('A sync is already running.');
  });
});

describe('the footer', () => {
  const stats = { schemaVersion: 2, items: 1234, availableItems: 1230, collections: 5, memberships: 9, hashtags: 3, dbBytes: 12_345_678 };
  const html = (over: Record<string, unknown> = {}) => render(h(Footer, { stats, capture: undefined, pageSize: 30, onPageSize: noop, onExport: noop, onImport: noop, onWipe: noop, ...over } as never));

  it('shows the library size and what is no longer saved', () => {
    const out = html();
    expect(out).toContain('1,234 videos');
    expect(out).toContain('5 collections');
    expect(out).toContain('11.8 MB');
    expect(out).toContain('4 no longer saved');
  });

  it('offers export, import and a two-step wipe (the confirmation is not shown until asked for)', () => {
    const out = html();
    expect(out).toContain('>Export<');
    expect(out).toContain('>Import<');
    expect(out).toContain('>Wipe library<');
    expect(out).not.toContain('Yes, wipe');
    expect(out).toContain('type="file"');
  });

  it('says who the library was read as, and what was last done', () => {
    const out = html({ capture: { pages: 12, viewerHandle: 'me' }, message: 'Exported 5 videos.' });
    expect(out).toContain('Read 12 pages as @me');
    expect(out).toContain('Exported 5 videos.');
  });
});
