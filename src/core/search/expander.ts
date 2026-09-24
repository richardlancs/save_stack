// The related-terms layer: "food" also finds recipe, pasta, cooking... (the data lives in related-terms.json so it
// can be edited without touching code, and later replaced by embeddings behind the same interface).
import data from './related-terms.json';
import { needsSubstring, tokenize } from './chips';

/** A chip may expand to at most this many related terms (bounds the FTS5 expression, see docs/STORAGE_SPIKE.md §4). */
export const MAX_RELATED_TERMS = 30;

export interface Expansion {
  /** Related terms, most specific first, never including the chip's own words. Empty if the chip is not a known category. */
  terms: string[];
  /** The category the chip resolved to, for transparency in the UI. */
  category?: string;
}

/** The seam for later: an embedding-based expander can implement the same interface. */
export interface TermExpander {
  /** `key` is the chip's matching identity (lower-case words joined by single spaces). */
  expand(key: string): Expansion;
  /** Every word a user might type that we recognise (used for did-you-mean). */
  vocabulary(): string[];
}

export interface RelatedTermsData {
  version: number;
  categories: Record<string, string[]>;
  aliases: Record<string, string>;
}

/** Candidate spellings of a typed word: recipes -> recipe, stocks -> stock, hobbies -> hobby, cooking -> cook. */
function variants(key: string): string[] {
  const out = [key];
  if (key.endsWith('ies') && key.length > 4) out.push(`${key.slice(0, -3)}y`);
  if (key.endsWith('es') && key.length > 3) out.push(key.slice(0, -2));
  if (key.endsWith('s') && key.length > 3) out.push(key.slice(0, -1));
  if (key.endsWith('ing') && key.length > 5) out.push(key.slice(0, -3));
  return out;
}

export function createExpander(d: RelatedTermsData = data as RelatedTermsData): TermExpander {
  const categories = new Map(Object.entries(d.categories));
  const aliases = new Map(Object.entries(d.aliases));

  function resolve(key: string): string | undefined {
    for (const v of variants(key)) {
      if (categories.has(v)) return v;
      const a = aliases.get(v);
      if (a !== undefined && categories.has(a)) return a;
    }
    return undefined;
  }

  return {
    expand(key: string): Expansion {
      const category = resolve(key);
      if (category === undefined) return { terms: [] };
      const own = new Set(tokenize(key));
      const terms: string[] = [];
      const seen = new Set<string>();
      for (const raw of categories.get(category)!) {
        const t = raw.normalize('NFKC').toLowerCase().trim();
        // a term identical to the chip's own words adds nothing; substring-only scripts are not served by FTS
        if (!t || seen.has(t) || own.has(t) || t === key || needsSubstring(t)) continue;
        seen.add(t);
        terms.push(t);
        if (terms.length >= MAX_RELATED_TERMS) break;
      }
      return { terms, category };
    },
    vocabulary(): string[] {
      return [...new Set([...categories.keys(), ...aliases.keys()])];
    },
  };
}

export const defaultExpander: TermExpander = createExpander();
