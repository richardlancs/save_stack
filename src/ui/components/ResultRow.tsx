import { useState } from 'preact/hooks';
import type { ChipMatch, ExplainResponse, HighlightSegment, ResultItem } from '../../core/search/types';
import { formatCompact, formatDuration, savedLabel } from '../format';
import type { QueryChip } from '../state/query';

function Snippet({ segments }: { segments: HighlightSegment[] }) {
  // Captions are untrusted text: always rendered as text nodes, never as markup.
  return (
    <p class="caption">
      {segments.map((s, i) => (s.hit ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>))}
    </p>
  );
}

function Thumb({ url, alt, kind }: { url?: string; alt: string; kind: 'video' | 'photo' }) {
  const [broken, setBroken] = useState(false);
  // Thumbnail links can expire: a dead image is normal, never an error.
  if (!url || broken) return (
    <div class="thumb placeholder" role="img" aria-label={alt}>
      <svg class="placeholder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="3" />
        {kind === 'photo' ? <><circle cx="8.5" cy="8.5" r="1.5" /><path d="m4 18 5-5 3 3 4-5 4 5" /></> : <path d="m10 8 6 4-6 4V8Z" />}
      </svg>
      <span>{kind === 'photo' ? 'Photo' : 'Video'}</span>
    </div>
  );
  return <img class="thumb" src={url} alt="" loading="lazy" referrerpolicy="no-referrer" onError={() => setBroken(true)} />;
}

function describeMatch(m: ChipMatch, chips: QueryChip[]): string {
  const text = chips.find((c) => c.id === m.chipId)?.text ?? m.chipId;
  if (m.via === 'none') return `"${text}": not matched`;
  const where = m.fields.length > 0 ? ` in ${m.fields.join(', ')}` : '';
  return m.via === 'related' ? `"${text}": matched through the related word "${m.term ?? ''}"${where}` : `"${text}": matched${where}`;
}

export interface ResultRowProps {
  result: ResultItem;
  /** The chips of the search these results belong to (for "why did this match"). */
  chips: QueryChip[];
  url?: string;
  explain(platform: string, externalId: string): Promise<ExplainResponse>;
}

export function ResultRow({ result, chips, url, explain }: ResultRowProps) {
  const { item } = result;
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState<ChipMatch[] | 'loading' | 'error' | undefined>(undefined);
  const saved = savedLabel(item.savedAt, item.savedAtSource);
  const alt = `${item.mediaType === 'photo' ? 'Photo' : 'Video'} by ${item.authorHandle}`;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && why === undefined && chips.length > 0) {
      setWhy('loading');
      explain(item.platform, item.externalId).then((r) => setWhy(r.matches), () => setWhy('error'));
    }
  };

  return (
    <li class={item.available ? 'result' : 'result gone'} data-testid="result">
      <div class="result-media">
        <Thumb key={item.thumbnailUrl ?? ''} url={item.thumbnailUrl} alt={alt} kind={item.mediaType} />
        {item.mediaType === 'photo' ? (
          <span class="media-kind" aria-hidden="true">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="6" y="3" width="11" height="11" rx="2" /><path d="M3 6v9a2 2 0 0 0 2 2h9" /></svg>
          </span>
        ) : null}
        {item.durationSec !== undefined || item.stats?.views !== undefined ? (
          <p class="media-stats">
            {item.stats?.views !== undefined ? <span class="media-views"><svg viewBox="0 0 12 14" fill="currentColor" aria-hidden="true"><path d="m2 1 9 6-9 6V1Z" /></svg>{formatCompact(item.stats.views)} views</span> : null}
            {item.durationSec !== undefined ? <span class="media-duration">{formatDuration(item.durationSec)}</span> : null}
          </p>
        ) : null}
      </div>
      <div class="result-body">
        <p class="author">@{item.authorHandle}</p>
        <Snippet segments={result.snippet.length > 0 ? result.snippet : [{ text: item.caption ?? '', hit: false }]} />
        {saved || !item.available ? (
          <p class="meta result-meta">
            {saved ? <span>{saved}</span> : null}
            {!item.available ? <span class="badge">No longer saved</span> : null}
          </p>
        ) : null}
        {item.collections.length > 0 ? (
          <p class="tags">{item.collections.map((c) => <span class="tag" key={c.externalId}>{c.name}</span>)}</p>
        ) : null}
        <div class="actions">
          {url ? <a class="link" href={url} target="_blank" rel="noopener noreferrer">Open</a> : null}
          {chips.length > 0 ? (
            <button type="button" class="linkbtn" aria-expanded={open} onClick={toggle}>Why this matched</button>
          ) : null}
        </div>
        {open ? (
          <div class="why" role="region" aria-label="Why this matched">
            {why === 'loading' ? <p>Checking...</p> : why === 'error' ? <p>Could not explain this result.</p> : Array.isArray(why) ? <ul>{why.map((m, i) => <li key={i}>{describeMatch(m, chips)}</li>)}</ul> : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}
