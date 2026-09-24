// Does a page origin fall under a Chrome match pattern such as `https://www.tiktok.com/*` or `https://*.example.com/*`?
// Only the scheme and host are compared (the path part of a pattern is irrelevant to "which site sent this message").
// Pure and total.

export function originMatchesPattern(pattern: string, origin: string | undefined): boolean {
  if (typeof origin !== 'string') return false;
  const p = /^(https?):\/\/([^/]+)\/.*$/.exec(pattern);
  const o = /^(https?):\/\/([^/:]+)$/.exec(origin); // an explicit port never matches: a pattern without one means the default port
  if (!p || !o) return false;
  if (p[1] !== o[1]) return false;
  const patHost = p[2]!.toLowerCase();
  const host = o[2]!.toLowerCase();
  if (patHost.startsWith('*.')) {
    const base = patHost.slice(2);
    return host === base || host.endsWith(`.${base}`);
  }
  return patHost === host;
}

export const originMatchesAny = (patterns: readonly string[], origin: string | undefined): boolean => patterns.some((p) => originMatchesPattern(p, origin));
