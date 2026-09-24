// TikTok exposes NO per-video saved time. But the favorites list is paginated by a cursor that is a Unix timestamp in
// seconds, strictly decreasing from page to page (M0 finding, docs/TIKTOK_FINDINGS.md §3): it behaves as the save time of the
// LAST video on the page. So for a page:
//   - the request cursor (the previous page's response cursor, or "now" for the first page) is an UPPER bound on every save time
//   - the response cursor is (about) the save time of the last video, i.e. the LOWER end
// and the videos in between are estimated by even spacing. This is an estimate with page granularity (7 to 15 videos, from
// days to months apart in sparse periods) and is always labelled `interpolated`. Inference, verified against one account.

/**
 * A cursor is only trusted as a time if it is a plausible epoch in seconds (after 2001-09-09). "0" means "none". Cursors come from the
 * page's own request URL, so nothing derived from one may ever be later than the moment of capture: estimateSavedAt clamps.
 */
function cursorMs(cursor: string | undefined): number | undefined {
  if (cursor === undefined || !/^\d{1,16}$/.test(cursor)) return undefined;
  const ms = Number(cursor) * 1000;
  return ms >= 1_000_000_000_000 ? ms : undefined;
}

/**
 * Estimated save times (epoch ms), newest first, for `count` videos delivered in one favorites page.
 * Always returns `count` values, strictly decreasing, so the order TikTok returned them in is preserved.
 * `bounded` says whether BOTH ends of the interval were known (an interpolation) or only the upper end (the last or only page:
 * the values then only preserve order and must not be shown as dates).
 */
export function estimateSavedAt(count: number, requestCursor: string | undefined, responseCursor: string | undefined, capturedAt: number): { times: number[]; bounded: boolean } {
  if (count <= 0) return { times: [], bounded: false };
  const upper = Math.min(cursorMs(requestCursor) ?? capturedAt, capturedAt); // never in the future, whatever the cursor claims
  const lowerCandidate = cursorMs(responseCursor);
  const lower = lowerCandidate !== undefined && lowerCandidate < upper ? lowerCandidate : undefined;
  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    times.push(lower !== undefined ? Math.round(lower + ((count - 1 - i) / count) * (upper - lower)) : upper - (i + 1) * 1000);
  }
  return { times, bounded: lower !== undefined };
}

/** Times only (see estimateSavedAt). */
export function interpolateSavedAt(count: number, requestCursor: string | undefined, responseCursor: string | undefined, capturedAt: number): number[] {
  return estimateSavedAt(count, requestCursor, responseCursor, capturedAt).times;
}
