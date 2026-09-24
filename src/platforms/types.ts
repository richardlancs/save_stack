// The platform adapter contract: everything a social platform must provide so the rest of Scroganize (storage, search,
// sync, UI) never has to know which platform a video came from. No chrome.* and no DOM here: adapters' `parse` must run in
// plain Node under Vitest. See docs/ADDING_A_PLATFORM.md.

import type { ParsedBatch, SavedItem } from '../core/model';
import type { SyncPageSpec, SyncPlatformSpec } from '../core/sync/types';

/** A network response the platform's own web app already loads, that we are allowed to read. Matched by exact path. */
export interface CaptureRule {
  /** What this response is, in the adapter's own vocabulary (e.g. 'favorites', 'collection_items'). */
  kind: string;
  /** Exact URL pathname (no query). Nothing outside these rules is ever forwarded out of the page. */
  path: string;
}

/** What the page-side hook reports about one allowed response. Contains no headers, cookies or tokens. */
export interface RawCapture {
  platform: string;
  kind: string;
  /** The cursor the page sent with the request (a time for some lists, an offset for others). Digits only. */
  requestCursor?: string;
  /** For per-collection requests. Digits only. */
  collectionId?: string;
  /** Epoch ms when the response arrived. */
  capturedAt: number;
  /** The parsed JSON response body. */
  body: unknown;
}

export interface PageInfo {
  kind: string;
  /** `hasMore` as the platform reported it; null if it was missing or not a boolean. Completion means hasMore === false, NEVER count === total. */
  hasMore: boolean | null;
  requestCursor?: string;
  responseCursor?: string;
  itemsDelivered: number;
  /** What the platform CLAIMS the list holds (unreliable: 263 declared vs 227 delivered). */
  declaredTotal?: number;
  collectionId?: string;
}

export type ProblemCode =
  | 'bad_envelope' //         the response is not the shape this kind of response has
  | 'bad_record' //           one record could not be read and was dropped
  | 'missing_collection_id'; // a per-collection page arrived without the collection it belongs to

export interface ParseProblem {
  code: ProblemCode;
  message: string;
  index?: number;
}

/** How closely a response matched what the parser expects: the raw material for "the platform changed something" warnings. */
export interface ShapeReport {
  items: number;
  /** Item keys the parser has never seen before (capped). */
  unknownItemKeys: string[];
  /** How many items lacked each field the product relies on. */
  missing: Record<string, number>;
}

export interface ParsedCapture {
  batch: ParsedBatch;
  page: PageInfo;
  /** For payloads that name the account they belong to (collection lists/details): must match the signed-in user. */
  ownerHandle?: string;
  problems: ParseProblem[];
  shape: ShapeReport;
}

export interface PlatformAdapter {
  /** 'tiktok'. Stored on every item. */
  id: string;
  displayName: string;
  /** Bumps whenever the parser's understanding of the platform changes; recorded with drift reports. */
  parserVersion: number;
  /** Chrome match patterns for the pages whose traffic is read. */
  hostMatches: readonly string[];
  captureRules: readonly CaptureRule[];
  /** PURE and TOTAL: never throws, whatever the input. Bad records are dropped and reported in `problems`. */
  parse(capture: RawCapture): ParsedCapture;
  /** How to actively read this platform's lists (sync): where they are, how to tell the page kind, what the driver may probe. */
  sync: SyncPlatformSpec & SyncPageSpec;
  /** Link back to the original post. */
  canonicalUrl(item: Pick<SavedItem, 'authorHandle' | 'externalId' | 'mediaType'>): string;
}
