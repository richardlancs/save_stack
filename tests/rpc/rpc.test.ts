// RPC server + client wired together in-process over a real (in-memory) SQLite adapter.
import { describe, expect, it } from 'vitest';
import { RPC_VERSION, type RpcRequest } from '../../src/extension/rpc/protocol';
import { RpcCallError, createClient } from '../../src/extension/rpc/client';
import { createRpcServer } from '../../src/extension/rpc/server';
import { batch, coll, item, items, member, memoryAdapter } from '../storage/helpers';

async function setup() {
  const mem = await memoryAdapter();
  let resets = 0;
  const server = createRpcServer({
    adapter: () => mem.adapter,
    storage: 'memory',
    resetStorage: async () => { resets++; await mem.adapter.wipe(); },
  });
  // A transport that round-trips through JSON, like chrome.runtime.sendMessage does.
  const client = createClient(async (req) => JSON.parse(JSON.stringify(await server(JSON.parse(JSON.stringify(req)))))) ;
  return { ...mem, server, client, resets: () => resets };
}

describe('RPC', () => {
  it('ping reports versions and storage', async () => {
    const { client } = await setup();
    expect(await client.ping()).toEqual({ pong: true, rpcVersion: RPC_VERSION, schemaVersion: 2, storage: 'memory' });
  });

  it('upsertBatch -> getStats / getCollections / getItem, all through JSON', async () => {
    const { client } = await setup();
    const r = await client.upsertBatch(batch({ items: items(1, 3), collections: [coll(1, 'Recipes', 48)], memberships: [member(1, 1), member(2, 1)] }));
    expect(r).toMatchObject({ inserted: 3, membershipsWritten: 2 });
    expect(await client.getStats()).toMatchObject({ items: 3, collections: 1, memberships: 2 });
    expect(await client.getCollections()).toMatchObject([{ name: 'Recipes', declaredTotal: 48, itemsSeen: 2 }]);
    expect(await client.getItem('tiktok', 'id2')).toMatchObject({ externalId: 'id2', collections: [{ name: 'Recipes' }] });
    expect(await client.getItem('tiktok', 'nope')).toBeNull();
  });

  it('reconcile, export, import, wipe', async () => {
    const { client, resets } = await setup();
    await client.upsertBatch(batch({ items: items(1, 4) }));
    expect(await client.reconcile({ platform: 'tiktok', seenExternalIds: ['id1', 'id2'] })).toMatchObject({ markedUnavailable: 2 });
    const bundle = await client.exportData();
    expect(bundle.items).toHaveLength(4);
    await client.wipeData();
    expect(resets()).toBe(1);
    expect(await client.getStats()).toMatchObject({ items: 0 });
    await client.importData(bundle);
    expect(await client.getStats()).toMatchObject({ items: 4, availableItems: 2 });
  });

  it('methods answered by the service worker are refused by the database owner (they never reach it in the product)', async () => {
    const { client } = await setup();
    for (const call of [() => client.startSync(), () => client.pauseSync(), () => client.resumeSync(), () => client.cancelSync(), () => client.getSyncStatus(), () => client.getCaptureStatus(), () => client.getSettings(), () => client.setSettings({})]) {
      await expect(call()).rejects.toMatchObject({ name: 'RpcCallError', code: 'BAD_REQUEST', message: expect.stringContaining('service worker') });
    }
  });

  it('rejects malformed envelopes, unknown methods and bad params without throwing out of the server', async () => {
    const { server, client } = await setup();
    expect(await server(null)).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(await server({ v: 999, id: 'a', method: 'ping' })).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
    expect(await server({ v: RPC_VERSION, id: 'a', method: 'dropTables' })).toMatchObject({ id: 'a', ok: false, error: { code: 'BAD_REQUEST', message: expect.stringContaining('unknown method') } });
    await expect(client.call('getItem', { platform: 1 } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(client.call('upsertBatch', { nope: true } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(client.call('importData', { format: 'x' } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('maps a storage failure to INTERNAL and stays usable', async () => {
    const { client } = await setup();
    const bad = { items: [{ platform: 'tiktok', externalId: undefined, authorHandle: 'x' }] } as never;
    await expect(client.call('upsertBatch', bad)).rejects.toMatchObject({ code: 'INTERNAL' });
    await client.upsertBatch(batch({ items: [item(1)] }));
    expect((await client.getStats()).items).toBe(1);
  });

  it('the client reports UNAVAILABLE when the transport itself fails, and detects a mismatched response', async () => {
    const down = createClient(async () => { throw new Error('Receiving end does not exist'); });
    await expect(down.ping()).rejects.toMatchObject({ code: 'UNAVAILABLE', message: expect.stringContaining('Receiving end') });
    const liar = createClient(async () => ({ v: RPC_VERSION, id: 'someone-else', ok: true, result: null }));
    await expect(liar.getStats()).rejects.toBeInstanceOf(RpcCallError);
  });

  it('every request the client builds is a valid envelope', async () => {
    const seen: RpcRequest[] = [];
    const client = createClient(async (req) => { seen.push(req); return { v: RPC_VERSION, id: req.id, ok: true, result: null }; });
    await client.wipeData();
    await client.startSync({ mode: 'full' });
    expect(seen.map((r) => [r.v, r.method])).toEqual([[RPC_VERSION, 'wipeData'], [RPC_VERSION, 'startSync']]);
    expect(new Set(seen.map((r) => r.id)).size).toBe(2);
  });
});
