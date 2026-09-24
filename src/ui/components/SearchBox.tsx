import type { SearchMode, SearchSort } from '../../core/search/types';
import type { QueryState } from '../state/query';
import { isStale } from '../state/query';

const SORTS: Array<{ value: SearchSort; label: string }> = [
  { value: 'relevance', label: 'Best match' },
  { value: 'recently_saved', label: 'Recently saved' },
  { value: 'newest', label: 'Newest posted' },
  { value: 'most_viewed', label: 'Most viewed' },
];

export interface SearchBoxProps {
  query: QueryState;
  busy: boolean;
  onInput(value: string): void;
  onEnter(): void;
  onBackspaceEmpty(): void;
  /** Returns true when the pasted text was a list and has been turned into chips (the browser's own paste is then suppressed). */
  onPaste(text: string): boolean;
  onRemove(id: string): void;
  onSearch(): void;
  onMode(mode: SearchMode): void;
  onSort(sort: SearchSort): void;
  onExpandAll(on: boolean): void;
}

export function SearchBox(p: SearchBoxProps) {
  const q = p.query;
  const stale = isStale(q);
  const allExpand = q.draft.length === 0 ? q.defaultExpand : q.draft.every((c) => c.expand);
  return (
    <form
      class="searchbox"
      role="search"
      onSubmit={(e) => { e.preventDefault(); p.onSearch(); }}
    >
      <div class="searchrow">
        <input
          id="category-input"
          class="input"
          type="text"
          value={q.input}
          autocomplete="off"
          spellcheck={false}
          placeholder="Type a category, press Enter"
          aria-label="Add a category to search for"
          onInput={(e) => p.onInput((e.currentTarget as HTMLInputElement).value)}
          onPaste={(e) => { if (p.onPaste(e.clipboardData?.getData('text') ?? '')) e.preventDefault(); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); p.onEnter(); }
            else if (e.key === 'Backspace' && (e.currentTarget as HTMLInputElement).value === '') p.onBackspaceEmpty();
          }}
        />
        <button class="btn primary" type="submit" disabled={p.busy}>Search</button>
      </div>

      {q.notice ? <p class="hint" role="status">{q.notice}</p> : null}

      <ul class="chips" aria-label="Categories in this search">
        {q.draft.map((c) => (
          <li class="chip" key={c.id}>
            <span class="chip-text">{c.text}</span>
            <button type="button" class="chip-x" aria-label={`Remove the category ${c.text}`} onClick={() => p.onRemove(c.id)}>×</button>
          </li>
        ))}
      </ul>

      {stale ? <p class="stale" role="status" data-testid="stale">Filters changed. Press Search to update the results.</p> : null}

      <div class="options">
        <fieldset class="segmented" aria-label="Match">
          <legend class="sr-only">Match</legend>
          <label class={q.mode === 'all' ? 'seg on' : 'seg'}><input type="radio" name="mode" checked={q.mode === 'all'} onChange={() => p.onMode('all')} /> All categories</label>
          <label class={q.mode === 'any' ? 'seg on' : 'seg'}><input type="radio" name="mode" checked={q.mode === 'any'} onChange={() => p.onMode('any')} /> Any category</label>
        </fieldset>
        <label class="check"><input type="checkbox" checked={allExpand} onChange={(e) => p.onExpandAll((e.currentTarget as HTMLInputElement).checked)} /> Include related words</label>
        <label class="sort">
          <span class="sr-only">Sort by</span>
          <select value={q.sort} onChange={(e) => p.onSort((e.currentTarget as HTMLSelectElement).value as SearchSort)} aria-label="Sort by">
            {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
      </div>
    </form>
  );
}
