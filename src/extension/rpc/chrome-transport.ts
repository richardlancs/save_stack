// The one place a UI surface touches chrome.runtime. Kept out of client.ts so the client stays environment-free.
import type { RpcResponse, RuntimeMessage } from './protocol';
import type { Transport } from './client';

/** Send an RPC request to the service worker, which forwards it to the database owner. */
export const chromeTransport: Transport = async (request) => {
  const message: RuntimeMessage = { target: 'db', request };
  const response = (await chrome.runtime.sendMessage(message)) as RpcResponse | undefined;
  if (!response) throw new Error('no response from the Scroganize background (is the extension enabled?)');
  return response;
};
