// Runs INSIDE tiktok.com's own JavaScript world (that is the only place its responses can be seen). Tiny on purpose:
// all logic lives in ../capture/hook.ts (unit-tested) and the platform files. See docs/ARCHITECTURE.md for the trust model.
import { installCaptureHook, type HookWindow } from '../capture/hook';
import { classifyRequest } from '../../platforms/tiktok/capture-rules';
import { HYDRATION_SCRIPT_ID, pageHandleFromPath, viewerFromHydration } from '../../platforms/tiktok/page-identity';

export default defineContentScript({
  matches: ['https://www.tiktok.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    let cached: { el: Element; len: number; viewer: { handle: string; id?: string } } | undefined;
    const viewer = (): { handle: string; id?: string } | undefined => {
      const el = document.getElementById(HYDRATION_SCRIPT_ID);
      const text = el?.textContent;
      if (!el || !text) return undefined;
      if (cached && cached.el === el && cached.len === text.length) return cached.viewer;
      const v = viewerFromHydration(text);
      cached = v ? { el, len: text.length, viewer: v } : undefined; // a failed read is retried next time
      return v;
    };

    installCaptureHook(window as unknown as HookWindow, {
      id: 'tiktok',
      classify: classifyRequest,
      identity: () => {
        const pageHandle = pageHandleFromPath(location.pathname);
        const v = viewer();
        return { ...(pageHandle ? { pageHandle } : {}), ...(v ? { viewerHandle: v.handle, ...(v.id !== undefined ? { viewerId: v.id } : {}) } : {}) };
      },
    });
  },
});
