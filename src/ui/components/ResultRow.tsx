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
  // A platform's thumbnail links can expire (TikTok's after about two days): a dead image is normal, never an error.
  if (!url || broken) return <div class="thumb placeholder" role="img" aria-label={alt}>{kind === 'photo' ? 'Photo' : 'Video'}</div>;
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
      <Thumb key={item.thumbnailUrl ?? ''} url={item.thumbnailUrl} alt={alt} kind={item.mediaType} />
      <div class="result-body">
        <Snippet segments={result.snippet.length > 0 ? result.snippet : [{ text: item.caption ?? '', hit: false }]} />
        <p class="meta">
          <span class="author">@{item.authorHandle}</span>
          {item.durationSec !== undefined ? <span>{formatDuration(item.durationSec)}</span> : null}
          {item.stats?.views !== undefined ? <span>{formatCompact(item.stats.views)} views</span> : null}
          {saved ? <span>{saved}</span> : null}
          {!item.available ? <span class="badge">No longer saved</span> : null}
        </p>
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
