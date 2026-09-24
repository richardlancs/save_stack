// Small text helpers for search results: did-you-mean and safe highlighting. Pure.
import type { HighlightSegment } from './types';

// ------------------------------------------------------------------ did you mean

/** Optimal-string-alignment distance, giving up (returning max + 1) as soon as it must exceed `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a.charCodeAt(i - 1) === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1)) v = Math.min(v, prev2[j - 2]! + 1); // transposition
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * The closest known word to a mistyped one ("makup" -> "makeup"), or undefined. Short words tolerate one typo,
 * longer ones two. Ties prefer a word with the same first letter (people rarely mistype the first one).
 */
export function closestWord(target: string, vocabulary: Iterable<string>): string | undefined {
  const t = target.normalize('NFKC').toLowerCase();
  if (t.length < 3) return undefined;
  const max = t.length <= 4 ? 1 : 2;
  let best: string | undefined;
  let bestD = max + 1;
  let bestSameFirst = false;
  for (const v of vocabulary) {
    const w = v.normalize('NFKC').toLowerCase();
    if (w === t || Math.abs(w.length - t.length) > max) continue;
    const d = editDistance(t, w, max);
    if (d > max) continue;
    const sameFirst = w[0] === t[0];
    if (d < bestD || (d === bestD && sameFirst && !bestSameFirst)) { best = v; bestD = d; bestSameFirst = sameFirst; }
  }
  return best;
}

// ------------------------------------------------------------------ highlighting

export interface HighlightTerms {
  /** Words the user typed: a caption word starting with one of these (or that one starts with) is a hit. */
  prefixes: string[];
  /** Related single words: whole-word (or trivially inflected) hits. */
  exact: string[];
  /** Multiword phrases, matched as substrings of the lower-cased caption. */
  phrases: string[];
  /** CJK / emoji chips, matched as substrings. */
  substrings: string[];
}

const WORD = /[\p{L}\p{N}]+/gu;
/** Candidate base forms of a word: recipes -> recipe, hobbies -> hobby, cooking -> cook / cooke, dogs -> dog. */
function forms(w: string): Set<string> {
  const f = new Set([w]);
  if (w.endsWith('ies') && w.length > 4) f.add(`${w.slice(0, -3)}y`);
  if (w.endsWith('es') && w.length > 3) f.add(w.slice(0, -2));
  if (w.endsWith('s') && w.length > 3) f.add(w.slice(0, -1));
  if (w.endsWith('ing') && w.length > 5) { f.add(w.slice(0, -3)); f.add(`${w.slice(0, -3)}e`); }
  if (w.endsWith('ed') && w.length > 4) { f.add(w.slice(0, -2)); f.add(w.slice(0, -1)); }
  return f;
}
/** Two words are "the same" for highlighting if any of their base forms coincide. Approximate on purpose (no real stemmer). */
function sameStem(a: string, b: string): boolean {
  if (a === b) return true;
  const fa = forms(a);
  for (const x of forms(b)) if (fa.has(x)) return true;
  return false;
}

function isWordHit(word: string, t: HighlightTerms): boolean {
  for (const e of t.exact) if (sameStem(word, e)) return true;
  for (const p of t.prefixes) {
    if (word.startsWith(p) || (word.length >= 4 && p.startsWith(word)) || sameStem(word, p)) return true;
  }
  return false;
}

/**
 * Break a caption into segments, marking the parts that matched. The output is structured text, never HTML:
 * captions are untrusted, so the UI must render `text` as text.
 * Highlighting is a JavaScript approximation of what full-text search matched (it has no stemmer), which is
 * fine for display; which chip matched a result is answered authoritatively by explainMatch.
 */
export function buildSnippet(caption: string, terms: HighlightTerms, maxLen = 160): HighlightSegment[] {
  const text = caption ?? '';
  if (text.length === 0) return [];
  const ranges: Array<[number, number]> = [];
  for (const m of text.matchAll(WORD)) {
    if (isWordHit(m[0].normalize('NFKC').toLowerCase(), terms)) ranges.push([m.index!, m.index! + m[0].length]);
  }
  const lower = text.toLowerCase();
  if (lower.length === text.length) {
    // (a few characters change length when lower-cased; then phrase offsets would be wrong, so skip them)
    for (const needle of [...terms.phrases, ...terms.substrings]) {
      if (!needle) continue;
      for (let from = lower.indexOf(needle); from !== -1; from = lower.indexOf(needle, from + needle.length)) ranges.push([from, from + needle.length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }

  // window around the first hit, without cutting a word in half where avoidable
  let from = 0;
  if (merged.length > 0 && merged[0]![0] > 60) {
    from = Math.max(0, merged[0]![0] - 50);
    const space = text.indexOf(' ', from);
    if (space !== -1 && space < merged[0]![0]) from = space + 1;
  }
  const to = Math.min(text.length, from + maxLen);

  const segments: HighlightSegment[] = [];
  const push = (s: string, hit: boolean) => {
    if (!s) return;
    const last = segments[segments.length - 1];
    if (last && last.hit === hit) last.text += s;
    else segments.push({ text: s, hit });
  };
  if (from > 0) push('…', false);
  let cursor = from;
  for (const [s, e] of merged) {
    if (e <= from || s >= to) continue;
    const a = Math.max(s, from);
    const b = Math.min(e, to);
    push(text.slice(cursor, a), false);
    push(text.slice(a, b), true);
    cursor = b;
  }
  push(text.slice(cursor, to), false);
  if (to < text.length) push('…', false);
  return segments;
}
