// Who is on the page, and who is signed in. Read from the page's URL and its own hydration data; nothing is requested.
// Pure and total (bad input yields undefined), so it runs inside the in-page hook without any risk of breaking the page.

const HANDLE = /^[A-Za-z0-9._]{1,64}$/;

/** `/@someone/collection/x-123` -> `someone`. The profile whose page the user is looking at. */
export function pageHandleFromPath(pathname: string): string | undefined {
  const m = /^\/@([^/?#]+)(?:\/|$)/.exec(pathname);
  if (!m) return undefined;
  let h: string;
  try { h = decodeURIComponent(m[1]!); } catch { return undefined; }
  return HANDLE.test(h) ? h : undefined;
}

/**
 * The signed-in user from the `__UNIVERSAL_DATA_FOR_REHYDRATION__` blob: `webapp.app-context.user.uniqueId` (the handle, which a user
 * can change) and `.uid` (the stable numeric id, which cannot).
 */
export function viewerFromHydration(text: string | null | undefined): { handle: string; id?: string } | undefined {
  if (typeof text !== 'string' || text.length === 0 || text.length > 5_000_000) return undefined;
  let data: unknown;
  try { data = JSON.parse(text); } catch { return undefined; }
  const obj = (v: unknown): Record<string, unknown> | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
  const root = obj(data);
  const scope = obj(root?.['__DEFAULT_SCOPE__']) ?? root;
  const user = obj(obj(scope?.['webapp.app-context'])?.['user']);
  const handle = user?.['uniqueId'];
  if (typeof handle !== 'string' || !HANDLE.test(handle)) return undefined;
  const uid = user?.['uid'];
  const id = typeof uid === 'string' ? uid : typeof uid === 'number' && Number.isSafeInteger(uid) ? String(uid) : undefined;
  return { handle, ...(id !== undefined && /^\d{1,24}$/.test(id) ? { id } : {}) };
}

/** Just the handle (see viewerFromHydration). */
export function viewerHandleFromHydration(text: string | null | undefined): string | undefined {
  return viewerFromHydration(text)?.handle;
}

export const HYDRATION_SCRIPT_ID = '__UNIVERSAL_DATA_FOR_REHYDRATION__';
