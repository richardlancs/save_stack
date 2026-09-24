import { describe, expect, it } from 'vitest';
import { RPC_VERSION } from '../../src/extension/rpc/protocol';
import { createSearchGate, isSearchLike } from '../../src/extension/rpc/search-gate';

const search = (requestId: string, method = 'search') => ({ v: RPC_VERSION, id: `id-${requestId}-${method}`, method, params: { requestId, chips: [] } });

/**
 * A tiny model of the worker's event loop: messages that arrive while the worker is busy are QUEUED, and only become
 * "arrived" (their listener runs) when the running task yields to the loop.
 */
function fakeLoop() {
  const pending: Array<() => void> = [];
  return {
    deliverLater: (fn: () => void) => { pending.push(fn); },
    yieldToLoop: async () => { while (pending.length) pending.shift()!(); },
  };
}

describe('search gate', () => {
  it('drops a search that a newer one replaced while the worker was busy (the real-extension failure)', async () => {
    const loop = fakeLoop();
    const gate = createSearchGate(loop.yieldToLoop);
    const older = search('older');
    const newer = search('newer');

    // 1. the worker is busy with a slow request; both searches are already waiting in the event loop
    gate.noteArrival(older); // older's listener ran when it arrived (before the slow request started)...
    loop.deliverLater(() => gate.noteArrival(newer)); // ...but newer's listener cannot run until the worker yields

    // 2. slow request finishes; it is older's turn. WITHOUT the yield it would run now, unaware of newer:
    expect(gate.isSuperseded('older')).toBe(false); // this is exactly what the old design saw

    // 3. with the gate, older yields first, letting newer register
    await gate.beforeRun(older);
    expect(gate.isSuperseded('older')).toBe(true);
    expect(gate.isSuperseded('newer')).toBe(false);
  });

  it('a lone search is never superseded, and repeating the same requestId is not a replacement', async () => {
    const gate = createSearchGate(async () => {});
    gate.noteArrival(search('a'));
    await gate.beforeRun(search('a'));
    expect(gate.isSuperseded('a')).toBe(false);
    gate.noteArrival(search('a', 'getChipInfo')); // same cycle: search + chip info
    expect(gate.isSuperseded('a')).toBe(false);
  });

  it('only search-like messages take part: other methods neither yield nor change what is newest', async () => {
    let yields = 0;
    const gate = createSearchGate(async () => { yields++; });
    gate.noteArrival(search('a'));
    for (const other of [{ v: RPC_VERSION, id: 'x', method: 'getStats' }, { v: RPC_VERSION, id: 'y', method: 'upsertBatch', params: { items: [] } }, { v: RPC_VERSION, id: 'z', method: 'explainMatch', params: { requestId: 'zzz' } }]) {
      gate.noteArrival(other);
      await gate.beforeRun(other);
    }
    expect(yields).toBe(0);
    expect(gate.isSuperseded('a')).toBe(false);
    await gate.beforeRun(search('a'));
    expect(yields).toBe(1);
  });

  it('nothing is superseded before any search has arrived, and malformed messages are ignored', () => {
    const gate = createSearchGate(async () => {});
    expect(gate.isSuperseded('anything')).toBe(false);
    for (const junk of [null, undefined, 5, {}, { v: 999, method: 'search', params: { requestId: 'r' } }, { v: RPC_VERSION, method: 'search' }, { v: RPC_VERSION, method: 'search', params: { requestId: 7 } }]) {
      gate.noteArrival(junk);
      expect(isSearchLike(junk)).toBe(false);
    }
    expect(gate.isSuperseded('anything')).toBe(false);
  });

  it('the newest of several queued searches wins', async () => {
    const loop = fakeLoop();
    const gate = createSearchGate(loop.yieldToLoop);
    gate.noteArrival(search('s1'));
    loop.deliverLater(() => gate.noteArrival(search('s2')));
    loop.deliverLater(() => gate.noteArrival(search('s3')));
    await gate.beforeRun(search('s1'));
    expect(['s1', 's2', 's3'].map((id) => gate.isSuperseded(id))).toEqual([true, true, false]);
  });
});
