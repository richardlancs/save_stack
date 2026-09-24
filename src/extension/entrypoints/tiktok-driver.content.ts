// Runs in the sync window's tiktok.com page (isolated world). It only scrolls, waits, and reports what kind of page it is on;
// all decisions are made by the service worker's state machine. See src/extension/sync/driver.ts for the loop and its rules.
import { createPageDriver, parseDriverCommand, type DriverEnv, type DriverEvent } from '../sync/driver';
import { HYDRATION_SCRIPT_ID, viewerFromHydration } from '../../platforms/tiktok/page-identity';
import { TIKTOK_PAGE_SPEC } from '../../platforms/tiktok/sync';

export default defineContentScript({
  matches: ['https://www.tiktok.com/*'],
  runAt: 'document_idle',
  noScriptStartedPostMessage: true, // see tiktok-relay.content.ts
  main() {
    const env: DriverEnv = {
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      random: () => Math.random(),
      // The end-to-end browser (headless Chromium under Playwright) reports every tab as visible, so its build can force "hidden" with a DOM
      // attribute. That branch is compiled out of the production bundle (scripts/check-build.mjs verifies it).
      visible: () => document.visibilityState === 'visible' && !(import.meta.env.WXT_E2E_HOOKS && document.documentElement.hasAttribute('data-scroganize-e2e-hidden')),
      scrollHeight: () => document.documentElement.scrollHeight,
      scrollToBottom: () => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }),
      nudge: () => {
        const el = document.scrollingElement ?? document.body;
        el.dispatchEvent(new WheelEvent('wheel', { deltaY: 400, bubbles: true, cancelable: true }));
      },
      reveal: () => {
        for (const selector of TIKTOK_PAGE_SPEC.revealSavedSelectors) {
          const el = document.querySelector<HTMLElement>(selector);
          if (el) { el.click(); return true; }
        }
        return false;
      },
      snapshot: () => {
        const blob = document.getElementById(HYDRATION_SCRIPT_ID);
        const viewer = viewerFromHydration(blob?.textContent);
        const present: Record<string, boolean> = {};
        for (const [name, selector] of Object.entries(TIKTOK_PAGE_SPEC.probes)) {
          try { present[name] = document.querySelector(selector) !== null; } catch { present[name] = false; }
        }
        return { pathname: location.pathname, search: location.search, title: document.title, ...(viewer ? { viewer: viewer.handle, ...(viewer.id !== undefined ? { viewerId: viewer.id } : {}) } : {}), hasBootstrap: blob !== null, present };
      },
    };

    const emit = (event: DriverEvent): void => {
      try { void chrome.runtime.sendMessage({ target: 'sync-driver', event }).catch(() => undefined); } catch { /* extension reloaded: nothing to report to */ }
    };
    const driver = createPageDriver(env, TIKTOK_PAGE_SPEC, emit);

    // Only pacing defaults in production; the end-to-end build may pass a faster config.
    const allowConfig = Boolean(import.meta.env.WXT_E2E_HOOKS);
    chrome.runtime.onMessage.addListener((message: unknown, sender) => {
      // Commands come from our own service worker only (which has no tab), never from the page or another extension.
      if (sender.id !== chrome.runtime.id || sender.tab !== undefined) return false;
      const command = parseDriverCommand((message as { driver?: unknown } | null)?.driver, allowConfig);
      if (command) driver.handle(command);
      return false;
    });
    document.addEventListener('visibilitychange', () => driver.visibilityChanged());
    driver.announce();
  },
});
