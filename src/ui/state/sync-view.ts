// Turning the sync state machine's state into words and buttons. Pure.

import type { SyncState } from '../../core/sync/types';
import { plural } from '../format';

export type SyncButton = 'start' | 'pause' | 'resume' | 'cancel';

export interface SyncView {
  /** The one line that says what is happening. */
  headline: string;
  /** A second line with progress detail, if there is any. */
  detail?: string;
  /** 0..1 progress across the saved list and the collections, or undefined when it cannot be known. */
  fraction?: number;
  /** Which buttons make sense right now, in display order. */
  buttons: SyncButton[];
  tone: 'idle' | 'working' | 'attention' | 'good' | 'bad';
  /** Notes for the user after or during a run. */
  warnings: string[];
  /** The message to show when the sync needs the user (already written to be shown as is). */
  attentionMessage?: string;
}

const collectionsDone = (s: SyncState): number => s.collections.filter((c) => c.status === 'done' || c.status === 'skipped').length;

export function syncView(s: SyncState | undefined): SyncView {
  if (!s || s.status === 'idle') return { headline: 'Not synced yet', detail: 'Sync reads your saved videos and collections so they can be searched.', buttons: ['start'], tone: 'idle', warnings: [] };

  const total = s.collections.length;
  const done = collectionsDone(s);
  const news = s.totals.inserted;
  const newText = news > 0 ? `${plural(news, 'new video')} so far` : 'nothing new so far';
  const fraction = s.phase === 'done' ? 1 : s.phase === 'collections' && total > 0 ? 0.3 + 0.7 * (done / total) : s.phase === 'saved' ? Math.min(0.28, 0.02 + s.saved.pages * 0.02) : s.phase === 'start' ? 0.01 : undefined;

  switch (s.status) {
    case 'running': {
      const active = s.collections.find((c) => c.status === 'active');
      const headline =
        s.phase === 'start' ? 'Opening the sync window...'
        : s.phase === 'saved' ? `Reading your saved videos (${plural(s.saved.items, 'video')} seen)`
        : active ? `Reading collection ${done + 1} of ${total}: ${active.name}`
        : 'Finishing up...';
      return { headline, detail: newText, ...(fraction !== undefined ? { fraction } : {}), buttons: ['pause', 'cancel'], tone: 'working', warnings: s.warnings };
    }
    case 'paused':
      return { headline: 'Paused', detail: `${newText}. The sync window stays open.`, ...(fraction !== undefined ? { fraction } : {}), buttons: ['resume', 'cancel'], tone: 'attention', warnings: s.warnings };
    case 'needs_attention': {
      return {
        headline: 'The sync needs you',
        detail: newText,
        ...(fraction !== undefined ? { fraction } : {}),
        buttons: ['resume', 'cancel'], // a hidden window usually fixes itself, but Resume is never withheld: a closed window cannot
        tone: 'attention',
        warnings: s.warnings,
        ...(s.attention ? { attentionMessage: s.attention.message } : {}),
      };
    }
    case 'completed':
      return {
        headline: s.saved.done === 'partial' || s.warnings.length > 0 ? 'Sync finished, with notes' : 'Sync finished',
        detail: `${plural(s.totals.inserted, 'new video')}, ${plural(s.saved.items, 'video')} read from your saved list, ${plural(done, 'collection')} read`,
        fraction: 1,
        buttons: ['start'],
        tone: s.warnings.length > 0 ? 'attention' : 'good',
        warnings: s.warnings,
      };
    case 'cancelled':
      return { headline: 'Sync cancelled', detail: news > 0 ? `${plural(news, 'new video')} were saved before it stopped.` : 'Nothing was changed.', buttons: ['start'], tone: 'idle', warnings: s.warnings };
    case 'failed':
      return { headline: 'The sync stopped', ...(s.error ? { detail: s.error } : {}), buttons: ['start'], tone: 'bad', warnings: s.warnings };
    default:
      return { headline: 'Not synced yet', buttons: ['start'], tone: 'idle', warnings: [] };
  }
}
