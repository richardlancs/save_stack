// The capture pipeline: what the service worker does with a message a content script relayed from a platform page.
//
//   sender check -> shape/size validation -> identity guard -> JSON parse -> adapter.parse -> ingest (binds the account) -> status
//
// The cheap checks (who sent it, is it well-formed, whose page is it) all happen BEFORE the body is parsed, so a flood of hostile
// messages costs almost nothing. The account binding is enforced by the DATABASE, atomically with the write (see
// core/ingest/account.ts); the status kept here is only a display cache and an early, cheap refusal.
//
// Everything here is chrome-free (the service worker injects `ingest` and the status store), so the whole pipeline is
// unit-tested against the real SQLite adapter and hostile inputs. It never throws: every outcome is a CaptureOutcome.
//
// There is deliberately NO duplicate suppression: a platform re-sends pages whenever a tab opens, with fresh envelope fields and
// re-signed thumbnail URLs, so recognising "the same page" is unreliable, and re-applying a page is cheap and idempotent (it also
// refreshes stats, thumbnails and `last seen`). A page that adds nothing new is reported as such (`duplicate`), not skipped.

import { matchAccount } from '../../core/ingest/account';
import type { AccountRef, Membership, ParsedBatch, UpsertResult } from '../../core/model';
import {
  emptyCaptureStatus,
  type AcceptedPage,
  type CaptureListener,
  type CaptureSource,
  type CaptureOutcome,
  type CaptureRejection,
  type CaptureStatus,
} from '../../platforms/capture-protocol';
import { originMatchesAny } from '../../platforms/match-origin';
import type { PlatformRegistry } from '../../platforms/registry';
import { validateCaptureMessage } from '../../platforms/validate-capture';

/** What Chrome tells us about who sent a runtime message. `origin` is set by the browser, not by the sender. */
export interface SenderInfo {
  id?: string;
  origin?: string;
  frameId?: number;
  /** The tab the message came from (used by the sync to recognise its own window). */
  tabId?: number;
}

export interface StatusStore {
  load(): Promise<CaptureStatus | undefined>;
  save(status: CaptureStatus): Promise<void>;
}

export interface CapturePipelineDeps {
  registry: PlatformRegistry;
  /** chrome.runtime.id: a message from any other extension is refused. */
  ownExtensionId: string;
  /** Store a batch. Must throw (with `code: 'ACCOUNT_MISMATCH'` or an AccountMismatchError) when the batch's account is not the library's. */
  ingest(batch: ParsedBatch): Promise<UpsertResult>;
  store: StatusStore;
  now?: () => number;
}

export interface CapturePipeline {
  handle(message: unknown, sender: SenderInfo): Promise<CaptureOutcome>;
  getStatus(): Promise<CaptureStatus>;
  /** Forget capture counters and the cached account (call after the library is wiped or replaced). */
  reset(): Promise<void>;
  /** Observe outcomes (used by the sync). Returns an unsubscribe function. */
  subscribe(listener: CaptureListener): () => void;
}

const lc = (s: string | undefined): string | undefined => (s === undefined ? undefined : s.toLowerCase());
const MAX_UNKNOWN_KEYS = 30;
/** Memberships that arrived before their collection existed are kept (in memory) and applied when it does. */
const MAX_PENDING_COLLECTIONS = 50;
const MAX_PENDING_MEMBERSHIPS = 1000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isAccountMismatch = (e: unknown): boolean => isObj(e) && (e.code === 'ACCOUNT_MISMATCH' || e.name === 'AccountMismatchError');

/** A stored status may be from an older build or damaged: keep what is usable and fill in the rest. */
function normalizeStatus(raw: unknown): CaptureStatus {
  const e = emptyCaptureStatus();
  if (!isObj(raw) || raw.version !== 1) return e;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const drift = isObj(raw.drift) ? raw.drift : {};
  return {
    ...e,
    version: 1,
    ...(typeof raw.viewerHandle === 'string' ? { viewerHandle: raw.viewerHandle } : {}),
    ...(typeof raw.viewerId === 'string' ? { viewerId: raw.viewerId } : {}),
    ...(typeof raw.lastCaptureAt === 'number' ? { lastCaptureAt: raw.lastCaptureAt } : {}),
    pages: num(raw.pages), items: num(raw.items), inserted: num(raw.inserted), touched: num(raw.touched), reindexed: num(raw.reindexed),
    duplicates: num(raw.duplicates), skippedMemberships: num(raw.skippedMemberships),
    rejected: isObj(raw.rejected) ? (raw.rejected as CaptureStatus['rejected']) : {},
    byKind: isObj(raw.byKind) ? (raw.byKind as CaptureStatus['byKind']) : {},
    ...(isObj(raw.lastPage) ? { lastPage: raw.lastPage as unknown as NonNullable<CaptureStatus['lastPage']> } : {}),
    ...(isObj(raw.lastRejection) ? { lastRejection: raw.lastRejection as unknown as NonNullable<CaptureStatus['lastRejection']> } : {}),
    drift: {
      parserVersion: num(drift.parserVersion), itemsSeen: num(drift.itemsSeen), badRecords: num(drift.badRecords),
      unknownItemKeys: Array.isArray(drift.unknownItemKeys) ? drift.unknownItemKeys.filter((k): k is string => typeof k === 'string').slice(0, MAX_UNKNOWN_KEYS).map((k) => k.slice(0, 64)) : [],
      missing: isObj(drift.missing) ? (drift.missing as Record<string, number>) : {},
      ...(typeof drift.lastReportAt === 'number' ? { lastReportAt: drift.lastReportAt } : {}),
    },
  };
}

export function createCapturePipeline(deps: CapturePipelineDeps): CapturePipeline {
  const now = deps.now ?? Date.now;
  const listeners = new Set<CaptureListener>();
  let source: CaptureSource = {}; // the message being processed (processing is strictly one at a time)
  const notify = (fn: (l: CaptureListener) => void | Promise<void> | undefined): void => {
    for (const l of listeners) {
      try { void Promise.resolve(fn(l)).catch(() => undefined); } catch { /* an observer must never break a capture */ }
    }
  };
  let status: CaptureStatus | undefined;
  let loaded = false; // false until the stored status was READ successfully: never overwrite what could not be read
  let chain: Promise<unknown> = Promise.resolve();
  const pending = new Map<string, Membership[]>(); // collection external id -> memberships waiting for the collection to exist

  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };

  const load = async (): Promise<CaptureStatus> => {
    if (status && loaded) return status;
    try { status = normalizeStatus(await deps.store.load()); loaded = true; }
    catch { status ??= emptyCaptureStatus(); }
    return status;
  };

  // Status writes are coalesced: at most one in flight, and whatever is newest when it finishes is written next. A flood of
  // rejected messages therefore costs at most one storage write at a time.
  let saving: Promise<void> | undefined;
  let dirty = false;
  const flush = (): Promise<void> => {
    dirty = true;
    saving ??= (async () => {
      while (dirty && loaded && status) {
        dirty = false;
        try { await deps.store.save(structuredClone(status)); } catch { /* diagnostics: never fail a capture over them */ }
      }
    })().finally(() => { saving = undefined; });
    return saving;
  };

  const reject = (s: CaptureStatus, reason: CaptureRejection, kind?: string): CaptureOutcome => {
    s.rejected[reason] = (s.rejected[reason] ?? 0) + 1;
    s.lastRejection = { reason, at: now() };
    void flush();
    notify((l) => l.rejected?.(reason, kind, source));
    return kind === undefined ? { accepted: false, reason } : { accepted: false, reason, kind };
  };

  const accountOf = (s: CaptureStatus, platform: string): AccountRef | undefined =>
    s.viewerHandle === undefined ? undefined : { platform, handle: s.viewerHandle, ...(s.viewerId !== undefined ? { id: s.viewerId } : {}) };

  async function process(message: unknown, sender: SenderInfo): Promise<CaptureOutcome> {
    source = sender.tabId !== undefined ? { tabId: sender.tabId } : {};
    const s = await load();

    // 1. Who sent it? Chrome fills `id` and `origin` itself; a web page cannot set them.
    if (sender.id !== deps.ownExtensionId) return reject(s, 'sender');
    if (sender.frameId !== undefined && sender.frameId !== 0) return reject(s, 'sender');

    // 2. Is it well-formed, from a known platform, one of that platform's allowed kinds, and of sane size?
    const checked = validateCaptureMessage(message, deps.registry, now());
    if (!checked.ok) return reject(s, checked.reason);
    const m = checked.message;
    const adapter = deps.registry.get(m.platform)!;
    if (!originMatchesAny(adapter.hostMatches, sender.origin)) return reject(s, 'sender', m.kind);

    // 3. Identity guard (cheap: no body parsing yet): only the signed-in user's OWN saved posts may enter the library.
    const viewer = lc(m.viewerHandle);
    if (!viewer) return reject(s, 'identity_unknown', m.kind);
    if (lc(m.pageHandle) !== viewer) return reject(s, 'not_own_profile', m.kind);
    const incoming: AccountRef = { platform: m.platform, handle: m.viewerHandle!, ...(m.viewerId !== undefined ? { id: m.viewerId } : {}) };
    const cached = accountOf(s, m.platform);
    if (cached && matchAccount(cached, incoming) === 'different') return reject(s, 'account_mismatch', m.kind); // early exit; the database has the last word

    // 4. The body is parsed HERE, inside the worker, so hostile JSON can only hurt this call.
    let body: unknown;
    try { body = JSON.parse(m.body); } catch { return reject(s, 'bad_json', m.kind); }

    // 5. Platform-specific reading. Total: bad records are dropped and reported, never thrown.
    const parsed = adapter.parse({
      platform: m.platform,
      kind: m.kind,
      ...(m.requestCursor !== undefined ? { requestCursor: m.requestCursor } : {}),
      ...(m.collectionId !== undefined ? { collectionId: m.collectionId } : {}),
      capturedAt: m.capturedAt,
      body,
    });
    const batch = parsed.batch;
    const empty = batch.items.length === 0 && (batch.collections?.length ?? 0) === 0 && (batch.memberships?.length ?? 0) === 0;
    if (parsed.problems.some((p) => p.code === 'bad_envelope') && empty) return reject(s, 'bad_envelope', m.kind);
    if (parsed.ownerHandle !== undefined && lc(parsed.ownerHandle) !== viewer) return reject(s, 'owner_mismatch', m.kind);

    // 6. Store. The database binds the library to this account on first use and refuses a different one, in the same transaction.
    let result: UpsertResult | undefined;
    if (!empty) {
      try { result = await deps.ingest({ ...batch, account: incoming }); }
      catch (e) {
        if (isAccountMismatch(e)) {
          const bound = isObj(e) && isObj(e.bound) ? (e.bound as unknown as AccountRef) : undefined;
          if (bound?.handle) { s.viewerHandle = bound.handle; if (bound.id !== undefined) s.viewerId = bound.id; }
          return reject(s, 'account_mismatch', m.kind);
        }
        return reject(s, 'ingest_failed', m.kind);
      }
      // Memberships whose collection did not exist yet (the item list beat the collection list): keep them and apply them once it does.
      if (result.skippedMemberships > 0 && m.kind !== undefined && batch.memberships && parsed.page.collectionId !== undefined) {
        s.skippedMemberships += result.skippedMemberships;
        if (pending.has(parsed.page.collectionId) || pending.size < MAX_PENDING_COLLECTIONS) {
          const list = pending.get(parsed.page.collectionId) ?? [];
          for (const mem of batch.memberships) if (list.length < MAX_PENDING_MEMBERSHIPS) list.push(mem);
          pending.set(parsed.page.collectionId, list);
        }
      }
      for (const c of batch.collections ?? []) {
        const waiting = pending.get(c.externalId);
        if (!waiting) continue;
        pending.delete(c.externalId);
        try { await deps.ingest({ items: [], memberships: waiting, account: incoming, ...(batch.syncedAt !== undefined ? { syncedAt: batch.syncedAt } : {}) }); } catch { /* the next read of that collection applies them */ }
      }
    }
    const inserted = result?.inserted ?? 0;
    const duplicate = batch.items.length > 0 && inserted === 0;
    const summary: AcceptedPage = {
      kind: m.kind,
      ...(parsed.page.collectionId !== undefined ? { collectionId: parsed.page.collectionId } : {}),
      ...(m.requestCursor !== undefined ? { requestCursor: m.requestCursor } : {}),
      ...(parsed.page.responseCursor !== undefined ? { responseCursor: parsed.page.responseCursor } : {}),
      hasMore: parsed.page.hasMore,
      itemsDelivered: parsed.page.itemsDelivered,
      inserted,
      reindexed: result?.reindexed ?? 0,
      duplicate,
      externalIds: batch.items.map((i) => i.externalId),
      ...(batch.collections && batch.collections.length > 0 ? { collections: batch.collections.map((c) => ({ id: c.externalId, name: c.name, ...(c.declaredTotal !== undefined ? { declaredTotal: c.declaredTotal } : {}) })) } : {}),
      ...(parsed.page.declaredTotal !== undefined ? { declaredTotal: parsed.page.declaredTotal } : {}),
    };

    // 7. Bookkeeping: counters, and the "did the platform change its format?" signals.
    s.viewerHandle = m.viewerHandle!;
    if (m.viewerId !== undefined) s.viewerId = m.viewerId;
    s.lastCaptureAt = now();
    s.pages += 1;
    if (duplicate) s.duplicates += 1;
    s.items += parsed.page.itemsDelivered;
    s.inserted += inserted;
    s.touched += result?.touched ?? 0;
    s.reindexed += result?.reindexed ?? 0;
    const k = (s.byKind[m.kind] ??= { pages: 0, items: 0, lastAt: 0 });
    k.pages += 1;
    k.items += parsed.page.itemsDelivered;
    k.lastAt = now();
    s.lastPage = {
      kind: m.kind,
      hasMore: parsed.page.hasMore,
      itemsDelivered: parsed.page.itemsDelivered,
      ...(parsed.page.declaredTotal !== undefined ? { declaredTotal: parsed.page.declaredTotal } : {}),
      ...(parsed.page.collectionId !== undefined ? { collectionId: parsed.page.collectionId } : {}),
      at: now(),
    };
    const d = s.drift;
    d.parserVersion = adapter.parserVersion;
    d.itemsSeen += parsed.shape.items;
    const bad = parsed.problems.filter((p) => p.code === 'bad_record').length;
    d.badRecords += bad;
    let drifted = bad > 0;
    for (const key of parsed.shape.unknownItemKeys) {
      if (!d.unknownItemKeys.includes(key) && d.unknownItemKeys.length < MAX_UNKNOWN_KEYS) { d.unknownItemKeys.push(key); drifted = true; }
    }
    for (const [field, n] of Object.entries(parsed.shape.missing)) { d.missing[field] = (d.missing[field] ?? 0) + n; }
    if (drifted) d.lastReportAt = now();
    await flush();
    notify((l) => l.accepted?.(summary, source));

    return {
      accepted: true,
      kind: m.kind,
      items: parsed.page.itemsDelivered,
      ...(duplicate ? { duplicate: true } : {}),
      ...(result ? { inserted: result.inserted } : {}),
    };
  }

  return {
    handle: (message, sender) =>
      serial(async () => {
        try { return await process(message, sender); }
        catch { return reject(await load(), 'malformed'); } // last-resort net: the pipeline must never throw
      }),
    getStatus: () => serial(async () => structuredClone(await load())),
    reset: () => serial(async () => {
      status = emptyCaptureStatus();
      loaded = true; // an intentional reset: from here on this is the truth to persist
      pending.clear();
      await flush();
    }),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
