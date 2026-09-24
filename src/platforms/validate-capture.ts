// Validation of a capture message. Called at BOTH the relay content script and the service worker (the second check does not
// trust the first), and it is pure so it is tested with hostile inputs. Total: never throws.

import {
  CAPTURE_CHANNEL,
  CAPTURE_VERSION,
  MAX_BODY_CHARS,
  MAX_CLOCK_SKEW_MS,
  type CaptureMessage,
  type CaptureRejection,
} from './capture-protocol';
import type { PlatformRegistry } from './registry';

const HANDLE = /^[A-Za-z0-9._]{1,64}$/;
const CURSOR = /^\d{1,16}$/;
const COLLECTION_ID = /^\d{1,24}$/;
const USER_ID = /^\d{1,24}$/;
const PLATFORM_ID = /^[a-z][a-z0-9_-]{0,31}$/;

export type Validation = { ok: true; message: CaptureMessage } | { ok: false; reason: CaptureRejection };

const optString = (v: unknown, re: RegExp): string | undefined | null => {
  if (v === undefined) return undefined;
  return typeof v === 'string' && re.test(v) ? v : null; // null = present but invalid
};

export function validateCaptureMessage(data: unknown, registry: PlatformRegistry, now: number = Date.now()): Validation {
  try {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) return { ok: false, reason: 'malformed' };
    const m = data as Record<string, unknown>;
    if (m.channel !== CAPTURE_CHANNEL || m.v !== CAPTURE_VERSION) return { ok: false, reason: 'malformed' };
    if (typeof m.platform !== 'string' || !PLATFORM_ID.test(m.platform)) return { ok: false, reason: 'malformed' };
    const adapter = registry.get(m.platform);
    if (!adapter) return { ok: false, reason: 'wrong_platform' };
    if (typeof m.kind !== 'string' || !adapter.captureRules.some((r) => r.kind === m.kind)) return { ok: false, reason: 'unknown_kind' };

    const requestCursor = optString(m.requestCursor, CURSOR);
    const collectionId = optString(m.collectionId, COLLECTION_ID);
    const pageHandle = optString(m.pageHandle, HANDLE);
    const viewerHandle = optString(m.viewerHandle, HANDLE);
    const viewerId = optString(m.viewerId, USER_ID);
    if (requestCursor === null || collectionId === null || pageHandle === null || viewerHandle === null || viewerId === null) return { ok: false, reason: 'malformed' };

    if (typeof m.capturedAt !== 'number' || !Number.isFinite(m.capturedAt)) return { ok: false, reason: 'malformed' };
    if (Math.abs(now - m.capturedAt) > MAX_CLOCK_SKEW_MS) return { ok: false, reason: 'stale' };

    if (typeof m.body !== 'string' || m.body.length === 0) return { ok: false, reason: 'malformed' };
    if (m.body.length > MAX_BODY_CHARS) return { ok: false, reason: 'too_large' };

    return {
      ok: true,
      // Rebuilt field by field: nothing the sender attached beyond the known fields is carried forward.
      message: {
        channel: CAPTURE_CHANNEL,
        v: CAPTURE_VERSION,
        platform: m.platform,
        kind: m.kind,
        requestCursor,
        collectionId,
        capturedAt: m.capturedAt,
        body: m.body,
        pageHandle,
        viewerHandle,
        viewerId,
      },
    };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}
