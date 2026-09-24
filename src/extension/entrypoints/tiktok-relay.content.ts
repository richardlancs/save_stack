// Isolated-world half of capture: receives the in-page hook's window messages, validates them, and forwards them to the
// service worker. The page cannot call chrome.* itself, which is why this second script exists.
import { installCaptureRelay } from '../capture/relay';
import { registry } from '../../platforms/registry';

export default defineContentScript({
  matches: ['https://www.tiktok.com/*'],
  runAt: 'document_start',
  // WXT would otherwise tell the page a content script started (window.postMessage carrying the extension id): not for the page to know.
  noScriptStartedPostMessage: true,
  main() {
    installCaptureRelay(window, window, registry, (message) => chrome.runtime.sendMessage(message));
  },
});
