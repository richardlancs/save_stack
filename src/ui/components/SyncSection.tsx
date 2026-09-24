import { useState } from 'preact/hooks';
import type { SyncState } from '../../core/sync/types';
import { syncView, type SyncButton } from '../state/sync-view';

export interface SyncSectionProps {
  state: SyncState | undefined;
  busy: boolean;
  error?: string;
  onStart(mode: 'incremental' | 'full'): void;
  onPause(): void;
  onResume(): void;
  onCancel(): void;
}

const LABELS: Record<SyncButton, string> = { start: 'Sync', pause: 'Pause', resume: 'Resume', cancel: 'Cancel' };

export function SyncSection(p: SyncSectionProps) {
  const view = syncView(p.state);
  const [full, setFull] = useState(false);
  const canStart = view.buttons.includes('start');

  const click = (b: SyncButton) => {
    if (b === 'start') p.onStart(full ? 'full' : 'incremental');
    else if (b === 'pause') p.onPause();
    else if (b === 'resume') p.onResume();
    else p.onCancel();
  };

  return (
    <section class={`sync tone-${view.tone}`} aria-label="Sync">
      <p class="sync-eyebrow"><span class="status-dot" aria-hidden="true" />Library sync</p>
      <div class="sync-head">
        <div class="sync-copy">
          <p class="sync-title" data-testid="sync-headline">{view.headline}</p>
          {view.detail ? <p class="muted sync-detail">{view.detail}</p> : null}
        </div>
        <div class="sync-buttons">
          {view.buttons.map((b) => (
            <button key={b} type="button" class={b === 'start' || b === 'resume' ? 'btn primary' : 'btn'} disabled={p.busy} onClick={() => click(b)}>{LABELS[b]}</button>
          ))}
        </div>
      </div>

      {view.fraction !== undefined && p.state && p.state.status !== 'completed' ? (
        <div class="progress" role="progressbar" aria-label="Sync progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(view.fraction * 100)}>
          <div class="bar" style={{ width: `${Math.round(view.fraction * 100)}%` }} />
        </div>
      ) : null}

      {view.attentionMessage ? <p class="attention" role="alert">{view.attentionMessage}</p> : null}
      {p.error ? <p class="error" role="alert">{p.error}</p> : null}
      {view.warnings.length > 0 ? <ul class="warnings" aria-label="Notes">{view.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul> : null}

      {canStart ? (
        <label class="check small sync-full"><input type="checkbox" checked={full} onChange={(e) => setFull((e.currentTarget as HTMLInputElement).checked)} /> Full re-sync (also notice videos you have un-saved)</label>
      ) : null}
      {p.state && (p.state.status === 'running' || p.state.status === 'paused' || p.state.status === 'needs_attention') ? (
        <p class="muted small sync-reminder">Keep the sync window visible while it works: a hidden window cannot be scrolled.</p>
      ) : null}
    </section>
  );
}
