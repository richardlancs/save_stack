// Each result can carry a link back to the original post, built by the platform adapter. A failing link builder never fails a search.
import { describe, expect, it } from 'vitest';
import { defaultExpander } from '../../src/core/search/expander';
import { SearchService } from '../../src/core/search/service';
import { createRpcServer } from '../../src/extension/rpc/server';
import { RPC_VERSION } from '../../src/extension/rpc/protocol';
import { batch, item, memoryAdapter } from '../storage/helpers';

describe('result links', () => {
  it('a result carries the url the platform adapter builds for it', async () => {
    const mem = await memoryAdapter();
    await mem.adapter.upsertBatch(batch({ items: [item(1), item(2)] }));
    const service = new SearchService(mem.adapter, defaultExpander, undefined, (i) => `https://x.test/${i.authorHandle}/${i.externalId}`);
    const res = await service.search({ requestId: 'r1', chips: [] });
    expect(res.results.map((r) => r.url).sort()).toEqual(['https://x.test/author1/id1', 'https://x.test/author2/id2']);
  });

  it('no builder, or a builder with nothing to say, means no url (not an empty one)', async () => {
    const mem = await memoryAdapter();
    await mem.adapter.upsertBatch(batch({ items: [item(1)] }));
    for (const build of [undefined, () => undefined]) {
      const res = await new SearchService(mem.adapter, defaultExpander, undefined, build).search({ requestId: 'r1', chips: [] });
      expect(res.results).toHaveLength(1);
      expect('url' in res.results[0]!).toBe(false);
    }
  });

  it('a builder that throws costs the result its link, never the search its results', async () => {
    const mem = await memoryAdapter();
    await mem.adapter.upsertBatch(batch({ items: [item(1), item(2), item(3)] }));
    const res = await new SearchService(mem.adapter, defaultExpander, undefined, () => { throw new Error('adapter bug'); }).search({ requestId: 'r1', chips: [] });
    expect(res.results).toHaveLength(3);
    expect(res.results.every((r) => r.url === undefined)).toBe(true);
  });

  it('through the RPC server: the platform of each item picks its link builder', async () => {
    const mem = await memoryAdapter();
    await mem.adapter.upsertBatch(batch({ items: [item(1), item(2, { platform: 'other' })] }));
    const server = createRpcServer({ adapter: () => mem.adapter, storage: 'memory', urlFor: (i) => (i.platform === 'tiktok' ? `https://t.test/${i.externalId}` : undefined) });
    const res = await server({ v: RPC_VERSION, id: 'a', method: 'search', params: { requestId: 'r1', chips: [] } });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const byId = Object.fromEntries((res.result as { results: Array<{ item: { externalId: string }; url?: string }> }).results.map((r) => [r.item.externalId, r.url]));
      expect(byId).toEqual({ id1: 'https://t.test/id1', id2: undefined });
    }
  });
});
