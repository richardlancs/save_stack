import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, PAGE_SIZES, mergeSettings, normalizeSettings } from '../src/core/settings';

describe('settings', () => {
  it('start from documented defaults', () => {
    expect(normalizeSettings(undefined)).toEqual({ relatedWords: true, sort: 'relevance', pageSize: 30 });
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it('accept valid values, ignoring everything else', () => {
    expect(mergeSettings({ ...DEFAULT_SETTINGS }, { relatedWords: false, sort: 'recently_saved', pageSize: 50 })).toEqual({ relatedWords: false, sort: 'recently_saved', pageSize: 50 });
    const noisy = mergeSettings({ ...DEFAULT_SETTINGS }, { relatedWords: 'yes', sort: 'random', pageSize: 7, extra: 1, __proto__: { polluted: true } });
    expect(noisy).toEqual(DEFAULT_SETTINGS);
    expect((noisy as unknown as Record<string, unknown>).extra).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('a partial patch changes only what it names', () => {
    const base = mergeSettings({ ...DEFAULT_SETTINGS }, { pageSize: 10, relatedWords: false });
    expect(mergeSettings(base, { sort: 'newest' })).toEqual({ relatedWords: false, sort: 'newest', pageSize: 10 });
  });

  it('every value is validated on its own: one bad value does not block a good one', () => {
    expect(mergeSettings({ ...DEFAULT_SETTINGS }, { relatedWords: false, pageSize: 999 })).toEqual({ ...DEFAULT_SETTINGS, relatedWords: false });
  });

  it('never throws or mutates its input, whatever it is given', () => {
    const cur = { ...DEFAULT_SETTINGS };
    for (const bad of [undefined, null, 5, 'x', [], [1], () => 1, Symbol('s'), new Proxy({}, { get() { return undefined; } })]) expect(() => mergeSettings(cur, bad)).not.toThrow();
    expect(cur).toEqual(DEFAULT_SETTINGS);
    expect(PAGE_SIZES).toContain(DEFAULT_SETTINGS.pageSize);
  });
});
