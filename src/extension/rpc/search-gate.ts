// Decides whether a queued search has been replaced by a newer one. Pure: the "event loop" is injected so the
// ordering can be tested deterministically.
//
// Why a gate and not just "remember the newest requestId on arrival":
// the database worker handles one request at a time, and while it is busy (a slow query, an import) later messages
// sit in the event loop and their arrival handlers cannot run. When the busy call finishes, the OLDER search's turn
// comes up before the NEWER message has even been dispatched, so it would run although it is already stale
// (found by the real-extension end-to-end run; the in-process test could not see it because it faked the ordering).
// Yielding one event-loop turn before running a search lets every already-queued message register first.

import { RPC_VERSION } from './protocol';

interface Envelope {
  v?: unknown;
  method?: unknown;
  params?: { requestId?: unknown } | null;
}

/** search and getChipInfo of one cycle share a requestId, so they never supersede each other. */
export const isSearchLike = (msg: unknown): boolean => {
  const m = msg as Envelope | null;
  return m?.v === RPC_VERSION && (m.method === 'search' || m.method === 'getChipInfo') && typeof m.params?.requestId === 'string';
};

export function createSearchGate(yieldToLoop: () => Promise<void>) {
  let latest: string | null = null;
  return {
    /** Call from the message listener, the moment a message arrives. */
    noteArrival(msg: unknown): void {
      if (isSearchLike(msg)) latest = (msg as { params: { requestId: string } }).params.requestId;
    },
    /** Await before running a request. Only searches yield (a couple of milliseconds at most), everything else runs at once. */
    async beforeRun(msg: unknown): Promise<void> {
      if (isSearchLike(msg)) await yieldToLoop();
    },
    /** True if a newer search has arrived since `requestId`. */
    isSuperseded(requestId: string): boolean {
      return latest !== null && latest !== requestId;
    },
  };
}
