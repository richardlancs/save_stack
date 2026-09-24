// A library belongs to ONE signed-in account per platform: mixing two accounts' saved videos in one library would be silent
// corruption (the schema has no account dimension). The binding is stored in the database itself (table `meta`), so it is written
// in the same transaction as the data it protects and is cleared together with it by wipe / import. Pure helpers, no engine code.

import type { AccountRef } from '../model';

export type AccountMatch = 'same' | 'renamed' | 'upgraded' | 'different';

const lc = (s: string): string => s.toLowerCase();

/**
 * Compare the account a batch was read as with the one the library is bound to.
 *  - both have a stable id: the id decides, so a username change ("renamed") keeps working
 *  - otherwise handles decide (case-insensitively); a bound record that had no id gains one ("upgraded")
 */
export function matchAccount(bound: AccountRef, incoming: AccountRef): AccountMatch {
  if (bound.platform !== incoming.platform) return 'different';
  if (bound.id !== undefined && incoming.id !== undefined) {
    if (bound.id !== incoming.id) return 'different';
    return lc(bound.handle) === lc(incoming.handle) ? 'same' : 'renamed';
  }
  if (lc(bound.handle) !== lc(incoming.handle)) return 'different';
  return bound.id === undefined && incoming.id !== undefined ? 'upgraded' : 'same';
}

/** Validate an account reference that came from outside (RPC, import bundle). Rebuilt field by field. */
export function parseAccountRef(v: unknown): AccountRef | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.platform !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(o.platform)) return undefined;
  if (typeof o.handle !== 'string' || !/^[A-Za-z0-9._]{1,64}$/.test(o.handle)) return undefined;
  if (o.id !== undefined && (typeof o.id !== 'string' || !/^\d{1,24}$/.test(o.id))) return undefined;
  return { platform: o.platform, handle: o.handle, ...(o.id !== undefined ? { id: o.id as string } : {}) };
}

export class AccountMismatchError extends Error {
  constructor(readonly bound: AccountRef) {
    super(`this library belongs to "${bound.handle}"; wipe it to use a different account`);
    this.name = 'AccountMismatchError';
  }
}
