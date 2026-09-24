import type { Database } from '@sqlite.org/sqlite-wasm';
import { MIGRATIONS, type Migration } from './migrations';

/** Pragmas chosen by the M0 spike (docs/STORAGE_SPIKE.md §2). Exotic settings bought nothing and journal_mode=MEMORY/OFF risks corruption. */
export const SAFE_PRAGMAS: readonly string[] = [
  'journal_mode = TRUNCATE', // avoids create/delete churn in the fixed-slot OPFS pool
  'synchronous = NORMAL',
  'temp_store = MEMORY',
  'cache_size = -32768',
  'foreign_keys = ON',
];

export function applyPragmas(db: Database): void {
  for (const p of SAFE_PRAGMAS) db.exec(`PRAGMA ${p}`);
}

export function schemaVersion(db: Database): number {
  return Number(db.selectValue('PRAGMA user_version') ?? 0);
}

function validate(migrations: readonly Migration[]): void {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`migrations must be contiguous from 1; got v${m.version} at position ${i + 1}`);
  });
}

/**
 * Apply every migration newer than the database's `user_version`, each in its own transaction with the
 * version bump, so a crash mid-migration leaves the previous version intact.
 * Refuses to open a database written by a newer build rather than guessing.
 */
export function migrate(db: Database, migrations: readonly Migration[] = MIGRATIONS): { from: number; to: number } {
  validate(migrations);
  const from = schemaVersion(db);
  const latest = migrations.length;
  if (from > latest) {
    throw new Error(`database schema v${from} is newer than this build supports (v${latest}); refusing to open it`);
  }
  for (const m of migrations.slice(from)) {
    db.transaction(() => {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
    });
  }
  return { from, to: latest };
}
