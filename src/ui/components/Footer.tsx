import { useRef, useState } from 'preact/hooks';
import type { StorageStats } from '../../core/model';
import type { CaptureStatus } from '../../platforms/capture-protocol';
import { formatBytes, formatCount, plural } from '../format';

export interface FooterProps {
  stats: StorageStats | undefined;
  capture: CaptureStatus | undefined;
  message?: string;
  pageSize: number;
  onPageSize(n: number): void;
  onExport(): void;
  onImport(file: File): void;
  onWipe(): void;
}

/** Statistics, export/import, and a two-step wipe. No browser dialogs: a modal would block the whole panel. */
export function Footer(p: FooterProps) {
  const [confirmWipe, setConfirmWipe] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const s = p.stats;

  return (
    <footer class="footer">
      <div class="footer-heading"><h2 class="footer-title">Your library</h2></div>
      <p class="stats" data-testid="stats">
        {s ? `${formatCount(s.items)} ${s.items === 1 ? 'video' : 'videos'} · ${plural(s.collections, 'collection')} · ${formatBytes(s.dbBytes)}` : 'Loading...'}
        {s && s.availableItems < s.items ? <span class="muted"> · {formatCount(s.items - s.availableItems)} no longer saved</span> : null}
      </p>
      {p.capture && p.capture.pages > 0 ? <p class="muted small footer-meta">Read {plural(p.capture.pages, 'page')}{p.capture.viewerHandle ? ` as @${p.capture.viewerHandle}` : ''}.</p> : null}
      {p.message ? <p class="muted small footer-meta" role="status">{p.message}</p> : null}
      <div class="footer-controls">
        <label class="pagesize small">Results per page <select value={p.pageSize} aria-label="Results per page" onChange={(e) => p.onPageSize(Number((e.currentTarget as HTMLSelectElement).value))}>{[10, 30, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
        <div class="footer-actions">
          <button type="button" class="linkbtn" onClick={p.onExport}>Export</button>
          <button type="button" class="linkbtn" onClick={() => fileInput.current?.click()}>Import</button>
          <input
            ref={fileInput}
            class="sr-only"
            tabIndex={-1}
            type="file"
            accept="application/json,.json"
            aria-label="Choose a file to import"
            onChange={(e) => {
              const f = (e.currentTarget as HTMLInputElement).files?.[0];
              if (f) p.onImport(f);
              (e.currentTarget as HTMLInputElement).value = '';
            }}
          />
          {!confirmWipe ? (
            <button type="button" class="linkbtn danger" onClick={() => setConfirmWipe(true)}>Wipe library</button>
          ) : (
            <span class="confirm" role="alertdialog" aria-label="Confirm wipe">
              Delete everything stored here? <button type="button" class="linkbtn danger" onClick={() => { setConfirmWipe(false); p.onWipe(); }}>Yes, wipe</button>
              <button type="button" class="linkbtn" onClick={() => setConfirmWipe(false)}>Keep it</button>
            </span>
          )}
        </div>
      </div>
    </footer>
  );
}
