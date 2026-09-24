// The search service: chips in, results out. It composes the pure pieces (chips, expander, planner, snippets) with a
// SearchStore, and owns the product rules that are not SQL: suggested chips, did-you-mean, safe highlighting.
// No chrome.*, no DOM, no SQL.

import { MAX_CHIPS, SearchInputError, normalizeChip, normalizeChips, tokenize, type NormalizedChip } from './chips';
import { defaultExpander, type TermExpander } from './expander';
import { planChip, planSearch, relatedCap, type ChipPlan, type SearchPlan } from './planner';
import type { FacetCounts, SearchStore } from './store';
import { buildSnippet, closestWord, type HighlightTerms } from './text';
import type {
  Chip,
  ChipInfo,
  ChipInfoRequest,
  ChipInfoResponse,
  ChipMatch,
  ExplainRequest,
  ExplainResponse,
  ResultItem,
  SearchRequest,
  SearchResponse,
  SuggestedChip,
} from './types';

/** Hashtags that describe the platform, not the content. Suggesting them would only be noise. */
const NOISE_TAGS = new Set(['fyp', 'fypage', 'foryou', 'foryoupage', 'fy', 'viral', 'trending', 'trend', 'tiktok', 'xyzbca', 'fypシ', 'parati', 'explore']);
const MAX_SUGGESTED = { hashtags: 6, collections: 3, authors: 3 } as const;

const round = (n: number) => Math.round(n * 1000) / 1000;

function requireRequestId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || id.length === 0 || id.length > 100) throw new SearchInputError('requestId must be a non-empty string');
}

export function highlightTerms(plan: SearchPlan): HighlightTerms {
  const t: HighlightTerms = { prefixes: [], exact: [], phrases: [], substrings: [] };
  for (const chip of plan.chips) {
    if (chip.substrings.length > 0) { t.substrings.push(...chip.substrings); continue; }
    const words = tokenize(chip.key);
    t.prefixes.push(...words);
    if (words.length > 1) t.phrases.push(words.join(' '));
    for (const term of chip.relatedTerms) {
      const w = tokenize(term);
      if (w.length === 1) t.exact.push(w[0]!);
      else if (w.length > 1) t.phrases.push(w.join(' '));
    }
  }
  return t;
}

export class SearchService {
  constructor(
    private readonly store: SearchStore,
    private readonly expander: TermExpander = defaultExpander,
    private readonly clock: () => number = () => performance.now(),
  ) {}

  /** The fast path: results, capped total, suggested chips. Per-chip counts and "why matched" are separate calls. */
  async search(req: SearchRequest): Promise<SearchResponse> {
    const t0 = this.clock();
    requireRequestId(req?.requestId);
    const plan = planSearch(req, this.expander);
    const found = await this.store.searchQuery(plan);
    const items = await this.store.hydrateItems(found.ids);
    const byId = new Map(items.map((i) => [i.id, i]));
    const terms = highlightTerms(plan);
    const results: ResultItem[] = [];
    found.ids.forEach((id, i) => {
      const item = byId.get(id);
      if (item) results.push({ item, snippet: buildSnippet(item.caption ?? "", terms), score: round(found.scores[i] ?? 0) });
    });
    // suggestions describe the whole result set, so only the first page carries them
    const suggestedChips = plan.cursor || found.candidateIds.length === 0 ? [] : this.suggest(await this.store.facetCandidates(found.candidateIds), plan, found.candidateIds.length);
    return {
      requestId: req.requestId,
      results,
      total: found.total,
      totalIsCapped: found.totalIsCapped,
      nextCursor: found.nextCursor,
      tookMs: round(this.clock() - t0),
      orderedBy: found.orderedBy,
      tooBroad: found.tooBroad,
      suggestedChips,
    };
  }

  /** Per-chip counts, what each chip also matched, and a did-you-mean for chips that match nothing. */
  async chipInfo(req: ChipInfoRequest): Promise<ChipInfoResponse> {
    requireRequestId(req?.requestId);
    if (!Array.isArray(req.chips)) throw new SearchInputError('chips must be an array');
    // the same expansion budget the search itself uses, so a chip's badge count matches what the search matched
    const { all, plans } = this.plansFor(req.chips);
    const infoByPlan = new Map<ChipPlan, ChipInfo>();
    let vocab: Set<string> | undefined;
    for (const plan of new Set(plans.values())) {
      const { count, capped } = await this.store.countChip(plan);
      const info: ChipInfo = { chipId: plan.chipId, count, countIsCapped: capped, expandedTerms: plan.relatedTerms };
      if (count === 0 && plan.own !== null && tokenize(plan.key).length === 1) {
        if (!vocab) {
          const v = await this.store.vocabulary();
          vocab = new Set([...v.hashtags, ...v.authors, ...v.collections, ...this.expander.vocabulary()]);
        }
        const guess = closestWord(plan.key, vocab);
        if (guess !== undefined) info.didYouMean = guess;
      }
      infoByPlan.set(plan, info);
    }
    // one entry for EVERY chip the caller sent: a duplicate ("Food" and "food") shares its twin's numbers under its own id
    return { requestId: req.requestId, chips: all.map((n) => ({ ...infoByPlan.get(plans.get(n.id)!)!, chipId: n.id })) };
  }

  /** Why one result matched: per chip, the words it matched directly or only through a related term, and in which fields. */
  async explain(req: ExplainRequest): Promise<ExplainResponse> {
    if (typeof req?.platform !== 'string' || typeof req?.externalId !== 'string') throw new SearchInputError('explainMatch needs { platform, externalId, chips }');
    if (!Array.isArray(req.chips)) throw new SearchInputError('chips must be an array');
    const { all, plans } = this.plansFor(req.chips);
    const unique = [...new Set(plans.values())];
    const rows = await this.store.explainItem(req.platform, req.externalId, unique);
    if (rows === null) throw new SearchInputError('no such item');
    const byPlanId = new Map(rows.map((r) => [r.chipId, r]));
    // one entry for every chip the caller sent (a duplicate shares its twin's answer under its own id)
    const matches: ChipMatch[] = all.map((n) => {
      const r = byPlanId.get(plans.get(n.id)!.chipId)!;
      return { chipId: n.id, via: r.via, fields: r.fields, ...(r.term ? { term: r.term } : {}) };
    });
    return { matches };
  }

  /**
   * Validate EVERY incoming chip (so a bad one is rejected), then plan each distinct chip once. Search itself drops
   * duplicates; chipInfo and explainMatch must answer for each chip the UI sent, so they map every incoming chip id to the plan of
   * its first twin. The related-terms share is computed from the distinct chips, exactly as search does.
   */
  private plansFor(chips: readonly Chip[]): { all: NormalizedChip[]; plans: Map<string, ChipPlan> } {
    if (chips.length > MAX_CHIPS * 2) throw new SearchInputError(`too many chips (max ${MAX_CHIPS})`);
    const all = chips.map((c) => normalizeChip(c));
    const distinct = normalizeChips(chips);
    const cap = relatedCap(distinct);
    const byKey = new Map<string, ChipPlan>();
    for (const n of distinct) byKey.set(`${n.key}\u0000${n.expand}`, planChip(n, this.expander, cap));
    const plans = new Map<string, ChipPlan>();
    for (const n of all) plans.set(n.id, byKey.get(`${n.key}\u0000${n.expand}`)!);
    return { all, plans };
  }

  private suggest(f: FacetCounts, plan: SearchPlan, sample: number): SuggestedChip[] {
    const used = new Set<string>();
    for (const c of plan.chips) { used.add(c.key); for (const w of tokenize(c.key)) used.add(w); }
    // on a tiny result set a single occurrence is still informative; on a big one it is noise
    const min = sample >= 20 ? 2 : 1;
    const take = (list: FacetCounts['hashtags'], source: SuggestedChip['source'], max: number, skip?: (t: string) => boolean): SuggestedChip[] =>
      list
        .filter((x) => x.count >= min && !used.has(x.text.toLowerCase()) && !(skip?.(x.text.toLowerCase()) ?? false))
        .slice(0, max)
        .map((x) => ({ text: x.text, count: x.count, source }));
    return [
      ...take(f.hashtags, 'hashtag', MAX_SUGGESTED.hashtags, (t) => NOISE_TAGS.has(t)),
      ...take(f.collections, 'collection', MAX_SUGGESTED.collections),
      ...take(f.authors, 'author', MAX_SUGGESTED.authors),
    ];
  }
}
