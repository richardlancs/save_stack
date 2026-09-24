// The chrome.runtime message a relay content script sends to the service worker. `message` is validated again there.
import type { CaptureMessage } from '../../platforms/capture-protocol';

export interface CaptureRuntimeMessage {
  target: 'capture';
  message: CaptureMessage;
}

export const CAPTURE_STATUS_KEY = 'scroganize.captureStatus';
