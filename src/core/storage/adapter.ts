// The engine-agnostic storage contract. Everything above this line (ingest, search planning, the RPC server)
// depends on this interface only. It is async so an IndexedDB fallback could implement it if OPFS ever fails,
// even though the SQLite implementation is synchronous underneath.
//
// Search comes in through SearchStore (src/core/search/store.ts): the SQL for it lives with the engine, the query logic does not.

import type { SearchStore } from '../search/store';
import type {
  AccountRef,
  ExportBundle,
  ParsedBatch,
  ReconcileInput,
  ReconcileResult,
  StorageStats,
  StoredCollection,
  StoredItem,
  UpsertResult,
} from '../model';

export interface StorageAdapter extends SearchStore {
  /** Bring the database to the latest schema. Idempotent. */
  migrate(): Promise<{ from: number; to: number }>;

  /** Apply one batch atomically: all of it or none of it. Idempotent for identical input. */
  upsertBatch(batch: ParsedBatch): Promise<UpsertResult>;

  getItem(platform: string, externalId: string): Promise<StoredItem | null>;
  /** The account the library is bound to for this platform, if any. */
  getAccount(platform: string): Promise<AccountRef | null>;
  listCollections(): Promise<StoredCollection[]>;
  stats(): Promise<StorageStats>;

  /** Apply the outcome of a COMPLETE sync pass: mark vanished videos unavailable / drop stale memberships. */
  reconcile(input: ReconcileInput): Promise<ReconcileResult>;

  exportAll(): Promise<ExportBundle>;
  /** Replaces all existing data with the bundle. */
  importAll(bundle: ExportBundle): Promise<void>;
  /** Delete every row. Storage-level reclamation (dropping the file) is the owner's job. */
  wipe(): Promise<void>;
  close(): Promise<void>;
}
