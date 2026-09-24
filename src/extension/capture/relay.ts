// The relay: an isolated-world content script's logic. It listens for the in-page hook's window messages, validates them
// (the service worker validates again and does not trust this), and forwards them to the extension.
// Written against a small `RelayWindow` so it is unit-tested in Node with fakes.

import { validateCaptureMessage } from '../../platforms/validate-capture';
import type { PlatformRegistry } from '../../platforms/registry';
import { CAPTURE_CHANNEL } from '../../platforms/capture-protocol';
import type { CaptureRuntimeMessage } from './protocol';

export interface RelayWindow {
  location: { origin: string };
  addEventListener(type: 'message', listener: (ev: { source: unknown; origin: string; data: unknown }) => void): void;
}

export function installCaptureRelay(
  win: RelayWindow,
  self: unknown,
  registry: PlatformRegistry,
  send: (message: CaptureRuntimeMessage) => Promise<unknown>,
): void {
  win.addEventListener('message', (ev) => {
    try {
      // Only this page's own window, same origin. (Frames or other windows posting to us are ignored.)
      if (ev.source !== self || ev.origin !== win.location.origin) return;
      const data = ev.data as { channel?: unknown } | null;
      if (data === null || typeof data !== 'object' || data.channel !== CAPTURE_CHANNEL) return; // cheap exit for the page's other traffic
      const checked = validateCaptureMessage(data, registry);
      if (!checked.ok) return;
      void send({ target: 'capture', message: checked.message }).catch(() => undefined); // the worker may be starting; capture is best-effort
    } catch { /* never break the page */ }
  });
}
