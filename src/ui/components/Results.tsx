import type { ExplainResponse } from '../../core/search/types';
import { formatCount, plural } from '../format';
import type { QueryChip, QueryState } from '../state/query';
import { describeCommitted } from '../state/query';
import type { ResultsState } from '../state/results';
import { narrowestChip, rowKey } from '../state/results';
import { ResultRow } from './ResultRow';

export interface ResultsProps {
  query: QueryState;
  results: ResultsState;
  hasAnyVideos: boolean;
  /** The platform's display name, from the backend (the UI never hard-codes one). */
  platformName: string;
  onLoadMore(): void;
  onAddSuggested(text: string): void;
  onUseSuggestion(chipId: string, text: string): void;
  explain(platform: string, externalId: string, chips: QueryChip[]): Promise<ExplainResponse>;
}

export function Results(p: ResultsProps) {
  const { results: r, query: q } = p;
  const committed = q.committed;

  if (r.status === 'idle' || (r.status === 'loading' && r.items.length === 0)) return <p class="muted results-state" role="status">{r.status === 'loading' ? 'Searching...' : ''}</p>;
  if (r.status === 'error') return <p class="error" role="alert">Search failed: {r.error}</p>;

  if (!p.hasAnyVideos) { // an empty library: nothing to search, whatever categories are set
    return (
      <div class="empty">
        <svg class="empty-icon" viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <rect x="6" y="7" width="12" height="16" rx="2" /><rect x="22" y="7" width="12" height="16" rx="2" /><path d="M6 28h12M22 28h12M6 33h8M22 33h8" />
        </svg>
        <h2>Nothing here yet</h2>
        <p>Press <strong>Sync</strong> to read your saved videos and collections, or just browse your saved videos on {p.platformName} while signed in: they appear here automatically.</p>
      </div>
    );
  }

  const narrow = narrowestChip(r);
  const countText = r.total === 0 ? 'No videos found' : `${formatCount(r.total, r.totalIsCapped)} ${r.total === 1 ? 'video' : 'videos'}`;

  return (
    <section class="results-section" aria-label="Results">
      <div class="summary">
        <div class="summary-title">
          <p class="count" role="status" aria-live="polite" data-testid="count">{countText}</p>
          <p class="muted result-context">{describeCommitted(q)}</p>
        </div>
      </div>

      {r.chipInfo.length > 0 ? (
        <ul class="chipinfo" aria-label="Per category">
          {r.chipInfo.map((info) => {
            const chip = committed.find((c) => c.id === info.chipId);
            if (!chip) return null;
            return (
              <li class={info.count === 0 ? 'chipinfo-item zero' : 'chipinfo-item'} key={info.chipId}>
                <span class="chipinfo-label"><span class="chip-text">{chip.text}</span> <span class="chip-count">{formatCount(info.count, info.countIsCapped)}</span></span>
                {info.expandedTerms.length > 0 ? <span class="muted chipinfo-detail">also matched: {info.expandedTerms.slice(0, 8).join(', ')}{info.expandedTerms.length > 8 ? ', ...' : ''}</span> : null}
                {info.didYouMean ? (
                  <span class="chipinfo-detail"><button type="button" class="linkbtn" onClick={() => p.onUseSuggestion(info.chipId, info.didYouMean!)}>Did you mean "{info.didYouMean}"?</button></span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {r.tooBroad ? (
        <p class="notice" role="status">More than 10,000 videos match, so they are shown newest saved first. Add another category to narrow it down.</p>
      ) : null}

      {r.total === 0 ? (
        <p class="notice" role="status">
          {narrow && narrow.count === 0 ? `Nothing matches "${committed.find((c) => c.id === narrow.chipId)?.text ?? ''}". ` : narrow ? `"${committed.find((c) => c.id === narrow.chipId)?.text ?? ''}" is the narrowest category (${plural(narrow.count, 'video')}). ` : ''}
          Try fewer categories, or switch to "Any category".
        </p>
      ) : null}

      <ul class="results" aria-label="Videos">
        {r.items.map((it) => (
          <ResultRow
            key={rowKey(r, it.item)}
            result={it}
            chips={committed}
            {...(it.url !== undefined ? { url: it.url } : {})}
            explain={(platform, externalId) => p.explain(platform, externalId, committed)}
          />
        ))}
      </ul>

      {r.nextCursor !== undefined ? (
        <p class="more"><button type="button" class="btn" disabled={r.loadingMore} onClick={p.onLoadMore}>{r.loadingMore ? 'Loading...' : 'Show more'}</button></p>
      ) : null}

      {r.suggested.length > 0 ? (
        <div class="suggested">
          <h3>Narrow it down</h3>
          <ul class="chips">
            {r.suggested.slice(0, 12).map((s) => (
              <li class="chip suggestion" key={`${s.source}:${s.text}`}>
                <button type="button" class="linkbtn" onClick={() => p.onAddSuggested(s.text)} aria-label={`Add the category ${s.text} (${plural(s.count, 'video')})`}>
                  <span class="suggestion-plus" aria-hidden="true">+</span> {s.text} <span class="muted">{formatCount(s.count)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
