import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { StorageStats } from '../core/model';
import type { ExplainResponse } from '../core/search/types';
import type { SyncState } from '../core/sync/types';
import type { CaptureStatus } from '../platforms/capture-protocol';
import type { Settings } from '../core/settings';
import { api, downloadJson, errorMessage, isSuperseded, onSyncProgress, readJsonFile } from './api';
import { Footer } from './components/Footer';
import { Results } from './components/Results';
import { SearchBox } from './components/SearchBox';
import { SyncSection } from './components/SyncSection';
import {
  addSuggested, commit, initialQuery, pasteIsList, pasteList, pressEnter, removeChip, removeLastChip, replaceChipText, setExpandAll, setMode, setSort, typeInput,
  type QueryChip, type QueryState, type SearchParams,
} from './state/query';
import { appended, begin, chipInfoLoaded, failed, initialResults, loaded, loadingMore, type ResultsState } from './state/results';

/** Only used if the backend cannot answer `getSettings` (the real defaults live with the backend). */
const FALLBACK_SETTINGS: Settings = { relatedWords: true, sort: 'relevance', pageSize: 30 };
const toChip = (c: QueryChip) => ({ id: c.id, text: c.text, expand: c.expand });

export function App() {
  const [q, setQ] = useState<QueryState>(initialQuery);
  const [res, setRes] = useState<ResultsState>(initialResults);
  const [stats, setStats] = useState<StorageStats>();
  const [capture, setCapture] = useState<CaptureStatus>();
  const [sync, setSync] = useState<SyncState>();
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncError, setSyncError] = useState<string>();
  const [footerMessage, setFooterMessage] = useState<string>();
  const settings = useRef<Settings>({ ...FALLBACK_SETTINGS });
  const [pageSize, setPageSize] = useState(FALLBACK_SETTINGS.pageSize);
  const counter = useRef(0);
  const committed = useRef<SearchParams>({ chips: [], mode: 'all', sort: 'relevance' });
  const lastSyncSeq = useRef(-1);
  const prevSyncStatus = useRef<string>();

  const refreshMeta = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([api.getStats(), api.getCaptureStatus()]);
      setStats(s);
      setCapture(c);
    } catch { /* the footer keeps its last numbers */ }
  }, []);

  const runSearch = useCallback(async (params: SearchParams) => {
    committed.current = params;
    const requestId = `ui-${++counter.current}`;
    setRes((r) => begin(r, requestId));
    const chips = params.chips.map(toChip);
    try {
      const response = await api.search({ requestId, chips, mode: params.mode, sort: params.sort, limit: settings.current.pageSize });
      setRes((r) => loaded(r, response));
    } catch (e) {
      if (isSuperseded(e)) return; // a newer search replaced this one: nothing to show
      setRes((r) => failed(r, requestId, errorMessage(e)));
      return;
    }
    if (chips.length === 0) return;
    // The per-chip counts come second and are optional: if they fail, the results already on screen stay.
    try {
      const info = await api.getChipInfo({ requestId, chips, mode: params.mode });
      setRes((r) => chipInfoLoaded(r, requestId, info.chips));
    } catch { /* the chips simply show no counts */ }
  }, []);

  const search = useCallback((state: QueryState) => {
    const { state: next, params } = commit(state);
    setQ(next);
    void runSearch(params);
  }, [runSearch]);

  const loadMore = useCallback(async () => {
    const cursor = res.nextCursor;
    if (cursor === undefined || res.loadingMore) return;
    setRes((r) => loadingMore(r));
    const params = committed.current;
    const requestId = res.requestId ?? `ui-${++counter.current}`;
    try {
      const response = await api.search({ requestId, chips: params.chips.map(toChip), mode: params.mode, sort: params.sort, limit: settings.current.pageSize, cursor });
      setRes((r) => appended(r, response));
    } catch (e) {
      if (!isSuperseded(e)) setRes((r) => failed(r, requestId, errorMessage(e)));
    }
  }, [res.nextCursor, res.loadingMore, res.requestId]);

  const saveSettings = useCallback((patch: Partial<Settings>) => {
    settings.current = { ...settings.current, ...patch };
    void api.setSettings(patch).catch(() => undefined); // a preference that fails to save is not worth an error
  }, []);

  // First paint: everything you saved, newest first (with the saved preferences); plus the numbers, the sync state, and live sync progress.
  useEffect(() => {
    api.getSettings().catch(() => ({ ...FALLBACK_SETTINGS })).then((st) => {
      settings.current = st;
      setPageSize(st.pageSize);
      setQ(initialQuery({ relatedWords: st.relatedWords, sort: st.sort }));
      void runSearch({ chips: [], mode: 'all', sort: st.sort });
    });
    void refreshMeta();
    api.getSyncStatus().then((s) => { lastSyncSeq.current = s.seq; prevSyncStatus.current = s.status; setSync(s); }, () => undefined);
    const off = onSyncProgress((s) => {
      if (s.seq < lastSyncSeq.current) return; // an older broadcast arriving late
      lastSyncSeq.current = s.seq;
      setSync(s);
    });
    const onVisible = () => { if (document.visibilityState === 'visible') void refreshMeta(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { off(); document.removeEventListener('visibilitychange', onVisible); };
  }, [runSearch, refreshMeta]);

  // While a sync runs the library grows: keep the numbers fresh, and refresh the results when it ends.
  useEffect(() => {
    const status = sync?.status;
    const wasWorking = prevSyncStatus.current === 'running' || prevSyncStatus.current === 'paused' || prevSyncStatus.current === 'needs_attention';
    prevSyncStatus.current = status;
    if (status === 'running') {
      const t = setInterval(() => void refreshMeta(), 3000);
      return () => clearInterval(t);
    }
    if (wasWorking && (status === 'completed' || status === 'failed' || status === 'cancelled')) {
      void refreshMeta();
      void runSearch(committed.current);
    }
    return undefined;
  }, [sync?.status, refreshMeta, runSearch]);

  const syncCall = async (fn: () => Promise<SyncState>) => {
    setSyncBusy(true);
    setSyncError(undefined);
    try { const s = await fn(); lastSyncSeq.current = Math.max(lastSyncSeq.current, s.seq); setSync(s); }
    catch (e) { setSyncError(errorMessage(e)); }
    finally { setSyncBusy(false); }
  };

  const explain = useCallback((platform: string, externalId: string, chips: QueryChip[]): Promise<ExplainResponse> => api.explainMatch({ platform, externalId, chips: chips.map(toChip) }), []);

  const platformName = capture?.platforms?.[0]?.displayName ?? 'The platform';
  const drifted = capture !== undefined && (capture.drift.unknownItemKeys.length > 0 || capture.drift.badRecords > 0);

  return (
    <main class="app">
      <header class="top">
        <span class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21l-6-4-6 4Z" />
            <path d="M10 8h4M10 11h4" />
          </svg>
        </span>
        <div>
          <h1>Scroganize</h1>
          <p class="muted">Search the videos you saved.</p>
        </div>
      </header>

      <SyncSection
        state={sync}
        busy={syncBusy}
        {...(syncError !== undefined ? { error: syncError } : {})}
        onStart={(mode) => void syncCall(() => api.startSync({ mode }))}
        onPause={() => void syncCall(() => api.pauseSync())}
        onResume={() => void syncCall(() => api.resumeSync())}
        onCancel={() => void syncCall(() => api.cancelSync())}
      />

      {drifted ? (
        <p class="notice" role="status" data-testid="drift" title={capture ? `unknown fields: ${capture.drift.unknownItemKeys.join(', ') || 'none'}; unreadable records: ${capture.drift.badRecords}` : ''}>
          {platformName} changed something, so some results may be incomplete.
        </p>
      ) : null}

      <SearchBox
        query={q}
        busy={res.status === 'loading' && res.items.length === 0}
        onInput={(v) => setQ((s) => typeInput(s, v))}
        onEnter={() => { const r = pressEnter(q); if (r.search) search(q); else setQ(r.state); }}
        onBackspaceEmpty={() => setQ((s) => removeLastChip(s))}
        onPaste={(text) => { if (!pasteIsList(text)) return false; setQ((s) => pasteList(s, text)); return true; }}
        onRemove={(id) => setQ((s) => removeChip(s, id))}
        onSearch={() => search(q)}
        onMode={(m) => setQ((s) => setMode(s, m))}
        onSort={(o) => { setQ((s) => setSort(s, o)); saveSettings({ sort: o }); }}
        onExpandAll={(on) => { setQ((s) => setExpandAll(s, on)); saveSettings({ relatedWords: on }); }}
      />

      <Results
        query={q}
        results={res}
        hasAnyVideos={stats === undefined ? true : stats.items > 0} // (until the numbers arrive, do not flash "nothing here")
        platformName={platformName}
        onLoadMore={() => void loadMore()}
        onAddSuggested={(text) => setQ((s) => addSuggested(s, text))}
        onUseSuggestion={(chipId, text) => setQ((s) => replaceChipText(s, chipId, text))}
        explain={explain}
      />

      <Footer
        stats={stats}
        capture={capture}
        {...(footerMessage !== undefined ? { message: footerMessage } : {})}
        pageSize={pageSize}
        onPageSize={(n) => { setPageSize(n); saveSettings({ pageSize: n }); void runSearch(committed.current); }}
        onExport={() => {
          api.exportData().then(
            (bundle) => { downloadJson(`scroganize-export-${new Date().toISOString().slice(0, 10)}.json`, bundle); setFooterMessage(`Exported ${bundle.items.length} videos.`); },
            (e) => setFooterMessage(`Export failed: ${errorMessage(e)}`),
          );
        }}
        onImport={(file) => {
          readJsonFile(file)
            .then((json) => api.importData(json as never))
            .then(() => { setFooterMessage('Imported. The library was replaced.'); return Promise.all([refreshMeta(), runSearch(committed.current)]); })
            .catch((e) => setFooterMessage(`Import failed: ${errorMessage(e)}`));
        }}
        onWipe={() => {
          api.wipeData().then(
            () => { setFooterMessage('The library is empty.'); return Promise.all([refreshMeta(), runSearch(committed.current)]); },
            (e) => setFooterMessage(`Wipe failed: ${errorMessage(e)}`),
          );
        }}
      />
    </main>
  );
}
