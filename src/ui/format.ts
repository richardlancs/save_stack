// Small display helpers. Pure and locale-aware only where a person reads the result.

import type { SavedAtSource } from '../core/model';

/** 1234 -> "1,234"; with a capped total, "10,000+". */
export function formatCount(n: number, capped = false, locale?: string): string {
  const base = new Intl.NumberFormat(locale).format(n);
  return capped ? `${new Intl.NumberFormat(locale).format(n - 1)}+` : base;
}

/** 12_345_678 -> "11.8 MB" */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** 95 -> "1:35" */
export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '';
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 1_500 -> "1.5K", 2_300_000 -> "2.3M" */
export function formatCompact(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}K`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0).replace(/\.0$/, '')}M`;
}

/**
 * How to show when something was saved. The stored value is an ESTIMATE with provenance, so it is never displayed more
 * precisely than it deserves; `unknown` shows nothing at all (the times only keep the list order).
 */
export function savedLabel(savedAt: number, source: SavedAtSource, now: number = Date.now(), locale?: string): string {
  if (source === 'unknown') return '';
  const d = new Date(savedAt);
  if (Number.isNaN(d.getTime())) return '';
  if (source === 'interpolated') return `around ${new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric' }).format(d)}`;
  const days = Math.floor((now - savedAt) / 86_400_000);
  if (source === 'first_seen') {
    if (days <= 0) return 'saved today';
    if (days === 1) return 'saved yesterday';
    if (days < 14) return `saved ${days} days ago`;
    return `saved ${new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', year: 'numeric' }).format(d)}`;
  }
  return `saved ${new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(d)}`;
}

/** "3 new videos", "1 new video" */
export function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
