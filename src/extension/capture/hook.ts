// The in-page hook. It runs in the PAGE'S OWN JavaScript world (a MAIN-world content script) because that is the only place
// the platform's own network responses can be seen. It is deliberately tiny and defensive:
//
//   * It changes nothing the page can observe. `fetch` and the XHR methods are wrapped in Proxies over the originals (so name,
//     length, prototype and toString are the originals'); the original call is made first and with the original arguments; the page
//     gets the same resolved value, and a rejection reaches the page exactly as it would without us (unhandled rejections included).
//     Everything else the hook does runs on a side branch whose failures are swallowed.
//   * It only ever looks at requests the adapter classified as allowed (exact-path allowlist). Every other request is
//     ignored without being read.
//   * It forwards the response text plus digits-only request values, and NOTHING else: no headers, cookies, tokens, other query
//     values, and never the request body.
//
// The hook is written against a small `HookWindow` interface so its behaviour is unit-tested in Node with a fake window.

import { CAPTURE_CHANNEL, CAPTURE_VERSION, MAX_BODY_CHARS, type CaptureMessage } from '../../platforms/capture-protocol';

export interface ClassifiedRequest {
  kind: string;
  requestCursor?: string;
  collectionId?: string;
}

export interface HookIdentity {
  pageHandle?: string;
  viewerHandle?: string;
  viewerId?: string;
}

export interface HookPlatform {
  id: string;
  /** Decide whether a request may be read, and extract the only request values that may be forwarded. Must not throw. */
  classify(input: unknown, baseOrigin: string): ClassifiedRequest | null;
  /** Who the page shows / who is signed in, evaluated when the request is made (SPA navigation changes the page mid-session). */
  identity(): HookIdentity;
}

interface FakeXhrLike {
  responseType: string;
  responseText: string;
  response: unknown;
  status: number;
  addEventListener(type: 'load', listener: () => void): void;
}
interface XhrCtorLike {
  prototype: {
    open(this: unknown, method: string, url: string | URL, ...rest: unknown[]): unknown;
    send(this: unknown, ...args: unknown[]): unknown;
  };
}

interface FetchResponseLike { ok: boolean; clone(): { text(): Promise<string> } }

export interface HookWindow {
  fetch?: (input: unknown, init?: unknown) => Promise<FetchResponseLike>;
  XMLHttpRequest?: XhrCtorLike;
  location: { origin: string };
  postMessage(message: unknown, targetOrigin: string): void;
}

export interface InstalledHook {
  /** Restores the page's original fetch/XHR (used by tests). */
  uninstall(): void;
}

const noop = (): void => undefined;

export function installCaptureHook(win: HookWindow, platform: HookPlatform, now: () => number = Date.now): InstalledHook {
  const report = (c: ClassifiedRequest, body: string, ident: HookIdentity): void => {
    try {
      if (typeof body !== 'string' || body.length === 0 || body.length > MAX_BODY_CHARS) return;
      const message: CaptureMessage = {
        channel: CAPTURE_CHANNEL,
        v: CAPTURE_VERSION,
        platform: platform.id,
        kind: c.kind,
        capturedAt: now(),
        body,
        ...(c.requestCursor !== undefined ? { requestCursor: c.requestCursor } : {}),
        ...(c.collectionId !== undefined ? { collectionId: c.collectionId } : {}),
        ...(ident.pageHandle !== undefined ? { pageHandle: ident.pageHandle } : {}),
        ...(ident.viewerHandle !== undefined ? { viewerHandle: ident.viewerHandle } : {}),
        ...(ident.viewerId !== undefined ? { viewerId: ident.viewerId } : {}),
      };
      win.postMessage(message, win.location.origin); // same-origin only: never a wildcard target
    } catch { /* the page must never notice us */ }
  };

  const classify = (input: unknown): ClassifiedRequest | null => {
    try { return platform.classify(input, win.location.origin); } catch { return null; }
  };
  const identity = (): HookIdentity => {
    try { return platform.identity(); } catch { return {}; }
  };

  const restore: Array<() => void> = [];

  // ---- fetch
  const originalFetch = win.fetch;
  if (typeof originalFetch === 'function') {
    win.fetch = new Proxy(originalFetch, {
      apply(target, thisArg, args: [unknown, unknown?]) {
        const c = classify(args[0]);
        const ident = c ? identity() : {};
        const promise = Reflect.apply(target, thisArg, args) as Promise<FetchResponseLike>;
        if (!c) return promise;
        // A DERIVED promise: it resolves with the very same response, and rejects with the very same reason. (Attaching a rejection
        // handler to the page's own promise would mark it handled and hide the page's unhandledrejection event.)
        return promise.then((res) => {
          try {
            if (res && res.ok === true) res.clone().text().then((body) => report(c, body, ident), noop); // clone BEFORE the page reads the body
          } catch { /* ignore */ }
          return res;
        });
      },
    });
    restore.push(() => { win.fetch = originalFetch; });
  }

  // ---- XMLHttpRequest
  const Xhr = win.XMLHttpRequest;
  if (Xhr?.prototype) {
    const proto = Xhr.prototype;
    const originalOpen = proto.open;
    const originalSend = proto.send;
    // One record per open(): a re-opened object gets a NEW record, so a listener added for an earlier request can never report a later one.
    const tracked = new WeakMap<object, { c: ClassifiedRequest; ident: HookIdentity; sent: boolean }>();

    proto.open = new Proxy(originalOpen, {
      apply(target, thisArg, args: [string, string | URL, ...unknown[]]) {
        try {
          if (thisArg !== null && typeof thisArg === 'object') {
            const c = classify(args[1]);
            if (c) tracked.set(thisArg, { c, ident: identity(), sent: false });
            else tracked.delete(thisArg);
          }
        } catch { /* ignore */ }
        return Reflect.apply(target, thisArg, args);
      },
    });
    proto.send = new Proxy(originalSend, {
      apply(target, thisArg, args: unknown[]) {
        try {
          const rec = thisArg !== null && typeof thisArg === 'object' ? tracked.get(thisArg) : undefined;
          if (rec && !rec.sent) {
            rec.sent = true;
            const xhr = thisArg as FakeXhrLike;
            xhr.addEventListener('load', () => {
              try {
                if (tracked.get(xhr as unknown as object) !== rec) return; // the object was re-opened for another request
                if (xhr.status < 200 || xhr.status >= 300) return;
                const text =
                  xhr.responseType === '' || xhr.responseType === 'text' ? xhr.responseText : xhr.responseType === 'json' ? JSON.stringify(xhr.response) : undefined;
                if (typeof text === 'string') report(rec.c, text, rec.ident);
              } catch { /* ignore */ }
            });
          }
        } catch { /* ignore */ }
        return Reflect.apply(target, thisArg, args);
      },
    });
    restore.push(() => { proto.open = originalOpen; proto.send = originalSend; });
  }

  return { uninstall: () => { for (const r of restore.reverse()) r(); } };
}
