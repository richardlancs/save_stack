// Who may say what to the service worker. Pure (no chrome.*): the worker passes in what Chrome reported about the sender.
//
//   target 'capture' : relayed by OUR content script from a platform page  -> the capture pipeline (which validates again)
//   target 'db'      : database RPC, ONLY from our own extension pages       -> handleDb
//
// A content script runs inside a web page, so it can never reach the database RPC (export / wipe / import).

import type { CaptureOutcome } from '../platforms/capture-protocol';
import { originMatchesAny } from '../platforms/match-origin';
import type { CapturePipeline, SenderInfo } from './capture/pipeline';
import { parseDriverEvent, type DriverEvent } from './sync/driver';
import { RPC_VERSION, type RpcRequest, type RpcResponse, type RuntimeMessage } from './rpc/protocol';

export interface RouterDeps {
  ownExtensionId: string;
  /** `chrome-extension://<id>`: the origin of our own pages. */
  extensionOrigin: string;
  pipeline: CapturePipeline;
  handleDb(request: RpcRequest): Promise<RpcResponse>;
  /** Sync: events from the page driver, accepted only from a content script of ours on one of `platformMatches`. */
  sync?: { onDriverEvent(event: DriverEvent, sender: { tabId?: number }): Promise<void> };
  platformMatches?: readonly string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Returns the answer, or undefined when the message is not addressed to the service worker (the listener then stays silent). */
export function createMessageRouter(deps: RouterDeps): (message: unknown, sender: SenderInfo) => Promise<RpcResponse | CaptureOutcome> | undefined {
  return (message, sender) => {
    if (!isObject(message)) return undefined;

    if (message.target === 'capture') return deps.pipeline.handle(message.message, sender);

    if (message.target === 'sync-driver') {
      const trusted = deps.sync !== undefined && sender.id === deps.ownExtensionId && (sender.frameId === undefined || sender.frameId === 0) && originMatchesAny(deps.platformMatches ?? [], sender.origin);
      const event = trusted ? parseDriverEvent(message.event) : undefined;
      if (!event) return Promise.resolve<CaptureOutcome>({ accepted: false, reason: 'sender' });
      return deps.sync!.onDriverEvent(event, sender.tabId === undefined ? {} : { tabId: sender.tabId }).then(() => ({ accepted: true }) satisfies CaptureOutcome);
    }

    if (message.target === 'db') {
      const request = (message as unknown as RuntimeMessage).request;
      const id = isObject(request) && typeof request.id === 'string' ? request.id : '';
      const fromOurPage = sender.id === deps.ownExtensionId && sender.origin === deps.extensionOrigin;
      if (!fromOurPage) return Promise.resolve({ v: RPC_VERSION, id, ok: false, error: { code: 'BAD_REQUEST', message: 'database RPC is only available to Scroganize pages' } } satisfies RpcResponse);
      return deps.handleDb(request);
    }
    return undefined;
  };
}
